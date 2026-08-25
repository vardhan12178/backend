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
 * Employees / RBAC.
 *
 * The critical security property under test: `roles: ['admin']` alone is
 * NOT sufficient for any write action. A caller needs either
 * `adminRole: 'super_admin'` OR an explicit `permissions.<module>: 'write'`
 * grant (checked by middleware/permissions.js#requirePermission). This
 * suite exercises that boundary directly on the employees module itself
 * (the module that manages every other module's access), plus the extra
 * requireSuperAdminForRoleAssignment guard stacked on create/update.
 */

async function loginAs(username) {
    const res = await request(app).post('/api/login').send({ username, password: 'Password123!' });
    return res.body.token;
}

/** Register a plain user, promote to bare admin (roles:['admin'], no adminRole, no permissions). */
async function makeBareAdmin(username, overrides = {}) {
    await registerAndLogin(request, app, { username, email: `${username}@test.com` });
    await User.updateOne({ username }, { $set: { roles: ['admin'], adminRole: null, permissions: {}, ...overrides } });
    return loginAs(username);
}

describe('Employees: permission boundary (roles:[admin] alone is not enough)', () => {
    let superAdminToken;
    let bareAdminToken;
    let plainUserToken;
    let targetUserId;

    beforeEach(async () => {
        const superAdmin = await registerAndLogin(request, app, { username: 'superadmin1', email: 'superadmin1@test.com' });
        await makeSuperAdmin(User, superAdmin.payload.username);
        superAdminToken = await loginAs('superadmin1');

        bareAdminToken = await makeBareAdmin('bareadmin1');

        const plainUser = await registerAndLogin(request, app, { username: 'plainuser1', email: 'plainuser1@test.com' });
        plainUserToken = plainUser.token;

        const target = await registerAndLogin(request, app, { username: 'targetuser1', email: 'targetuser1@test.com' });
        const targetDoc = await User.findOne({ username: target.payload.username });
        targetUserId = targetDoc._id.toString();
    });

    it('rejects list (read) for a plain non-admin user with 403', async () => {
        const res = await request(app)
            .get('/api/admin/employees')
            .set('Authorization', `Bearer ${plainUserToken}`);
        expect(res.statusCode).toBe(403);
    });

    it('rejects list (read) for an admin with roles:[admin] but no adminRole/permissions', async () => {
        const res = await request(app)
            .get('/api/admin/employees')
            .set('Authorization', `Bearer ${bareAdminToken}`);
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/missing read access to employees/i);
    });

    it('allows list (read) for super_admin', async () => {
        const res = await request(app)
            .get('/api/admin/employees')
            .set('Authorization', `Bearer ${superAdminToken}`);
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.body.employees)).toBe(true);
    });

    it('rejects addEmployee (write) for a bare admin (roles:[admin], no permission grant)', async () => {
        const res = await request(app)
            .post('/api/admin/employees')
            .set('Authorization', `Bearer ${bareAdminToken}`)
            .send({ email: 'targetuser1@test.com', adminRole: 'reviewer' });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/missing write access to employees/i);

        // Confirm nothing changed on the target.
        const target = await User.findById(targetUserId);
        expect(target.adminRole).toBeNull();
    });

    it('allows addEmployee for an admin with explicit permissions.employees=write, for non-super_admin roles', async () => {
        const grantedToken = await makeBareAdmin('grantedadmin1', { permissions: { employees: 'write' } });

        const res = await request(app)
            .post('/api/admin/employees')
            .set('Authorization', `Bearer ${grantedToken}`)
            .send({ email: 'targetuser1@test.com', adminRole: 'reviewer' });
        expect(res.statusCode).toBe(201);
        expect(res.body.employee.adminRole).toBe('reviewer');

        const target = await User.findById(targetUserId);
        expect(target.adminRole).toBe('reviewer');
        expect(target.roles).toContain('admin');
    });

    it('blocks a non-super_admin (even with employees:write) from granting super_admin to someone else', async () => {
        const grantedToken = await makeBareAdmin('grantedadmin2', { permissions: { employees: 'write' } });

        const res = await request(app)
            .post('/api/admin/employees')
            .set('Authorization', `Bearer ${grantedToken}`)
            .send({ email: 'targetuser1@test.com', adminRole: 'super_admin' });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/only a super admin can grant super admin/i);
    });

    it('blocks a non-super_admin (even with employees:write) from granting the employees module via permissions payload', async () => {
        const grantedToken = await makeBareAdmin('grantedadmin3', { permissions: { employees: 'write' } });

        const res = await request(app)
            .post('/api/admin/employees')
            .set('Authorization', `Bearer ${grantedToken}`)
            .send({ email: 'targetuser1@test.com', adminRole: 'reviewer', permissions: { employees: 'write' } });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/only a super admin can grant employees module access/i);
    });

    it('allows super_admin to grant super_admin to another user', async () => {
        const res = await request(app)
            .post('/api/admin/employees')
            .set('Authorization', `Bearer ${superAdminToken}`)
            .send({ email: 'targetuser1@test.com', adminRole: 'super_admin' });
        expect(res.statusCode).toBe(201);

        const target = await User.findById(targetUserId);
        expect(target.adminRole).toBe('super_admin');
    });

    it('rejects updateEmployee (write) for a bare admin', async () => {
        await User.updateOne({ _id: targetUserId }, { $set: { roles: ['user', 'admin'], adminRole: 'reviewer' } });

        const res = await request(app)
            .patch(`/api/admin/employees/${targetUserId}`)
            .set('Authorization', `Bearer ${bareAdminToken}`)
            .send({ adminRole: 'order_manager' });
        expect(res.statusCode).toBe(403);
    });

    it('rejects revokeEmployee (write) for a bare admin', async () => {
        await User.updateOne({ _id: targetUserId }, { $set: { roles: ['user', 'admin'], adminRole: 'reviewer' } });

        const res = await request(app)
            .delete(`/api/admin/employees/${targetUserId}`)
            .set('Authorization', `Bearer ${bareAdminToken}`);
        expect(res.statusCode).toBe(403);

        const target = await User.findById(targetUserId);
        expect(target.adminRole).toBe('reviewer'); // unchanged
    });

    it('allows revokeEmployee for super_admin and strips admin role/permissions', async () => {
        await User.updateOne(
            { _id: targetUserId },
            { $set: { roles: ['user', 'admin'], adminRole: 'reviewer', permissions: { reviews: 'write' } } }
        );

        const res = await request(app)
            .delete(`/api/admin/employees/${targetUserId}`)
            .set('Authorization', `Bearer ${superAdminToken}`);
        expect(res.statusCode).toBe(200);

        const target = await User.findById(targetUserId);
        expect(target.adminRole).toBeNull();
        expect(target.roles).not.toContain('admin');
        expect(Object.keys(target.permissions?.toObject?.() || target.permissions || {})).toHaveLength(0);
    });

    it('prevents an admin from modifying their own access via updateEmployee', async () => {
        const superAdminDoc = await User.findOne({ username: 'superadmin1' });
        const res = await request(app)
            .patch(`/api/admin/employees/${superAdminDoc._id}`)
            .set('Authorization', `Bearer ${superAdminToken}`)
            .send({ adminRole: 'reviewer' });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/cannot modify your own access/i);
    });

    it('prevents an admin from revoking their own access', async () => {
        const superAdminDoc = await User.findOne({ username: 'superadmin1' });
        const res = await request(app)
            .delete(`/api/admin/employees/${superAdminDoc._id}`)
            .set('Authorization', `Bearer ${superAdminToken}`);
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/cannot revoke your own access/i);
    });

    it('prevents a non-super_admin from modifying another super_admin, even with employees:write', async () => {
        const grantedToken = await makeBareAdmin('grantedadmin4', { permissions: { employees: 'write' } });
        await User.updateOne({ _id: targetUserId }, { $set: { roles: ['user', 'admin'], adminRole: 'super_admin' } });

        const res = await request(app)
            .patch(`/api/admin/employees/${targetUserId}`)
            .set('Authorization', `Bearer ${grantedToken}`)
            .send({ adminRole: 'reviewer' });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/only a super admin can modify another super admin/i);
    });

    it('rejects requests with no auth token at all', async () => {
        const res = await request(app).get('/api/admin/employees');
        expect(res.statusCode).toBe(401);
    });

    it('rejects addEmployee for an unknown email with 404', async () => {
        const res = await request(app)
            .post('/api/admin/employees')
            .set('Authorization', `Bearer ${superAdminToken}`)
            .send({ email: 'nobody@nowhere.com', adminRole: 'reviewer' });
        expect(res.statusCode).toBe(404);
    });

    it('rejects addEmployee for an already-employee account with 409', async () => {
        await User.updateOne({ _id: targetUserId }, { $set: { roles: ['user', 'admin'], adminRole: 'reviewer' } });
        const res = await request(app)
            .post('/api/admin/employees')
            .set('Authorization', `Bearer ${superAdminToken}`)
            .send({ email: 'targetuser1@test.com', adminRole: 'order_manager' });
        expect(res.statusCode).toBe(409);
    });

    it('rejects addEmployee with an invalid adminRole', async () => {
        const res = await request(app)
            .post('/api/admin/employees')
            .set('Authorization', `Bearer ${superAdminToken}`)
            .send({ email: 'targetuser1@test.com', adminRole: 'not_a_real_role' });
        expect(res.statusCode).toBe(400);
    });

    it('applies the role preset permissions when none are explicitly supplied', async () => {
        const res = await request(app)
            .post('/api/admin/employees')
            .set('Authorization', `Bearer ${superAdminToken}`)
            .send({ email: 'targetuser1@test.com', adminRole: 'sales_manager' });
        expect(res.statusCode).toBe(201);
        expect(res.body.employee.permissions).toMatchObject({
            coupons: 'write', sales: 'write', membership: 'write', marketing: 'write', notifications: 'read',
        });
    });

    it('a scoped-permission admin (e.g. reviews:write) still cannot read the employees list', async () => {
        const reviewerToken = await makeBareAdmin('reviewer_only', { permissions: { reviews: 'write' } });
        const res = await request(app)
            .get('/api/admin/employees')
            .set('Authorization', `Bearer ${reviewerToken}`);
        expect(res.statusCode).toBe(403);
    });
});
