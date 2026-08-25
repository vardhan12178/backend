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

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
const { default: Coupon } = await import('../models/Coupon.js');

const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

describe('Coupons: admin CRUD (permission-gated)', () => {
    let adminToken;
    let userToken;

    beforeEach(async () => {
        const admin = await registerAndLogin(request, app, { username: 'couponadmin', email: 'couponadmin@test.com' });
        // requirePermission("coupons", "write") requires either super_admin or an
        // explicit permissions.coupons="write" grant — plain roles:["admin"] is
        // NOT enough. The previous test suite assumed otherwise and would have
        // silently 403'd here once permission enforcement was actually exercised.
        await makeSuperAdmin(User, admin.payload.username);
        const adminLogin = await request(app)
            .post('/api/login')
            .send({ username: admin.payload.username, password: 'Password123!' });
        adminToken = adminLogin.body.token;

        const user = await registerAndLogin(request, app, { username: 'couponuser', email: 'couponuser@test.com' });
        userToken = user.token;
    });

    it('rejects coupon creation from a non-admin user', async () => {
        const res = await request(app)
            .post('/api/coupons')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'DENY10', type: 'percent', value: 10, validTo: inDays(7) });
        expect(res.statusCode).toBe(403);
    });

    it('creates a coupon with the type/value contract and validates it using subtotal', async () => {
        const createRes = await request(app)
            .post('/api/coupons')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ code: 'SAVE10', type: 'percent', value: 10, validTo: inDays(7), isPublic: true });
        expect(createRes.statusCode).toBe(201);

        const validateRes = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'SAVE10', subtotal: 1000 });
        expect(validateRes.statusCode).toBe(200);
        expect(validateRes.body.valid).toBe(true);
        expect(validateRes.body.discount).toBe(100);
    });

    it('rejects legacy create payload keys discountType/discountValue', async () => {
        const res = await request(app)
            .post('/api/coupons')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ code: 'OLD10', discountType: 'percentage', discountValue: 10, validTo: inDays(7) });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a duplicate coupon code', async () => {
        await request(app)
            .post('/api/coupons')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ code: 'DUPE10', type: 'flat', value: 50, validTo: inDays(7) });
        const res = await request(app)
            .post('/api/coupons')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ code: 'dupe10', type: 'flat', value: 25, validTo: inDays(7) });
        expect(res.statusCode).toBe(409);
    });

    it('rejects a percent coupon value outside 1-100', async () => {
        const res = await request(app)
            .post('/api/coupons')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ code: 'BAD150', type: 'percent', value: 150, validTo: inDays(7) });
        expect(res.statusCode).toBe(400);
    });

    it('lists, updates, and deletes coupons', async () => {
        const createRes = await request(app)
            .post('/api/coupons')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ code: 'CRUD10', type: 'flat', value: 20, validTo: inDays(7) });
        const id = createRes.body.coupon._id;

        const listRes = await request(app)
            .get('/api/coupons/all')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(listRes.statusCode).toBe(200);
        expect(listRes.body.coupons.some((c) => c._id === id)).toBe(true);

        const updateRes = await request(app)
            .patch(`/api/coupons/${id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ value: 30 });
        expect(updateRes.statusCode).toBe(200);
        expect(updateRes.body.coupon.value).toBe(30);

        const deleteRes = await request(app)
            .delete(`/api/coupons/${id}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(deleteRes.statusCode).toBe(200);

        const afterDelete = await Coupon.findById(id);
        expect(afterDelete).toBeNull();
    });
});

describe('Coupons: validation rules', () => {
    let userToken;

    beforeEach(async () => {
        const user = await registerAndLogin(request, app, { username: 'coupontester', email: 'coupontester@test.com' });
        userToken = user.token;
    });

    it('rejects an unknown coupon code', async () => {
        const res = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'DOESNOTEXIST', subtotal: 500 });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/not found/i);
    });

    it('rejects a coupon that has already expired', async () => {
        await Coupon.create({
            code: 'EXPIRED10',
            type: 'flat',
            value: 50,
            validFrom: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
            validTo: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        });
        const res = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'EXPIRED10', subtotal: 500 });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/expired/i);
    });

    it('rejects a coupon that is not yet valid', async () => {
        await Coupon.create({
            code: 'FUTURE10',
            type: 'flat',
            value: 50,
            validFrom: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
            validTo: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        });
        const res = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'FUTURE10', subtotal: 500 });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/not yet valid/i);
    });

    it('rejects a coupon that has hit its global usage limit', async () => {
        await Coupon.create({
            code: 'MAXEDOUT',
            type: 'flat',
            value: 50,
            usageLimit: 1,
            usedCount: 1,
            validTo: inDays(7),
        });
        const res = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'MAXEDOUT', subtotal: 500 });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/usage limit reached/i);
    });

    it('rejects a coupon the user has already used up to their per-user limit', async () => {
        const decoded = JSON.parse(Buffer.from(userToken.split('.')[1], 'base64').toString());
        const coupon = await Coupon.create({
            code: 'ONEPERUSER',
            type: 'flat',
            value: 50,
            perUserLimit: 1,
            validTo: inDays(7),
            usedBy: [{ userId: decoded.userId, count: 1 }],
        });
        const res = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: coupon.code, subtotal: 500 });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/already used this coupon/i);
    });

    it('rejects when the subtotal is below the minimum order value', async () => {
        await Coupon.create({
            code: 'MIN500',
            type: 'flat',
            value: 50,
            minOrder: 500,
            validTo: inDays(7),
        });
        const res = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'MIN500', subtotal: 200 });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/minimum order/i);
    });

    it('applies a flat coupon and caps a percent coupon at maxDiscount', async () => {
        await Coupon.create({ code: 'FLAT50', type: 'flat', value: 50, validTo: inDays(7) });
        const flatRes = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'FLAT50', subtotal: 500 });
        expect(flatRes.statusCode).toBe(200);
        expect(flatRes.body.discount).toBe(50);

        await Coupon.create({ code: 'PCT50CAP100', type: 'percent', value: 50, maxDiscount: 100, validTo: inDays(7) });
        const pctRes = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'PCT50CAP100', subtotal: 1000 }); // 50% of 1000 = 500, capped to 100
        expect(pctRes.statusCode).toBe(200);
        expect(pctRes.body.discount).toBe(100);
    });

    it('rejects coupon validation when subtotal is missing', async () => {
        await Coupon.create({ code: 'SAVE20', type: 'percent', value: 20, validTo: inDays(7), isPublic: true });
        const res = await request(app)
            .post('/api/coupons/validate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'SAVE20', total: 1000 }); // wrong key
        expect(res.statusCode).toBe(400);
    });

    it('rejects coupon validation without authentication', async () => {
        const res = await request(app).post('/api/coupons/validate').send({ code: 'SAVE20', subtotal: 500 });
        expect(res.statusCode).toBe(401);
    });
});

describe('Coupons: public listing', () => {
    it('only lists active, public, currently-valid coupons', async () => {
        await Coupon.create({ code: 'PUB1', type: 'flat', value: 10, isPublic: true, isActive: true, validTo: inDays(7) });
        await Coupon.create({ code: 'PRIVATE1', type: 'flat', value: 10, isPublic: false, isActive: true, validTo: inDays(7) });
        await Coupon.create({
            code: 'EXPIREDPUB',
            type: 'flat',
            value: 10,
            isPublic: true,
            isActive: true,
            validFrom: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
            validTo: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        });

        const res = await request(app).get('/api/coupons/public');
        expect(res.statusCode).toBe(200);
        const codes = res.body.coupons.map((c) => c.code);
        expect(codes).toContain('PUB1');
        expect(codes).not.toContain('PRIVATE1');
        expect(codes).not.toContain('EXPIREDPUB');
    });
});
