import { jest } from '@jest/globals';

// Define mock BEFORE imports
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: {
        get: jest.fn().mockResolvedValue(null), // Always cache miss
        set: jest.fn(),
        del: jest.fn(),
        on: jest.fn(),
        quit: jest.fn()
    }
}));

// Dynamic imports are required when using unstable_mockModule
const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: Product } = await import('../models/Product.js');

describe('Product API', () => {
    beforeEach(async () => {
        // Seed a product
        await Product.create({
            title: 'Gaming Mouse',
            description: 'High precision wireless mouse',
            category: 'electronics',
            price: 2999,
            stock: 50,
            thumbnail: 'http://example.com/image.jpg',
            embedding: [] // Mock embedding
        });
    });

    it('should list products', async () => {
        const res = await request(app).get('/api/products');

        expect(res.statusCode).toEqual(200);
        expect(res.body.products).toHaveLength(1);
        expect(res.body.products[0].title).toBe('Gaming Mouse');
    });

    it('should filter products by search query', async () => {
        const res = await request(app).get('/api/products?q=Mouse');

        expect(res.statusCode).toEqual(200);
    });

    it('should return 404 for invalid product ID', async () => {
        const res = await request(app).get('/api/products/666666666666666666666666');
        expect(res.statusCode).toEqual(404);
    });
});
