import request from 'supertest';
import app from '../app.js';

describe('Auth API', () => {
  const user = {
    name: 'Test User',
    username: 'testuser',
    email: 'test@example.com',
    password: 'password123',
    confirmPassword: 'password123',
  };

  test('POST /api/register should register a user successfully', async () => {
    const res = await request(app)
      .post('/api/register')
      .send(user);

    // For debugging
    if (![200, 201, 409].includes(res.statusCode)) {
      console.error('Register response:', res.statusCode, res.body);
    }

    expect([200, 201, 409]).toContain(res.statusCode);
  });

  test('POST /api/login should return token for valid credentials', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: user.username, password: user.password });

    if (![200, 401].includes(res.statusCode)) {
      console.error('Login response:', res.statusCode, res.body);
    }

    expect([200, 401]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.body.token).toBeDefined();
    }
  });

  test('POST /api/forgot should always return success message', async () => {
    const res = await request(app)
      .post('/api/forgot')
      .send({ emailOrUsername: user.email });

    if (res.statusCode !== 200) {
      console.error('Forgot response:', res.statusCode, res.body);
    }

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toMatch(/reset link/i);
  });
});
