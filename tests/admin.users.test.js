import { jest } from '@jest/globals';
import { createStatefulRedisMock, registerAndLogin, makeSuperAdmin } from './helpers.js';

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: redisMock,
    CACHE_TTL: {
        PRODUCTS_LIST: 300,
        PRODUCT_DETAIL: 600,
        PROFILE: 3600,
        SALE: 60,
        HOME: 300,
        TWO_FA: 300,
    },
    invalidatePattern: jest.fn(),
}));

jest.unstable_mockModule('resend', () => ({
    Resend: class {
        constructor() {
            this.emails = { send: jest.fn().mockResolvedValue({ id: 'mock_email_id' }) };
        }
    }
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');

/**
 * Admin customer-account actions (list/block/reset-password/disable-2FA/delete).
 * Gated by requirePermission("users", <level>) — same RBAC rules as the
 * employees module: roles:['admin'] alone is not enough.
 */

async function loginAs(username) {
    const res = await request(app).post('/api/login').send({ username, password: 'Password123!' });
    return res.body.token;
}

async function makeBareAdmin(username, overrides = {}) {
    await registerAndLogin(request, app, { username, email: `${username}@test.com` });
    await User.updateOne({ username }, { $set: { roles: ['admin'], adminRole: null, permissions: {}, ...overrides } });
    return loginAs(username);
}

describe('Admin users: permission boundary', () => {
    let superAdminToken;
    let bareAdminToken;
    let usersWriteToken;
    let usersReadToken;
    let plainUserToken;
    let targetUserId;

    beforeEach(async () => {
        const superAdmin = await registerAndLogin(request, app, { username: 'usersuperadmin', email: 'usersuperadmin@test.com' });
        await makeSuperAdmin(User, superAdmin.payload.username);
        superAdminToken = await loginAs('usersuperadmin');

        bareAdminToken = await makeBareAdmin('userbareadmin');
        usersWriteToken = await makeBareAdmin('userswriteadmin', { permissions: { users: 'write' } });
        usersReadToken = await makeBareAdmin('usersreadadmin', { permissions: { users: 'read' } });

        const plainUser = await registerAndLogin(request, app, { username: 'plainuser2', email: 'plainuser2@test.com' });
        plainUserToken = plainUser.token;

        const target = await registerAndLogin(request, app, { username: 'targetcustomer', email: 'targetcustomer@test.com' });
        const targetDoc = await User.findOne({ username: target.payload.username });
        targetUserId = targetDoc._id.toString();
    });

    describe('GET /api/admin/users (read)', () => {
        it('rejects a plain user with 403', async () => {
            const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${plainUserToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('rejects a bare admin (no permission grant) with 403', async () => {
            const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${bareAdminToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('allows an admin with users:read', async () => {
            const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${usersReadToken}`);
            expect(res.statusCode).toBe(200);
            expect(Array.isArray(res.body.users)).toBe(true);
            expect(res.body.users.some((u) => u.username === 'targetcustomer')).toBe(true);
        });

        it('allows super_admin', async () => {
            const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${superAdminToken}`);
            expect(res.statusCode).toBe(200);
        });

        it('never leaks password fields in the list', async () => {
            const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${superAdminToken}`);
            expect(res.statusCode).toBe(200);
            for (const u of res.body.users) {
                expect(u.password).toBeUndefined();
            }
        });
    });

    describe('PATCH /api/admin/users/:id/block (write)', () => {
        it('rejects an admin holding only users:read', async () => {
            const res = await request(app)
                .patch(`/api/admin/users/${targetUserId}/block`)
                .set('Authorization', `Bearer ${usersReadToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('rejects a bare admin', async () => {
            const res = await request(app)
                .patch(`/api/admin/users/${targetUserId}/block`)
                .set('Authorization', `Bearer ${bareAdminToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('toggles blocked=true then back to false for an admin with users:write', async () => {
            const first = await request(app)
                .patch(`/api/admin/users/${targetUserId}/block`)
                .set('Authorization', `Bearer ${usersWriteToken}`);
            expect(first.statusCode).toBe(200);
            expect(first.body.blocked).toBe(true);

            const target = await User.findById(targetUserId);
            expect(target.blocked).toBe(true);

            const second = await request(app)
                .patch(`/api/admin/users/${targetUserId}/block`)
                .set('Authorization', `Bearer ${usersWriteToken}`);
            expect(second.statusCode).toBe(200);
            expect(second.body.blocked).toBe(false);
        });

        it('prevents an admin from blocking their own account', async () => {
            const writeAdminDoc = await User.findOne({ username: 'userswriteadmin' });
            const res = await request(app)
                .patch(`/api/admin/users/${writeAdminDoc._id}/block`)
                .set('Authorization', `Bearer ${usersWriteToken}`);
            expect(res.statusCode).toBe(400);
        });

        it('returns 404 for a non-existent user id', async () => {
            const res = await request(app)
                .patch('/api/admin/users/64b000000000000000000000/block')
                .set('Authorization', `Bearer ${usersWriteToken}`);
            expect(res.statusCode).toBe(404);
        });
    });

    describe('PATCH /api/admin/users/:id/reset-password (write)', () => {
        it('rejects a bare admin', async () => {
            const res = await request(app)
                .patch(`/api/admin/users/${targetUserId}/reset-password`)
                .set('Authorization', `Bearer ${bareAdminToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('resets the password for an admin with users:write and returns a temp password', async () => {
            const before = await User.findById(targetUserId).select('+password');
            const res = await request(app)
                .patch(`/api/admin/users/${targetUserId}/reset-password`)
                .set('Authorization', `Bearer ${usersWriteToken}`);
            expect(res.statusCode).toBe(200);
            expect(res.body.tempPassword).toMatch(/^[a-f0-9]{12}$/);

            const after = await User.findById(targetUserId).select('+password');
            expect(after.password).not.toBe(before.password);

            // The temp password actually works for login.
            const loginRes = await request(app)
                .post('/api/login')
                .send({ username: 'targetcustomer', password: res.body.tempPassword });
            expect(loginRes.statusCode).toBe(200);
        });
    });

    describe('PATCH /api/admin/users/:id/disable-2fa (write)', () => {
        it('rejects a bare admin', async () => {
            const res = await request(app)
                .patch(`/api/admin/users/${targetUserId}/disable-2fa`)
                .set('Authorization', `Bearer ${bareAdminToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('disables 2FA for an admin with users:write', async () => {
            await User.updateOne({ _id: targetUserId }, { $set: { twoFactorEnabled: true, twoFactorSecret: 'secret', twoFactorBackupCodes: ['a', 'b'] } });

            const res = await request(app)
                .patch(`/api/admin/users/${targetUserId}/disable-2fa`)
                .set('Authorization', `Bearer ${usersWriteToken}`);
            expect(res.statusCode).toBe(200);

            const target = await User.findById(targetUserId).select('+twoFactorBackupCodes');
            expect(target.twoFactorEnabled).toBe(false);
            expect(target.twoFactorBackupCodes).toHaveLength(0);
        });
    });

    describe('DELETE /api/admin/users/:id (write)', () => {
        it('rejects a bare admin', async () => {
            const res = await request(app)
                .delete(`/api/admin/users/${targetUserId}`)
                .set('Authorization', `Bearer ${bareAdminToken}`);
            expect(res.statusCode).toBe(403);
            expect(await User.findById(targetUserId)).toBeTruthy();
        });

        it('prevents an admin from deleting their own account', async () => {
            const writeAdminDoc = await User.findOne({ username: 'userswriteadmin' });
            const res = await request(app)
                .delete(`/api/admin/users/${writeAdminDoc._id}`)
                .set('Authorization', `Bearer ${usersWriteToken}`);
            expect(res.statusCode).toBe(400);
        });

        it('deletes the user for an admin with users:write', async () => {
            const res = await request(app)
                .delete(`/api/admin/users/${targetUserId}`)
                .set('Authorization', `Bearer ${usersWriteToken}`);
            expect(res.statusCode).toBe(200);
            expect(await User.findById(targetUserId)).toBeNull();
        });

        it('returns 404 deleting a non-existent user', async () => {
            const res = await request(app)
                .delete('/api/admin/users/64b000000000000000000000')
                .set('Authorization', `Bearer ${usersWriteToken}`);
            expect(res.statusCode).toBe(404);
        });
    });

    it('rejects all endpoints without a token', async () => {
        const res = await request(app).get('/api/admin/users');
        expect(res.statusCode).toBe(401);
    });
});
