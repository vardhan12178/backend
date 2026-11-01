import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { createStatefulRedisMock, registerAndLogin, makeSuperAdmin } from './helpers.js';

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: redisMock,
    CACHE_TTL: { PRODUCTS_LIST: 300, PRODUCT_DETAIL: 600, PROFILE: 3600, SALE: 60, HOME: 300, TWO_FA: 300 },
    invalidatePattern: jest.fn(),
}));
jest.unstable_mockModule('resend', () => ({
    Resend: class { constructor() { this.emails = { send: jest.fn().mockResolvedValue({ id: 'mock' }) }; } }
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: CatalogProduct } = await import('../models/CatalogProduct.js');
const { default: CatalogReview } = await import('../models/CatalogReview.js');
const { default: Order } = await import('../models/Order.js');
const { default: User } = await import('../models/User.js');
const { publicName, cleanText } = await import('../services/catalog.userReviews.js');
const { syncRatings } = await import('../services/catalog.ratings.js');

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const goodReview = { stars: 5, title: 'Great', body: 'Battery easily lasts two days and the screen is lovely.' };

async function seedProduct() {
    await CatalogProduct.syncIndexes();
    return CatalogProduct.create({
        slug: 'rev-phone', title: 'Brand rev-phone', brand: 'Brand', category: 'mobiles', categoryPath: ['electronics', 'mobiles'],
        status: 'draft', launchDate: '2026-01', priceRange: { min: 10000, max: 10000 }, inStock: true, searchText: 'rev-phone',
        variants: [{ sku: 'REV-1', options: { Color: 'Black' }, price: 10000, mrp: 12000, stock: 5, isDefault: true }],
    });
}

async function shopperWithOrder(product, stage = 'DELIVERED', overrides = {}) {
    const { token, payload } = await registerAndLogin(request, app, overrides);
    const user = await User.findOne({ username: payload.username });
    const n = new mongoose.Types.ObjectId().toString().slice(-8);
    await Order.collection.insertOne({
        userId: user._id, orderId: `ORD-${n}`, invoiceNumber: `INV-${n}`, stage, createdAt: new Date(),
        products: [{ productId: product._id, catalog: 'v2', sku: 'REV-1', name: product.title, quantity: 1, price: 10000, selectedVariants: 'Color: Black' }],
    });
    return { token, user };
}

describe('helpers', () => {
    it('shows first name and last initial only', () => {
        expect(publicName('Asha Rao')).toBe('Asha R.');
        expect(publicName('Asha')).toBe('Asha');
        expect(publicName('')).toBe('VKart shopper');
    });
    it('strips tags and control characters', () => {
        expect(cleanText('<b>Nice</b><script>x</script> phone\u0007')).toBe('Nicex phone');
    });
});

describe('Shopper reviews', () => {
    let product;
    beforeEach(async () => { product = await seedProduct(); });

    it('lists nothing at first and does not need a login', async () => {
        const res = await request(app).get('/api/v2/products/rev-phone/reviews');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ total: 0, reviews: [], canReview: false, signedIn: false });
        expect((await request(app).get('/api/v2/products/nope/reviews')).status).toBe(404);
    });

    it('requires a login to write', async () => {
        expect((await request(app).post('/api/v2/products/rev-phone/reviews').send(goodReview)).status).toBe(401);
    });

    it('rejects shoppers whose order has not been delivered', async () => {
        const { token } = await shopperWithOrder(product, 'SHIPPED');
        const res = await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(token)).send(goodReview);
        expect(res.status).toBe(403);
        const state = await request(app).get('/api/v2/products/rev-phone/reviews').set(auth(token));
        expect(state.body.canReview).toBe(false);
    });

    it('lets a delivered buyer review once, shows a verified review and updates the rating', async () => {
        const { token } = await shopperWithOrder(product, 'DELIVERED', { name: 'Asha Rao' });
        const before = await request(app).get('/api/v2/products/rev-phone/reviews').set(auth(token));
        expect(before.body.canReview).toBe(true);

        const res = await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(token)).send(goodReview);
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ stars: 5, verified: true, mine: true, name: 'Asha R.', variant: 'Color: Black' });

        const dupe = await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(token)).send(goodReview);
        expect(dupe.status).toBe(409);

        const list = await request(app).get('/api/v2/products/rev-phone/reviews');
        expect(list.body.total).toBe(1);
        expect(list.body.reviews[0].mine).toBe(false);
        const after = await request(app).get('/api/v2/products/rev-phone/reviews').set(auth(token));
        expect(after.body).toMatchObject({ canReview: false });
        expect(after.body.myReview.title).toBe('Great');

        const stored = await CatalogProduct.findOne({ slug: 'rev-phone' }).lean();
        expect(stored.rating.count).toBe(1); // product has no sample reviews, so only the real one counts
        expect(stored.rating.average).toBe(5);
    });

    it('validates stars and length, and strips markup', async () => {
        const { token } = await shopperWithOrder(product);
        expect((await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(token)).send({ stars: 7, body: 'long enough text here' })).status).toBe(400);
        expect((await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(token)).send({ stars: 4, body: 'short' })).status).toBe(400);
        const res = await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(token)).send({ stars: 4, title: '<i>Ok</i>', body: '<script>alert(1)</script>Works fine for me.' });
        expect(res.status).toBe(201);
        expect(res.body.title).toBe('Ok');
        expect(res.body.body).not.toMatch(/</);
    });

    it('lets the author edit and delete, and nobody else', async () => {
        const a = await shopperWithOrder(product);
        const b = await shopperWithOrder(product);
        const created = await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(a.token)).send(goodReview);
        const id = created.body.id;

        expect((await request(app).put(`/api/v2/reviews/${id}`).set(auth(b.token)).send({ stars: 1 })).status).toBe(403);
        const edited = await request(app).put(`/api/v2/reviews/${id}`).set(auth(a.token)).send({ stars: 3 });
        expect(edited.status).toBe(200);
        expect((await CatalogProduct.findOne({ slug: 'rev-phone' }).lean()).rating.average).toBe(3);

        expect((await request(app).delete(`/api/v2/reviews/${id}`).set(auth(b.token))).status).toBe(403);
        expect((await request(app).delete(`/api/v2/reviews/${id}`).set(auth(a.token))).status).toBe(200);
        expect((await CatalogProduct.findOne({ slug: 'rev-phone' }).lean()).rating).toMatchObject({ average: 0, count: 0 });
    });

    it('toggles helpful votes, but not on your own review', async () => {
        const a = await shopperWithOrder(product);
        const b = await shopperWithOrder(product);
        const { body: review } = await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(a.token)).send(goodReview);

        expect((await request(app).post(`/api/v2/reviews/${review.id}/helpful`).set(auth(a.token))).status).toBe(400);
        const up = await request(app).post(`/api/v2/reviews/${review.id}/helpful`).set(auth(b.token));
        expect(up.body).toEqual({ voted: true, helpful: 1 });
        const down = await request(app).post(`/api/v2/reviews/${review.id}/helpful`).set(auth(b.token));
        expect(down.body).toEqual({ voted: false, helpful: 0 });
    });

    it('sorts by helpful and by rating', async () => {
        const a = await shopperWithOrder(product);
        const b = await shopperWithOrder(product);
        const c = await shopperWithOrder(product);
        const low = await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(a.token)).send({ stars: 2, body: 'Heats up while charging a lot.' });
        await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(b.token)).send({ stars: 5, body: 'Superb camera in daylight shots.' });
        await request(app).post(`/api/v2/reviews/${low.body.id}/helpful`).set(auth(c.token));

        const helpful = await request(app).get('/api/v2/products/rev-phone/reviews?sort=helpful');
        expect(helpful.body.reviews[0].stars).toBe(2);
        const high = await request(app).get('/api/v2/products/rev-phone/reviews?sort=high');
        expect(high.body.reviews.map((r) => r.stars)).toEqual([5, 2]);
    });

    it('lets a moderator hide a review, which removes it from the rating', async () => {
        const a = await shopperWithOrder(product);
        const { body: review } = await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(a.token)).send(goodReview);

        const { token: adminToken, payload } = await registerAndLogin(request, app);
        expect((await request(app).get('/api/admin/v2/reviews').set(auth(adminToken))).status).toBe(403);
        await makeSuperAdmin(User, payload.username);
        const login = await request(app).post('/api/admin/login').send({ username: payload.username, password: payload.password });
        const admin = auth(login.body.token);

        const listed = await request(app).get('/api/admin/v2/reviews').set(admin);
        expect(listed.body.reviews[0]).toMatchObject({ id: review.id, status: 'published', product: 'Brand rev-phone' });

        const hide = await request(app).patch(`/api/admin/v2/reviews/${review.id}`).set(admin).send({ status: 'hidden' });
        expect(hide.status).toBe(200);
        expect((await request(app).get('/api/v2/products/rev-phone/reviews')).body.total).toBe(0);
        expect((await CatalogProduct.findOne({ slug: 'rev-phone' }).lean()).rating.count).toBe(0);
    });

    it('keeps real reviews in the rating when ratings are re-synced', async () => {
        const a = await shopperWithOrder(product);
        await request(app).post('/api/v2/products/rev-phone/reviews').set(auth(a.token)).send(goodReview);
        await CatalogProduct.updateOne({ slug: 'rev-phone' }, { $set: { rating: { average: 0, count: 0 } } });
        await syncRatings();
        expect((await CatalogProduct.findOne({ slug: 'rev-phone' }).lean()).rating).toMatchObject({ average: 5, count: 1 });
        expect(await CatalogReview.countDocuments()).toBe(1);
    });
});
