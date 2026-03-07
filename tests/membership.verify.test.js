import { jest } from '@jest/globals';
import crypto from 'crypto';

process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test_secret';

const ordersCreateMock = jest.fn();
const ordersFetchMock = jest.fn();
const paymentsFetchMock = jest.fn();

class RazorpayMock {
    constructor() {
        this.orders = {
            create: ordersCreateMock,
            fetch: ordersFetchMock,
        };
        this.payments = {
            fetch: paymentsFetchMock,
        };
    }
}

const consumeMembershipOrderSessionMock = jest.fn();

const redisMock = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    scan: jest.fn().mockResolvedValue(["0", []]),
    on: jest.fn(),
    quit: jest.fn()
};

jest.unstable_mockModule('razorpay', () => ({
    default: RazorpayMock,
}));

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

jest.unstable_mockModule('../services/payment.session.service.js', () => ({
    consumeCheckoutVerificationToken: jest.fn(),
    getCheckoutVerificationToken: jest.fn(),
    saveCheckoutOrderSession: jest.fn(),
    getCheckoutOrderSession: jest.fn(),
    consumeCheckoutOrderSession: jest.fn(),
    issueCheckoutVerificationToken: jest.fn(),
    saveMembershipOrderSession: jest.fn(),
    getMembershipOrderSession: consumeMembershipOrderSessionMock,
    consumeMembershipOrderSession: consumeMembershipOrderSessionMock,
    saveWalletOrderSession: jest.fn(),
    getWalletOrderSession: jest.fn(),
    consumeWalletOrderSession: jest.fn(),
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: MembershipPlan } = await import('../models/MembershipPlan.js');
const { default: User } = await import('../models/User.js');

describe('Membership verify security', () => {
    let token;
    let userId;
    let planA;
    let planB;

    beforeEach(async () => {
        consumeMembershipOrderSessionMock.mockReset();
        ordersCreateMock.mockReset();
        ordersFetchMock.mockReset();
        paymentsFetchMock.mockReset();

        await request(app).post('/api/register').send({
            name: 'Membership User',
            username: 'memberuser',
            email: 'member@test.com',
            password: 'Password123!',
            confirmPassword: 'Password123!',
        });

        const loginRes = await request(app).post('/api/login').send({
            username: 'memberuser',
            password: 'Password123!',
        });
        token = loginRes.body.token;
        userId = String((await User.findOne({ username: 'memberuser' }))._id);

        planA = await MembershipPlan.create({
            name: 'Prime Monthly',
            slug: 'prime-monthly',
            durationDays: 30,
            price: 999,
            isActive: true,
        });
        planB = await MembershipPlan.create({
            name: 'Prime Yearly',
            slug: 'prime-yearly',
            durationDays: 365,
            price: 4999,
            isActive: true,
        });
    });

    const sign = (orderId, paymentId) =>
        crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${orderId}|${paymentId}`)
            .digest('hex');

    it('activates membership using server-side pending order session', async () => {
        const orderId = 'order_mem_1';
        const paymentId = 'pay_mem_1';
        const amountPaise = 99900;

        consumeMembershipOrderSessionMock.mockResolvedValueOnce({
            userId,
            planId: String(planA._id),
            amount: amountPaise,
            currency: 'INR',
        });

        ordersFetchMock.mockResolvedValueOnce({
            id: orderId,
            amount: amountPaise,
        });
        paymentsFetchMock.mockResolvedValueOnce({
            order_id: orderId,
            amount: amountPaise,
            status: 'captured',
        });

        const res = await request(app)
            .post('/api/membership/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({
                razorpay_order_id: orderId,
                razorpay_payment_id: paymentId,
                razorpay_signature: sign(orderId, paymentId),
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(String(res.body.membership.planId)).toBe(String(planA._id));
    });

    it('rejects membership verify when client planId mismatches pending order plan', async () => {
        const orderId = 'order_mem_2';
        const paymentId = 'pay_mem_2';
        const amountPaise = 99900;

        consumeMembershipOrderSessionMock.mockResolvedValueOnce({
            userId,
            planId: String(planA._id),
            amount: amountPaise,
            currency: 'INR',
        });

        ordersFetchMock.mockResolvedValueOnce({
            id: orderId,
            amount: amountPaise,
        });
        paymentsFetchMock.mockResolvedValueOnce({
            order_id: orderId,
            amount: amountPaise,
            status: 'captured',
        });

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
});
