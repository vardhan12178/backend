import { jest } from '@jest/globals';

// Mock Redis
const redisMock = {
    get: jest.fn().mockResolvedValue(null),
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

// Mock Resend
jest.unstable_mockModule('resend', () => ({
    Resend: class {
        constructor() {
            this.emails = {
                send: jest.fn().mockResolvedValue({ id: 'mock_email_id' })
            };
        }
    }
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');

describe('Auth Endpoints', () => {
    const mockUser = {
        name: 'Test User',
        username: 'testu',
        email: 'test@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!'
    };

    it('should register a new user', async () => {
        const res = await request(app)
            .post('/api/register')
            .send(mockUser);

        expect(res.statusCode).toEqual(201);
        expect(res.body).toHaveProperty('message', 'User registered successfully');

        const user = await User.findOne({ email: mockUser.email });
        expect(user).toBeTruthy();
        expect(user.password).not.toBe(mockUser.password);
    });

    it('should login with valid credentials', async () => {
        await request(app).post('/api/register').send(mockUser);

        const res = await request(app)
            .post('/api/login')
            .send({
                username: mockUser.username,
                password: mockUser.password
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('token');
    });

    it('should fail login with wrong password', async () => {
        await request(app).post('/api/register').send(mockUser);

        const res = await request(app)
            .post('/api/login')
            .send({
                username: mockUser.username,
                password: 'WrongPassword'
            });

        expect(res.statusCode).toEqual(401);
    });
});
