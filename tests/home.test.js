import { jest } from '@jest/globals';
import { createStatefulRedisMock } from './helpers.js';

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: redisMock,
    CACHE_TTL: { PRODUCTS_LIST: 300, PRODUCT_DETAIL: 600, PROFILE: 3600, SALE: 60, HOME: 300, TWO_FA: 300 },
    invalidatePattern: jest.fn(),
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: Product } = await import('../models/Product.js');
const { default: Sale } = await import('../models/Sale.js');

const makeProduct = (overrides = {}) => ({
    title: 'Test Product',
    description: 'A test product',
    category: 'smartphones',
    price: 10000,
    stock: 10,
    thumbnail: 'http://example.com/img.jpg',
    isActive: true,
    ...overrides,
});

describe('Home: consolidated home-page data', () => {
    beforeEach(async () => {
        await redisMock.del('home:data');
        await redisMock.del('sale:active');
    });

    it('returns featured/newArrivals/activeSale/stats with an empty catalog', async () => {
        const res = await request(app).get('/api/home');
        expect(res.statusCode).toBe(200);
        expect(res.body.featured).toEqual([]);
        expect(res.body.newArrivals).toEqual([]);
        expect(res.body.activeSale).toBeNull();
        expect(res.body.stats).toBeNull();
    });

    it('interleaves featured products round-robin across the 4 promoted categories', async () => {
        await Product.create([
            makeProduct({ title: 'Phone A', category: 'smartphones' }),
            makeProduct({ title: 'Phone B', category: 'smartphones' }),
            makeProduct({ title: 'Laptop A', category: 'laptops' }),
        ]);

        const res = await request(app).get('/api/home');
        expect(res.statusCode).toBe(200);
        const titles = res.body.featured.map((p) => p.title);
        expect(titles).toHaveLength(3);
        // Round-robin interleave: category order is [smartphones, laptops, ...],
        // so with 2 smartphones + 1 laptop the sequence is [smartphone, laptop, smartphone]
        // regardless of which specific smartphone doc sorts first on a rating/isFeatured tie.
        expect(titles[1]).toBe('Laptop A');
        expect(titles.filter((t) => t.startsWith('Phone'))).toHaveLength(2);
    });

    it('excludes inactive products from both featured and newArrivals', async () => {
        await Product.create(makeProduct({ title: 'Hidden Product', isActive: false }));
        const res = await request(app).get('/api/home');
        const allTitles = [...res.body.featured, ...res.body.newArrivals].map((p) => p.title);
        expect(allTitles).not.toContain('Hidden Product');
    });

    it('caps newArrivals at 8 even with more active products', async () => {
        const many = Array.from({ length: 10 }, (_, i) => makeProduct({ title: `Item ${i}`, category: 'misc' }));
        await Product.create(many);
        const res = await request(app).get('/api/home');
        expect(res.body.newArrivals.length).toBeLessThanOrEqual(8);
    });

    it('includes the real catalog-wide rating/review stats rollup', async () => {
        await Product.create([
            makeProduct({ title: 'A', rating: 4, reviews: [{ rating: 4, comment: 'test comment here' }] }),
            makeProduct({ title: 'B', rating: 2 }),
        ]);
        const res = await request(app).get('/api/home');
        expect(res.body.stats).toMatchObject({ totalProducts: 2, totalReviews: 1 });
        expect(res.body.stats.avgRating).toBe(3);
    });

    it('overlays active sale pricing onto featured/newArrivals', async () => {
        await Product.create(makeProduct({ title: 'Sale Phone', category: 'smartphones', price: 1000, discountPercentage: 0 }));
        await Sale.create({
            name: 'Flash Sale',
            slug: 'flash-sale',
            categories: [{ category: 'smartphones', discountPercent: 20 }],
            startDate: new Date(Date.now() - 1000),
            endDate: new Date(Date.now() + 60 * 60 * 1000),
        });

        const res = await request(app).get('/api/home');
        expect(res.body.activeSale.name).toBe('Flash Sale');
        const saleItem = res.body.featured.find((p) => p.title === 'Sale Phone');
        expect(saleItem.onSale).toBe(true);
        expect(saleItem.price).toBeLessThan(1000);
    });

    it('serves from cache on a second request without re-querying (cache hit returns same payload)', async () => {
        await Product.create(makeProduct({ title: 'Cached Product' }));
        const first = await request(app).get('/api/home');
        expect(first.statusCode).toBe(200);

        // Delete the product from the DB directly — a cache hit should still
        // return the previously-cached payload rather than an empty one.
        await Product.deleteMany({});
        const second = await request(app).get('/api/home');
        expect(second.statusCode).toBe(200);
        expect(second.body).toEqual(first.body);
    });
});
