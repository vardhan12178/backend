import { jest } from '@jest/globals';
import { createStatefulRedisMock } from './helpers.js';

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
const { default: CatalogProduct } = await import('../models/CatalogProduct.js');
const { reserveV2Line, restoreV2Line } = await import('../services/catalogV2.stock.js');

const variant = (sku, price, mrp, extra = {}) => ({ sku, options: { Color: 'Black' }, price, mrp, stock: 10, isDefault: false, ...extra });
const product = (slug, overrides = {}) => ({
    slug,
    title: `Brand ${slug}`,
    brand: 'Brand',
    category: 'mobiles',
    categoryPath: ['electronics', 'mobiles'],
    status: 'draft',
    launchDate: '2026-01',
    variantOptions: [{ name: 'Color', values: [{ value: 'Black', hex: '#111111' }] }],
    media: { groupBy: 'Color', groups: { Black: [{ key: `mobiles/${slug}/black-1`, alt: slug }] }, common: [] },
    variants: [variant(`${slug}-A`, 10000, 12000, { isDefault: true })],
    priceRange: { min: 10000, max: 10000 },
    inStock: true,
    searchText: slug,
    ...overrides,
});

async function seed() {
    await CatalogProduct.syncIndexes();
    await CatalogProduct.insertMany([
        product('phone-a', { brand: 'Apple', priceRange: { min: 80000, max: 90000 }, variants: [variant('A-1', 80000, 80000, { isDefault: true }), variant('A-2', 90000, 90000)] }),
        product('phone-b', { brand: 'Samsung', priceRange: { min: 20000, max: 20000 }, variants: [variant('B-1', 20000, 40000, { isDefault: true })] }),
        product('phone-c', { brand: 'Samsung', priceRange: { min: 50000, max: 50000 }, variants: [variant('C-1', 50000, 55000, { isDefault: true })] }),
        product('saree-1', { category: 'fashion', categoryPath: ['fashion', 'women'], keySpecs: { gender: 'Women' }, brand: 'Libas' }),
        product('shirt-1', { category: 'fashion', categoryPath: ['fashion', 'men'], keySpecs: { gender: 'Men' }, brand: 'Levis' }),
        product('fridge-1', { category: 'refrigerators', categoryPath: ['home-appliances', 'refrigerators'], brand: 'Samsung' }),
        product('old-phone', { status: 'archived' }),
    ]);
}

describe('Catalog v2 API', () => {
    beforeEach(async () => {
        await seed();
    });

    it('lists storefront categories with counts, hiding archived products', async () => {
        const res = await request(app).get('/api/v2/categories');
        expect(res.status).toBe(200);
        const bySlug = Object.fromEntries(res.body.map((c) => [c.slug, c.count]));
        expect(bySlug).toMatchObject({ mobiles: 3, 'fashion-women': 1, 'fashion-men': 1, appliances: 1 });
    });

    it('lists products with cards, image URLs, facets and paging', async () => {
        const res = await request(app).get('/api/v2/products?category=mobiles&sort=price-asc&limit=2');
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(3);
        expect(res.body.pages).toBe(2);
        expect(res.body.products.map((p) => p.slug)).toEqual(['phone-b', 'phone-c']);
        const card = res.body.products[0];
        expect(card.discountPercent).toBe(50);
        expect(card).toMatchObject({ sku: 'B-1', id: expect.stringMatching(/^[a-f0-9]{24}$/), options: { Color: 'Black' }, needsSize: false, defaultInStock: true });
        expect(card.image.md).toMatch(/catalog-v2\/mobiles\/phone-b\/black-1-md\.webp$/);
        expect(res.body.facets.brands).toEqual([{ name: 'Samsung', count: 2 }, { name: 'Apple', count: 1 }]);
        expect(res.body.facets.price).toEqual({ min: 20000, max: 80000 });
    });

    it('filters by brand, price and discount without shrinking the brand facet', async () => {
        const res = await request(app).get('/api/v2/products?category=mobiles&brand=Samsung&maxPrice=30000');
        expect(res.body.products.map((p) => p.slug)).toEqual(['phone-b']);
        expect(res.body.facets.brands.find((b) => b.name === 'Samsung').count).toBe(1);

        const off = await request(app).get('/api/v2/products?category=mobiles&minDiscount=25');
        expect(off.body.products.map((p) => p.slug)).toEqual(['phone-b']);
    });

    it('splits fashion by gender and groups appliances', async () => {
        const women = await request(app).get('/api/v2/products?category=fashion-women');
        expect(women.body.products.map((p) => p.slug)).toEqual(['saree-1']);
        const appl = await request(app).get('/api/v2/products?category=appliances');
        expect(appl.body.products.map((p) => p.slug)).toEqual(['fridge-1']);
    });

    it('rejects bad query values', async () => {
        expect((await request(app).get('/api/v2/products?sort=random')).status).toBe(400);
        expect((await request(app).get('/api/v2/products?limit=500')).status).toBe(400);
        expect((await request(app).get('/api/v2/products/Not_A_Slug!')).status).toBe(400);
    });

    it('returns product detail with resolved media and per-variant discount', async () => {
        const res = await request(app).get('/api/v2/products/phone-b');
        expect(res.status).toBe(200);
        expect(res.body.embedding).toBeUndefined();
        expect(res.body.media.groups.Black[0].thumb).toMatch(/black-1-thumb\.webp$/);
        expect(res.body.variants[0]).toMatchObject({ sku: 'B-1', discountPercent: 50, inStock: true });
        expect(res.body.reviews).toBeNull(); // test fixtures have no sample reviews
        expect((await request(app).get('/api/v2/products/old-phone')).status).toBe(404);
        expect((await request(app).get('/api/v2/products/missing')).status).toBe(404);
    });

    it('falls back to same category, closest price, for similar products', async () => {
        const res = await request(app).get('/api/v2/products/phone-c/similar?limit=2');
        expect(res.status).toBe(200);
        expect(res.body.source).toBe('price');
        expect(res.body.products.map((p) => p.slug).sort()).toEqual(['phone-a', 'phone-b']);
    });

    it('resolves cart lines with live price and stock', async () => {
        const phone = await CatalogProduct.findOne({ slug: 'phone-a' }).lean();
        const res = await request(app).post('/api/v2/cart/resolve').send({
            items: [
                { productId: String(phone._id), sku: 'A-2', quantity: 2 },
                { productId: String(phone._id), sku: 'NOPE', quantity: 1 },
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.items[0]).toMatchObject({ sku: 'A-2', price: 90000, quantity: 2, available: true, variantLabel: 'Black' });
        expect(res.body.items[0].image).toMatch(/black-1-md\.webp$/);
        expect(res.body.items[1]).toMatchObject({ sku: 'NOPE', available: false });
    });

    it('reserves stock atomically and restores it', async () => {
        const phone = await CatalogProduct.findOne({ slug: 'phone-b' }).lean();
        const line = await reserveV2Line({ productId: phone._id, sku: 'B-1', quantity: 4 });
        expect(line).toMatchObject({ catalog: 'v2', sku: 'B-1', price: 20000, quantity: 4, name: 'Brand phone-b' });
        let doc = await CatalogProduct.findById(phone._id).lean();
        expect(doc.variants[0].stock).toBe(6);

        await expect(reserveV2Line({ productId: phone._id, sku: 'B-1', quantity: 7 })).rejects.toThrow(/Insufficient stock/);
        await reserveV2Line({ productId: phone._id, sku: 'B-1', quantity: 6 });
        doc = await CatalogProduct.findById(phone._id).lean();
        expect(doc.variants[0].stock).toBe(0);
        expect(doc.inStock).toBe(false);

        await restoreV2Line({ productId: phone._id, sku: 'B-1', quantity: 3 });
        doc = await CatalogProduct.findById(phone._id).lean();
        expect(doc.variants[0].stock).toBe(3);
        expect(doc.inStock).toBe(true);
    });
});
