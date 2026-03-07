import { jest } from '@jest/globals';

const redisMock = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    scan: jest.fn().mockResolvedValue(["0", []]),
    on: jest.fn(),
    quit: jest.fn()
};

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

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');

describe('Coupon API contract', () => {
    let adminToken;
    let userToken;

    beforeEach(async () => {
        await request(app).post('/api/register').send({
            name: 'Coupon Admin',
            username: 'couponadmin',
            email: 'couponadmin@test.com',
            password: 'Password123!',
            confirmPassword: 'Password123!',
        });
        await User.updateOne(
            { username: 'couponadmin' },
            { $set: { roles: ['admin'] } }
        );
        const adminLogin = await request(app).post('/api/login').send({
            username: 'couponadmin',
            password: 'Password123!',
        });
        adminToken = adminLogin.body.token;

        await request(app).post('/api/register').send({
            name: 'Coupon User',
            username: 'couponuser',
            email: 'couponuser@test.com',
            password: 'Password123!',
            confirmPassword: 'Password123!',
        });
        const userLogin = await request(app).post('/api/login').send({
            username: 'couponuser',
            password: 'Password123!',
        });
        userToken = userLogin.body.token;
    });

    it('creates coupon with type/value contract and validates using subtotal', async () => {
        const createRes = await request(app)
            .post('/api/coupons')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                code: 'SAVE10',
                type: 'percent',
                value: 10,
                validTo: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                isPublic: true,
            });

        expect(createRes.statusCode).toBe(201);

        const validateRes = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({
                code: 'SAVE10',
                subtotal: 1000,
            });

        expect(validateRes.statusCode).toBe(200);
        expect(validateRes.body.valid).toBe(true);
        expect(validateRes.body.discount).toBe(100);
    });

    it('rejects legacy create payload keys discountType/discountValue', async () => {
        const res = await request(app)
            .post('/api/coupons')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                code: 'OLD10',
                discountType: 'percentage',
                discountValue: 10,
                validTo: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            });

        expect(res.statusCode).toBe(400);
    });

    it('rejects coupon validation payload when subtotal is missing', async () => {
        const createRes = await request(app)
            .post('/api/coupons')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                code: 'SAVE20',
                type: 'percent',
                value: 20,
                validTo: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                isPublic: true,
            });
        expect(createRes.statusCode).toBe(201);

        const validateRes = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({
                code: 'SAVE20',
                total: 1000,
            });

        expect(validateRes.statusCode).toBe(400);
    });
});
