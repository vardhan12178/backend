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
const { default: Newsletter } = await import('../models/Newsletter.js');

describe('Newsletter subscribe/unsubscribe', () => {
    it('rejects an invalid email', async () => {
        const res = await request(app).post('/api/newsletter/subscribe').send({ email: 'not-an-email' });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a missing email', async () => {
        const res = await request(app).post('/api/newsletter/subscribe').send({});
        expect(res.statusCode).toBe(400);
    });

    it('subscribes a new email, lowercased', async () => {
        const res = await request(app).post('/api/newsletter/subscribe').send({ email: 'Test@Example.com' });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const record = await Newsletter.findOne({ email: 'test@example.com' });
        expect(record).toBeTruthy();
        expect(record.active).toBe(true);
    });

    // The validation regex anchors on ^...$ with no leading trim, so
    // surrounding whitespace fails validation rather than being silently
    // stripped first — documenting that behavior here.
    it('rejects an email with surrounding whitespace (validated before trimming)', async () => {
        const res = await request(app).post('/api/newsletter/subscribe').send({ email: '  test@example.com  ' });
        expect(res.statusCode).toBe(400);
    });

    it('re-subscribing an already-subscribed email is idempotent (upsert, no duplicate error)', async () => {
        await request(app).post('/api/newsletter/subscribe').send({ email: 'dup@example.com' });
        const res = await request(app).post('/api/newsletter/subscribe').send({ email: 'dup@example.com' });
        expect(res.statusCode).toBe(200);

        const count = await Newsletter.countDocuments({ email: 'dup@example.com' });
        expect(count).toBe(1);
    });

    it('re-activates a previously unsubscribed email', async () => {
        await request(app).post('/api/newsletter/subscribe').send({ email: 'resub@example.com' });
        await request(app).post('/api/newsletter/unsubscribe').send({ email: 'resub@example.com' });
        let record = await Newsletter.findOne({ email: 'resub@example.com' });
        expect(record.active).toBe(false);

        await request(app).post('/api/newsletter/subscribe').send({ email: 'resub@example.com' });
        record = await Newsletter.findOne({ email: 'resub@example.com' });
        expect(record.active).toBe(true);
    });

    it('unsubscribes an email', async () => {
        await request(app).post('/api/newsletter/subscribe').send({ email: 'unsub@example.com' });
        const res = await request(app).post('/api/newsletter/unsubscribe').send({ email: 'unsub@example.com' });
        expect(res.statusCode).toBe(200);

        const record = await Newsletter.findOne({ email: 'unsub@example.com' });
        expect(record.active).toBe(false);
    });

    it('rejects unsubscribe with a missing email', async () => {
        const res = await request(app).post('/api/newsletter/unsubscribe').send({});
        expect(res.statusCode).toBe(400);
    });
});
