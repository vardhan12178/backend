import { jest } from '@jest/globals';

// Define mock BEFORE imports
const redisMock = {
    get: jest.fn().mockResolvedValue(null), // Always cache miss
    set: jest.fn(),
    del: jest.fn(),
    scan: jest.fn().mockResolvedValue(["0", []]),
    on: jest.fn(),
    quit: jest.fn()
};

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

// Dynamic imports are required when using unstable_mockModule
const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: Product } = await import('../models/Product.js');
const { default: Sale } = await import('../models/Sale.js');

describe('Product API', () => {
    beforeEach(async () => {
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
        expect(res.body.pagination).toMatchObject({
            page: 1,
            limit: 12,
            total: 1,
            totalPages: 1,
        });
    });

    it('should filter products by search query', async () => {
        const res = await request(app).get('/api/products?q=Mouse');

        expect(res.statusCode).toEqual(200);
    });

    it('should paginate product results on the backend', async () => {
        await Product.create({
            title: 'Mechanical Keyboard',
            description: 'RGB keyboard',
            category: 'electronics',
            price: 4999,
            stock: 25,
            thumbnail: 'http://example.com/keyboard.jpg',
            embedding: []
        });

        const res = await request(app).get('/api/products?page=2&limit=1&sort=newest');

        expect(res.statusCode).toEqual(200);
        expect(res.body.products).toHaveLength(1);
        expect(res.body.pagination).toMatchObject({
            page: 2,
            limit: 1,
            total: 2,
            totalPages: 2,
        });
    });

    it('should return filter metadata without downloading the product list', async () => {
        await Product.create({
            title: 'Face Serum',
            description: 'Vitamin C serum',
            category: 'beauty',
            price: 1499,
            stock: 30,
            thumbnail: 'http://example.com/serum.jpg',
            embedding: []
        });

        const res = await request(app).get('/api/products/filters');
        expect(res.statusCode).toEqual(200);
        expect(res.body.categories.map((entry) => entry.slug)).toEqual(['beauty', 'electronics']);
        expect(res.body.priceRange).toMatchObject({
            min: 1499,
            max: 2999,
        });
    });

    it('should apply sale price filtering before pagination', async () => {
        await Product.deleteMany({});

        await Product.create([
            {
                title: 'Noise Cancelling Headphones',
                description: 'Travel headphones',
                category: 'electronics',
                price: 1020,
                stock: 20,
                thumbnail: 'http://example.com/headphones.jpg',
                embedding: []
            },
            {
                title: 'Portable Speaker',
                description: 'Bluetooth speaker',
                category: 'electronics',
                price: 1500,
                stock: 20,
                thumbnail: 'http://example.com/speaker.jpg',
                embedding: []
            }
        ]);

        await Sale.create({
            name: 'Electronics Sale',
            slug: 'electronics-sale',
            startDate: new Date(Date.now() - 60 * 1000),
            endDate: new Date(Date.now() + 60 * 60 * 1000),
            isActive: true,
            categories: [{ category: 'electronics', discountPercent: 20, primeDiscountPercent: 25 }],
        });

        const res = await request(app).get('/api/products?sale=true&maxPrice=1000&sort=price_asc');

        expect(res.statusCode).toEqual(200);
        expect(res.body.products).toHaveLength(1);
        expect(res.body.products[0]).toMatchObject({
            title: 'Noise Cancelling Headphones',
            onSale: true,
            price: 979,
        });
        expect(res.body.pagination.total).toBe(1);
    });

    it('should return 404 for invalid product ID', async () => {
        const res = await request(app).get('/api/products/666666666666666666666666');
        expect(res.statusCode).toEqual(404);
    });
});
