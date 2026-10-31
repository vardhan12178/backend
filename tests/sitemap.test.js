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
const { default: CatalogProduct } = await import('../models/CatalogProduct.js');

// Low-risk SEO plumbing — a minimal smoke test only, per the audit's
// judgment call (not full rigor).
describe('Sitemap: GET /sitemap.xml', () => {
    it('returns valid-looking XML including static pages, categories and visible products', async () => {
        const product = (slug, status) => ({
            slug, title: slug, brand: 'B', category: 'mobiles', categoryPath: ['electronics', 'mobiles'], status,
            variants: [{ sku: `${slug}-1`, options: {}, price: 10, mrp: 10, stock: 1, isDefault: true }],
            priceRange: { min: 10, max: 10 }, inStock: true, searchText: slug,
        });
        await CatalogProduct.create([product('shown-phone', 'active'), product('old-phone', 'archived')]);

        const res = await request(app).get('/sitemap.xml');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/xml/);
        expect(res.text).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
        expect(res.text).toContain('<urlset');
        expect(res.text).toContain('/products</loc>');
        expect(res.text).toMatch(/\/blog\/1<\/loc>/);
        expect(res.text).toContain('/products?cat=mobiles</loc>');
        expect(res.text).toContain('/products/shown-phone</loc>');
        expect(res.text).not.toContain('old-phone');
    });
});
