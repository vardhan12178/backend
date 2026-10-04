// Phase 2 hardening: money-path races, stale auth, server-side pricing,
// AI quotas and catalog visibility. Concurrency cases fire real parallel
// requests through the app against a real (in-memory) replica set.
import { jest } from '@jest/globals';
import { createStatefulRedisMock, registerAndLogin, makeSuperAdmin, signRazorpaySignature } from './helpers.js';

const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'dummy_secret';

const ordersCreateMock = jest.fn();
const ordersFetchMock = jest.fn();
const paymentsFetchMock = jest.fn();
class RazorpayMock {
    constructor() {
        this.orders = { create: ordersCreateMock, fetch: ordersFetchMock };
        this.payments = { fetch: paymentsFetchMock };
    }
}
jest.unstable_mockModule('razorpay', () => ({ default: RazorpayMock }));

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: redisMock,
    CACHE_TTL: { PRODUCTS_LIST: 300, PRODUCT_DETAIL: 600, PROFILE: 3600, SALE: 60, HOME: 300, TWO_FA: 300, COMPARE_SUMMARY: 3600 },
    invalidatePattern: jest.fn(),
}));

jest.unstable_mockModule('resend', () => ({
    Resend: class { constructor() { this.emails = { send: jest.fn().mockResolvedValue({ id: 'mock' }) }; } }
}));

const parseSearchQueryMock = jest.fn().mockResolvedValue({ q: 'shoes' });
jest.unstable_mockModule('../services/ai.service.js', () => ({
    handleChat: jest.fn().mockResolvedValue({ structured: { response: { summary: 'hi', points: [] } }, products: [] }),
    parseSearchQuery: parseSearchQueryMock,
    generateComparisonSummary: jest.fn(),
    vectorizeProduct: jest.fn(),
    generateReviewSummary: jest.fn(),
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
const { default: Product } = await import('../models/Product.js');
const { default: Order } = await import('../models/Order.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: MembershipPlan } = await import('../models/MembershipPlan.js');
const { issueCheckoutVerificationToken, saveWalletOrderSession, saveMembershipOrderSession, saveCheckoutOrderSession } =
    await import('../services/payment.session.service.js');
const { googleUsernameCandidate } = await import('../controllers/auth.controller.js');
const { flagDueManualRefunds } = await import('../services/refund.scheduler.js');
const { queryParser, stripMongoOperators } = await import('../middleware/security.js');
const { default: Notification } = await import('../models/Notification.js');

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const sign = (orderId, paymentId) => signRazorpaySignature(orderId, paymentId, RAZORPAY_KEY_SECRET);

const createProduct = (overrides = {}) =>
    Product.create({ title: 'Test Item', description: 'Desc', category: 'test', price: 100, stock: 10, thumbnail: 'img.jpg', ...overrides });

const orderBody = (productId, extra = {}) => ({
    products: [{ productId, name: 'Test Item', quantity: 1, price: 100 }],
    shippingAddress: '123 Fake St',
    ...extra,
});

const mockCapturedPayment = ({ orderId, paymentId, amount }) => {
    ordersFetchMock.mockResolvedValue({ id: orderId, amount });
    paymentsFetchMock.mockResolvedValue({ id: paymentId, order_id: orderId, amount, status: 'captured', method: 'card' });
};

// Holds every caller at the Razorpay payment fetch until `parties` requests
// have arrived, then releases them together — so concurrent verifies really
// do reach the credit step at the same time instead of running back to back.
const mockCapturedPaymentWithBarrier = ({ orderId, paymentId, amount, parties = 2 }) => {
    ordersFetchMock.mockResolvedValue({ id: orderId, amount });
    let arrived = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    paymentsFetchMock.mockImplementation(async () => {
        arrived += 1;
        if (arrived >= parties) release();
        await gate;
        return { id: paymentId, order_id: orderId, amount, status: 'captured', method: 'card' };
    });
};

beforeAll(async () => {
    // Unique payment indexes must exist before the race tests rely on them.
    await Order.init();
});

beforeEach(() => {
    ordersCreateMock.mockReset();
    ordersFetchMock.mockReset();
    paymentsFetchMock.mockReset();
});

describe('Checkout: one payment can only ever become one order', () => {
    it('two concurrent order placements with the same payment token create exactly one order', async () => {
        const { token, loginRes } = await registerAndLogin(request, app);
        const userId = loginRes.body.user?._id || (await User.findOne({}).sort({ createdAt: -1 }))._id;
        const product = await createProduct();

        // 100 + 50 shipping (below free-shipping threshold) = 150
        const verificationToken = await issueCheckoutVerificationToken({
            userId: String(userId), paymentId: 'pay_race_1', paymentOrderId: 'order_race_1',
            amountPaise: 15000, amount: 150, currency: 'INR', method: 'card',
        });
        const body = orderBody(product.id, { paymentVerificationToken: verificationToken });

        const results = await Promise.all([
            request(app).post('/api/orders').set(auth(token)).send(body),
            request(app).post('/api/orders').set(auth(token)).send(body),
        ]);
        const statuses = results.map((r) => r.statusCode).sort();

        expect(statuses).toEqual([201, 409]);
        expect(await Order.countDocuments({ paymentId: 'pay_race_1' })).toBe(1);
        expect((await Product.findById(product.id)).stock).toBe(9);
    });

    it('the database itself rejects a second order carrying the same payment id', async () => {
        const { loginRes } = await registerAndLogin(request, app);
        const userId = loginRes.body.user?._id || (await User.findOne({}))._id;
        const base = {
            userId, customer: { name: 'x', email: 'x@test.com' },
            products: [{ productId: (await createProduct()).id, name: 'a', quantity: 1, price: 10 }],
            shippingAddress: 'addr', paymentStatus: 'PAID', paymentMethod: 'CARD',
        };
        await Order.create({ ...base, paymentId: 'pay_unique', paymentOrderId: 'order_unique_a' });
        await expect(Order.create({ ...base, paymentId: 'pay_unique', paymentOrderId: 'order_unique_b' }))
            .rejects.toMatchObject({ code: 11000 });
        // Orders without a payment id (COD/wallet) never collide.
        await Order.create({ ...base });
        await Order.create({ ...base });
    });

    it('verifying the same Razorpay payment twice returns the same token', async () => {
        const { token, loginRes } = await registerAndLogin(request, app);
        const userId = loginRes.body.user?._id || (await User.findOne({}).sort({ createdAt: -1 }))._id;
        await saveCheckoutOrderSession('order_idem_1', { userId: String(userId), amount: 15000, currency: 'INR' });
        mockCapturedPayment({ orderId: 'order_idem_1', paymentId: 'pay_idem_1', amount: 15000 });

        const payload = { razorpay_order_id: 'order_idem_1', razorpay_payment_id: 'pay_idem_1', razorpay_signature: sign('order_idem_1', 'pay_idem_1') };
        const [a, b] = await Promise.all([
            request(app).post('/api/razorpay/verify').set(auth(token)).send(payload),
            request(app).post('/api/razorpay/verify').set(auth(token)).send(payload),
        ]);
        const ok = [a, b].filter((r) => r.statusCode === 200);
        expect(ok.length).toBeGreaterThanOrEqual(1);
        const tokens = new Set(ok.map((r) => r.body.verificationToken));
        expect(tokens.size).toBe(1);

        const again = await request(app).post('/api/razorpay/verify').set(auth(token)).send(payload);
        expect(again.statusCode).toBe(200);
        expect(again.body.verificationToken).toBe([...tokens][0]);
    });
});

describe('Checkout: Razorpay order is priced on the server', () => {
    it('ignores client prices and charges the server-computed total', async () => {
        const { token } = await registerAndLogin(request, app);
        const product = await createProduct({ price: 400, stock: 5 });
        ordersCreateMock.mockResolvedValue({ id: 'order_priced', amount: 85000, currency: 'INR', receipt: 'r' });

        const res = await request(app).post('/api/razorpay/create-order').set(auth(token)).send({
            products: [{ productId: product.id, quantity: 2, price: 1 }],
        });

        expect(res.statusCode).toBe(200);
        // 2 x 400 = 800, below the 999 free-shipping threshold -> +50
        expect(ordersCreateMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 85000, currency: 'INR' }));
    });

    it('rejects a cart with an unavailable product before creating a Razorpay order', async () => {
        const { token } = await registerAndLogin(request, app);
        const product = await createProduct({ isActive: false });
        const res = await request(app).post('/api/razorpay/create-order').set(auth(token)).send({
            products: [{ productId: product.id, quantity: 1 }],
        });
        expect(res.statusCode).toBe(400);
        expect(ordersCreateMock).not.toHaveBeenCalled();
    });
});

describe('Checkout: prices quoted at payment time are honoured', () => {
    const payFor = async (token, productId, quantity, orderId, paymentId) => {
        ordersCreateMock.mockImplementationOnce(async ({ amount }) => ({ id: orderId, amount, currency: 'INR', receipt: 'r' }));
        const created = await request(app).post('/api/razorpay/create-order').set(auth(token))
            .send({ products: [{ productId, quantity }] });
        expect(created.statusCode).toBe(200);
        mockCapturedPayment({ orderId, paymentId, amount: created.body.amount });
        const verified = await request(app).post('/api/razorpay/verify').set(auth(token))
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });
        expect(verified.statusCode).toBe(200);
        return verified.body.verificationToken;
    };

    it('places the order at the paid price when the price changed during payment', async () => {
        const { token } = await registerAndLogin(request, app, { username: 'pricechange', email: 'pricechange@test.com' });
        const product = await createProduct({ price: 400, stock: 5 });
        const verificationToken = await payFor(token, product.id, 1, 'order_honour_1', 'pay_honour_1');

        await Product.updateOne({ _id: product._id }, { $set: { price: 600 } }); // repriced mid-payment

        const res = await request(app).post('/api/orders').set(auth(token)).send({
            products: [{ productId: product.id, name: 'Test Item', quantity: 1 }],
            shippingAddress: '123 Fake St',
            paymentVerificationToken: verificationToken,
        });
        expect(res.statusCode).toBe(201);
        expect(res.body.products[0].price).toBe(400);
        expect(res.body.paymentStatus).toBe('PAID');
    });

    it('still rejects the payment if the cart itself changed', async () => {
        const { token } = await registerAndLogin(request, app, { username: 'cartchange', email: 'cartchange@test.com' });
        const product = await createProduct({ price: 400, stock: 5 });
        const verificationToken = await payFor(token, product.id, 1, 'order_honour_2', 'pay_honour_2');

        const res = await request(app).post('/api/orders').set(auth(token)).send({
            products: [{ productId: product.id, name: 'Test Item', quantity: 2 }],
            shippingAddress: '123 Fake St',
            paymentVerificationToken: verificationToken,
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/amount mismatch/i);
    });
});

describe('Coupons: usage limits hold under concurrency', () => {
    const makeCoupon = (overrides = {}) =>
        Coupon.create({ code: `RACE${Date.now()}${Math.floor(Math.random() * 1000)}`, type: 'flat', value: 10, validTo: new Date(Date.now() + 86400000), ...overrides });

    it('a single-use coupon is consumed by at most one of two simultaneous orders', async () => {
        const coupon = await makeCoupon({ usageLimit: 1 });
        const product = await createProduct({ stock: 10 });
        const buyers = [];
        for (const name of ['couponrace_a', 'couponrace_b']) {
            const { token } = await registerAndLogin(request, app, { username: name, email: `${name}@test.com` });
            await User.updateOne({ username: name }, { $set: { walletBalance: 1000 } });
            buyers.push(token);
        }

        const results = await Promise.all(
            buyers.map((t) => request(app).post('/api/orders').set(auth(t)).send(orderBody(product.id, { promo: coupon.code, walletUsed: 1000 })))
        );

        expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
        const fresh = await Coupon.findById(coupon._id);
        expect(fresh.usedCount).toBe(1);
        expect(await Order.countDocuments({ couponId: coupon._id })).toBe(1);
    });

    it('enforces the per-user limit', async () => {
        const coupon = await makeCoupon({ perUserLimit: 1 });
        const product = await createProduct({ stock: 10 });
        const { token } = await registerAndLogin(request, app, { username: 'peruser', email: 'peruser@test.com' });
        await User.updateOne({ username: 'peruser' }, { $set: { walletBalance: 1000 } });

        const first = await request(app).post('/api/orders').set(auth(token)).send(orderBody(product.id, { promo: coupon.code, walletUsed: 1000 }));
        const second = await request(app).post('/api/orders').set(auth(token)).send(orderBody(product.id, { promo: coupon.code, walletUsed: 1000 }));

        expect(first.statusCode).toBe(201);
        expect(second.statusCode).toBe(400);
        expect((await Coupon.findById(coupon._id)).usedCount).toBe(1);
    });
});

describe('Wallet and membership: a payment is credited exactly once', () => {
    it('two concurrent wallet top-up verifications credit the wallet once', async () => {
        const { token } = await registerAndLogin(request, app, { username: 'walletrace', email: 'walletrace@test.com' });
        const user = await User.findOne({ username: 'walletrace' });
        await saveWalletOrderSession('order_wallet_race', { userId: String(user._id), amount: 50000, currency: 'INR' });
        mockCapturedPaymentWithBarrier({ orderId: 'order_wallet_race', paymentId: 'pay_wallet_race', amount: 50000 });

        const payload = { razorpay_order_id: 'order_wallet_race', razorpay_payment_id: 'pay_wallet_race', razorpay_signature: sign('order_wallet_race', 'pay_wallet_race') };
        await Promise.all([
            request(app).post('/api/wallet/verify').set(auth(token)).send(payload),
            request(app).post('/api/wallet/verify').set(auth(token)).send(payload),
        ]);

        const after = await User.findById(user._id);
        expect(after.walletBalance).toBe(500);
        expect(after.walletTransactions.filter((t) => t.paymentId === 'pay_wallet_race')).toHaveLength(1);
    });

    it('two concurrent membership verifications extend Prime once', async () => {
        const plan = await MembershipPlan.create({ name: 'Monthly', slug: `monthly-${Date.now()}`, durationDays: 30, price: 99, isActive: true });
        const { token } = await registerAndLogin(request, app, { username: 'primerace', email: 'primerace@test.com' });
        const user = await User.findOne({ username: 'primerace' });
        await saveMembershipOrderSession('order_prime_race', { userId: String(user._id), planId: String(plan._id), amount: 9900, currency: 'INR' });
        mockCapturedPaymentWithBarrier({ orderId: 'order_prime_race', paymentId: 'pay_prime_race', amount: 9900 });

        const payload = { razorpay_order_id: 'order_prime_race', razorpay_payment_id: 'pay_prime_race', razorpay_signature: sign('order_prime_race', 'pay_prime_race') };
        await Promise.all([
            request(app).post('/api/membership/verify').set(auth(token)).send(payload),
            request(app).post('/api/membership/verify').set(auth(token)).send(payload),
        ]);

        const after = await User.findById(user._id);
        expect(after.membership.history).toHaveLength(1);
        const days = (new Date(after.membership.endDate) - Date.now()) / 86400000;
        expect(days).toBeGreaterThan(29);
        expect(days).toBeLessThan(31);
    });
});

describe('Membership: two different payments landing together both count', () => {
    it('extends Prime by both purchases (neither overwrites the other)', async () => {
        const plan = await MembershipPlan.create({ name: 'Monthly', slug: `monthly2-${Date.now()}`, durationDays: 30, price: 99, isActive: true });
        const { token } = await registerAndLogin(request, app, { username: 'primetwice', email: 'primetwice@test.com' });
        const user = await User.findOne({ username: 'primetwice' });
        for (const n of [1, 2]) {
            await saveMembershipOrderSession(`order_prime_${n}`, { userId: String(user._id), planId: String(plan._id), amount: 9900, currency: 'INR' });
        }
        ordersFetchMock.mockImplementation(async (id) => ({ id, amount: 9900 }));
        let arrived = 0;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        paymentsFetchMock.mockImplementation(async (paymentId) => {
            arrived += 1;
            if (arrived >= 2) release();
            await gate;
            return { id: paymentId, order_id: paymentId.replace('pay_', 'order_'), amount: 9900, status: 'captured' };
        });

        const verify = (n) => request(app).post('/api/membership/verify').set(auth(token)).send({
            razorpay_order_id: `order_prime_${n}`, razorpay_payment_id: `pay_prime_${n}`,
            razorpay_signature: sign(`order_prime_${n}`, `pay_prime_${n}`),
        });
        const results = await Promise.all([verify(1), verify(2)]);
        expect(results.map((r) => r.statusCode)).toEqual([200, 200]);

        const after = await User.findById(user._id);
        expect(after.membership.history.map((h) => h.paymentId).sort()).toEqual(['pay_prime_1', 'pay_prime_2']);
        const days = (new Date(after.membership.endDate) - Date.now()) / 86400000;
        expect(days).toBeGreaterThan(59);
        expect(days).toBeLessThan(61);
    });
});

describe('Auth: roles and blocked status are read live, not from the token', () => {
    it('a demoted admin loses admin access with their existing token', async () => {
        const { payload } = await registerAndLogin(request, app, { username: 'demoteme', email: 'demoteme@test.com' });
        await makeSuperAdmin(User, payload.username);
        const login = await request(app).post('/api/login').send({ username: payload.username, password: payload.password });
        const adminToken = login.body.token;

        expect((await request(app).get('/api/admin/vitals').set(auth(adminToken))).statusCode).toBe(200);

        await User.updateOne({ username: payload.username }, { $set: { roles: ['user'], adminRole: null } });
        expect((await request(app).get('/api/admin/vitals').set(auth(adminToken))).statusCode).toBe(403);
    });

    it('blocking a user ends their existing session immediately', async () => {
        const { token } = await registerAndLogin(request, app, { username: 'blockme', email: 'blockme@test.com' });
        expect((await request(app).get('/api/wallet').set(auth(token))).statusCode).toBe(200);

        await User.updateOne({ username: 'blockme' }, { $set: { blocked: true } });
        const res = await request(app).get('/api/wallet').set(auth(token));
        expect(res.statusCode).toBe(401);
        expect(res.body.error).toBe('account blocked');
    });

    it('a token for a deleted account is rejected', async () => {
        const { token } = await registerAndLogin(request, app, { username: 'deleteme', email: 'deleteme@test.com' });
        await User.deleteOne({ username: 'deleteme' });
        expect((await request(app).get('/api/wallet').set(auth(token))).statusCode).toBe(401);
    });
});

describe('Catalog: inactive products', () => {
    it('are hidden from shoppers but visible to admins; malformed ids are 404', async () => {
        const product = await createProduct({ isActive: false });
        expect((await request(app).get(`/api/products/${product.id}`)).statusCode).toBe(404);
        expect((await request(app).get('/api/products/not-an-id')).statusCode).toBe(404);

        const { payload } = await registerAndLogin(request, app, { username: 'catalogadmin', email: 'catalogadmin@test.com' });
        await makeSuperAdmin(User, payload.username);
        const login = await request(app).post('/api/login').send({ username: payload.username, password: payload.password });
        const res = await request(app).get(`/api/products/${product.id}`).set(auth(login.body.token));
        expect(res.statusCode).toBe(200);
    });
});

describe('Refund scheduler', () => {
    it('flags overdue manual refunds to admins instead of claiming they completed', async () => {
        const { loginRes } = await registerAndLogin(request, app);
        const userId = loginRes.body.user?._id || (await User.findOne({}))._id;
        const order = await Order.create({
            userId, customer: { name: 'x', email: 'x@test.com' },
            products: [{ productId: (await createProduct()).id, name: 'a', quantity: 1, price: 10 }],
            shippingAddress: 'addr', paymentStatus: 'PAID', paymentMethod: 'COD',
            refundStatus: 'INITIATED', refundMethod: 'ORIGINAL', refundDueAt: new Date(Date.now() - 1000),
        });

        expect(await flagDueManualRefunds()).toBe(1);

        const after = await Order.findById(order._id);
        expect(after.refundStatus).toBe('INITIATED');
        expect(after.refundDueAt).toBeUndefined();
        expect(await Notification.countDocuments({ title: /Manual refund due/ })).toBe(1);

        // Flagged once only.
        expect(await flagDueManualRefunds()).toBe(0);
    });
});

describe('Request sanitising (Express 5 replacement for mongo-sanitize + hpp)', () => {
    it('strips operator and dotted keys from bodies, deeply', () => {
        const body = { username: { $gt: '' }, nested: { ok: 1, 'a.b': 2, list: [{ $where: 'x', keep: true }] } };
        expect(stripMongoOperators(body)).toEqual({ username: {}, nested: { ok: 1, list: [{ keep: true }] } });
    });

    it('drops operator keys from query strings and collapses repeated params', () => {
        expect(queryParser('sort=a&sort=b&$where=1&a.b=2&q=red%20shoes')).toEqual({ sort: 'b', q: 'red shoes' });
        expect(queryParser('')).toEqual({});
    });

    it('an operator-injection login attempt is not a login', async () => {
        await registerAndLogin(request, app, { username: 'injectme', email: 'injectme@test.com' });
        const res = await request(app).post('/api/login').send({ username: { $gt: '' }, password: { $gt: '' } });
        expect(res.statusCode).not.toBe(200);
        expect(res.body.token).toBeUndefined();
    });

    it('?sort given twice reaches the API as a single value', async () => {
        await createProduct({ title: 'Alpha', price: 10 });
        await createProduct({ title: 'Beta', price: 20 });
        const res = await request(app).get('/api/products?sort=price-desc&sort=price-asc');
        expect(res.statusCode).toBe(200);
    });
});

describe('Google sign-up usernames', () => {
    it('cleans the email local part and adds a suffix on retries', () => {
        expect(googleUsernameCandidate('Jane.Doe+shop@gmail.com')).toBe('jane.doeshop');
        expect(googleUsernameCandidate('a@x.com')).toMatch(/^[a-z0-9._-]{3,}$/);
        const retry = googleUsernameCandidate('jane@gmail.com', 1);
        expect(retry).toMatch(/^jane[a-f0-9]{6}$/);
    });
});

describe('AI: daily quota', () => {
    const OLD = { ...process.env };
    beforeEach(async () => {
        process.env.AI_DAILY_LIMIT_GUEST = '2';
        process.env.AI_DAILY_LIMIT_USER = '3';
        const keys = [...(await redisMock.scan('0'))[1]];
        if (keys.length) await redisMock.del(...keys);
    });
    afterEach(() => {
        process.env.AI_DAILY_LIMIT_GUEST = OLD.AI_DAILY_LIMIT_GUEST;
        process.env.AI_DAILY_LIMIT_USER = OLD.AI_DAILY_LIMIT_USER;
    });

    it('caps guests, and signed-in users get their own larger allowance', async () => {
        const ask = (headers = {}) => request(app).post('/api/ai/parse-search').set(headers).send({ query: 'red shoes under 2000' });

        expect((await ask()).statusCode).toBe(200);
        expect((await ask()).statusCode).toBe(200);
        const blocked = await ask();
        expect(blocked.statusCode).toBe(429);
        expect(blocked.body.quotaExceeded).toBe(true);
        expect(blocked.body.error).toMatch(/sign in/i);

        const { token } = await registerAndLogin(request, app, { username: 'aiquota', email: 'aiquota@test.com' });
        for (let i = 0; i < 3; i += 1) {
            expect((await ask(auth(token))).statusCode).toBe(200);
        }
        const userBlocked = await ask(auth(token));
        expect(userBlocked.statusCode).toBe(429);
        expect(userBlocked.body.error).toMatch(/resets tomorrow/i);
    });
});
