import { jest } from '@jest/globals';
import { createStatefulRedisMock } from './helpers.js';

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule('../utils/redis.js', () => ({
  default: redisMock,
  CACHE_TTL: { PRODUCTS_LIST: 300, PRODUCT_DETAIL: 600, PROFILE: 3600, SALE: 60, HOME: 300, TWO_FA: 300 },
  invalidatePattern: jest.fn(),
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');

describe('Demo logins', () => {
  afterEach(() => { delete process.env.DEMO_LOGINS; });

  test('shopper demo signs in, is not an admin, and starts with an empty bag', async () => {
    const res = await request(app).post('/api/auth/demo/shopper');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.user.username).toBe('demo.shopper');
    expect(res.body.token).toBeTruthy();
    const user = await User.findOne({ username: 'demo.shopper' });
    expect(user.roles).toEqual(['user']);
    expect(user.cart).toHaveLength(0);
  });

  test('signing in twice reuses the same account', async () => {
    await request(app).post('/api/auth/demo/shopper');
    await request(app).post('/api/auth/demo/shopper');
    expect(await User.countDocuments({ username: 'demo.shopper' })).toBe(1);
  });

  test('demo accounts cannot be used with a password', async () => {
    await request(app).post('/api/auth/demo/admin');
    const res = await request(app).post('/api/admin/login').send({ username: 'demo.admin', password: 'Password123!' });
    expect(res.status).toBe(401);
  });

  test('demo admin can read allowed modules but never write', async () => {
    const login = await request(app).post('/api/auth/demo/admin');
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.token}` };

    const verify = await request(app).get('/api/admin/verify').set(auth);
    expect(verify.status).toBe(200);
    expect(verify.body.permissions.orders).toBe('read');
    expect(verify.body.permissions.users).toBeUndefined();

    expect((await request(app).get('/api/admin/v2/products').set(auth)).status).toBe(200);
    // Customers stay private
    expect((await request(app).get('/api/admin/users').set(auth)).status).toBe(403);

    const write = await request(app).post('/api/coupons').set(auth).send({ code: 'NOPE10', discountValue: 10 });
    expect(write.status).toBe(403);
    expect(write.body.message).toMatch(/read-only/i);
  });

  test('demo shopper cannot change the password', async () => {
    const login = await request(app).post('/api/auth/demo/shopper');
    const res = await request(app).put('/api/profile/password')
      .set({ Authorization: `Bearer ${login.body.token}` })
      .send({ currentPassword: 'x', newPassword: 'Password123!', confirmPassword: 'Password123!' });
    expect(res.status).toBe(403);
  });

  test('can be switched off', async () => {
    process.env.DEMO_LOGINS = 'false';
    expect((await request(app).post('/api/auth/demo/shopper')).status).toBe(404);
    expect((await request(app).post('/api/auth/demo/admin')).status).toBe(404);
  });
});
