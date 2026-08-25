import { jest } from '@jest/globals';
import { createStatefulRedisMock, registerAndLogin } from './helpers.js';

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: redisMock,
    CACHE_TTL: { PRODUCTS_LIST: 300, PRODUCT_DETAIL: 600, PROFILE: 3600, SALE: 60, HOME: 300, TWO_FA: 300 },
    invalidatePattern: jest.fn(),
}));

jest.unstable_mockModule('resend', () => ({
    Resend: class { constructor() { this.emails = { send: jest.fn().mockResolvedValue({ id: 'mock' }) }; } }
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');

describe('Profile: get/update, cart, wishlist, addresses, password', () => {
    let token;
    let username;

    beforeEach(async () => {
        username = 'profileuser';
        const { token: t } = await registerAndLogin(request, app, { username, email: 'profileuser@test.com' });
        token = t;
    });

    it('rejects all profile routes without auth', async () => {
        const res = await request(app).get('/api/profile');
        expect(res.statusCode).toBe(401);
    });

    describe('GET /api/profile', () => {
        it('returns the profile and computes isPrime=false with no membership', async () => {
            const res = await request(app).get('/api/profile').set('Authorization', `Bearer ${token}`);
            expect(res.statusCode).toBe(200);
            expect(res.body.username).toBe(username);
            expect(res.body.isPrime).toBe(false);
            expect(res.body.password).toBeUndefined();
        });

        it('serves a second request from cache', async () => {
            const first = await request(app).get('/api/profile').set('Authorization', `Bearer ${token}`);
            await User.updateOne({ username }, { $set: { name: 'Changed Name Directly In DB' } });
            const second = await request(app).get('/api/profile').set('Authorization', `Bearer ${token}`);
            expect(second.body.name).toBe(first.body.name);
        });
    });

    describe('PUT /api/profile/name', () => {
        it('rejects an empty name', async () => {
            const res = await request(app).put('/api/profile/name').set('Authorization', `Bearer ${token}`).send({ name: '   ' });
            expect(res.statusCode).toBe(400);
        });

        it('updates the name and invalidates the profile cache', async () => {
            await request(app).get('/api/profile').set('Authorization', `Bearer ${token}`); // warm cache
            const res = await request(app).put('/api/profile/name').set('Authorization', `Bearer ${token}`).send({ name: 'New Name' });
            expect(res.statusCode).toBe(200);
            expect(res.body.name).toBe('New Name');

            const fresh = await request(app).get('/api/profile').set('Authorization', `Bearer ${token}`);
            expect(fresh.body.name).toBe('New Name');
        });
    });

    describe('Cart', () => {
        it('starts empty', async () => {
            const res = await request(app).get('/api/profile/cart').set('Authorization', `Bearer ${token}`);
            expect(res.statusCode).toBe(200);
            expect(res.body.cart).toEqual([]);
        });

        it('replaces the cart wholesale via PUT', async () => {
            const items = [{ externalId: 'p1', title: 'Item 1', price: 100, quantity: 2 }];
            const res = await request(app).put('/api/profile/cart').set('Authorization', `Bearer ${token}`).send({ cart: items });
            expect(res.statusCode).toBe(200);
            expect(res.body.cart).toHaveLength(1);
            expect(res.body.cart[0].title).toBe('Item 1');
        });

        it('ignores a non-array cart payload (defaults to empty)', async () => {
            const res = await request(app).put('/api/profile/cart').set('Authorization', `Bearer ${token}`).send({ cart: 'not-an-array' });
            expect(res.statusCode).toBe(200);
            expect(res.body.cart).toEqual([]);
        });
    });

    describe('Wishlist', () => {
        it('replaces the wishlist wholesale via PUT', async () => {
            const items = [{ externalId: 'p2', title: 'Wished Item', price: 500 }];
            const res = await request(app).put('/api/profile/wishlist').set('Authorization', `Bearer ${token}`).send({ wishlist: items });
            expect(res.statusCode).toBe(200);
            expect(res.body.wishlist).toHaveLength(1);
        });
    });

    describe('Addresses', () => {
        const validAddress = {
            fullName: 'Jane Doe',
            phone: '9876543210',
            address1: '123 Main St',
            city: 'Mumbai',
            state: 'Maharashtra',
            pincode: '400001',
        };

        it('rejects an address missing required fields', async () => {
            const res = await request(app)
                .post('/api/profile/addresses')
                .set('Authorization', `Bearer ${token}`)
                .send({ fullName: 'Jane' });
            expect(res.statusCode).toBe(400);
        });

        it('adds an address', async () => {
            const res = await request(app).post('/api/profile/addresses').set('Authorization', `Bearer ${token}`).send(validAddress);
            expect(res.statusCode).toBe(201);
            expect(res.body.addresses).toHaveLength(1);
            expect(res.body.addresses[0].fullName).toBe('Jane Doe');
        });

        it('setting a new address as default unsets the previous default', async () => {
            await request(app).post('/api/profile/addresses').set('Authorization', `Bearer ${token}`).send({ ...validAddress, isDefault: true });
            const res = await request(app)
                .post('/api/profile/addresses')
                .set('Authorization', `Bearer ${token}`)
                .send({ ...validAddress, fullName: 'Second Address', isDefault: true });
            expect(res.statusCode).toBe(201);
            const defaults = res.body.addresses.filter((a) => a.isDefault);
            expect(defaults).toHaveLength(1);
            expect(defaults[0].fullName).toBe('Second Address');
        });

        it('updates an address', async () => {
            const addRes = await request(app).post('/api/profile/addresses').set('Authorization', `Bearer ${token}`).send(validAddress);
            const addrId = addRes.body.addresses[0]._id;

            const res = await request(app)
                .put(`/api/profile/addresses/${addrId}`)
                .set('Authorization', `Bearer ${token}`)
                .send({ city: 'Pune' });
            expect(res.statusCode).toBe(200);
            expect(res.body.addresses[0].city).toBe('Pune');
        });

        it('returns 404 updating a non-existent address', async () => {
            const res = await request(app)
                .put('/api/profile/addresses/64b000000000000000000000')
                .set('Authorization', `Bearer ${token}`)
                .send({ city: 'Pune' });
            expect(res.statusCode).toBe(404);
        });

        it('deletes an address', async () => {
            const addRes = await request(app).post('/api/profile/addresses').set('Authorization', `Bearer ${token}`).send(validAddress);
            const addrId = addRes.body.addresses[0]._id;

            const res = await request(app).delete(`/api/profile/addresses/${addrId}`).set('Authorization', `Bearer ${token}`);
            expect(res.statusCode).toBe(200);
            expect(res.body.addresses).toHaveLength(0);
        });

        it('lists addresses', async () => {
            await request(app).post('/api/profile/addresses').set('Authorization', `Bearer ${token}`).send(validAddress);
            const res = await request(app).get('/api/profile/addresses').set('Authorization', `Bearer ${token}`);
            expect(res.statusCode).toBe(200);
            expect(res.body.addresses).toHaveLength(1);
        });
    });

    describe('PUT /api/profile/password', () => {
        it('rejects a mismatched confirmPassword', async () => {
            const res = await request(app)
                .put('/api/profile/password')
                .set('Authorization', `Bearer ${token}`)
                .send({ currentPassword: 'Password123!', newPassword: 'NewPassword123!', confirmPassword: 'Different123!' });
            expect(res.statusCode).toBe(400);
        });

        it('rejects an incorrect current password', async () => {
            const res = await request(app)
                .put('/api/profile/password')
                .set('Authorization', `Bearer ${token}`)
                .send({ currentPassword: 'WrongPass1!', newPassword: 'NewPassword123!', confirmPassword: 'NewPassword123!' });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/current password is incorrect/i);
        });

        it('changes the password and the new password works for login', async () => {
            const res = await request(app)
                .put('/api/profile/password')
                .set('Authorization', `Bearer ${token}`)
                .send({ currentPassword: 'Password123!', newPassword: 'NewPassword123!', confirmPassword: 'NewPassword123!' });
            expect(res.statusCode).toBe(200);

            const loginRes = await request(app).post('/api/login').send({ username, password: 'NewPassword123!' });
            expect(loginRes.statusCode).toBe(200);
        });
    });

    describe('POST /api/profile/upload', () => {
        it('rejects a disallowed file extension before hitting S3', async () => {
            const res = await request(app)
                .post('/api/profile/upload')
                .set('Authorization', `Bearer ${token}`)
                .attach('profileImage', Buffer.from('not-an-image'), 'file.txt');
            expect(res.statusCode).toBe(400);
        });
    });
});
