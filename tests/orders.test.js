import { jest } from '@jest/globals';
import { createStatefulRedisMock, registerAndLogin, makeSuperAdmin } from './helpers.js';

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule('../utils/redis.js', () => ({
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

jest.unstable_mockModule('resend', () => ({
    Resend: class {
        constructor() {
            this.emails = { send: jest.fn().mockResolvedValue({ id: 'mock_email_id' }) };
        }
    }
}));

// Order creation for the online-payment path is driven entirely through
// services/payment.session.service.js. We mock it directly (as the previous
// suite did) so amount/ownership/mismatch edge cases are simple to drive,
// while the wallet-only path below exercises the real controller/model math
// with no mocking needed (walletUsed can fully cover the order total).
const consumeCheckoutVerificationTokenMock = jest.fn().mockResolvedValue(null);
const getCheckoutVerificationTokenMock = jest.fn();

jest.unstable_mockModule('../services/payment.session.service.js', () => ({
    consumeCheckoutVerificationToken: consumeCheckoutVerificationTokenMock,
    getCheckoutVerificationToken: getCheckoutVerificationTokenMock,
    saveCheckoutOrderSession: jest.fn(),
    getCheckoutOrderSession: jest.fn(),
    consumeCheckoutOrderSession: jest.fn(),
    issueCheckoutVerificationToken: jest.fn(),
    saveMembershipOrderSession: jest.fn(),
    getMembershipOrderSession: jest.fn(),
    consumeMembershipOrderSession: jest.fn(),
    saveWalletOrderSession: jest.fn(),
    getWalletOrderSession: jest.fn(),
    consumeWalletOrderSession: jest.fn(),
    saveWebhookConfirmation: jest.fn(),
    getWebhookConfirmation: jest.fn(),
    consumeWebhookConfirmation: jest.fn(),
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: Product } = await import('../models/Product.js');
const { default: User } = await import('../models/User.js');
const { default: jwt } = await import('jsonwebtoken');

const createProduct = (overrides = {}) =>
    Product.create({
        title: 'Test Item',
        description: 'Desc',
        category: 'test',
        price: 100,
        stock: 10,
        thumbnail: 'img.jpg',
        ...overrides,
    });

describe('Orders: create (online payment path)', () => {
    let token;
    let authUserId;
    let productId;

    beforeEach(async () => {
        consumeCheckoutVerificationTokenMock.mockReset().mockResolvedValue(null);
        getCheckoutVerificationTokenMock.mockReset();

        ({ token } = await registerAndLogin(request, app, {
            username: 'ordertester',
            email: 'order@test.com',
        }));
        authUserId = String(jwt.decode(token)?.userId);
        productId = (await createProduct()).id;
    });

    it('rejects order creation without authentication', async () => {
        const res = await request(app).post('/api/orders').send({});
        expect(res.statusCode).toBe(401);
    });

    it('creates an order once a valid payment verification token is presented', async () => {
        getCheckoutVerificationTokenMock.mockResolvedValueOnce({
            userId: authUserId,
            paymentId: 'pay_test_1',
            paymentOrderId: 'order_test_1',
            amountPaise: 25000, // 2 * 100 = 200 subtotal + 18%-inclusive tax + shipping -> matches totalPrice*100
        });

        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({
                products: [{ productId, name: 'Test Item', quantity: 2, price: 100 }],
                shippingAddress: '123 Fake St',
                paymentVerificationToken: 'verify_tok_1',
            });

        expect(res.statusCode).toBe(201);
        expect(res.body).toHaveProperty('_id');
        expect(res.body.paymentStatus).toBe('PAID');
        expect(res.body.paymentMethod).toBe('CARD');

        // Stock was decremented.
        const product = await Product.findById(productId);
        expect(product.stock).toBe(8);
    });

    it('rejects an online order missing the payment verification token', async () => {
        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({
                products: [{ productId, name: 'Test Item', quantity: 1, price: 100 }],
                shippingAddress: '123 Fake St',
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/payment verification token required/i);
    });

    it('rejects when the verified payment amount mismatches the server-computed total', async () => {
        getCheckoutVerificationTokenMock.mockResolvedValueOnce({
            userId: authUserId,
            paymentId: 'pay_bad_1',
            paymentOrderId: 'order_bad_1',
            amountPaise: 100, // intentionally wrong
        });
        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({
                products: [{ productId, name: 'Test Item', quantity: 1, price: 100 }],
                shippingAddress: '123 Fake St',
                paymentVerificationToken: 'verify_tok_mismatch',
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/payment amount mismatch/i);
    });

    it('rejects when the verification token does not belong to the requesting user', async () => {
        getCheckoutVerificationTokenMock.mockResolvedValueOnce({
            userId: '000000000000000000000000',
            paymentId: 'pay_other_user',
            paymentOrderId: 'order_other_user',
            amountPaise: 25000,
        });
        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({
                products: [{ productId, name: 'Test Item', quantity: 2, price: 100 }],
                shippingAddress: '123 Fake St',
                paymentVerificationToken: 'verify_tok_wrong_user',
            });
        expect(res.statusCode).toBe(403);
    });

    it('rejects checkout with an unknown/inactive product', async () => {
        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({
                products: [{ productId: '000000000000000000000000', name: 'Ghost', quantity: 1, price: 100 }],
                shippingAddress: '123 Fake St',
                paymentVerificationToken: 'verify_tok_ghost',
            });
        expect(res.statusCode).toBe(400);
    });

    it('rejects checkout requesting more quantity than is in stock', async () => {
        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({
                products: [{ productId, name: 'Test Item', quantity: 999, price: 100 }],
                shippingAddress: '123 Fake St',
                paymentVerificationToken: 'verify_tok_stock',
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/insufficient stock/i);
    });
});

describe('Orders: create (wallet-funded path — no gateway needed)', () => {
    let token;
    let username;
    let productId;

    beforeEach(async () => {
        const reg = await registerAndLogin(request, app, {
            username: 'walletorderer',
            email: 'walletorderer@test.com',
        });
        token = reg.token;
        username = reg.payload.username;
        productId = (await createProduct({ price: 100, stock: 5 })).id;
        // Fund the wallet generously so it fully covers the order total.
        await User.updateOne({ username }, { $set: { walletBalance: 1000 } });
    });

    it('places an order entirely on wallet balance with no payment token required', async () => {
        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({
                products: [{ productId, name: 'Test Item', quantity: 1, price: 100 }],
                shippingAddress: '123 Fake St',
                walletUsed: 1000,
            });

        expect(res.statusCode).toBe(201);
        expect(res.body.paymentMethod).toBe('WALLET');
        expect(res.body.paymentStatus).toBe('PAID');
        expect(res.body.walletUsed).toBeGreaterThan(0);

        const user = await User.findOne({ username });
        expect(user.walletBalance).toBeLessThan(1000);
        expect(user.walletTransactions.some((t) => t.type === 'DEBIT' && t.reason === 'Order payment')).toBe(true);
    });

    it('rejects when the requested wallet usage exceeds the actual balance', async () => {
        await User.updateOne({ username }, { $set: { walletBalance: 1 } });
        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({
                products: [{ productId, name: 'Test Item', quantity: 1, price: 100 }],
                shippingAddress: '123 Fake St',
                walletUsed: 1000,
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/insufficient wallet balance/i);
    });
});

describe('Orders: fetching own orders / access control', () => {
    let tokenA, usernameA, userIdA;
    let tokenB;
    let productId;
    let orderId;

    beforeEach(async () => {
        const a = await registerAndLogin(request, app, { username: 'ordera', email: 'ordera@test.com' });
        tokenA = a.token;
        usernameA = a.payload.username;
        userIdA = String(jwt.decode(tokenA)?.userId);

        const b = await registerAndLogin(request, app, { username: 'orderb', email: 'orderb@test.com' });
        tokenB = b.token;

        productId = (await createProduct()).id;
        await User.updateOne({ username: usernameA }, { $set: { walletBalance: 1000 } });

        const orderRes = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
                products: [{ productId, name: 'Test Item', quantity: 1, price: 100 }],
                shippingAddress: '123 Fake St',
                walletUsed: 1000,
            });
        orderId = orderRes.body._id;
    });

    it('rejects fetching orders without authentication', async () => {
        const res = await request(app).get('/api/profile/orders');
        expect(res.statusCode).toBe(401);
    });

    it("returns the authenticated user's own orders", async () => {
        const res = await request(app)
            .get('/api/profile/orders')
            .set('Authorization', `Bearer ${tokenA}`);
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.some((o) => String(o._id) === String(orderId))).toBe(true);
    });

    it("does not leak another user's orders in the list endpoint", async () => {
        const res = await request(app)
            .get('/api/profile/orders')
            .set('Authorization', `Bearer ${tokenB}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.some((o) => String(o._id) === String(orderId))).toBe(false);
    });

    it('returns a paginated shape from the paged endpoint', async () => {
        const res = await request(app)
            .get('/api/profile/orders/paged')
            .set('Authorization', `Bearer ${tokenA}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ page: 1 });
        expect(Array.isArray(res.body.items)).toBe(true);
        expect(res.body.total).toBeGreaterThanOrEqual(1);
    });

    it("rejects a different user from downloading another user's invoice", async () => {
        const res = await request(app)
            .get(`/api/orders/${orderId}/invoice`)
            .set('Authorization', `Bearer ${tokenB}`);
        expect(res.statusCode).toBe(403);
    });

    it('allows the owner to download their own invoice', async () => {
        const res = await request(app)
            .get(`/api/orders/${orderId}/invoice`)
            .set('Authorization', `Bearer ${tokenA}`);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/pdf/);
    });
});

describe('Orders: admin stage transitions', () => {
    let adminToken;
    let userToken;
    let username;
    let productId;
    let orderId;

    beforeEach(async () => {
        const admin = await registerAndLogin(request, app, { username: 'orderadmin', email: 'orderadmin@test.com' });
        await makeSuperAdmin(User, admin.payload.username);
        const adminLogin = await request(app)
            .post('/api/login')
            .send({ username: admin.payload.username, password: 'Password123!' });
        adminToken = adminLogin.body.token;

        const user = await registerAndLogin(request, app, { username: 'orderowner', email: 'orderowner@test.com' });
        userToken = user.token;
        username = user.payload.username;

        productId = (await createProduct()).id;
        await User.updateOne({ username }, { $set: { walletBalance: 1000 } });

        const orderRes = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${userToken}`)
            .send({
                products: [{ productId, name: 'Test Item', quantity: 1, price: 100 }],
                shippingAddress: '123 Fake St',
                walletUsed: 1000,
            });
        orderId = orderRes.body._id;
    });

    it('rejects stage updates from a non-admin user', async () => {
        const res = await request(app)
            .patch(`/api/admin/orders/${orderId}/stage`)
            .set('Authorization', `Bearer ${userToken}`)
            .send({ stage: 'CONFIRMED' });
        expect(res.statusCode).toBe(403);
    });

    it('rejects an invalid stage value', async () => {
        const res = await request(app)
            .patch(`/api/admin/orders/${orderId}/stage`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ stage: 'NOT_A_REAL_STAGE' });
        expect(res.statusCode).toBe(400);
    });

    it('lets an admin move an order through its stage pipeline', async () => {
        const res = await request(app)
            .patch(`/api/admin/orders/${orderId}/stage`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ stage: 'CONFIRMED' });
        expect(res.statusCode).toBe(200);
        expect(res.body.order.stage).toBe('CONFIRMED');
    });

    it('rejects updating a stage on an already-cancelled/delivered order', async () => {
        await request(app)
            .patch(`/api/admin/orders/${orderId}/stage`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ stage: 'CANCELLED' });

        const res = await request(app)
            .patch(`/api/admin/orders/${orderId}/stage`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ stage: 'CONFIRMED' });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/already completed or cancelled/i);
    });
});

describe('Orders: customer cancellation', () => {
    let tokenA, usernameA;
    let tokenB;
    let productId;
    let orderId;

    beforeEach(async () => {
        const a = await registerAndLogin(request, app, { username: 'cancela', email: 'cancela@test.com' });
        tokenA = a.token;
        usernameA = a.payload.username;

        const b = await registerAndLogin(request, app, { username: 'cancelb', email: 'cancelb@test.com' });
        tokenB = b.token;

        productId = (await createProduct({ stock: 5 })).id;
        await User.updateOne({ username: usernameA }, { $set: { walletBalance: 1000 } });

        const orderRes = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
                products: [{ productId, name: 'Test Item', quantity: 1, price: 100 }],
                shippingAddress: '123 Fake St',
                walletUsed: 1000,
            });
        orderId = orderRes.body._id;
    });

    it("rejects a different user cancelling someone else's order", async () => {
        const res = await request(app)
            .post(`/api/orders/${orderId}/cancel`)
            .set('Authorization', `Bearer ${tokenB}`)
            .send({ reason: 'not mine' });
        expect(res.statusCode).toBe(403);
    });

    it('rejects cancellation without a reason', async () => {
        const res = await request(app)
            .post(`/api/orders/${orderId}/cancel`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({});
        expect(res.statusCode).toBe(400);
    });

    it('cancels an order, restores stock, and refunds to wallet', async () => {
        const before = await Product.findById(productId);

        const res = await request(app)
            .post(`/api/orders/${orderId}/cancel`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ reason: 'changed my mind', refundMethod: 'WALLET' });

        expect(res.statusCode).toBe(200);
        expect(res.body.order.stage).toBe('CANCELLED');
        expect(res.body.order.refundStatus).toBe('COMPLETED');

        const after = await Product.findById(productId);
        expect(after.stock).toBe(before.stock + 1);

        const user = await User.findOne({ username: usernameA });
        expect(user.walletTransactions.some((t) => t.type === 'CREDIT' && t.reason === 'Order cancellation refund')).toBe(true);
    });

    it('rejects cancelling an order that is already cancelled', async () => {
        await request(app)
            .post(`/api/orders/${orderId}/cancel`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ reason: 'first cancel', refundMethod: 'WALLET' });

        const res = await request(app)
            .post(`/api/orders/${orderId}/cancel`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ reason: 'second cancel', refundMethod: 'WALLET' });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/cannot be cancelled/i);
    });
});
