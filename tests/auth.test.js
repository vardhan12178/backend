import { jest } from '@jest/globals';
import { createStatefulRedisMock, registerUser, loginUser, registerAndLogin } from './helpers.js';

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

const sendMock = jest.fn().mockResolvedValue({ id: 'mock_email_id' });
jest.unstable_mockModule('resend', () => ({
    Resend: class {
        constructor() {
            this.emails = { send: sendMock };
        }
    }
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');

const validUser = {
    name: 'Test User',
    username: 'testu',
    email: 'test@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
};

describe('Auth: register', () => {
    beforeEach(() => sendMock.mockClear());

    it('registers a new user with a hashed password', async () => {
        const res = await request(app).post('/api/register').send(validUser);

        expect(res.statusCode).toBe(201);
        expect(res.body).toHaveProperty('message', 'User registered successfully');

        const user = await User.findOne({ email: validUser.email }).select('+password');
        expect(user).toBeTruthy();
        expect(user.password).not.toBe(validUser.password);
        expect(user.emailVerified).toBe(false);
        expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('lowercases and trims username/email on registration', async () => {
        const res = await request(app).post('/api/register').send({
            ...validUser,
            username: '  TestU  ',
            email: '  TEST@Example.com  ',
        });
        expect(res.statusCode).toBe(201);
        const user = await User.findOne({ username: 'testu' });
        expect(user).toBeTruthy();
        expect(user.email).toBe('test@example.com');
    });

    it('rejects duplicate email with a different username', async () => {
        await request(app).post('/api/register').send(validUser);
        const res = await request(app).post('/api/register').send({
            ...validUser,
            username: 'anotheru',
        });
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/email already exists/i);
    });

    it('rejects duplicate username with a different email', async () => {
        await request(app).post('/api/register').send(validUser);
        const res = await request(app).post('/api/register').send({
            ...validUser,
            email: 'other@example.com',
        });
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/username already exists/i);
    });

    it('rejects a password shorter than 8 characters', async () => {
        const res = await request(app).post('/api/register').send({
            ...validUser,
            password: 'Pass1!',
            confirmPassword: 'Pass1!',
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/at least 8 characters/i);
    });

    it('rejects mismatched password/confirmPassword', async () => {
        const res = await request(app).post('/api/register').send({
            ...validUser,
            confirmPassword: 'Different123!',
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/do not match/i);
    });

    it('rejects registration missing required fields', async () => {
        const res = await request(app).post('/api/register').send({ name: 'No Fields' });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/missing required fields/i);
    });
});

describe('Auth: login', () => {
    beforeEach(async () => {
        await request(app).post('/api/register').send(validUser);
    });

    it('logs in with valid credentials and returns a token + user session', async () => {
        const res = await request(app).post('/api/login').send({
            username: validUser.username,
            password: validUser.password,
        });

        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('token');
        expect(res.body.authenticated).toBe(true);
        expect(res.body.user.username).toBe(validUser.username);
        expect(res.body.user).not.toHaveProperty('password');
    });

    it('logs in using the email instead of username', async () => {
        const res = await request(app).post('/api/login').send({
            username: validUser.email,
            password: validUser.password,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('token');
    });

    it('rejects an unknown user', async () => {
        const res = await request(app).post('/api/login').send({
            username: 'doesnotexist',
            password: 'whatever123',
        });
        expect(res.statusCode).toBe(401);
    });

    it('rejects a wrong password', async () => {
        const res = await request(app).post('/api/login').send({
            username: validUser.username,
            password: 'WrongPassword1!',
        });
        expect(res.statusCode).toBe(401);
        expect(res.body.message).toMatch(/invalid credentials/i);
    });

    it('rejects login for a blocked account', async () => {
        await User.updateOne({ username: validUser.username }, { $set: { blocked: true } });
        const res = await request(app).post('/api/login').send({
            username: validUser.username,
            password: validUser.password,
        });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/suspended/i);
    });

    it('rejects malformed payload with missing password', async () => {
        const res = await request(app).post('/api/login').send({ username: validUser.username });
        expect(res.statusCode).toBe(400);
    });

    // The controller does not currently gate login on emailVerified — an
    // unverified user can still log in and gets a normal session token.
    // (Note: the session payload's user-select projection doesn't even
    // include emailVerified, so we assert against the DB directly.)
    it('allows login for an unverified email (no verification gate on login)', async () => {
        const res = await request(app).post('/api/login').send({
            username: validUser.username,
            password: validUser.password,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('token');

        const user = await User.findOne({ username: validUser.username });
        expect(user.emailVerified).toBe(false);
    });
});

describe('Auth: logout', () => {
    it('clears the session cookie and revokes the token so it cannot be reused', async () => {
        await registerUser(request, app, {
            username: 'logoutuser',
            email: 'logoutuser@test.com',
        });
        const loginRes = await loginUser(request, app, { username: 'logoutuser', password: 'Password123!' });
        const token = loginRes.body.token;

        // Token works before logout.
        const before = await request(app)
            .get('/api/auth/check')
            .set('Authorization', `Bearer ${token}`);
        expect(before.body.authenticated).toBe(true);

        const logoutRes = await request(app)
            .post('/api/logout')
            .set('Authorization', `Bearer ${token}`);
        expect(logoutRes.statusCode).toBe(200);
        expect(logoutRes.body.message).toMatch(/logged out/i);

        // Revoked token must now be rejected by authenticateJWT.
        const resendRes = await request(app)
            .post('/api/resend-verify')
            .set('Authorization', `Bearer ${token}`);
        expect(resendRes.statusCode).toBe(401);
        expect(resendRes.body.error).toBe('token invalidated');
    });

    it('logs out gracefully even without a token', async () => {
        const res = await request(app).post('/api/logout');
        expect(res.statusCode).toBe(200);
    });
});

describe('Auth: auth/check', () => {
    it('returns authenticated:false when no token is present', async () => {
        const res = await request(app).get('/api/auth/check');
        expect(res.statusCode).toBe(200);
        expect(res.body.authenticated).toBe(false);
    });

    it('returns authenticated:true with the user session for a valid token', async () => {
        const { token } = await registerAndLogin(request, app, {
            username: 'checkuser',
            email: 'checkuser@test.com',
        });
        const res = await request(app)
            .get('/api/auth/check')
            .set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.authenticated).toBe(true);
        expect(res.body.user.username).toBe('checkuser');
    });
});

describe('Auth: forgot / reset password', () => {
    beforeEach(async () => {
        await request(app).post('/api/register').send(validUser);
        sendMock.mockClear();
    });

    it('returns the same generic message whether or not the account exists (no enumeration)', async () => {
        const existing = await request(app).post('/api/forgot').send({ emailOrUsername: validUser.email });
        const missing = await request(app).post('/api/forgot').send({ emailOrUsername: 'nobody@nowhere.com' });

        expect(existing.statusCode).toBe(200);
        expect(missing.statusCode).toBe(200);
        expect(existing.body.message).toBe(missing.body.message);
        expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('stores a reset token hash on the user for a real account', async () => {
        await request(app).post('/api/forgot').send({ emailOrUsername: validUser.username });
        const user = await User.findOne({ username: validUser.username }).select('+resetPasswordTokenHash');
        expect(user.resetPasswordTokenHash).toBeTruthy();
        expect(user.resetPasswordExpiresAt).toBeTruthy();
    });

    it('resets the password with a valid raw token extracted from the sent email link', async () => {
        await request(app).post('/api/forgot').send({ emailOrUsername: validUser.email });
        const emailHtml = sendMock.mock.calls[0][0].html;
        const rawToken = emailHtml.match(/token=([a-f0-9]+)/)[1];

        const res = await request(app).post('/api/reset').send({
            token: rawToken,
            password: 'NewPassword123!',
            confirmPassword: 'NewPassword123!',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.message).toMatch(/password reset successful/i);

        // Old password no longer works, new one does.
        const oldLogin = await request(app).post('/api/login').send({
            username: validUser.username,
            password: validUser.password,
        });
        expect(oldLogin.statusCode).toBe(401);

        const newLogin = await request(app).post('/api/login').send({
            username: validUser.username,
            password: 'NewPassword123!',
        });
        expect(newLogin.statusCode).toBe(200);
    });

    it('rejects reset with an invalid/unknown token', async () => {
        const res = await request(app).post('/api/reset').send({
            token: 'not-a-real-token',
            password: 'NewPassword123!',
            confirmPassword: 'NewPassword123!',
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/invalid or expired token/i);
    });

    it('rejects reset with an expired token', async () => {
        await request(app).post('/api/forgot').send({ emailOrUsername: validUser.email });
        const emailHtml = sendMock.mock.calls[0][0].html;
        const rawToken = emailHtml.match(/token=([a-f0-9]+)/)[1];

        // Force the stored expiry into the past.
        await User.updateOne(
            { username: validUser.username },
            { $set: { resetPasswordExpiresAt: new Date(Date.now() - 1000) } }
        );

        const res = await request(app).post('/api/reset').send({
            token: rawToken,
            password: 'NewPassword123!',
            confirmPassword: 'NewPassword123!',
        });
        expect(res.statusCode).toBe(400);
    });

    it('rejects reset with mismatched confirmPassword', async () => {
        await request(app).post('/api/forgot').send({ emailOrUsername: validUser.email });
        const emailHtml = sendMock.mock.calls[0][0].html;
        const rawToken = emailHtml.match(/token=([a-f0-9]+)/)[1];

        const res = await request(app).post('/api/reset').send({
            token: rawToken,
            password: 'NewPassword123!',
            confirmPassword: 'DifferentPassword123!',
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/do not match/i);
    });

    it('rejects reset with a too-short new password', async () => {
        const res = await request(app).post('/api/reset').send({
            token: 'irrelevant',
            password: 'short',
            confirmPassword: 'short',
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/at least 8 characters/i);
    });
});

describe('Auth: email verification', () => {
    it('verifies email with a valid token extracted from the registration email', async () => {
        sendMock.mockClear();
        await request(app).post('/api/register').send(validUser);
        const emailHtml = sendMock.mock.calls[0][0].html;
        const rawToken = emailHtml.match(/token=([a-f0-9]+)/)[1];

        const res = await request(app).get(`/api/verify-email?token=${rawToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.message).toMatch(/verified successfully/i);

        const user = await User.findOne({ username: validUser.username });
        expect(user.emailVerified).toBe(true);
    });

    it('rejects verification with an invalid token', async () => {
        const res = await request(app).get('/api/verify-email?token=bogus');
        expect(res.statusCode).toBe(400);
    });

    it('rejects verification with a missing token', async () => {
        const res = await request(app).get('/api/verify-email');
        expect(res.statusCode).toBe(400);
    });

    it('resends the verification email for a logged-in, unverified user', async () => {
        const { token } = await registerAndLogin(request, app, {
            username: 'resenduser',
            email: 'resenduser@test.com',
        });
        sendMock.mockClear();

        const res = await request(app)
            .post('/api/resend-verify')
            .set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.message).toMatch(/verification email sent/i);
        expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('short-circuits resend for an already-verified user', async () => {
        const { token, payload } = await registerAndLogin(request, app, {
            username: 'verifieduser',
            email: 'verifieduser@test.com',
        });
        await User.updateOne({ username: payload.username }, { $set: { emailVerified: true } });

        const res = await request(app)
            .post('/api/resend-verify')
            .set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.message).toMatch(/already verified/i);
    });

    it('rejects resend-verify without authentication', async () => {
        const res = await request(app).post('/api/resend-verify');
        expect(res.statusCode).toBe(401);
    });
});

describe('Auth: admin login', () => {
    it('rejects admin login for a regular (non-admin) user', async () => {
        await request(app).post('/api/register').send(validUser);
        const res = await request(app).post('/api/admin/login').send({
            username: validUser.username,
            password: validUser.password,
        });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/not an admin/i);
    });

    it('logs in an admin user and issues an admin token', async () => {
        await request(app).post('/api/register').send(validUser);
        await User.updateOne(
            { username: validUser.username },
            { $set: { roles: ['user', 'admin'], adminRole: 'super_admin' } }
        );

        const res = await request(app).post('/api/admin/login').send({
            username: validUser.username,
            password: validUser.password,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('token');
        expect(res.body.role).toBe('admin');
    });

    it('rejects admin login with wrong credentials', async () => {
        const res = await request(app).post('/api/admin/login').send({
            username: 'nobody',
            password: 'wrong',
        });
        expect(res.statusCode).toBe(401);
    });
});
