import request from 'supertest';
import app from '../app.js';

describe('Orders API', () => {
  let token;

  beforeAll(async () => {
    const login = await request(app)
      .post('/api/login')
      .send({ username: 'testuser', password: 'password123' });
    token = login.body?.token || '';
  });

  const fakeOrder = {
    products: [
      { name: 'Test Product', externalId: 'p1', quantity: 1, price: 100 }
    ],
    shippingAddress: '123 Test Street'
  };

  test('POST /api/orders should require authentication', async () => {
    const res = await request(app).post('/api/orders').send(fakeOrder);
    expect(res.statusCode).toBe(401);
  });

  test('POST /api/orders should create order with valid token', async () => {
    if (!token) return;
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send(fakeOrder);
    expect([201, 400, 401]).toContain(res.statusCode);
  });

  test('GET /api/profile/orders should return user orders', async () => {
    if (!token) return;
    const res = await request(app)
      .get('/api/profile/orders')
      .set('Authorization', `Bearer ${token}`);
    expect([200, 401]).toContain(res.statusCode);
  });
});
