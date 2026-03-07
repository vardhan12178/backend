import { jest } from '@jest/globals';

// Mock Redis
const redisMock = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    scan: jest.fn().mockResolvedValue(["0", []]),
    on: jest.fn(),
    quit: jest.fn()
};

const consumeCheckoutVerificationTokenMock = jest.fn().mockResolvedValue({
    userId: '000000000000000000000000',
    paymentId: 'pay_test_123',
    paymentOrderId: 'order_test_123',
    amountPaise: 25000,
});
const getCheckoutVerificationTokenMock = jest.fn().mockResolvedValue({
    userId: '000000000000000000000000',
    paymentId: 'pay_test_123',
    paymentOrderId: 'order_test_123',
    amountPaise: 25000,
});

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
}));

// Dynamic imports
const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: Product } = await import('../models/Product.js');
const { default: jwt } = await import('jsonwebtoken');

describe('Order API', () => {
    let token;
    let authUserId;
    let productId;

    beforeEach(async () => {
        consumeCheckoutVerificationTokenMock.mockReset();
        consumeCheckoutVerificationTokenMock.mockResolvedValue({
            userId: '000000000000000000000000',
            paymentId: 'pay_test_123',
            paymentOrderId: 'order_test_123',
            amountPaise: 25000,
        });
        getCheckoutVerificationTokenMock.mockReset();
        getCheckoutVerificationTokenMock.mockResolvedValue({
            userId: '000000000000000000000000',
            paymentId: 'pay_test_123',
            paymentOrderId: 'order_test_123',
            amountPaise: 25000,
        });

        // 1. Create User
        const userRes = await request(app)
            .post('/api/register')
            .send({
                name: 'Order Test User',
                username: 'ordertester',
                email: 'order@test.com',
                password: 'Password123!',
                confirmPassword: 'Password123!'
            });

        // 2. Login to get token
        const loginRes = await request(app)
            .post('/api/login')
            .send({ username: 'ordertester', password: 'Password123!' });

        token = loginRes.body.token;
        authUserId = String(jwt.decode(token)?.userId);

        // 3. Create Product
        const product = await Product.create({
            title: 'Test Item',
            description: 'Desc',
            category: 'test',
            price: 100,
            stock: 10,
            thumbnail: 'img.jpg',
            embedding: []
        });
        productId = product._id;
    });

    it('should create an order with valid token', async () => {
        const orderData = {
            products: [
                {
                    productId: productId,
                    name: 'Test Item',
                    quantity: 2,
                    price: 100
                }
            ],
            shippingAddress: '123 Fake St',
            paymentVerificationToken: 'verify_tok_1',
        };

        getCheckoutVerificationTokenMock.mockResolvedValueOnce({
            userId: authUserId,
            paymentId: 'pay_test_1',
            paymentOrderId: 'order_test_1',
            amountPaise: 25000,
        });

        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send(orderData);

        expect(res.statusCode).toEqual(201);
        expect(res.body).toHaveProperty('_id');
    });

    it('should reject order without token', async () => {
        const res = await request(app)
            .post('/api/orders')
            .send({});

        expect(res.statusCode).toEqual(401);
    });

    it('should reject online order when payment verification token is missing', async () => {
        const orderData = {
            products: [
                {
                    productId: productId,
                    name: 'Test Item',
                    quantity: 1,
                    price: 100
                }
            ],
            shippingAddress: '123 Fake St',
        };

        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send(orderData);

        expect(res.statusCode).toEqual(400);
        expect(res.body.message).toMatch(/payment verification token required/i);
    });

    it('should reject order when verified payment amount mismatches server total', async () => {
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
                products: [
                    {
                        productId,
                        name: 'Test Item',
                        quantity: 1,
                        price: 100
                    }
                ],
                shippingAddress: '123 Fake St',
                paymentVerificationToken: 'verify_tok_mismatch',
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/payment amount mismatch/i);
    });
});
