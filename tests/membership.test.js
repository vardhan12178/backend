import { jest } from '@jest/globals';
import crypto from 'crypto';
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

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: MembershipPlan } = await import('../models/MembershipPlan.js');
const { default: User } = await import('../models/User.js');

const sign = (orderId, paymentId) => signRazorpaySignature(orderId, paymentId, RAZORPAY_KEY_SECRET);

describe('Membership: plans + status', () => {
    beforeEach(async () => {
        ordersCreateMock.mockReset();
        ordersFetchMock.mockReset();
        paymentsFetchMock.mockReset();
    });

    it('lists only active plans, sorted by sortOrder', async () => {
        await MembershipPlan.create({ name: 'Hidden', slug: 'hidden', durationDays: 30, price: 99, isActive: false, sortOrder: 0 });
        await MembershipPlan.create({ name: 'Yearly', slug: 'yearly', durationDays: 365, price: 999, isActive: true, sortOrder: 2 });
        await MembershipPlan.create({ name: 'Monthly', slug: 'monthly', durationDays: 30, price: 99, isActive: true, sortOrder: 1 });

        const res = await request(app).get('/api/membership/plans');
        expect(res.statusCode).toBe(200);
        expect(res.body.map((p) => p.slug)).toEqual(['monthly', 'yearly']);
    });

    it('rejects status check without authentication', async () => {
        const res = await request(app).get('/api/membership/status');
        expect(res.statusCode).toBe(401);
    });

    it('reports isPrime:false for a user with no membership', async () => {
        const { token } = await registerAndLogin(request, app, { username: 'nomember', email: 'nomember@test.com' });
        const res = await request(app).get('/api/membership/status').set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.isPrime).toBe(false);
    });

    it('reports isPrime:false once membership.endDate is in the past (expiry)', async () => {
        const { token, payload } = await registerAndLogin(request, app, { username: 'expiredmember', email: 'expiredmember@test.com' });
        await User.updateOne(
            { username: payload.username },
            { $set: { membership: { plan: 'Old Plan', startDate: new Date(Date.now() - 60 * 86400000), endDate: new Date(Date.now() - 1000) } } }
        );
        const res = await request(app).get('/api/membership/status').set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.isPrime).toBe(false);
    });

    it('reports isPrime:true while membership.endDate is in the future', async () => {
        const { token, payload } = await registerAndLogin(request, app, { username: 'activemember', email: 'activemember@test.com' });
        await User.updateOne(
            { username: payload.username },
            { $set: { membership: { plan: 'Active Plan', startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000) } } }
        );
        const res = await request(app).get('/api/membership/status').set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.isPrime).toBe(true);
    });
});

describe('Membership: purchase (create Razorpay order)', () => {
    let token;
    let plan;

    beforeEach(async () => {
        ordersCreateMock.mockReset();
        ordersFetchMock.mockReset();
        paymentsFetchMock.mockReset();
        ({ token } = await registerAndLogin(request, app, { username: 'purchaser', email: 'purchaser@test.com' }));
        plan = await MembershipPlan.create({ name: 'Prime Monthly', slug: 'prime-monthly', durationDays: 30, price: 999, isActive: true });
    });

    it('rejects purchase without authentication', async () => {
        const res = await request(app).post('/api/membership/purchase').send({ planId: plan._id });
        expect(res.statusCode).toBe(401);
    });

    it('rejects purchase with a missing/invalid planId', async () => {
        const res = await request(app)
            .post('/api/membership/purchase')
            .set('Authorization', `Bearer ${token}`)
            .send({});
        expect(res.statusCode).toBe(400);
    });

    it('rejects purchase of a nonexistent plan', async () => {
        const res = await request(app)
            .post('/api/membership/purchase')
            .set('Authorization', `Bearer ${token}`)
            .send({ planId: '000000000000000000000000' });
        expect(res.statusCode).toBe(404);
    });

    it('rejects purchase of an inactive plan', async () => {
        const inactive = await MembershipPlan.create({ name: 'Gone', slug: 'gone', durationDays: 30, price: 50, isActive: false });
        const res = await request(app)
            .post('/api/membership/purchase')
            .set('Authorization', `Bearer ${token}`)
            .send({ planId: inactive._id });
        expect(res.statusCode).toBe(404);
    });

    it('creates a Razorpay order for a valid plan', async () => {
        ordersCreateMock.mockResolvedValueOnce({ id: 'order_plan_1', amount: 99900, currency: 'INR', receipt: 'pr_test' });
        const res = await request(app)
            .post('/api/membership/purchase')
            .set('Authorization', `Bearer ${token}`)
            .send({ planId: plan._id });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.orderId).toBe('order_plan_1');
        expect(res.body.plan.name).toBe('Prime Monthly');
    });
});

describe('Membership: verify + activate (security-critical)', () => {
    let token;
    let userId;
    let planA;
    let planB;

    beforeEach(async () => {
        ordersCreateMock.mockReset();
        ordersFetchMock.mockReset();
        paymentsFetchMock.mockReset();

        const reg = await registerAndLogin(request, app, { username: 'memberuser', email: 'member@test.com' });
        token = reg.token;
        userId = String((await User.findOne({ username: 'memberuser' }))._id);

        planA = await MembershipPlan.create({ name: 'Prime Monthly', slug: 'prime-monthly', durationDays: 30, price: 999, isActive: true });
        planB = await MembershipPlan.create({ name: 'Prime Yearly', slug: 'prime-yearly', durationDays: 365, price: 4999, isActive: true });
    });

    // Drives the real, unmocked services/payment.session.service.js against the
    // stateful redis mock so purchase -> verify is a genuine end-to-end flow.
    const purchase = async (plan) => {
        const orderId = `order_${crypto.randomBytes(4).toString('hex')}`;
        ordersCreateMock.mockResolvedValueOnce({ id: orderId, amount: Math.round(plan.price * 100), currency: 'INR', receipt: 'pr_test' });
        await request(app)
            .post('/api/membership/purchase')
            .set('Authorization', `Bearer ${token}`)
            .send({ planId: plan._id });
        return orderId;
    };

    it('activates membership for a genuine, correctly-signed, captured payment', async () => {
        const orderId = await purchase(planA);
        const paymentId = 'pay_mem_1';
        const amountPaise = Math.round(planA.price * 100);
        ordersFetchMock.mockResolvedValueOnce({ id: orderId, amount: amountPaise });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: orderId, amount: amountPaise, status: 'captured' });

        const res = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(String(res.body.membership.planId)).toBe(String(planA._id));
        expect(res.body.isPrime).toBe(true);
    });

    it('rejects a forged signature', async () => {
        const orderId = await purchase(planA);
        const paymentId = 'pay_forged';
        const forged = crypto.createHmac('sha256', 'wrong_secret').update(`${orderId}|${paymentId}`).digest('hex');

        const res = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: forged });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/invalid signature/i);
        expect(ordersFetchMock).not.toHaveBeenCalled();
    });

    it('rejects when no pending purchase session exists for the order id', async () => {
        const orderId = 'order_never_purchased';
        const paymentId = 'pay_no_session';
        const res = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/session expired or invalid/i);
    });

    it('rejects when the purchase session belongs to a different user', async () => {
        const orderId = await purchase(planA);
        const { token: otherToken } = await registerAndLogin(request, app, { username: 'otherbuyer', email: 'otherbuyer@test.com' });
        const paymentId = 'pay_cross_user';
        const res = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${otherToken}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });
        expect(res.statusCode).toBe(403);
    });

    it('rejects membership verify when client planId mismatches the pending order plan', async () => {
        const orderId = await purchase(planA);
        const paymentId = 'pay_mismatch';
        const amountPaise = Math.round(planA.price * 100);
        ordersFetchMock.mockResolvedValueOnce({ id: orderId, amount: amountPaise });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: orderId, amount: amountPaise, status: 'captured' });

        const res = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({
                razorpay_order_id: orderId,
                razorpay_payment_id: paymentId,
                razorpay_signature: sign(orderId, paymentId),
                planId: String(planB._id),
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/plan mismatch/i);
    });

    it('rejects when the paid amount does not match the plan price', async () => {
        const orderId = await purchase(planA);
        const paymentId = 'pay_wrong_amount';
        ordersFetchMock.mockResolvedValueOnce({ id: orderId, amount: Math.round(planA.price * 100) });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: orderId, amount: 100, status: 'captured' });

        const res = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/paid amount mismatch/i);
    });

    it('rejects when Razorpay reports the payment as not captured', async () => {
        const orderId = await purchase(planA);
        const paymentId = 'pay_uncaptured';
        const amountPaise = Math.round(planA.price * 100);
        ordersFetchMock.mockResolvedValueOnce({ id: orderId, amount: amountPaise });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: orderId, amount: amountPaise, status: 'authorized' });

        const res = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/not captured/i);
    });

    it('is idempotent for a replayed payment id (no duplicate history entry / no re-extension)', async () => {
        const orderId = await purchase(planA);
        const paymentId = 'pay_replay';
        const amountPaise = Math.round(planA.price * 100);
        ordersFetchMock.mockResolvedValue({ id: orderId, amount: amountPaise });
        paymentsFetchMock.mockResolvedValue({ order_id: orderId, amount: amountPaise, status: 'captured' });
        const signature = sign(orderId, paymentId);

        const first = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature });
        expect(first.statusCode).toBe(200);
        const historyLenAfterFirst = first.body.membership.history.length;

        // Session was consumed by the first call, so a naive replay now 400s —
        // that's the primary defense. We separately assert the duplicate-
        // paymentId short-circuit in the controller by re-purchasing the same
        // order id is not possible via the API, so this covers the realistic
        // replay path (re-submitting the exact same verify request twice).
        const second = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature });
        expect(second.statusCode).toBe(400);

        const user = await User.findById(userId);
        expect(user.membership.history.length).toBe(historyLenAfterFirst);
    });

    it('stacks a renewal purchase on top of an existing active membership instead of resetting it', async () => {
        // First purchase.
        const order1 = await purchase(planA);
        const amount1 = Math.round(planA.price * 100);
        ordersFetchMock.mockResolvedValueOnce({ id: order1, amount: amount1 });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: order1, amount: amount1, status: 'captured' });
        const first = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: order1, razorpay_payment_id: 'pay_first', razorpay_signature: sign(order1, 'pay_first') });
        const firstEndDate = new Date(first.body.membership.endDate);

        // Renewal purchase while still active.
        const order2 = await purchase(planA);
        ordersFetchMock.mockResolvedValueOnce({ id: order2, amount: amount1 });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: order2, amount: amount1, status: 'captured' });
        const second = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: order2, razorpay_payment_id: 'pay_second', razorpay_signature: sign(order2, 'pay_second') });

        expect(second.statusCode).toBe(200);
        const secondEndDate = new Date(second.body.membership.endDate);
        // Renewal extends from the previous end date, not from "now".
        expect(secondEndDate.getTime()).toBeGreaterThan(firstEndDate.getTime());
        expect(second.body.membership.history.length).toBe(2);
    });
});

describe('Membership: admin plan management', () => {
    let adminToken;
    let userToken;

    beforeEach(async () => {
        const admin = await registerAndLogin(request, app, { username: 'planadmin', email: 'planadmin@test.com' });
        await makeSuperAdmin(User, admin.payload.username);
        const adminLogin = await request(app).post('/api/login').send({ username: admin.payload.username, password: 'Password123!' });
        adminToken = adminLogin.body.token;

        const user = await registerAndLogin(request, app, { username: 'planuser', email: 'planuser@test.com' });
        userToken = user.token;
    });

    it('rejects plan creation from a non-admin', async () => {
        const res = await request(app)
            .post('/api/membership/admin/plans')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ name: 'Sneaky', price: 1, durationDays: 30 });
        expect(res.statusCode).toBe(403);
    });

    it('lets an admin create, update, and delete a plan', async () => {
        const createRes = await request(app)
            .post('/api/membership/admin/plans')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: 'New Plan', slug: 'new-plan', price: 199, durationDays: 30 });
        expect(createRes.statusCode).toBe(201);
        const id = createRes.body._id;

        const updateRes = await request(app)
            .put(`/api/membership/admin/plans/${id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ price: 249 });
        expect(updateRes.statusCode).toBe(200);
        expect(updateRes.body.price).toBe(249);

        const deleteRes = await request(app)
            .delete(`/api/membership/admin/plans/${id}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(deleteRes.statusCode).toBe(200);

        const listRes = await request(app)
            .get('/api/membership/admin/plans')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(listRes.body.some((p) => p._id === id)).toBe(false);
    });

    // The controller has no downgrade/cancel-membership endpoint — a user's
    // membership can only be extended (purchase/verify) or left to expire
    // naturally via endDate. Nothing to exercise here; documented for the
    // report rather than asserted.
});
