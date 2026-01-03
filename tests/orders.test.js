import { jest } from '@jest/globals';

// Mock Redis
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn(),
        del: jest.fn(),
        on: jest.fn(),
        quit: jest.fn()
    }
}));

// Dynamic imports
const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
const { default: Product } = await import('../models/Product.js');

describe('Order API', () => {
    let token;
    let productId;

    beforeEach(async () => {
        // 1. Create User
        const userRes = await request(app)
            .post('/api/register')
            .send({
                name: 'Order Test User',
                username: 'ordertester',
                email: 'order@test.com',
                password: 'Password123!',
                confirmPassword: 'Password123!'
            });

        // 2. Login to get token
        const loginRes = await request(app)
            .post('/api/login')
            .send({ username: 'ordertester', password: 'Password123!' });

        token = loginRes.body.token;

        // 3. Create Product
        const product = await Product.create({
            title: 'Test Item',
            description: 'Desc',
            category: 'test',
            price: 100,
            stock: 10,
            thumbnail: 'img.jpg',
            embedding: []
        });
        productId = product._id;
    });

    it('should create an order with valid token', async () => {
        const orderData = {
            products: [
                {
                    productId: productId,
                    name: 'Test Item',
                    quantity: 2,
                    price: 100
                }
            ],
            shippingAddress: '123 Fake St'
        };

        const res = await request(app)
            .post('/api/orders')
            .set('Authorization', `Bearer ${token}`)
            .send(orderData);

        expect(res.statusCode).toEqual(201);
        expect(res.body).toHaveProperty('_id');
    });

    it('should reject order without token', async () => {
        const res = await request(app)
            .post('/api/orders')
            .send({});

        expect(res.statusCode).toEqual(401);
    });
});
