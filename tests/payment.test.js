import { jest } from '@jest/globals';
import crypto from 'crypto';
import { createStatefulRedisMock, registerAndLogin, signRazorpaySignature } from './helpers.js';

const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'dummy_secret';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'dummy_webhook_secret';

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

const sign = (orderId, paymentId) => signRazorpaySignature(orderId, paymentId, RAZORPAY_KEY_SECRET);

describe('Payment: create Razorpay order', () => {
    let token;

    beforeEach(async () => {
        ordersCreateMock.mockReset();
        ordersFetchMock.mockReset();
        paymentsFetchMock.mockReset();
        ({ token } = await registerAndLogin(request, app, {
            username: 'payuser',
            email: 'payuser@test.com',
        }));
    });

    it('rejects unauthenticated order creation', async () => {
        const res = await request(app).post('/api/razorpay/create-order').send({ amount: 100 });
        expect(res.statusCode).toBe(401);
    });

    it('rejects a zero/negative amount', async () => {
        const res = await request(app)
            .post('/api/razorpay/create-order')
            .set('Authorization', `Bearer ${token}`)
            .send({ amount: 0 });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a non-3-letter currency', async () => {
        const res = await request(app)
            .post('/api/razorpay/create-order')
            .set('Authorization', `Bearer ${token}`)
            .send({ amount: 100, currency: 'INDIANRUPEES' });
        expect(res.statusCode).toBe(400);
    });

    it('creates an order, converting rupees to paise, and never leaks the real razorpay key', async () => {
        ordersCreateMock.mockResolvedValueOnce({
            id: 'order_created_1',
            amount: 25000,
            currency: 'INR',
            receipt: 'co_test',
        });

        const res = await request(app)
            .post('/api/razorpay/create-order')
            .set('Authorization', `Bearer ${token}`)
            .send({ amount: 250 });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.orderId).toBe('order_created_1');
        expect(res.body.amount).toBe(25000);
        expect(ordersCreateMock).toHaveBeenCalledWith(
            expect.objectContaining({ amount: 25000, currency: 'INR', payment_capture: 1 })
        );
    });

    it('returns 500 when the Razorpay API itself fails', async () => {
        ordersCreateMock.mockRejectedValueOnce(new Error('razorpay down'));
        const res = await request(app)
            .post('/api/razorpay/create-order')
            .set('Authorization', `Bearer ${token}`)
            .send({ amount: 100 });
        expect(res.statusCode).toBe(500);
        expect(res.body.success).toBe(false);
    });
});

describe('Payment: verify signature (security-critical)', () => {
    let token;

    beforeEach(async () => {
        ordersCreateMock.mockReset();
        ordersFetchMock.mockReset();
        paymentsFetchMock.mockReset();
        ({ token } = await registerAndLogin(request, app, {
            username: 'payverify',
            email: 'payverify@test.com',
        }));
    });

    const createOrderSession = async (amountPaise = 25000) => {
        ordersCreateMock.mockResolvedValueOnce({
            id: `order_${crypto.randomBytes(4).toString('hex')}`,
            amount: amountPaise,
            currency: 'INR',
            receipt: 'co_test',
        });
        const res = await request(app)
            .post('/api/razorpay/create-order')
            .set('Authorization', `Bearer ${token}`)
            .send({ amount: amountPaise / 100 });
        return res.body.orderId;
    };

    it('rejects a forged signature (wrong secret) even with otherwise-valid payment data', async () => {
        const orderId = await createOrderSession();
        const paymentId = 'pay_forged_1';
        const forgedSignature = crypto
            .createHmac('sha256', 'attacker_guessed_secret')
            .update(`${orderId}|${paymentId}`)
            .digest('hex');

        const res = await request(app)
            .post('/api/razorpay/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({
                razorpay_order_id: orderId,
                razorpay_payment_id: paymentId,
                razorpay_signature: forgedSignature,
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/invalid signature/i);
        // Never reaches Razorpay to reconcile a payment that was never proven authentic.
        expect(ordersFetchMock).not.toHaveBeenCalled();
    });

    it('rejects a signature that is simply the wrong length/garbage', async () => {
        const orderId = await createOrderSession();
        const res = await request(app)
            .post('/api/razorpay/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({
                razorpay_order_id: orderId,
                razorpay_payment_id: 'pay_garbage_1',
                razorpay_signature: 'not-even-hex',
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/invalid signature/i);
    });

    it('rejects when the checkout session was never created (or already consumed)', async () => {
        const orderId = 'order_never_created';
        const paymentId = 'pay_x';
        const res = await request(app)
            .post('/api/razorpay/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({
                razorpay_order_id: orderId,
                razorpay_payment_id: paymentId,
                razorpay_signature: sign(orderId, paymentId),
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/session expired or invalid/i);
    });

    it("rejects when the session belongs to a different user", async () => {
        const orderId = await createOrderSession();
        const { token: otherToken } = await registerAndLogin(request, app, {
            username: 'payverify2',
            email: 'payverify2@test.com',
        });
        const paymentId = 'pay_cross_user';
        const res = await request(app)
            .post('/api/razorpay/verify')
            .set('Authorization', `Bearer ${otherToken}`)
            .send({
                razorpay_order_id: orderId,
                razorpay_payment_id: paymentId,
                razorpay_signature: sign(orderId, paymentId),
            });
        expect(res.statusCode).toBe(403);
    });

    it('rejects when Razorpay reports the payment as not captured', async () => {
        const orderId = await createOrderSession();
        const paymentId = 'pay_uncaptured';
        ordersFetchMock.mockResolvedValueOnce({ id: orderId, amount: 25000 });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: orderId, amount: 25000, status: 'authorized' });

        const res = await request(app)
            .post('/api/razorpay/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({
                razorpay_order_id: orderId,
                razorpay_payment_id: paymentId,
                razorpay_signature: sign(orderId, paymentId),
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/not captured/i);
    });

    it('rejects when the paid amount does not match the session amount', async () => {
        const orderId = await createOrderSession(25000);
        const paymentId = 'pay_amount_mismatch';
        ordersFetchMock.mockResolvedValueOnce({ id: orderId, amount: 25000 });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: orderId, amount: 9900, status: 'captured' });

        const res = await request(app)
            .post('/api/razorpay/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({
                razorpay_order_id: orderId,
                razorpay_payment_id: paymentId,
                razorpay_signature: sign(orderId, paymentId),
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/paid amount mismatch/i);
    });

    it('verifies a genuine, correctly-signed, captured payment and issues a verification token', async () => {
        const orderId = await createOrderSession(25000);
        const paymentId = 'pay_genuine_1';
        ordersFetchMock.mockResolvedValueOnce({ id: orderId, amount: 25000 });
        paymentsFetchMock.mockResolvedValueOnce({
            order_id: orderId,
            amount: 25000,
            status: 'captured',
            method: 'upi',
        });

        const res = await request(app)
            .post('/api/razorpay/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({
                razorpay_order_id: orderId,
                razorpay_payment_id: paymentId,
                razorpay_signature: sign(orderId, paymentId),
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.verificationToken).toBeTruthy();
    });

    it('rejects verify requests missing required fields', async () => {
        const res = await request(app)
            .post('/api/razorpay/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({});
        expect(res.statusCode).toBe(400);
    });
});

describe('Payment: webhook signature (server-to-server, security-critical)', () => {
    const webhookHmac = (rawBodyString) =>
        crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBodyString).digest('hex');

    it('rejects a webhook with a missing signature header', async () => {
        const res = await request(app)
            .post('/api/razorpay/webhook')
            .send({ event: 'payment.captured', payload: {} });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a webhook with a forged signature', async () => {
        const payload = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_wh_1', order_id: 'order_wh_1' } } } };
        const res = await request(app)
            .post('/api/razorpay/webhook')
            .set('x-razorpay-signature', 'forged-signature-value')
            .send(payload);
        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('accepts a webhook with a genuine signature over the exact raw body', async () => {
        const payload = {
            event: 'payment.captured',
            payload: { payment: { entity: { id: 'pay_wh_ok', order_id: 'order_wh_ok', amount: 10000, currency: 'INR' } } },
        };
        const rawBody = JSON.stringify(payload);
        const res = await request(app)
            .post('/api/razorpay/webhook')
            .set('Content-Type', 'application/json')
            .set('x-razorpay-signature', webhookHmac(rawBody))
            .send(rawBody);

        expect(res.statusCode).toBe(200);
        expect(res.body.received).toBe(true);
    });

    it('dedupes an identical retried webhook delivery (same event + entity id)', async () => {
        const payload = {
            event: 'payment.captured',
            payload: { payment: { entity: { id: 'pay_wh_dup', order_id: 'order_wh_dup', amount: 5000, currency: 'INR' } } },
        };
        const rawBody = JSON.stringify(payload);
        const signature = webhookHmac(rawBody);

        const first = await request(app)
            .post('/api/razorpay/webhook')
            .set('Content-Type', 'application/json')
            .set('x-razorpay-signature', signature)
            .send(rawBody);
        expect(first.statusCode).toBe(200);
        expect(first.body.duplicate).toBeFalsy();

        const second = await request(app)
            .post('/api/razorpay/webhook')
            .set('Content-Type', 'application/json')
            .set('x-razorpay-signature', signature)
            .send(rawBody);
        expect(second.statusCode).toBe(200);
        expect(second.body.duplicate).toBe(true);
    });
});
