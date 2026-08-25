import { jest } from '@jest/globals';
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
const { default: User } = await import('../models/User.js');
const { default: Sale } = await import('../models/Sale.js');

async function loginAs(username) {
    const res = await request(app).post('/api/login').send({ username, password: 'Password123!' });
    return res.body.token;
}

async function makeBareAdmin(username, overrides = {}) {
    await registerAndLogin(request, app, { username, email: `${username}@test.com` });
    await User.updateOne({ username }, { $set: { roles: ['admin'], adminRole: null, permissions: {}, ...overrides } });
    return loginAs(username);
}

const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

const validSale = {
    name: 'Diwali Sale',
    slug: 'diwali-sale',
    categories: [{ category: 'electronics', discountPercent: 20, primeDiscountPercent: 25 }],
    startDate: inDays(-1),
    endDate: inDays(7),
};

describe('Sales: public active-sale endpoint', () => {
    // The stateful redis mock persists across `it()` blocks within this file
    // (mirroring real Redis), so getActiveSale()'s cache must be cleared
    // between tests that rely on the DB read path, same as production.
    beforeEach(async () => {
        await redisMock.del('sale:active');
    });

    it('returns sale:null when no sale is active', async () => {
        const res = await request(app).get('/api/sales/active');
        expect(res.statusCode).toBe(200);
        expect(res.body.sale).toBeNull();
    });

    it('returns the currently active sale', async () => {
        await Sale.create(validSale);
        const res = await request(app).get('/api/sales/active');
        expect(res.statusCode).toBe(200);
        expect(res.body.sale.name).toBe('Diwali Sale');
    });

    it('does not return a sale outside its date window', async () => {
        await Sale.create({ ...validSale, slug: 'past-sale', startDate: inDays(-10), endDate: inDays(-2) });
        const res = await request(app).get('/api/sales/active');
        expect(res.statusCode).toBe(200);
        expect(res.body.sale).toBeNull();
    });
});

describe('Sales: admin CRUD (permission-gated)', () => {
    let superAdminToken;
    let salesWriteToken;
    let salesReadToken;
    let bareAdminToken;

    beforeEach(async () => {
        const superAdmin = await registerAndLogin(request, app, { username: 'salesuperadmin', email: 'salesuperadmin@test.com' });
        await makeSuperAdmin(User, superAdmin.payload.username);
        superAdminToken = await loginAs('salesuperadmin');

        salesWriteToken = await makeBareAdmin('saleswriteadmin', { permissions: { sales: 'write' } });
        salesReadToken = await makeBareAdmin('salesreadadmin', { permissions: { sales: 'read' } });
        bareAdminToken = await makeBareAdmin('salesbareadmin');
    });

    it('rejects list for a bare admin', async () => {
        const res = await request(app).get('/api/sales').set('Authorization', `Bearer ${bareAdminToken}`);
        expect(res.statusCode).toBe(403);
    });

    it('lists sales for an admin with sales:read', async () => {
        await Sale.create(validSale);
        const res = await request(app).get('/api/sales').set('Authorization', `Bearer ${salesReadToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveLength(1);
    });

    it('rejects create for an admin with only sales:read', async () => {
        const res = await request(app)
            .post('/api/sales')
            .set('Authorization', `Bearer ${salesReadToken}`)
            .send(validSale);
        expect(res.statusCode).toBe(403);
    });

    it('creates a sale for an admin with sales:write', async () => {
        const res = await request(app)
            .post('/api/sales')
            .set('Authorization', `Bearer ${salesWriteToken}`)
            .send(validSale);
        expect(res.statusCode).toBe(201);
        expect(res.body.slug).toBe('diwali-sale');
    });

    it('rejects a sale with no category discounts (schema validator)', async () => {
        const res = await request(app)
            .post('/api/sales')
            .set('Authorization', `Bearer ${salesWriteToken}`)
            .send({ ...validSale, slug: 'empty-sale', categories: [] });
        expect(res.statusCode).toBe(500);
    });

    it('rejects a duplicate slug with 409', async () => {
        await Sale.create(validSale);
        const res = await request(app)
            .post('/api/sales')
            .set('Authorization', `Bearer ${salesWriteToken}`)
            .send(validSale);
        expect(res.statusCode).toBe(409);
    });

    it('creating a new active sale deactivates other active sales (single-active-sale invariant)', async () => {
        const first = await Sale.create(validSale);
        expect(first.isActive).toBe(true);

        await request(app)
            .post('/api/sales')
            .set('Authorization', `Bearer ${salesWriteToken}`)
            .send({ ...validSale, slug: 'new-year-sale', name: 'New Year Sale' });

        const firstAfter = await Sale.findById(first._id);
        expect(firstAfter.isActive).toBe(false);
    });

    it('updates a sale for an admin with sales:write and clears the sale cache', async () => {
        const sale = await Sale.create(validSale);
        await redisMock.set('sale:active', JSON.stringify(sale), 'EX', 60);

        const res = await request(app)
            .put(`/api/sales/${sale._id}`)
            .set('Authorization', `Bearer ${salesWriteToken}`)
            .send({ name: 'Diwali Mega Sale' });
        expect(res.statusCode).toBe(200);
        expect(res.body.name).toBe('Diwali Mega Sale');

        const cached = await redisMock.get('sale:active');
        expect(cached).toBeNull();
    });

    it('returns 404 updating a non-existent sale', async () => {
        const res = await request(app)
            .put('/api/sales/64b000000000000000000000')
            .set('Authorization', `Bearer ${salesWriteToken}`)
            .send({ name: 'Nope' });
        expect(res.statusCode).toBe(404);
    });

    it('deletes a sale for an admin with sales:write', async () => {
        const sale = await Sale.create(validSale);
        const res = await request(app)
            .delete(`/api/sales/${sale._id}`)
            .set('Authorization', `Bearer ${salesWriteToken}`);
        expect(res.statusCode).toBe(200);
        expect(await Sale.findById(sale._id)).toBeNull();
    });

    it('rejects delete for a bare admin', async () => {
        const sale = await Sale.create(validSale);
        const res = await request(app)
            .delete(`/api/sales/${sale._id}`)
            .set('Authorization', `Bearer ${bareAdminToken}`);
        expect(res.statusCode).toBe(403);
        expect(await Sale.findById(sale._id)).toBeTruthy();
    });

    it('gets a single sale by id for super_admin', async () => {
        const sale = await Sale.create(validSale);
        const res = await request(app)
            .get(`/api/sales/${sale._id}`)
            .set('Authorization', `Bearer ${superAdminToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.name).toBe('Diwali Sale');
    });
});
