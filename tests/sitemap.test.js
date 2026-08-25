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

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: Product } = await import('../models/Product.js');

// Low-risk SEO plumbing — a minimal smoke test only, per the audit's
// judgment call (not full rigor).
describe('Sitemap: GET /sitemap.xml', () => {
    it('returns valid-looking XML including static pages and active products', async () => {
        await Product.create({
            title: 'Sitemap Product', description: 'd', category: 'c',
            price: 10, stock: 1, thumbnail: 'http://x.com/i.jpg', isActive: true,
        });

        const res = await request(app).get('/sitemap.xml');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/xml/);
        expect(res.text).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
        expect(res.text).toContain('<urlset');
        expect(res.text).toContain('/products</loc>');
        expect(res.text).toMatch(/\/blog\/1<\/loc>/);
    });
});
