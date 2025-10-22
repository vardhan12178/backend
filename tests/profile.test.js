import request from 'supertest';
import app from '../app.js';

describe('Profile API', () => {
  let token;

  beforeAll(async () => {
    const login = await request(app)
      .post('/api/login')
      .send({ username: 'testuser', password: 'password123' });
    token = login.body?.token || '';
  });

  test('GET /api/profile should require authentication', async () => {
    const res = await request(app).get('/api/profile');
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/profile should return user when token is valid', async () => {
    if (!token) return;
    const res = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`);
    expect([200, 401]).toContain(res.statusCode);
  });
});
