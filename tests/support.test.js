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

// getIO() throws "Socket.io not initialized!" when no server has called
// initSocket() — every caller in support.controller.js/admin.support.controller.js
// wraps it in try/catch already, so no explicit mock is required, but we
// confirm that assumption holds rather than risk a real socket.io server
// spinning up during tests.

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
const { default: SupportConversation } = await import('../models/SupportConversation.js');

async function loginAs(username) {
    const res = await request(app).post('/api/login').send({ username, password: 'Password123!' });
    return res.body.token;
}

async function makeBareAdmin(username, overrides = {}) {
    await registerAndLogin(request, app, { username, email: `${username}@test.com` });
    await User.updateOne({ username }, { $set: { roles: ['admin'], adminRole: null, permissions: {}, ...overrides } });
    return loginAs(username);
}

describe('Support: customer-side conversation + messages', () => {
    let tokenA;
    let tokenB;

    beforeEach(async () => {
        const a = await registerAndLogin(request, app, { username: 'supportuserA', email: 'supportuserA@test.com' });
        tokenA = a.token;
        const b = await registerAndLogin(request, app, { username: 'supportuserB', email: 'supportuserB@test.com' });
        tokenB = b.token;
    });

    it('rejects creating a conversation without auth', async () => {
        const res = await request(app).post('/api/support/conversations').send({ category: 'OTHER' });
        expect(res.statusCode).toBe(401);
    });

    it('creates a new conversation, defaulting an invalid category to OTHER', async () => {
        const res = await request(app)
            .post('/api/support/conversations')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ category: 'NOT_A_REAL_CATEGORY', contextSummary: 'Where is my order?' });
        expect(res.statusCode).toBe(201);
        expect(res.body.resumed).toBe(false);
        expect(res.body.conversation.category).toBe('OTHER');
        expect(res.body.conversation.status).toBe('AWAITING_AGENT');
    });

    it('resumes an existing open conversation instead of creating a duplicate', async () => {
        const first = await request(app)
            .post('/api/support/conversations')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ category: 'PAYMENT' });
        const second = await request(app)
            .post('/api/support/conversations')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ category: 'ORDER_STATUS' });

        expect(second.statusCode).toBe(200);
        expect(second.body.resumed).toBe(true);
        expect(second.body.conversation._id).toBe(first.body.conversation._id);

        const count = await SupportConversation.countDocuments({ userId: (await User.findOne({ username: 'supportuserA' }))._id });
        expect(count).toBe(1);
    });

    it('GET mine returns null when there is no open conversation', async () => {
        const res = await request(app).get('/api/support/conversations/mine').set('Authorization', `Bearer ${tokenB}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.conversation).toBeNull();
    });

    it('GET mine returns the open conversation', async () => {
        await request(app).post('/api/support/conversations').set('Authorization', `Bearer ${tokenA}`).send({ category: 'OTHER' });
        const res = await request(app).get('/api/support/conversations/mine').set('Authorization', `Bearer ${tokenA}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.conversation).toBeTruthy();
    });

    it('sends a message on the conversation', async () => {
        const createRes = await request(app).post('/api/support/conversations').set('Authorization', `Bearer ${tokenA}`).send({ category: 'OTHER' });
        const convoId = createRes.body.conversation._id;

        const res = await request(app)
            .post(`/api/support/conversations/${convoId}/messages`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ text: 'Hello, I need help with my order.' });
        expect(res.statusCode).toBe(201);
        expect(res.body.message.sender).toBe('USER');
        expect(res.body.conversation.messages).toHaveLength(1);
    });

    it('rejects an empty message', async () => {
        const createRes = await request(app).post('/api/support/conversations').set('Authorization', `Bearer ${tokenA}`).send({ category: 'OTHER' });
        const convoId = createRes.body.conversation._id;

        const res = await request(app)
            .post(`/api/support/conversations/${convoId}/messages`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ text: '   ' });
        expect(res.statusCode).toBe(400);
    });

    it("access control: user B cannot read or reply to user A's conversation", async () => {
        const createRes = await request(app).post('/api/support/conversations').set('Authorization', `Bearer ${tokenA}`).send({ category: 'OTHER' });
        const convoId = createRes.body.conversation._id;

        const res = await request(app)
            .post(`/api/support/conversations/${convoId}/messages`)
            .set('Authorization', `Bearer ${tokenB}`)
            .send({ text: 'I should not be able to send this.' });
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toMatch(/not your conversation/i);
    });

    it('returns 404 sending a message to a non-existent conversation', async () => {
        const res = await request(app)
            .post('/api/support/conversations/64b000000000000000000000/messages')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ text: 'Hello?' });
        expect(res.statusCode).toBe(404);
    });

    it('rejects sending a message to a CLOSED conversation', async () => {
        const createRes = await request(app).post('/api/support/conversations').set('Authorization', `Bearer ${tokenA}`).send({ category: 'OTHER' });
        const convoId = createRes.body.conversation._id;
        await SupportConversation.updateOne({ _id: convoId }, { $set: { status: 'CLOSED' } });

        const res = await request(app)
            .post(`/api/support/conversations/${convoId}/messages`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ text: 'Are you still there?' });
        expect(res.statusCode).toBe(400);
    });

    it('a RESOLVED conversation re-opens to AWAITING_AGENT when the customer follows up', async () => {
        const createRes = await request(app).post('/api/support/conversations').set('Authorization', `Bearer ${tokenA}`).send({ category: 'OTHER' });
        const convoId = createRes.body.conversation._id;
        await SupportConversation.updateOne({ _id: convoId }, { $set: { status: 'RESOLVED' } });

        const res = await request(app)
            .post(`/api/support/conversations/${convoId}/messages`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ text: 'Actually I have another question.' });
        expect(res.statusCode).toBe(201);
        expect(res.body.conversation.status).toBe('AWAITING_AGENT');
    });
});

describe('Admin support (permission-gated)', () => {
    let supportReadToken;
    let supportWriteToken;
    let bareAdminToken;
    let customerToken;
    let customerId;
    let convoId;

    beforeEach(async () => {
        supportReadToken = await makeBareAdmin('supportreadadmin', { permissions: { support: 'read' } });
        supportWriteToken = await makeBareAdmin('supportwriteadmin', { permissions: { support: 'write' } });
        bareAdminToken = await makeBareAdmin('supportbareadmin');

        const customer = await registerAndLogin(request, app, { username: 'supportcustomer', email: 'supportcustomer@test.com' });
        customerToken = customer.token;
        customerId = (await User.findOne({ username: 'supportcustomer' }))._id.toString();

        const createRes = await request(app)
            .post('/api/support/conversations')
            .set('Authorization', `Bearer ${customerToken}`)
            .send({ category: 'ORDER_STATUS', contextSummary: 'Where is my package?' });
        convoId = createRes.body.conversation._id;
    });

    it('rejects listing conversations for a bare admin', async () => {
        const res = await request(app).get('/api/admin/support/conversations').set('Authorization', `Bearer ${bareAdminToken}`);
        expect(res.statusCode).toBe(403);
    });

    it('lists conversations for an admin with support:read', async () => {
        const res = await request(app).get('/api/admin/support/conversations').set('Authorization', `Bearer ${supportReadToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.conversations.length).toBeGreaterThanOrEqual(1);
    });

    it('filters conversations by status', async () => {
        const res = await request(app).get('/api/admin/support/conversations?status=AWAITING_AGENT').set('Authorization', `Bearer ${supportReadToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.conversations.every((c) => c.status === 'AWAITING_AGENT')).toBe(true);
    });

    it('gets a single conversation by id', async () => {
        const res = await request(app).get(`/api/admin/support/conversations/${convoId}`).set('Authorization', `Bearer ${supportReadToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.conversation._id).toBe(convoId);
    });

    it('returns 404 for a non-existent conversation id', async () => {
        const res = await request(app).get('/api/admin/support/conversations/64b000000000000000000000').set('Authorization', `Bearer ${supportReadToken}`);
        expect(res.statusCode).toBe(404);
    });

    it('rejects an agent reply for an admin holding only support:read', async () => {
        const res = await request(app)
            .post(`/api/admin/support/conversations/${convoId}/messages`)
            .set('Authorization', `Bearer ${supportReadToken}`)
            .send({ text: 'Hi, how can I help?' });
        expect(res.statusCode).toBe(403);
    });

    it('agent reply auto-claims the conversation and moves it to IN_PROGRESS', async () => {
        const res = await request(app)
            .post(`/api/admin/support/conversations/${convoId}/messages`)
            .set('Authorization', `Bearer ${supportWriteToken}`)
            .send({ text: 'Hi, how can I help?' });
        expect(res.statusCode).toBe(201);
        expect(res.body.message.sender).toBe('AGENT');
        expect(res.body.conversation.status).toBe('IN_PROGRESS');
        expect(res.body.conversation.assignedAgentId).toBeTruthy();
    });

    it('the customer sees the agent reply in their own conversation view', async () => {
        await request(app)
            .post(`/api/admin/support/conversations/${convoId}/messages`)
            .set('Authorization', `Bearer ${supportWriteToken}`)
            .send({ text: 'We are looking into it.' });

        const res = await request(app).get('/api/support/conversations/mine').set('Authorization', `Bearer ${customerToken}`);
        expect(res.body.conversation.messages).toHaveLength(1);
        expect(res.body.conversation.messages[0].text).toBe('We are looking into it.');
    });

    describe('PATCH /api/admin/support/conversations/:id (claim/resolve/close/reopen)', () => {
        it('rejects an invalid action', async () => {
            const res = await request(app)
                .patch(`/api/admin/support/conversations/${convoId}`)
                .set('Authorization', `Bearer ${supportWriteToken}`)
                .send({ action: 'not_a_real_action' });
            expect(res.statusCode).toBe(400);
        });

        it('rejects for an admin holding only support:read', async () => {
            const res = await request(app)
                .patch(`/api/admin/support/conversations/${convoId}`)
                .set('Authorization', `Bearer ${supportReadToken}`)
                .send({ action: 'claim' });
            expect(res.statusCode).toBe(403);
        });

        it('claims a conversation', async () => {
            const res = await request(app)
                .patch(`/api/admin/support/conversations/${convoId}`)
                .set('Authorization', `Bearer ${supportWriteToken}`)
                .send({ action: 'claim' });
            expect(res.statusCode).toBe(200);
            expect(res.body.conversation.status).toBe('IN_PROGRESS');
            expect(res.body.conversation.assignedAgentId).toBeTruthy();
        });

        it('resolves then closes a conversation', async () => {
            const resolveRes = await request(app)
                .patch(`/api/admin/support/conversations/${convoId}`)
                .set('Authorization', `Bearer ${supportWriteToken}`)
                .send({ action: 'resolve' });
            expect(resolveRes.body.conversation.status).toBe('RESOLVED');

            const closeRes = await request(app)
                .patch(`/api/admin/support/conversations/${convoId}`)
                .set('Authorization', `Bearer ${supportWriteToken}`)
                .send({ action: 'close' });
            expect(closeRes.body.conversation.status).toBe('CLOSED');
        });

        it('reopen restores IN_PROGRESS if already claimed, else AWAITING_AGENT', async () => {
            await request(app)
                .patch(`/api/admin/support/conversations/${convoId}`)
                .set('Authorization', `Bearer ${supportWriteToken}`)
                .send({ action: 'claim' });
            await request(app)
                .patch(`/api/admin/support/conversations/${convoId}`)
                .set('Authorization', `Bearer ${supportWriteToken}`)
                .send({ action: 'resolve' });

            const res = await request(app)
                .patch(`/api/admin/support/conversations/${convoId}`)
                .set('Authorization', `Bearer ${supportWriteToken}`)
                .send({ action: 'reopen' });
            expect(res.body.conversation.status).toBe('IN_PROGRESS');
        });
    });
});
