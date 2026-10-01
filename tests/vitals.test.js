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
const { normalizePath } = await import('../controllers/vitals.controller.js');

const beacon = (body) => request(app).post('/api/vitals').send(body);

describe('Web vitals', () => {
    beforeEach(async () => {
        await redisMock.del('vitals:LCP', 'vitals:INP', 'vitals:CLS', 'vitals:FCP', 'vitals:TTFB');
    });

    describe('POST /api/vitals', () => {
        it('stores a valid sample anonymously and answers 204', async () => {
            const res = await beacon({ name: 'LCP', value: 1834.27, rating: 'good', path: '/products?q=phone' });
            expect(res.status).toBe(204);

            const stored = await redisMock.lrange('vitals:LCP', 0, -1);
            expect(stored).toHaveLength(1);
            expect(JSON.parse(stored[0])).toMatchObject({ v: 1834.27, r: 'good', p: '/products' });
        });

        it('silently drops invalid samples (still 204, nothing stored)', async () => {
            const bad = [
                { name: 'BOGUS', value: 10, rating: 'good', path: '/' },
                { name: 'LCP', value: -5, rating: 'good', path: '/' },
                { name: 'LCP', value: 'abc', rating: 'good', path: '/' },
                { name: 'LCP', value: 999999999, rating: 'good', path: '/' },
                { name: 'CLS', value: 50, rating: 'poor', path: '/' },
                { name: 'LCP', value: 100, rating: 'excellent', path: '/' },
                {},
            ];
            for (const body of bad) {
                const res = await beacon(body);
                expect(res.status).toBe(204);
            }
            for (const name of ['LCP', 'CLS']) {
                expect(await redisMock.lrange(`vitals:${name}`, 0, -1)).toHaveLength(0);
            }
        });

        it('keeps only the most recent 1000 samples per metric', async () => {
            await redisMock.del('vitals:TTFB');
            for (let i = 0; i < 1003; i += 1) {
                await redisMock.lpush('vitals:TTFB', JSON.stringify({ v: i, r: 'good', p: '/', t: 1 }));
            }
            await beacon({ name: 'TTFB', value: 5, rating: 'good', path: '/' });
            const stored = await redisMock.lrange('vitals:TTFB', 0, -1);
            expect(stored).toHaveLength(1000);
            expect(JSON.parse(stored[0]).v).toBe(5);
        });
    });

    describe('normalizePath', () => {
        it('collapses ids and strips query strings so no identifiers are stored', () => {
            expect(normalizePath('/product/66f0a1b2c3d4e5f6a7b8c9d0?ref=home')).toBe('/product/:id');
            expect(normalizePath('/orders/12345')).toBe('/orders/:id');
            expect(normalizePath('/order-success/VK-2026-000123')).toBe('/order-success/:id');
            expect(normalizePath('/products')).toBe('/products');
            expect(normalizePath('/reset/' + 'x'.repeat(64))).toBe('/reset/:id');
            expect(normalizePath('https://evil.example/')).toBe('/');
            expect(normalizePath('//evil.example/x')).toBe('/');
            expect(normalizePath(undefined)).toBe('/');
        });
    });

    describe('GET /api/admin/vitals', () => {
        it('rejects anonymous and non-admin callers', async () => {
            expect((await request(app).get('/api/admin/vitals')).status).toBe(401);

            const { token } = await registerAndLogin(request, app);
            const res = await request(app).get('/api/admin/vitals').set('Authorization', `Bearer ${token}`);
            expect(res.status).toBe(403);
        });

        it('returns p75 and rating split per metric for admins', async () => {
            const { payload } = await registerAndLogin(request, app);
            await makeSuperAdmin(User, payload.username);
            const login = await request(app).post('/api/login').send({ username: payload.username, password: payload.password });
            const token = login.body.token;

            const values = [1000, 1500, 2000, 3000];
            const ratings = ['good', 'good', 'good', 'needs-improvement'];
            for (let i = 0; i < values.length; i += 1) {
                await beacon({ name: 'LCP', value: values[i], rating: ratings[i], path: '/' });
            }

            const res = await request(app).get('/api/admin/vitals').set('Authorization', `Bearer ${token}`);
            expect(res.status).toBe(200);
            expect(res.body.metrics.LCP).toMatchObject({ count: 4, p75: 2000, good: 75, needsImprovement: 25, poor: 0 });
            expect(res.body.metrics.INP).toMatchObject({ count: 0, p75: null });
        });
    });
});
