import { jest } from '@jest/globals';
import speakeasy from 'speakeasy';
import { createStatefulRedisMock, registerAndLogin } from './helpers.js';

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

// Generates a valid TOTP for a base32 secret at an arbitrary point in time
// (defaults to "now"), so tests don't have to wait on the real clock.
const codeFor = (secret, atUnixSeconds) =>
    speakeasy.totp({ secret, encoding: 'base32', time: atUnixSeconds });

describe('2FA: setup / enable / disable', () => {
    let token;

    beforeEach(async () => {
        ({ token } = await registerAndLogin(request, app, {
            username: 'tfauser',
            email: 'tfauser@test.com',
        }));
    });

    it('rejects setup without authentication', async () => {
        const res = await request(app).post('/api/2fa/setup');
        expect(res.statusCode).toBe(401);
    });

    it('generates a QR + base32 secret for an authenticated user', async () => {
        const res = await request(app)
            .post('/api/2fa/setup')
            .set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.qr).toMatch(/^data:image\/png;base64,/);
        expect(res.body.manualEntryKey).toBeTruthy();
        expect(res.body.secret).toBe(res.body.manualEntryKey);
    });

    it('rejects enabling 2FA with a wrong TOTP code', async () => {
        const setupRes = await request(app)
            .post('/api/2fa/setup')
            .set('Authorization', `Bearer ${token}`);

        const res = await request(app)
            .post('/api/2fa/enable')
            .set('Authorization', `Bearer ${token}`)
            .send({ token: '000000', secret: setupRes.body.secret });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/invalid code/i);

        const user = await User.findOne({ username: 'tfauser' });
        expect(user.twoFactorEnabled).toBe(false);
    });

    it('rejects enabling 2FA with missing data', async () => {
        const res = await request(app)
            .post('/api/2fa/enable')
            .set('Authorization', `Bearer ${token}`)
            .send({});
        expect(res.statusCode).toBe(400);
    });

    it('enables 2FA with a valid TOTP code and stores the secret encrypted', async () => {
        const setupRes = await request(app)
            .post('/api/2fa/setup')
            .set('Authorization', `Bearer ${token}`);
        const secret = setupRes.body.secret;
        const code = codeFor(secret);

        const res = await request(app)
            .post('/api/2fa/enable')
            .set('Authorization', `Bearer ${token}`)
            .send({ token: code, secret });
        expect(res.statusCode).toBe(200);
        expect(res.body.message).toMatch(/2fa enabled/i);

        const user = await User.findOne({ username: 'tfauser' }).select('+twoFactorSecretEnc');
        expect(user.twoFactorEnabled).toBe(true);
        expect(user.twoFactorSecretEnc).toBeTruthy();
        expect(user.twoFactorSecretEnc).not.toBe(secret);
    });

    it('disables 2FA for an authenticated user', async () => {
        const setupRes = await request(app)
            .post('/api/2fa/setup')
            .set('Authorization', `Bearer ${token}`);
        const secret = setupRes.body.secret;
        await request(app)
            .post('/api/2fa/enable')
            .set('Authorization', `Bearer ${token}`)
            .send({ token: codeFor(secret), secret });

        const res = await request(app)
            .post('/api/2fa/disable')
            .set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.message).toMatch(/2fa disabled/i);

        const user = await User.findOne({ username: 'tfauser' }).select('+twoFactorSecretEnc');
        expect(user.twoFactorEnabled).toBe(false);
        expect(user.twoFactorSecretEnc).toBeFalsy();
    });

    it('suppresses the 2FA prompt flag', async () => {
        const res = await request(app)
            .post('/api/2fa/suppress')
            .set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(200);
        const user = await User.findOne({ username: 'tfauser' });
        expect(user.suppress2faPrompt).toBe(true);
    });
});

describe('2FA: login flow (inline token2fa on /api/login)', () => {
    let secret;
    const username = 'tfalogin';
    const password = 'Password123!';

    beforeEach(async () => {
        const { token } = await registerAndLogin(request, app, {
            username,
            email: 'tfalogin@test.com',
            password,
            confirmPassword: password,
        });
        const setupRes = await request(app)
            .post('/api/2fa/setup')
            .set('Authorization', `Bearer ${token}`);
        secret = setupRes.body.secret;
        await request(app)
            .post('/api/2fa/enable')
            .set('Authorization', `Bearer ${token}`)
            .send({ token: codeFor(secret), secret });
    });

    it('returns an opaque challenge instead of a session when 2FA is enabled and no code is given', async () => {
        const res = await request(app).post('/api/login').send({ username, password });
        expect(res.statusCode).toBe(200);
        expect(res.body.require2FA).toBe(true);
        expect(res.body.challengeToken).toBeTruthy();
        expect(res.body).not.toHaveProperty('token');
    });

    it('rejects login with a wrong inline 2FA code', async () => {
        const res = await request(app)
            .post('/api/login')
            .send({ username, password, token2fa: '000000' });
        expect(res.statusCode).toBe(401);
        expect(res.body.message).toMatch(/invalid 2fa code/i);
    });

    it('logs in with a correct inline 2FA code', async () => {
        const res = await request(app)
            .post('/api/login')
            .send({ username, password, token2fa: codeFor(secret) });
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('token');
    });

    it('rejects an inline 2FA code generated far outside the verification window (expired)', async () => {
        const staleCode = codeFor(secret, Math.floor(Date.now() / 1000) - 600); // 10 min ago
        const res = await request(app)
            .post('/api/login')
            .send({ username, password, token2fa: staleCode });
        expect(res.statusCode).toBe(401);
    });
});

describe('2FA: login-verify (challenge-token flow)', () => {
    let secret;
    let challengeToken;
    const username = 'tfachallenge';
    const password = 'Password123!';

    beforeEach(async () => {
        const { token } = await registerAndLogin(request, app, {
            username,
            email: 'tfachallenge@test.com',
            password,
            confirmPassword: password,
        });
        const setupRes = await request(app)
            .post('/api/2fa/setup')
            .set('Authorization', `Bearer ${token}`);
        secret = setupRes.body.secret;
        await request(app)
            .post('/api/2fa/enable')
            .set('Authorization', `Bearer ${token}`)
            .send({ token: codeFor(secret), secret });

        const loginRes = await request(app).post('/api/login').send({ username, password });
        challengeToken = loginRes.body.challengeToken;
    });

    it('completes login with a valid challengeToken + correct TOTP code', async () => {
        const res = await request(app)
            .post('/api/2fa/login-verify')
            .send({ challengeToken, token: codeFor(secret) });
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('token');
    });

    it('consumes the challenge token so it cannot be reused (one-time use)', async () => {
        const code = codeFor(secret);
        const first = await request(app)
            .post('/api/2fa/login-verify')
            .send({ challengeToken, token: code });
        expect(first.statusCode).toBe(200);

        const second = await request(app)
            .post('/api/2fa/login-verify')
            .send({ challengeToken, token: code });
        expect(second.statusCode).toBe(400);
        expect(second.body.message).toMatch(/expired or invalid/i);
    });

    it('rejects an unknown/invalid challengeToken', async () => {
        const res = await request(app)
            .post('/api/2fa/login-verify')
            .send({ challengeToken: 'not-a-real-challenge', token: codeFor(secret) });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/expired or invalid/i);
    });

    it('rejects a valid challengeToken with the wrong TOTP code', async () => {
        const res = await request(app)
            .post('/api/2fa/login-verify')
            .send({ challengeToken, token: '000000' });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/invalid verification code/i);
    });

    it('rejects a TOTP code generated far outside the verification window (expired)', async () => {
        const staleCode = codeFor(secret, Math.floor(Date.now() / 1000) - 600);
        const res = await request(app)
            .post('/api/2fa/login-verify')
            .send({ challengeToken, token: staleCode });
        expect(res.statusCode).toBe(400);
    });

    it('rejects login-verify with missing parameters', async () => {
        const res = await request(app).post('/api/2fa/login-verify').send({});
        expect(res.statusCode).toBe(400);
    });
});
