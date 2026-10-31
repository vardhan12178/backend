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

    it('filters by specs and rating, with facet counts, and sorts by rating', async () => {
        const set = (slug, fields) => CatalogProduct.updateOne({ slug }, { $set: fields });
        await set('phone-a', { keySpecs: { is5G: true, os: 'iOS', batteryMah: 4800 }, 'variants.0.keySpecs': { ramGB: 8, storageGB: 256 }, 'variants.1.keySpecs': { ramGB: 8, storageGB: 512 }, rating: { average: 4.7, count: 900 } });
        await set('phone-b', { keySpecs: { is5G: false, os: 'Android', batteryMah: 6000 }, 'variants.0.keySpecs': { ramGB: 6, storageGB: 128 }, rating: { average: 4.1, count: 5000 } });
        await set('phone-c', { keySpecs: { is5G: true, os: 'Android', batteryMah: 5000 }, 'variants.0.keySpecs': { ramGB: 12, storageGB: 256 }, rating: { average: 4.4, count: 2000 } });

        const res = await request(app).get('/api/v2/products?category=mobiles&f_storage=256&f_5g=1&sort=price-asc');
        expect(res.status).toBe(200);
        expect(res.body.products.map((p) => p.slug)).toEqual(['phone-c', 'phone-a']);
        const facet = (key) => res.body.facets.specs.find((f) => f.key === key);
        // Each filter's counts apply the other filters: storage among 5G phones, 5G among 256 GB phones
        expect(facet('storage').options).toEqual([{ value: '256', label: '256 GB', count: 2 }, { value: '512', label: '512 GB', count: 1 }]);
        expect(facet('5g')).toMatchObject({ kind: 'flag', options: [{ value: '1', label: '5G', count: 2 }] });
        expect(facet('os').options.map((o) => [o.value, o.count])).toEqual([['Android', 1], ['iOS', 1]]);

        const battery = await request(app).get('/api/v2/products?category=mobiles&f_battery=6000&f_nope=1');
        expect(battery.body.products.map((p) => p.slug)).toEqual(['phone-b']);

        const top = await request(app).get('/api/v2/products?category=mobiles&sort=rating');
        expect(top.body.products.map((p) => p.slug)).toEqual(['phone-a', 'phone-c', 'phone-b']);
        const good = await request(app).get('/api/v2/products?category=mobiles&minRating=4.4');
        expect(good.body.products.map((p) => p.slug).sort()).toEqual(['phone-a', 'phone-c']);
        expect(good.body.facets.ratings).toEqual([{ min: 4, count: 3 }, { min: 3, count: 3 }]);
        expect((await request(app).get('/api/v2/products?minRating=9')).status).toBe(400);
    });

    it('copies sample ratings into the database, writing only what changed', async () => {
        const { syncRatings } = await import('../services/catalogV2.ratings.js');
        await CatalogProduct.create(product('apple-ipad-a16', { category: 'tablets', categoryPath: ['electronics', 'tablets'], variants: [variant('IPAD-1', 34900, 34900, { isDefault: true })] }));
        expect(await syncRatings()).toBe(1); // only the product with sample reviews
        const ipad = await CatalogProduct.findOne({ slug: 'apple-ipad-a16' }).lean();
        expect(ipad.rating.average).toBe(4.6);
        expect(ipad.rating.count).toBeGreaterThan(0);
        expect(await syncRatings()).toBe(0);
    });

    it('splits fashion by gender and groups appliances', async () => {
        const women = await request(app).get('/api/v2/products?category=fashion-women');
        expect(women.body.products.map((p) => p.slug)).toEqual(['saree-1']);
        const appl = await request(app).get('/api/v2/products?category=appliances');
        expect(appl.body.products.map((p) => p.slug)).toEqual(['fridge-1']);
    });

    it('searches by keyword across categories, best match first', async () => {
        const res = await request(app).get('/api/v2/products?q=samsung%20phone');
        expect(res.status).toBe(200);
        expect(res.body.sort).toBe('relevance');
        // Samsung phones match both words, so they rank above the Samsung fridge
        expect(res.body.products.map((p) => p.slug).slice(-1)).toEqual(['fridge-1']);
        expect(res.body.products.map((p) => p.slug)).toEqual(expect.arrayContaining(['phone-b', 'phone-c', 'fridge-1']));
        expect((await request(app).get('/api/v2/products?sort=relevance')).body.sort).toBe('featured');
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
