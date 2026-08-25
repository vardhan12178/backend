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
const { default: Settings } = await import('../models/Settings.js');

async function loginAs(username) {
    const res = await request(app).post('/api/login').send({ username, password: 'Password123!' });
    return res.body.token;
}

async function makeBareAdmin(username, overrides = {}) {
    await registerAndLogin(request, app, { username, email: `${username}@test.com` });
    await User.updateOne({ username }, { $set: { roles: ['admin'], adminRole: null, permissions: {}, ...overrides } });
    return loginAs(username);
}

describe('Admin settings (permission-gated)', () => {
    let settingsReadToken;
    let settingsWriteToken;
    let marketingReadToken;
    let marketingWriteToken;
    let bareAdminToken;
    let plainUserToken;

    beforeEach(async () => {
        settingsReadToken = await makeBareAdmin('settingsreadadmin', { permissions: { settings: 'read' } });
        settingsWriteToken = await makeBareAdmin('settingswriteadmin', { permissions: { settings: 'write' } });
        marketingReadToken = await makeBareAdmin('marketingreadadmin', { permissions: { marketing: 'read' } });
        marketingWriteToken = await makeBareAdmin('marketingwriteadmin', { permissions: { marketing: 'write' } });
        bareAdminToken = await makeBareAdmin('settingsbareadmin');
        const plainUser = await registerAndLogin(request, app, { username: 'settingsplainuser', email: 'settingsplainuser@test.com' });
        plainUserToken = plainUser.token;
    });

    describe('GET /api/admin/settings/announcements/public', () => {
        it('is public — no auth required', async () => {
            const res = await request(app).get('/api/admin/settings/announcements/public');
            expect(res.statusCode).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });

        it('only returns active announcements, sorted by sortOrder', async () => {
            await Settings.create({
                announcements: [
                    { text: 'Inactive banner', isActive: false, sortOrder: 0 },
                    { text: 'Second', isActive: true, sortOrder: 2 },
                    { text: 'First', isActive: true, sortOrder: 1 },
                ],
            });
            const res = await request(app).get('/api/admin/settings/announcements/public');
            expect(res.statusCode).toBe(200);
            expect(res.body.map((a) => a.text)).toEqual(['First', 'Second']);
        });
    });

    describe('GET /api/admin/settings (store settings)', () => {
        it('rejects a plain user', async () => {
            const res = await request(app).get('/api/admin/settings').set('Authorization', `Bearer ${plainUserToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('rejects a bare admin', async () => {
            const res = await request(app).get('/api/admin/settings').set('Authorization', `Bearer ${bareAdminToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('auto-creates default settings on first read for an admin with settings:read', async () => {
            const res = await request(app).get('/api/admin/settings').set('Authorization', `Bearer ${settingsReadToken}`);
            expect(res.statusCode).toBe(200);
            expect(res.body.store.storeName).toBe('VKart');
        });
    });

    describe('PUT /api/admin/settings/store', () => {
        it('rejects an admin holding only settings:read', async () => {
            const res = await request(app)
                .put('/api/admin/settings/store')
                .set('Authorization', `Bearer ${settingsReadToken}`)
                .send({ storeName: 'New Name' });
            expect(res.statusCode).toBe(403);
        });

        it('updates store settings for an admin with settings:write', async () => {
            const res = await request(app)
                .put('/api/admin/settings/store')
                .set('Authorization', `Bearer ${settingsWriteToken}`)
                .send({ storeName: 'VKart Prime', freeShippingThreshold: 999, primeEnabled: false });
            expect(res.statusCode).toBe(200);
            expect(res.body.settings.storeName).toBe('VKart Prime');
            expect(res.body.settings.freeShippingThreshold).toBe(999);
            expect(res.body.settings.primeEnabled).toBe(false);
        });
    });

    describe('PUT /api/admin/settings/profile (own profile, any admin)', () => {
        it('rejects a plain (non-admin) user', async () => {
            const res = await request(app)
                .put('/api/admin/settings/profile')
                .set('Authorization', `Bearer ${plainUserToken}`)
                .send({ name: 'New Name' });
            expect(res.statusCode).toBe(403);
        });

        it('allows a bare admin (no module permissions needed — self-service)', async () => {
            const res = await request(app)
                .put('/api/admin/settings/profile')
                .set('Authorization', `Bearer ${bareAdminToken}`)
                .send({ name: 'Self Updated Name' });
            expect(res.statusCode).toBe(200);
            expect(res.body.admin.name).toBe('Self Updated Name');
        });
    });

    describe('Announcements (gated by marketing module, not settings)', () => {
        it('rejects GET /admin/settings/announcements for an admin with only settings:write', async () => {
            const res = await request(app).get('/api/admin/settings/announcements').set('Authorization', `Bearer ${settingsWriteToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('allows GET for an admin with marketing:read', async () => {
            const res = await request(app).get('/api/admin/settings/announcements').set('Authorization', `Bearer ${marketingReadToken}`);
            expect(res.statusCode).toBe(200);
        });

        it('rejects PUT for an admin with only marketing:read', async () => {
            const res = await request(app)
                .put('/api/admin/settings/announcements')
                .set('Authorization', `Bearer ${marketingReadToken}`)
                .send({ announcements: [{ text: 'Sale live now!' }] });
            expect(res.statusCode).toBe(403);
        });

        it('rejects a non-array announcements payload', async () => {
            const res = await request(app)
                .put('/api/admin/settings/announcements')
                .set('Authorization', `Bearer ${marketingWriteToken}`)
                .send({ announcements: 'not-an-array' });
            expect(res.statusCode).toBe(400);
        });

        it('updates announcements for an admin with marketing:write', async () => {
            const res = await request(app)
                .put('/api/admin/settings/announcements')
                .set('Authorization', `Bearer ${marketingWriteToken}`)
                .send({ announcements: [{ text: 'Sale live now!', isActive: true, sortOrder: 0 }] });
            expect(res.statusCode).toBe(200);
            expect(res.body.announcements).toHaveLength(1);
            expect(res.body.announcements[0].text).toBe('Sale live now!');
        });
    });
});
