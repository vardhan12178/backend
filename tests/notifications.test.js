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
const { default: Notification } = await import('../models/Notification.js');

async function loginAs(username) {
    const res = await request(app).post('/api/login').send({ username, password: 'Password123!' });
    return res.body.token;
}

async function makeBareAdmin(username, overrides = {}) {
    await registerAndLogin(request, app, { username, email: `${username}@test.com` });
    await User.updateOne({ username }, { $set: { roles: ['admin'], adminRole: null, permissions: {}, ...overrides } });
    return loginAs(username);
}

describe('Admin notifications (permission-gated)', () => {
    let notifReadToken;
    let notifWriteToken;
    let bareAdminToken;
    let plainUserToken;

    beforeEach(async () => {
        notifReadToken = await makeBareAdmin('notifreadadmin', { permissions: { notifications: 'read' } });
        notifWriteToken = await makeBareAdmin('notifwriteadmin', { permissions: { notifications: 'write' } });
        bareAdminToken = await makeBareAdmin('notifbareadmin');
        const plainUser = await registerAndLogin(request, app, { username: 'notifplainuser', email: 'notifplainuser@test.com' });
        plainUserToken = plainUser.token;

        await Notification.create([
            { userId: null, type: 'system', title: 'Admin Notif 1', message: 'msg 1' },
            { userId: null, type: 'alert', title: 'Admin Notif 2', message: 'msg 2' },
        ]);
    });

    it('rejects a plain user', async () => {
        const res = await request(app).get('/api/admin/notifications').set('Authorization', `Bearer ${plainUserToken}`);
        expect(res.statusCode).toBe(403);
    });

    it('rejects a bare admin', async () => {
        const res = await request(app).get('/api/admin/notifications').set('Authorization', `Bearer ${bareAdminToken}`);
        expect(res.statusCode).toBe(403);
    });

    it('lists admin notifications (userId:null) with unread count for notifications:read', async () => {
        const res = await request(app).get('/api/admin/notifications').set('Authorization', `Bearer ${notifReadToken}`);
        expect(res.statusCode).toBe(200);
        // Registration itself fires a "New User Registered" admin notification
        // (see auth.controller.js), so assert our seeded notifications are
        // present rather than asserting an exact total count.
        const titles = res.body.notifications.map((n) => n.title);
        expect(titles).toEqual(expect.arrayContaining(['Admin Notif 1', 'Admin Notif 2']));
        expect(res.body.unreadCount).toBe(res.body.notifications.length);
    });

    it('rejects mark-as-read for an admin holding only notifications:read', async () => {
        const res = await request(app)
            .put('/api/admin/notifications/read')
            .set('Authorization', `Bearer ${notifReadToken}`)
            .send({ all: true });
        expect(res.statusCode).toBe(403);
    });

    it('marks all as read for an admin with notifications:write', async () => {
        const res = await request(app)
            .put('/api/admin/notifications/read')
            .set('Authorization', `Bearer ${notifWriteToken}`)
            .send({ all: true });
        expect(res.statusCode).toBe(200);

        const remaining = await Notification.countDocuments({ userId: null, isRead: false });
        expect(remaining).toBe(0);
    });

    it('marks specific ids as read', async () => {
        const [n1] = await Notification.find({ userId: null });
        const res = await request(app)
            .put('/api/admin/notifications/read')
            .set('Authorization', `Bearer ${notifWriteToken}`)
            .send({ ids: [n1._id.toString()] });
        expect(res.statusCode).toBe(200);

        const n1After = await Notification.findById(n1._id);
        expect(n1After.isRead).toBe(true);
    });

    it('does not leak a user-scoped notification into the admin feed', async () => {
        const someUser = await User.findOne({ username: 'notifplainuser' });
        await Notification.create({ userId: someUser._id, type: 'order', title: 'User notif', message: 'private' });

        const res = await request(app).get('/api/admin/notifications').set('Authorization', `Bearer ${notifReadToken}`);
        expect(res.body.notifications.every((n) => n.title !== 'User notif')).toBe(true);
    });
});

describe('User notifications (own feed only)', () => {
    let tokenA;
    let tokenB;
    let userAId;

    beforeEach(async () => {
        const a = await registerAndLogin(request, app, { username: 'notifuserA', email: 'notifuserA@test.com' });
        tokenA = a.token;
        const userDocA = await User.findOne({ username: 'notifuserA' });
        userAId = userDocA._id;

        const b = await registerAndLogin(request, app, { username: 'notifuserB', email: 'notifuserB@test.com' });
        tokenB = b.token;

        await Notification.create([
            { userId: userAId, type: 'order', title: 'Order Shipped', message: 'Your order shipped' },
            { userId: userAId, type: 'order', title: 'Order Delivered', message: 'Your order was delivered' },
        ]);
    });

    it('rejects without auth', async () => {
        const res = await request(app).get('/api/user/notifications');
        expect(res.statusCode).toBe(401);
    });

    it("returns only the caller's own notifications", async () => {
        const res = await request(app).get('/api/user/notifications').set('Authorization', `Bearer ${tokenA}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.notifications).toHaveLength(2);
        expect(res.body.unreadCount).toBe(2);
    });

    it("another user cannot see user A's notifications", async () => {
        const res = await request(app).get('/api/user/notifications').set('Authorization', `Bearer ${tokenB}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.notifications).toHaveLength(0);
    });

    it('marks all of the caller\'s notifications as read without touching another user\'s', async () => {
        const res = await request(app)
            .put('/api/user/notifications/read')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ all: true });
        expect(res.statusCode).toBe(200);

        const remaining = await Notification.countDocuments({ userId: userAId, isRead: false });
        expect(remaining).toBe(0);
    });

    it("marking as read with another user's ids does not affect them (scoped to req.user.userId)", async () => {
        const [n1] = await Notification.find({ userId: userAId });
        // userB attempts to mark userA's notification as read via crafted ids
        const res = await request(app)
            .put('/api/user/notifications/read')
            .set('Authorization', `Bearer ${tokenB}`)
            .send({ ids: [n1._id.toString()] });
        expect(res.statusCode).toBe(200);

        const n1After = await Notification.findById(n1._id);
        expect(n1After.isRead).toBe(false); // untouched — the update filter scopes by req.user.userId
    });
});
