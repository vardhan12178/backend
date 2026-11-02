import { jest } from "@jest/globals";
import { createStatefulRedisMock } from "./helpers.js";

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule("../utils/redis.js", () => ({
  default: redisMock,
  CACHE_TTL: {
    PRODUCTS_LIST: 300,
    PRODUCT_DETAIL: 600,
    PROFILE: 3600,
    SALE: 60,
    HOME: 300,
    TWO_FA: 300,
  },
  invalidatePattern: jest.fn(),
}));

const { default: request } = await import("supertest");
const { default: app } = await import("../app.js");
const { default: User } = await import("../models/User.js");
const { default: Order } = await import("../models/Order.js");
const { default: CatalogProduct } = await import("../models/CatalogProduct.js");
const { default: CatalogReview } = await import("../models/CatalogReview.js");

describe("Demo logins", () => {
  afterEach(() => {
    delete process.env.DEMO_LOGINS;
  });

  test("shopper demo signs in, is not an admin, and starts with an empty bag", async () => {
    const res = await request(app).post("/api/auth/demo/shopper");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.user.username).toBe("demo.shopper");
    expect(res.body.token).toBeTruthy();
    const user = await User.findOne({ username: "demo.shopper" });
    expect(user.roles).toEqual(["user"]);
    expect(user.cart).toHaveLength(0);
  });

  test("signing in twice reuses the same account", async () => {
    await request(app).post("/api/auth/demo/shopper");
    await request(app).post("/api/auth/demo/shopper");
    expect(await User.countDocuments({ username: "demo.shopper" })).toBe(1);
  });

  test("demo accounts cannot be used with a password", async () => {
    await request(app).post("/api/auth/demo/admin");
    const res = await request(app)
      .post("/api/admin/login")
      .send({ username: "demo.admin", password: "Password123!" });
    expect(res.status).toBe(401);
  });

  test("demo admin can read allowed modules but never write", async () => {
    const login = await request(app).post("/api/auth/demo/admin");
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.token}` };

    const verify = await request(app).get("/api/admin/verify").set(auth);
    expect(verify.status).toBe(200);
    expect(verify.body.permissions.orders).toBe("read");
    expect(verify.body.permissions.users).toBeUndefined();

    expect((await request(app).get("/api/admin/v2/products").set(auth)).status).toBe(200);
    // Customers stay private
    expect((await request(app).get("/api/admin/users").set(auth)).status).toBe(403);

    const write = await request(app)
      .post("/api/coupons")
      .set(auth)
      .send({ code: "NOPE10", discountValue: 10 });
    expect(write.status).toBe(403);
    expect(write.body.message).toMatch(/read-only/i);
  });

  test("demo shopper cannot change the password", async () => {
    const login = await request(app).post("/api/auth/demo/shopper");
    const res = await request(app)
      .put("/api/profile/password")
      .set({ Authorization: `Bearer ${login.body.token}` })
      .send({ currentPassword: "x", newPassword: "Password123!", confirmPassword: "Password123!" });
    expect(res.status).toBe(403);
  });

  test("can be switched off", async () => {
    process.env.DEMO_LOGINS = "false";
    expect((await request(app).post("/api/auth/demo/shopper")).status).toBe(404);
    expect((await request(app).post("/api/auth/demo/admin")).status).toBe(404);
  });

  describe("seeded delivered order", () => {
    const mk = (slug, count) => ({
      slug,
      title: `Brand ${slug}`,
      brand: "Brand",
      category: "mobiles",
      categoryPath: ["electronics", "mobiles"],
      status: "draft",
      priceRange: { min: 9000, max: 9000 },
      inStock: true,
      searchText: slug,
      rating: { average: 4, count },
      variants: [
        {
          sku: `${slug}-1`,
          options: { Color: "Black" },
          price: 9000,
          mrp: 10000,
          stock: 5,
          isDefault: true,
        },
      ],
    });
    beforeEach(async () => {
      await CatalogProduct.syncIndexes();
      await CatalogProduct.insertMany([mk("demo-a", 500), mk("demo-b", 400), mk("demo-c", 10)]);
    });

    test("the demo shopper can review the two most-rated products, once, and the next visit starts clean", async () => {
      const login = await request(app).post("/api/auth/demo/shopper");
      const auth = { Authorization: `Bearer ${login.body.token}` };

      const state = await request(app).get("/api/v2/products/demo-a/reviews").set(auth);
      expect(state.body.canReview).toBe(true);
      expect(
        (await request(app).get("/api/v2/products/demo-c/reviews").set(auth)).body.canReview
      ).toBe(false);

      const posted = await request(app)
        .post("/api/v2/products/demo-a/reviews")
        .set(auth)
        .send({ stars: 5, title: "Nice", body: "Tried the demo review flow today." });
      expect(posted.status).toBe(201);
      expect(await CatalogReview.countDocuments()).toBe(1);

      // Signing in again wipes it, so the next visitor can write their own
      const again = await request(app).post("/api/auth/demo/shopper");
      expect(await CatalogReview.countDocuments()).toBe(0);
      const next = await request(app)
        .get("/api/v2/products/demo-a/reviews")
        .set({ Authorization: `Bearer ${again.body.token}` });
      expect(next.body.canReview).toBe(true);
      expect(await Order.countDocuments({ orderId: "VK-DEMO-DELIVERED" })).toBe(1);
    });

    test("the demo order appears in the shopper's own orders list, once, however often they sign in", async () => {
      await request(app).post("/api/auth/demo/shopper");
      const login = await request(app).post("/api/auth/demo/shopper");
      const res = await request(app)
        .get("/api/profile/orders")
        .set({ Authorization: `Bearer ${login.body.token}` });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].orderId).toBe("VK-DEMO-DELIVERED");
      expect(res.body[0].stage).toBe("DELIVERED");
    });

    test("the demo order never shows up in the admin order list", async () => {
      await request(app).post("/api/auth/demo/shopper");
      const admin = await request(app).post("/api/auth/demo/admin");
      const res = await request(app)
        .get("/api/admin/orders")
        .set({ Authorization: `Bearer ${admin.body.token}` });
      expect(res.status).toBe(200);
      expect(res.body.some((o) => o.isDemo || o.orderId === "VK-DEMO-DELIVERED")).toBe(false);
    });
  });
});
