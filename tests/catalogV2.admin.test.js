import { jest } from '@jest/globals';
import { createStatefulRedisMock, registerAndLogin } from './helpers.js';

const redisMock = createStatefulRedisMock(jest);
const invalidatePattern = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: redisMock,
    CACHE_TTL: { PRODUCTS_LIST: 300, PRODUCT_DETAIL: 600, PROFILE: 3600, SALE: 60, HOME: 300, TWO_FA: 300 },
    invalidatePattern,
}));
jest.unstable_mockModule('resend', () => ({
    Resend: class { constructor() { this.emails = { send: jest.fn().mockResolvedValue({ id: 'mock' }) }; } }
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
const { default: CatalogProduct } = await import('../models/CatalogProduct.js');

const variant = (sku, price, mrp, stock, extra = {}) => ({ sku, options: { Storage: sku.split('-').pop() }, price, mrp, stock, isDefault: false, ...extra });
const product = (slug, overrides = {}) => ({
    slug, title: `Brand ${slug}`, brand: 'Brand', category: 'mobiles', categoryPath: ['electronics', 'mobiles'], status: 'active',
    variantOptions: [{ name: 'Storage', values: [{ value: '128GB' }, { value: '256GB' }] }],
    media: { groupBy: 'Storage', groups: {}, common: [{ key: `mobiles/${slug}/front-1`, alt: slug }] },
    variants: [variant(`${slug}-128GB`, 20000, 25000, 10, { isDefault: true }), variant(`${slug}-256GB`, 24000, 29000, 3)],
    priceRange: { min: 20000, max: 24000 }, inStock: true, searchText: slug,
    ...overrides,
});

async function adminToken(username, set) {
    const { token } = await registerAndLogin(request, app, { username, email: `${username}@test.com` });
    await User.updateOne({ username }, { $set: { roles: ['admin'], adminRole: null, permissions: {}, ...set } });
    return token;
}

describe('Catalog v2 admin API', () => {
    let writer;
    let reader;
    let shopper;
    let phone;

    beforeEach(async () => {
        invalidatePattern.mockClear();
        await CatalogProduct.insertMany([
            product('phone-a'),
            product('phone-b', { status: 'draft', brand: 'Other', variants: [variant('phone-b-128GB', 9000, 9000, 0, { isDefault: true })], priceRange: { min: 9000, max: 9000 }, inStock: false }),
            product('saree-1', { category: 'fashion', categoryPath: ['fashion', 'women'], keySpecs: { gender: 'Women' }, status: 'archived' }),
        ]);
        phone = await CatalogProduct.findOne({ slug: 'phone-a' }).lean();
        writer = await adminToken(`w${Date.now()}`, { permissions: { products: 'write' } });
        reader = await adminToken(`r${Date.now()}`, { permissions: { products: 'read' } });
        ({ token: shopper } = await registerAndLogin(request, app));
    });

    const as = (token) => ({ get: (u) => request(app).get(u).set('Authorization', `Bearer ${token}`), patch: (u, b) => request(app).patch(u).set('Authorization', `Bearer ${token}`).send(b) });

    it('lists every product with variants, status counts and filters', async () => {
        const res = await as(reader).get('/api/admin/v2/products');
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(3);
        expect(res.body.counts).toEqual({ all: 3, active: 1, draft: 1, archived: 1, out: 1, low: 2 });
        const a = res.body.products.find((p) => p.slug === 'phone-a');
        expect(a).toMatchObject({ category: 'mobiles', status: 'active', stock: 13, lowStock: true, outOfStock: 0 });
        expect(a.variants).toEqual([
            expect.objectContaining({ sku: 'phone-a-128GB', label: '128GB', price: 20000, mrp: 25000, stock: 10, isDefault: true, discountPercent: 20 }),
            expect.objectContaining({ sku: 'phone-a-256GB', stock: 3 }),
        ]);
        expect(res.body.products.find((p) => p.slug === 'saree-1').category).toBe('fashion-women');

        const out = await as(reader).get('/api/admin/v2/products?stock=out');
        expect(out.body.products.map((p) => p.slug)).toEqual(['phone-b']);
        const search = await as(reader).get('/api/admin/v2/products?q=phone-a-256');
        expect(search.body.products.map((p) => p.slug)).toEqual(['phone-a']);
        const archived = await as(reader).get('/api/admin/v2/products?status=archived&category=fashion-women');
        expect(archived.body.products.map((p) => p.slug)).toEqual(['saree-1']);
    });

    it('edits a variant and keeps price range and stock flags in step', async () => {
        const res = await as(writer).patch(`/api/admin/v2/products/${phone._id}/variants/phone-a-256GB`, { price: 18000, stock: 0 });
        expect(res.status).toBe(200);
        expect(res.body.priceRange).toEqual({ min: 18000, max: 20000 });
        expect(res.body.variants[1]).toMatchObject({ price: 18000, mrp: 29000, stock: 0 });
        expect(res.body.outOfStock).toBe(1);
        expect(invalidatePattern).toHaveBeenCalledWith('v2:*');

        const saved = await CatalogProduct.findById(phone._id).lean();
        expect(saved.variants[1].price).toBe(18000);
        expect(saved.inStock).toBe(true); // the 128GB variant is still in stock
    });

    it('rejects impossible prices and unknown variants', async () => {
        const url = `/api/admin/v2/products/${phone._id}/variants`;
        expect((await as(writer).patch(`${url}/phone-a-128GB`, { price: 30000 })).body.message).toMatch(/MRP can't be lower/);
        expect((await as(writer).patch(`${url}/phone-a-128GB`, { stock: -1 })).status).toBe(400);
        expect((await as(writer).patch(`${url}/nope`, { stock: 1 })).status).toBe(404);
    });

    it('changes status and the featured flag', async () => {
        const res = await as(writer).patch(`/api/admin/v2/products/${phone._id}`, { status: 'archived', isFeatured: true });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'archived', isFeatured: true });
        // Archived products disappear from the storefront API
        expect((await request(app).get('/api/v2/products/phone-a')).status).toBe(404);
        expect((await as(writer).patch(`/api/admin/v2/products/${phone._id}`, { status: 'deleted' })).status).toBe(400);
    });

    it('sets status in bulk, by ids or for everything matching a filter', async () => {
        const post = (token, b) => request(app).post('/api/admin/v2/products/bulk-status').set('Authorization', `Bearer ${token}`).send(b);
        const byIds = await post(writer, { ids: [String(phone._id)], status: 'draft' });
        expect(byIds.body).toEqual({ matched: 1, updated: 1, status: 'draft' });
        const all = await post(writer, { ids: 'all', filter: { status: 'draft' }, status: 'active' });
        expect(all.body).toMatchObject({ matched: 2, updated: 2 });
        expect(await CatalogProduct.countDocuments({ status: 'active' })).toBe(2);
        expect((await post(writer, { ids: [], status: 'active' })).status).toBe(400);
        expect((await post(reader, { ids: 'all', status: 'active' })).status).toBe(403);
    });

    it('needs products access: read to list, write to edit', async () => {
        expect((await request(app).get('/api/admin/v2/products')).status).toBe(401);
        expect((await as(shopper).get('/api/admin/v2/products')).status).toBe(403);
        expect((await as(reader).patch(`/api/admin/v2/products/${phone._id}`, { status: 'draft' })).status).toBe(403);
    });
});
