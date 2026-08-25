import { jest } from '@jest/globals';

jest.unstable_mockModule('../utils/redis.js', () => ({
    default: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn(),
        del: jest.fn(),
        scan: jest.fn().mockResolvedValue(['0', []]),
        on: jest.fn(),
        quit: jest.fn(),
    },
    CACHE_TTL: { PRODUCTS_LIST: 300, PRODUCT_DETAIL: 600, PROFILE: 3600, SALE: 60, HOME: 300, TWO_FA: 300 },
    invalidatePattern: jest.fn(),
}));

// No mock of @google/generative-ai / ai.service.js needed here — the
// recommendation controller only touches Product/User via mongoose and
// Atlas $vectorSearch (unsupported by mongodb-memory-server, but every
// call site wraps it in try/catch and falls back to a plain Mongo query,
// which is the path these tests exercise since no product has an
// embedding set).

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: Product } = await import('../models/Product.js');

const makeProduct = (overrides = {}) => ({
    title: 'Product',
    description: 'desc',
    category: 'electronics',
    price: 1000,
    stock: 5,
    thumbnail: 'http://x.com/i.jpg',
    isActive: true,
    ...overrides,
});

describe('Recommendations: GET /api/products/:id/similar', () => {
    it('returns 404 for a non-existent product', async () => {
        const res = await request(app).get('/api/products/64b000000000000000000000/similar');
        expect(res.statusCode).toBe(404);
    });

    it('falls back to same-category top-rated products when there is no embedding', async () => {
        const source = await Product.create(makeProduct({ title: 'Source', category: 'electronics' }));
        await Product.create(makeProduct({ title: 'Sibling', category: 'electronics', rating: 4 }));
        await Product.create(makeProduct({ title: 'Other Category', category: 'beauty' }));

        const res = await request(app).get(`/api/products/${source._id}/similar`);
        expect(res.statusCode).toBe(200);
        expect(res.body.products.some((p) => p.title === 'Sibling')).toBe(true);
        expect(res.body.products.every((p) => p.category === 'electronics')).toBe(true);
    });

    it('excludes the source product itself from the results', async () => {
        const source = await Product.create(makeProduct({ title: 'Source2', category: 'electronics' }));
        const res = await request(app).get(`/api/products/${source._id}/similar`);
        expect(res.body.products.every((p) => p._id !== String(source._id))).toBe(true);
    });

    it('respects the limit query param, clamped to [1,20]', async () => {
        const source = await Product.create(makeProduct({ title: 'Source3', category: 'electronics' }));
        await Product.create(Array.from({ length: 5 }, (_, i) => makeProduct({ title: `Sib${i}`, category: 'electronics' })));
        const res = await request(app).get(`/api/products/${source._id}/similar?limit=2`);
        expect(res.body.products.length).toBeLessThanOrEqual(2);
    });
});

describe('Recommendations: GET /api/recommendations/for-you', () => {
    it('returns a cold-start / trending fallback for a guest with no history', async () => {
        await Product.create(makeProduct({ title: 'Trending', isFeatured: true, rating: 5 }));
        const res = await request(app).get('/api/recommendations/for-you');
        expect(res.statusCode).toBe(200);
        expect(res.body.personalized).toBe(false);
        expect(Array.isArray(res.body.products)).toBe(true);
    });

    it('respects the limit query param, clamped to [1,24]', async () => {
        await Product.create(Array.from({ length: 5 }, (_, i) => makeProduct({ title: `T${i}` })));
        const res = await request(app).get('/api/recommendations/for-you?limit=3');
        expect(res.body.products.length).toBeLessThanOrEqual(3);
    });
});
