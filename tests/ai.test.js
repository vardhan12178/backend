import { jest } from '@jest/globals';
import { createStatefulRedisMock, registerAndLogin } from './helpers.js';

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: redisMock,
    CACHE_TTL: { PRODUCTS_LIST: 300, PRODUCT_DETAIL: 600, PROFILE: 3600, SALE: 60, HOME: 300, TWO_FA: 300, COMPARE_SUMMARY: 3600 },
    invalidatePattern: jest.fn(),
}));

jest.unstable_mockModule('resend', () => ({
    Resend: class { constructor() { this.emails = { send: jest.fn().mockResolvedValue({ id: 'mock' }) }; } }
}));

// Thin contract tests only, per explicit scope: mock the AI service entirely
// (it wraps @google/generative-ai) — never assert on LLM output content,
// only request validation / auth / error-handling / response-shape contract.
const handleChatMock = jest.fn();
const parseSearchQueryMock = jest.fn();
const generateComparisonSummaryMock = jest.fn();
jest.unstable_mockModule('../services/ai.service.js', () => ({
    handleChat: handleChatMock,
    parseSearchQuery: parseSearchQueryMock,
    generateComparisonSummary: generateComparisonSummaryMock,
    vectorizeProduct: jest.fn(),
    generateReviewSummary: jest.fn(),
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: Product } = await import('../models/Product.js');

beforeEach(() => {
    handleChatMock.mockReset();
    parseSearchQueryMock.mockReset();
    generateComparisonSummaryMock.mockReset();
});

describe('AI: GET /api/ai/health', () => {
    it('reports online status without requiring auth', async () => {
        const res = await request(app).get('/api/ai/health');
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('online');
    });
});

describe('AI: POST /api/ai/chat', () => {
    it('rejects a too-short message', async () => {
        const res = await request(app).post('/api/ai/chat').send({ message: 'h' });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a non-array history payload', async () => {
        const res = await request(app).post('/api/ai/chat').send({ message: 'hello there', history: 'not-an-array' });
        expect(res.statusCode).toBe(400);
    });

    it('works for a guest (optionalAuth, no token required) and forwards the mocked response shape', async () => {
        handleChatMock.mockResolvedValueOnce({ structured: { response: { summary: 'ok', points: [] } }, products: [] });
        const res = await request(app).post('/api/ai/chat').send({ message: 'best budget laptop' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ structured: { response: { summary: 'ok', points: [] } }, products: [] });
        expect(handleChatMock).toHaveBeenCalledWith('best budget laptop', []);
    });

    it('returns 500 with a graceful message when the AI service rejects', async () => {
        handleChatMock.mockRejectedValueOnce(new Error('Gemini timed out'));
        const res = await request(app).post('/api/ai/chat').send({ message: 'best budget laptop' });
        expect(res.statusCode).toBe(500);
        expect(res.body.error).toMatch(/currently busy/i);
    });

    it('accepts a valid Bearer token too (optionalAuth allows both)', async () => {
        const { token } = await registerAndLogin(request, app, { username: 'aichatuser', email: 'aichatuser@test.com' });
        handleChatMock.mockResolvedValueOnce({ structured: {}, products: [] });
        const res = await request(app)
            .post('/api/ai/chat')
            .set('Authorization', `Bearer ${token}`)
            .send({ message: 'hello world' });
        expect(res.statusCode).toBe(200);
    });
});

describe('AI: POST /api/ai/parse-search', () => {
    it('rejects a too-short query', async () => {
        const res = await request(app).post('/api/ai/parse-search').send({ query: 'ab' });
        expect(res.statusCode).toBe(400);
    });

    it('returns the parsed filters on success', async () => {
        await Product.create({ title: 'X', description: 'Y', category: 'laptops', price: 100, stock: 1, thumbnail: 'http://x.com/i.jpg' });
        parseSearchQueryMock.mockResolvedValueOnce({ q: 'gaming', category: 'laptops', minPrice: null, maxPrice: 50000, minRating: null, sort: 'price_asc' });

        const res = await request(app).post('/api/ai/parse-search').send({ query: 'gaming laptop under 50000' });
        expect(res.statusCode).toBe(200);
        expect(res.body.category).toBe('laptops');
        expect(res.body.sort).toBe('price_asc');
    });

    it('returns 503 with a graceful message when the AI service rejects', async () => {
        parseSearchQueryMock.mockRejectedValueOnce(new Error('AI request timed out'));
        const res = await request(app).post('/api/ai/parse-search').send({ query: 'gaming laptop under 50000' });
        expect(res.statusCode).toBe(503);
        expect(res.body.error).toMatch(/currently busy/i);
    });
});

describe('AI: POST /api/ai/compare', () => {
    it('rejects fewer than 2 product ids', async () => {
        const res = await request(app).post('/api/ai/compare').send({ ids: ['64b000000000000000000000'] });
        expect(res.statusCode).toBe(400);
    });

    it('rejects more than 4 product ids', async () => {
        const ids = Array.from({ length: 5 }, (_, i) => `64b00000000000000000000${i}`);
        const res = await request(app).post('/api/ai/compare').send({ ids });
        expect(res.statusCode).toBe(400);
    });

    it('returns 404 when a product id does not exist', async () => {
        const p1 = await Product.create({ title: 'P1', description: 'd', category: 'c', price: 10, stock: 1, thumbnail: 'http://x.com/i.jpg' });
        const res = await request(app).post('/api/ai/compare').send({ ids: [p1._id.toString(), '64b000000000000000000000'] });
        expect(res.statusCode).toBe(404);
    });

    it('returns the mocked comparison verdict on success', async () => {
        const p1 = await Product.create({ title: 'P1', description: 'd', category: 'c', price: 10, stock: 1, thumbnail: 'http://x.com/i.jpg' });
        const p2 = await Product.create({ title: 'P2', description: 'd', category: 'c', price: 20, stock: 1, thumbnail: 'http://x.com/i.jpg' });
        generateComparisonSummaryMock.mockResolvedValueOnce({
            overallPickId: p1._id.toString(),
            overallReason: 'cheaper',
            perProduct: [{ id: p1._id.toString(), bestFor: 'budget shoppers' }],
        });

        const res = await request(app).post('/api/ai/compare').send({ ids: [p1._id.toString(), p2._id.toString()] });
        expect(res.statusCode).toBe(200);
        expect(res.body.available).toBe(true);
        expect(res.body.overallPickId).toBe(p1._id.toString());
    });

    it('returns 503 with available:false when the AI service rejects', async () => {
        const p1 = await Product.create({ title: 'P1', description: 'd', category: 'c', price: 10, stock: 1, thumbnail: 'http://x.com/i.jpg' });
        const p2 = await Product.create({ title: 'P2', description: 'd', category: 'c', price: 20, stock: 1, thumbnail: 'http://x.com/i.jpg' });
        generateComparisonSummaryMock.mockRejectedValueOnce(new Error('AI request timed out'));

        const res = await request(app).post('/api/ai/compare').send({ ids: [p1._id.toString(), p2._id.toString()] });
        expect(res.statusCode).toBe(503);
        expect(res.body.available).toBe(false);
    });
});
