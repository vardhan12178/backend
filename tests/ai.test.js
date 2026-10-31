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
const rankChatMock = jest.fn();
jest.unstable_mockModule('../services/ai.service.js', () => ({
    handleChat: handleChatMock,
    rankChat: rankChatMock,
    parseSearchQuery: parseSearchQueryMock,
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');

beforeEach(() => {
    handleChatMock.mockReset();
    parseSearchQueryMock.mockReset();
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
        expect(handleChatMock).toHaveBeenCalledWith('best budget laptop', [], { twoPhase: false });
    });

    it('keeps only the last 10 history turns', async () => {
        handleChatMock.mockResolvedValueOnce({ structured: { response: { summary: 'ok', points: [] } }, products: [] });
        const history = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
        const res = await request(app).post('/api/ai/chat').send({ message: 'gaming phone', history });
        expect(res.statusCode).toBe(200);
        expect(handleChatMock).toHaveBeenCalledWith('gaming phone', history.slice(-10), { twoPhase: false });
    });

    it('asks for a two-phase answer when the client supports it', async () => {
        handleChatMock.mockResolvedValue({ structured: { response: { summary: 'ok', points: [] } }, products: [], rank: { token: 't' } });
        await request(app).post('/api/ai/chat').send({ message: 'gaming phone', twoPhase: true });
        expect(handleChatMock).toHaveBeenLastCalledWith('gaming phone', [], { twoPhase: true });
    });
});

describe('AI: POST /api/ai/chat/rank', () => {
    const token = crypto.randomUUID();

    it('rejects a malformed token', async () => {
        const res = await request(app).post('/api/ai/chat/rank').send({ token: 'nope' });
        expect(res.statusCode).toBe(400);
    });

    it('returns 404 for an unknown or expired token', async () => {
        rankChatMock.mockResolvedValueOnce(null);
        const res = await request(app).post('/api/ai/chat/rank').send({ token });
        expect(res.statusCode).toBe(404);
    });

    it('returns the ranked answer', async () => {
        rankChatMock.mockResolvedValueOnce({ structured: { response: { summary: 'best', points: [] } }, products: [{ _id: 'a' }], reranked: true });
        const res = await request(app).post('/api/ai/chat/rank').send({ token });
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ structured: { response: { summary: 'best' } }, products: [{ _id: 'a' }], reranked: true });
        expect(rankChatMock).toHaveBeenCalledWith(token);
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

    it('returns the parsed filters on success, grounded on the storefront categories', async () => {
        parseSearchQueryMock.mockResolvedValueOnce({ q: 'gaming', category: 'laptops', minPrice: null, maxPrice: 50000, minRating: null, sort: 'price_asc' });

        const res = await request(app).post('/api/ai/parse-search').send({ query: 'gaming laptop under 50000' });
        expect(res.statusCode).toBe(200);
        expect(res.body.category).toBe('laptops');
        expect(res.body.sort).toBe('price_asc');
        const [, categories] = parseSearchQueryMock.mock.calls[0];
        expect(categories).toEqual(expect.arrayContaining([{ slug: 'laptops', name: 'Laptops' }, { slug: 'fashion-women', name: "Women's Fashion" }]));
    });

    it('returns 503 with a graceful message when the AI service rejects', async () => {
        parseSearchQueryMock.mockRejectedValueOnce(new Error('AI request timed out'));
        const res = await request(app).post('/api/ai/parse-search').send({ query: 'gaming laptop under 50000' });
        expect(res.statusCode).toBe(503);
        expect(res.body.error).toMatch(/currently busy/i);
    });
});

describe('AI: POST /api/ai/compare', () => {
    it('is gone along with the old catalog', async () => {
        const res = await request(app).post('/api/ai/compare').send({ ids: ['a', 'b'] });
        expect(res.statusCode).toBe(404);
    });
});
