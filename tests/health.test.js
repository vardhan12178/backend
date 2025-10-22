import request from 'supertest';
import app from '../app.js';

describe('Health & readiness endpoints', () => {
  test('GET /health should return ok', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('ok');
  });
});
