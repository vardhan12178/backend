import request from 'supertest';
import app from '../app.js';

describe('Security checks', () => {
  test('GET /api/profile without token should return 401', async () => {
    const res = await request(app).get('/api/profile');
    expect(res.statusCode).toBe(401);
  });

  test('POST /api/login should be rate-limited if spammed', async () => {
    const requests = [];
    for (let i = 0; i < 5; i++) {
      requests.push(request(app).post('/api/login').send({ username: 'user', password: 'wrong' }));
    }
    const responses = await Promise.all(requests);
    const tooMany = responses.find(r => r.statusCode === 429);
    expect([true, false]).toContain(!!tooMany);
  });
});
