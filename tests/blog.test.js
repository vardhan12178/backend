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

describe('Blog (static content API)', () => {
    it('lists all blog posts with summary fields, no auth required', async () => {
        const res = await request(app).get('/api/blog');
        expect(res.statusCode).toBe(200);
        expect(res.body.total).toBeGreaterThan(0);
        expect(Array.isArray(res.body.posts)).toBe(true);
        expect(res.body.posts[0]).toHaveProperty('title');
        expect(res.body.posts[0]).toHaveProperty('summary');
    });

    it('filters posts by tag (case-insensitive)', async () => {
        const res = await request(app).get('/api/blog?tag=guides');
        expect(res.statusCode).toBe(200);
        expect(res.body.posts.length).toBeGreaterThan(0);
        for (const post of res.body.posts) {
            expect(post.tags.some((t) => t.toLowerCase() === 'guides')).toBe(true);
        }
    });

    it('returns an empty list for an unknown tag', async () => {
        const res = await request(app).get('/api/blog?tag=doesnotexist');
        expect(res.statusCode).toBe(200);
        expect(res.body.posts).toEqual([]);
        expect(res.body.total).toBe(0);
    });

    it('gets a single post by id', async () => {
        const res = await request(app).get('/api/blog/1');
        expect(res.statusCode).toBe(200);
        expect(res.body.post.id).toBe('1');
    });

    it('returns 404 for an unknown post id', async () => {
        const res = await request(app).get('/api/blog/999');
        expect(res.statusCode).toBe(404);
    });
});
