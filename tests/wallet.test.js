import { jest } from '@jest/globals';
import crypto from 'crypto';
import { createStatefulRedisMock, registerAndLogin, signRazorpaySignature } from './helpers.js';

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
const { default: User } = await import('../models/User.js');
const { default: Product } = await import('../models/Product.js');
const { saveWalletOrderSession } = await import('../services/payment.session.service.js');

const sign = (orderId, paymentId) => signRazorpaySignature(orderId, paymentId, RAZORPAY_KEY_SECRET);

describe('Wallet: balance + transaction history', () => {
    beforeEach(() => {
        ordersCreateMock.mockReset();
        ordersFetchMock.mockReset();
        paymentsFetchMock.mockReset();
    });

    it('rejects fetching the wallet without authentication', async () => {
        const res = await request(app).get('/api/wallet');
        expect(res.statusCode).toBe(401);
    });

    it('returns a zero balance and empty history for a new user', async () => {
        const { token } = await registerAndLogin(request, app, { username: 'freshwallet', email: 'freshwallet@test.com' });
        const res = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.balance).toBe(0);
        expect(res.body.transactions).toEqual([]);
    });

    it('exposes wallet transaction history, most recent first', async () => {
        const { token, payload } = await registerAndLogin(request, app, { username: 'historywallet', email: 'historywallet@test.com' });
        await User.updateOne(
            { username: payload.username },
            {
                $set: {
                    walletBalance: 150,
                    walletTransactions: [
                        { type: 'CREDIT', amount: 100, reason: 'Wallet top-up', createdAt: new Date(Date.now() - 2000) },
                        { type: 'CREDIT', amount: 50, reason: 'Refund', createdAt: new Date() },
                    ],
                },
            }
        );
        const res = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.balance).toBe(150);
        expect(res.body.transactions).toHaveLength(2);
        // getWallet reverses so the most recently pushed entry comes first.
        expect(res.body.transactions[0].reason).toBe('Refund');
    });
});

describe('Wallet: top-up order creation', () => {
    let token;

    beforeEach(async () => {
        ordersCreateMock.mockReset();
        ordersFetchMock.mockReset();
        paymentsFetchMock.mockReset();
        ({ token } = await registerAndLogin(request, app, { username: 'topupuser', email: 'topupuser@test.com' }));
    });

    it('rejects top-up order creation without authentication', async () => {
        const res = await request(app).post('/api/wallet/topup').send({ amount: 100 });
        expect(res.statusCode).toBe(401);
    });

    it('rejects a zero/negative top-up amount', async () => {
        const res = await request(app).post('/api/wallet/topup').set('Authorization', `Bearer ${token}`).send({ amount: 0 });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a top-up amount above the 100000 cap', async () => {
        const res = await request(app).post('/api/wallet/topup').set('Authorization', `Bearer ${token}`).send({ amount: 200000 });
        expect(res.statusCode).toBe(400);
    });

    it('creates a Razorpay order for a valid top-up amount', async () => {
        ordersCreateMock.mockResolvedValueOnce({ id: 'order_topup_1', amount: 50000, currency: 'INR', receipt: 'wallet_test' });
        const res = await request(app).post('/api/wallet/topup').set('Authorization', `Bearer ${token}`).send({ amount: 500 });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.orderId).toBe('order_topup_1');
    });
});

describe('Wallet: verify top-up (security-critical) + credit', () => {
    let token;
    let username;

    beforeEach(async () => {
        ordersCreateMock.mockReset();
        ordersFetchMock.mockReset();
        paymentsFetchMock.mockReset();
        const reg = await registerAndLogin(request, app, { username: 'verifywallet', email: 'verifywallet@test.com' });
        token = reg.token;
        username = reg.payload.username;
    });

    const topup = async (amountRupees) => {
        const orderId = `order_${crypto.randomBytes(4).toString('hex')}`;
        ordersCreateMock.mockResolvedValueOnce({ id: orderId, amount: Math.round(amountRupees * 100), currency: 'INR', receipt: 'wallet_test' });
        await request(app).post('/api/wallet/topup').set('Authorization', `Bearer ${token}`).send({ amount: amountRupees });
        return orderId;
    };

    it('rejects a forged signature', async () => {
        const orderId = await topup(500);
        const paymentId = 'pay_forged';
        const forged = crypto.createHmac('sha256', 'wrong_secret').update(`${orderId}|${paymentId}`).digest('hex');
        const res = await request(app)
            .post('/api/wallet/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: forged });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/invalid signature/i);
        expect(ordersFetchMock).not.toHaveBeenCalled();
    });

    it('rejects when no pending top-up session exists', async () => {
        const orderId = 'order_no_session';
        const paymentId = 'pay_no_session';
        const res = await request(app)
            .post('/api/wallet/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/session expired or invalid/i);
    });

    it('rejects when the top-up session belongs to a different user', async () => {
        const orderId = await topup(500);
        const { token: otherToken } = await registerAndLogin(request, app, { username: 'otherwallet', email: 'otherwallet@test.com' });
        const paymentId = 'pay_cross_user';
        const res = await request(app)
            .post('/api/wallet/verify')
            .set('Authorization', `Bearer ${otherToken}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });
        expect(res.statusCode).toBe(403);
    });

    it('rejects when Razorpay reports the payment as not captured', async () => {
        const orderId = await topup(500);
        const paymentId = 'pay_uncaptured';
        ordersFetchMock.mockResolvedValueOnce({ id: orderId, amount: 50000 });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: orderId, amount: 50000, status: 'authorized' });
        const res = await request(app)
            .post('/api/wallet/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/not captured/i);
    });

    it('credits the wallet for a genuine, correctly-signed, captured top-up', async () => {
        const orderId = await topup(500);
        const paymentId = 'pay_genuine';
        ordersFetchMock.mockResolvedValueOnce({ id: orderId, amount: 50000 });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: orderId, amount: 50000, status: 'captured' });

        const res = await request(app)
            .post('/api/wallet/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.balance).toBe(500);

        const walletRes = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
        expect(walletRes.body.balance).toBe(500);
        expect(walletRes.body.transactions[0]).toMatchObject({ type: 'CREDIT', amount: 500, reason: 'Wallet top-up' });
    });

    it('does not double-credit a payment id that has already been recorded', async () => {
        // Simulate a payment that was already credited once (e.g. via an
        // earlier verify call), then re-present a session for the SAME
        // paymentId (e.g. a stray webhook-driven session) — the controller's
        // duplicate-paymentId guard must stop a second credit.
        await User.updateOne(
            { username },
            {
                $set: { walletBalance: 500 },
                $push: { walletTransactions: { type: 'CREDIT', amount: 500, reason: 'Wallet top-up', paymentId: 'pay_dup' } },
            }
        );
        const orderId = `order_${crypto.randomBytes(4).toString('hex')}`;
        await saveWalletOrderSession(orderId, {
            userId: String((await User.findOne({ username }))._id),
            amount: 50000,
            currency: 'INR',
            receipt: 'wallet_test',
        });
        ordersFetchMock.mockResolvedValueOnce({ id: orderId, amount: 50000 });
        paymentsFetchMock.mockResolvedValueOnce({ order_id: orderId, amount: 50000, status: 'captured' });

        const res = await request(app)
            .post('/api/wallet/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ razorpay_order_id: orderId, razorpay_payment_id: 'pay_dup', razorpay_signature: sign(orderId, 'pay_dup') });

        expect(res.statusCode).toBe(200);
        expect(res.body.balance).toBe(500); // unchanged, not 1000
    });
});

describe('Wallet: debit via order checkout (walletUsed)', () => {
    it('debits the wallet balance and records a DEBIT transaction when used to pay for an order', async () => {
        const { token, payload } = await registerAndLogin(request, app, { username: 'debitwallet', email: 'debitwallet@test.com' });
        await User.updateOne({ username: payload.username }, { $set: { walletBalance: 1000 } });
        const product = await Product.create({
            title: 'Wallet Item',
            description: 'Desc',
            category: 'test',
            price: 100,
            stock: 5,
            thumbnail: 'img.jpg',
        });

        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({
                products: [{ productId: product.id, name: 'Wallet Item', quantity: 1, price: 100 }],
                shippingAddress: '123 Fake St',
                walletUsed: 1000,
            });
        expect(res.statusCode).toBe(201);

        const walletRes = await request(app).get('/api/wallet').set('Authorization', `Bearer ${token}`);
        expect(walletRes.body.balance).toBeLessThan(1000);
        expect(walletRes.body.transactions.some((t) => t.type === 'DEBIT' && t.reason === 'Order payment')).toBe(true);
    });

    // There is no dedicated wallet "debit" endpoint — debits only ever
    // happen as a side effect of order checkout (order.controller.js), which
    // is also where the "insufficient balance" rejection lives (walletUsed >
    // walletBalance -> 400 "Insufficient wallet balance"). That path is
    // covered in tests/orders.test.js rather than duplicated here.
});
