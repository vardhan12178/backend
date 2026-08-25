// Shared, mock-free helpers for backend tests.
//
// This file intentionally does NOT call jest.unstable_mockModule or import
// app.js/any mocked module itself — each test file owns its own mocks
// (redis, resend, razorpay, ...) which must be registered before app.js is
// imported in that file. These helpers just take the already-imported
// `request`/`app`/`User` as parameters so they stay reusable across suites.

import crypto from 'crypto';

/**
 * Register a new user through the real /api/register endpoint.
 * Returns both the response and the payload used, so callers can log in
 * with the same credentials afterwards.
 */
export async function registerUser(request, app, overrides = {}) {
  const unique = crypto.randomBytes(4).toString('hex');
  const payload = {
    name: 'Test User',
    username: `user_${unique}`,
    email: `user_${unique}@test.com`,
    password: 'Password123!',
    confirmPassword: 'Password123!',
    ...overrides,
  };
  const res = await request(app).post('/api/register').send(payload);
  return { res, payload };
}

/** Log in through the real /api/login endpoint. */
export async function loginUser(request, app, { username, password, ...rest }) {
  return request(app).post('/api/login').send({ username, password, ...rest });
}

/** Register + log in, returning a ready-to-use bearer token. */
export async function registerAndLogin(request, app, overrides = {}) {
  const { payload } = await registerUser(request, app, overrides);
  const loginRes = await loginUser(request, app, {
    username: payload.username,
    password: payload.password,
  });
  return { token: loginRes.body.token, payload, loginRes };
}

/** Promote an existing user to super_admin (bypasses per-module permission checks). */
export async function makeSuperAdmin(User, username) {
  await User.updateOne(
    { username },
    { $set: { roles: ['admin'], adminRole: 'super_admin' } }
  );
}

/** Compute the Razorpay client-side payment signature (order_id|payment_id HMAC). */
export function signRazorpaySignature(orderId, paymentId, secret) {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

/**
 * In-memory ioredis-compatible mock. Unlike a bare `jest.fn()` stub, this
 * actually stores values so code paths that round-trip through Redis
 * (2FA login challenges, Razorpay checkout/membership/wallet sessions,
 * token blacklist, webhook dedupe) can be tested end-to-end instead of
 * always taking the "cache miss" branch.
 *
 * Must be constructed with the test file's own `jest` (from '@jest/globals')
 * since jest.fn() is not shared across module registries.
 */
export function createStatefulRedisMock(jest) {
  const store = new Map();
  return {
    get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key, value, ...args) => {
      const nx = args.includes('NX');
      if (nx && store.has(key)) return null; // mirrors ioredis SET NX failure
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (...keys) => {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count += 1;
      }
      return count;
    }),
    scan: jest.fn().mockResolvedValue(['0', []]),
    on: jest.fn(),
    quit: jest.fn(),
  };
}
