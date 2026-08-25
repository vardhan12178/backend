import { jest } from '@jest/globals';
import { createStatefulRedisMock, registerAndLogin, makeSuperAdmin } from './helpers.js';

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: redisMock,
    CACHE_TTL: {
        PRODUCTS_LIST: 300,
        PRODUCT_DETAIL: 600,
        PROFILE: 3600,
        SALE: 60,
        HOME: 300,
        TWO_FA: 300,
        REVIEW_SUMMARY: 3600,
    },
    invalidatePattern: jest.fn(),
}));

jest.unstable_mockModule('resend', () => ({
    Resend: class {
        constructor() {
            this.emails = { send: jest.fn().mockResolvedValue({ id: 'mock_email_id' }) };
        }
    }
}));

// product.controller.js fires vectorizeProduct() (Gemini embeddings) on
// create/update in the background and calls generateReviewSummary() on
// GET .../review-summary — both would otherwise attempt a real network
// call against the Gemini API using whatever dummy key is configured.
const vectorizeProductMock = jest.fn().mockResolvedValue(undefined);
const generateReviewSummaryMock = jest.fn().mockResolvedValue({ pros: [], cons: [], sentiment: 'neutral' });
jest.unstable_mockModule('../services/ai.service.js', () => ({
    vectorizeProduct: vectorizeProductMock,
    generateReviewSummary: generateReviewSummaryMock,
    generateComparisonSummary: jest.fn(),
    parseSearchQuery: jest.fn(),
    handleChat: jest.fn(),
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
const { default: Product } = await import('../models/Product.js');

async function loginAs(username) {
    const res = await request(app).post('/api/login').send({ username, password: 'Password123!' });
    return res.body.token;
}

async function makeBareAdmin(username, overrides = {}) {
    await registerAndLogin(request, app, { username, email: `${username}@test.com` });
    await User.updateOne({ username }, { $set: { roles: ['admin'], adminRole: null, permissions: {}, ...overrides } });
    return loginAs(username);
}

const validProduct = {
    title: 'Wireless Mouse',
    description: 'A great wireless mouse',
    category: 'electronics',
    brand: 'Acme',
    price: 1999,
    discountPercentage: 10,
    stock: 25,
    thumbnail: 'http://example.com/mouse.jpg',
};

describe('Products: admin CRUD (permission-gated)', () => {
    let superAdminToken;
    let productsWriteToken;
    let productsReadToken;
    let bareAdminToken;
    let plainUserToken;

    beforeEach(async () => {
        vectorizeProductMock.mockClear();

        const superAdmin = await registerAndLogin(request, app, { username: 'prodsuperadmin', email: 'prodsuperadmin@test.com' });
        await makeSuperAdmin(User, superAdmin.payload.username);
        superAdminToken = await loginAs('prodsuperadmin');

        productsWriteToken = await makeBareAdmin('prodwriteadmin', { permissions: { products: 'write' } });
        productsReadToken = await makeBareAdmin('prodreadadmin', { permissions: { products: 'read' } });
        bareAdminToken = await makeBareAdmin('prodbareadmin');

        const plainUser = await registerAndLogin(request, app, { username: 'produser1', email: 'produser1@test.com' });
        plainUserToken = plainUser.token;
    });

    describe('POST /api/admin/products (create)', () => {
        it('rejects a plain user', async () => {
            const res = await request(app)
                .post('/api/admin/products')
                .set('Authorization', `Bearer ${plainUserToken}`)
                .send(validProduct);
            expect(res.statusCode).toBe(403);
        });

        it('rejects a bare admin with no products grant', async () => {
            const res = await request(app)
                .post('/api/admin/products')
                .set('Authorization', `Bearer ${bareAdminToken}`)
                .send(validProduct);
            expect(res.statusCode).toBe(403);
        });

        it('rejects an admin holding only products:read', async () => {
            const res = await request(app)
                .post('/api/admin/products')
                .set('Authorization', `Bearer ${productsReadToken}`)
                .send(validProduct);
            expect(res.statusCode).toBe(403);
        });

        it('creates a product for an admin with products:write and fires background vectorization', async () => {
            const res = await request(app)
                .post('/api/admin/products')
                .set('Authorization', `Bearer ${productsWriteToken}`)
                .send(validProduct);
            expect(res.statusCode).toBe(201);
            expect(res.body.product.title).toBe(validProduct.title);
            expect(res.body.product.createdBy).toBeTruthy();

            const stored = await Product.findById(res.body.product._id);
            expect(stored).toBeTruthy();
            // vectorizeProduct is fire-and-forget; give the microtask queue a tick.
            await new Promise((r) => setImmediate(r));
            expect(vectorizeProductMock).toHaveBeenCalledTimes(1);
        });

        it('strips fields outside the write-allowlist (e.g. rating cannot be set directly)', async () => {
            const res = await request(app)
                .post('/api/admin/products')
                .set('Authorization', `Bearer ${productsWriteToken}`)
                .send({ ...validProduct, rating: 5, embedding: [1, 2, 3] });
            expect(res.statusCode).toBe(201);
            expect(res.body.product.rating).toBe(0);
        });

        it('creates a product for super_admin without an explicit permission grant', async () => {
            const res = await request(app)
                .post('/api/admin/products')
                .set('Authorization', `Bearer ${superAdminToken}`)
                .send({ ...validProduct, title: 'Super Admin Mouse' });
            expect(res.statusCode).toBe(201);
        });

        it('returns 500 (mongoose validation surfaces as server error here) when required fields are missing', async () => {
            const res = await request(app)
                .post('/api/admin/products')
                .set('Authorization', `Bearer ${productsWriteToken}`)
                .send({ title: 'Missing Fields Product' });
            expect(res.statusCode).toBe(500);
        });
    });

    describe('PUT /api/admin/products/:id (update)', () => {
        let productId;
        beforeEach(async () => {
            const created = await Product.create({ ...validProduct, createdBy: null });
            productId = created._id.toString();
        });

        it('rejects a bare admin', async () => {
            const res = await request(app)
                .put(`/api/admin/products/${productId}`)
                .set('Authorization', `Bearer ${bareAdminToken}`)
                .send({ price: 2500 });
            expect(res.statusCode).toBe(403);
        });

        it('updates allowed fields for an admin with products:write', async () => {
            const res = await request(app)
                .put(`/api/admin/products/${productId}`)
                .set('Authorization', `Bearer ${productsWriteToken}`)
                .send({ price: 2500, stock: 10 });
            expect(res.statusCode).toBe(200);
            expect(res.body.product.price).toBe(2500);
            expect(res.body.product.stock).toBe(10);
        });

        it('re-vectorizes only when an embed-trigger field changes', async () => {
            await request(app)
                .put(`/api/admin/products/${productId}`)
                .set('Authorization', `Bearer ${productsWriteToken}`)
                .send({ stock: 99 }); // not an embed-trigger field
            await new Promise((r) => setImmediate(r));
            expect(vectorizeProductMock).not.toHaveBeenCalled();

            await request(app)
                .put(`/api/admin/products/${productId}`)
                .set('Authorization', `Bearer ${productsWriteToken}`)
                .send({ title: 'Retitled Mouse' }); // embed-trigger field
            await new Promise((r) => setImmediate(r));
            expect(vectorizeProductMock).toHaveBeenCalledTimes(1);
        });

        it('invalidates the product detail + list caches on update', async () => {
            await redisMock.set(`product:${productId}`, JSON.stringify({ stale: true }), 'EX', 600);
            await request(app)
                .put(`/api/admin/products/${productId}`)
                .set('Authorization', `Bearer ${productsWriteToken}`)
                .send({ price: 3000 });
            const cached = await redisMock.get(`product:${productId}`);
            expect(cached).toBeNull();
        });

        it('returns 404 updating a non-existent product', async () => {
            const res = await request(app)
                .put('/api/admin/products/64b000000000000000000000')
                .set('Authorization', `Bearer ${productsWriteToken}`)
                .send({ price: 100 });
            expect(res.statusCode).toBe(404);
        });

        it('rejects an invalid discountPercentage (schema validator, max 90)', async () => {
            const res = await request(app)
                .put(`/api/admin/products/${productId}`)
                .set('Authorization', `Bearer ${productsWriteToken}`)
                .send({ discountPercentage: 150 });
            expect(res.statusCode).toBe(500); // runValidators throws -> caught by generic 500 handler
        });
    });

    describe('DELETE /api/admin/products/:id', () => {
        let productId;
        beforeEach(async () => {
            const created = await Product.create({ ...validProduct, createdBy: null });
            productId = created._id.toString();
        });

        it('rejects a bare admin', async () => {
            const res = await request(app)
                .delete(`/api/admin/products/${productId}`)
                .set('Authorization', `Bearer ${bareAdminToken}`);
            expect(res.statusCode).toBe(403);
            expect(await Product.findById(productId)).toBeTruthy();
        });

        it('deletes the product for an admin with products:write', async () => {
            const res = await request(app)
                .delete(`/api/admin/products/${productId}`)
                .set('Authorization', `Bearer ${productsWriteToken}`);
            expect(res.statusCode).toBe(200);
            expect(await Product.findById(productId)).toBeNull();
        });

        it('returns 404 deleting a non-existent product', async () => {
            const res = await request(app)
                .delete('/api/admin/products/64b000000000000000000000')
                .set('Authorization', `Bearer ${productsWriteToken}`);
            expect(res.statusCode).toBe(404);
        });
    });

    describe('GET /api/admin/products (admin list)', () => {
        it('rejects a plain user', async () => {
            const res = await request(app).get('/api/admin/products').set('Authorization', `Bearer ${plainUserToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('rejects a bare admin', async () => {
            const res = await request(app).get('/api/admin/products').set('Authorization', `Bearer ${bareAdminToken}`);
            expect(res.statusCode).toBe(403);
        });

        it('lists all products (active and inactive) for an admin with products:read', async () => {
            await Product.create({ ...validProduct, title: 'Inactive Product', isActive: false, createdBy: null });
            const res = await request(app).get('/api/admin/products').set('Authorization', `Bearer ${productsReadToken}`);
            expect(res.statusCode).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            expect(res.body.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('POST /api/admin/products/upload (image upload)', () => {
        it('rejects a bare admin', async () => {
            const res = await request(app)
                .post('/api/admin/products/upload')
                .set('Authorization', `Bearer ${bareAdminToken}`)
                .attach('image', Buffer.from('fake-image-bytes'), 'test.png');
            expect(res.statusCode).toBe(403);
        });

        it('rejects a disallowed file extension before hitting S3', async () => {
            const res = await request(app)
                .post('/api/admin/products/upload')
                .set('Authorization', `Bearer ${productsWriteToken}`)
                .attach('image', Buffer.from('not-an-image'), 'test.txt');
            expect(res.statusCode).toBe(400);
        });
    });

    describe('Reviews: add/list/delete', () => {
        let productId;
        let userToken;

        beforeEach(async () => {
            const created = await Product.create({ ...validProduct, createdBy: null });
            productId = created._id.toString();
            const user = await registerAndLogin(request, app, { username: 'reviewer1', email: 'reviewer1@test.com' });
            userToken = user.token;
        });

        it('rejects an unauthenticated review submission', async () => {
            const res = await request(app)
                .post(`/api/products/${productId}/reviews`)
                .send({ rating: 5, comment: 'Great product, highly recommend it!' });
            expect(res.statusCode).toBe(401);
        });

        it('rejects a rating outside 1-5 via validator', async () => {
            const res = await request(app)
                .post(`/api/products/${productId}/reviews`)
                .set('Authorization', `Bearer ${userToken}`)
                .send({ rating: 7, comment: 'Great product, highly recommend it!' });
            expect(res.statusCode).toBe(400);
        });

        it('rejects a too-short comment via validator', async () => {
            const res = await request(app)
                .post(`/api/products/${productId}/reviews`)
                .set('Authorization', `Bearer ${userToken}`)
                .send({ rating: 4, comment: 'short' });
            expect(res.statusCode).toBe(400);
        });

        it('adds a review, updates the product rating, and lists it back', async () => {
            const addRes = await request(app)
                .post(`/api/products/${productId}/reviews`)
                .set('Authorization', `Bearer ${userToken}`)
                .send({ rating: 5, comment: 'Great product, highly recommend it!' });
            expect(addRes.statusCode).toBe(201);
            expect(addRes.body.newRating).toBe(5);

            const listRes = await request(app).get(`/api/products/${productId}/reviews`);
            expect(listRes.statusCode).toBe(200);
            expect(listRes.body.total).toBe(1);
            expect(listRes.body.reviews[0].comment).toMatch(/great product/i);
        });

        it('rejects a second review from the same user on the same product', async () => {
            await request(app)
                .post(`/api/products/${productId}/reviews`)
                .set('Authorization', `Bearer ${userToken}`)
                .send({ rating: 5, comment: 'Great product, highly recommend it!' });
            const res = await request(app)
                .post(`/api/products/${productId}/reviews`)
                .set('Authorization', `Bearer ${userToken}`)
                .send({ rating: 3, comment: 'Changed my mind about this item.' });
            expect(res.statusCode).toBe(400);
        });

        it('lets the review author delete their own review, but not another user', async () => {
            const addRes = await request(app)
                .post(`/api/products/${productId}/reviews`)
                .set('Authorization', `Bearer ${userToken}`)
                .send({ rating: 5, comment: 'Great product, highly recommend it!' });
            const reviewId = addRes.body.review._id;

            const other = await registerAndLogin(request, app, { username: 'reviewer2', email: 'reviewer2@test.com' });
            const forbidden = await request(app)
                .delete(`/api/products/${productId}/reviews/${reviewId}`)
                .set('Authorization', `Bearer ${other.token}`);
            expect(forbidden.statusCode).toBe(404);

            const ok = await request(app)
                .delete(`/api/products/${productId}/reviews/${reviewId}`)
                .set('Authorization', `Bearer ${userToken}`);
            expect(ok.statusCode).toBe(200);
            expect(ok.body.totalReviews).toBe(0);
        });

        it('review-summary short-circuits (no AI call) with fewer than 3 reviews', async () => {
            const res = await request(app).get(`/api/products/${productId}/review-summary`);
            expect(res.statusCode).toBe(200);
            expect(res.body.available).toBe(false);
            expect(res.body.reason).toBe('not-enough-reviews');
            expect(generateReviewSummaryMock).not.toHaveBeenCalled();
        });

        it('review-summary calls the (mocked) AI summarizer once there are 3+ reviews', async () => {
            const product = await Product.findById(productId);
            product.reviews.push(
                { rating: 5, comment: 'Really good build quality overall', userId: undefined },
                { rating: 4, comment: 'Works well for the price point', userId: undefined },
                { rating: 3, comment: 'Decent but battery life is short', userId: undefined }
            );
            await product.save();

            const res = await request(app).get(`/api/products/${productId}/review-summary`);
            expect(res.statusCode).toBe(200);
            expect(res.body.available).toBe(true);
            expect(generateReviewSummaryMock).toHaveBeenCalledTimes(1);
        });
    });
});

describe('Admin reviews moderation (permission-gated)', () => {
    let superAdminToken;
    let reviewsWriteToken;
    let bareAdminToken;
    let productId;
    let reviewId;

    beforeEach(async () => {
        const superAdmin = await registerAndLogin(request, app, { username: 'modsuperadmin', email: 'modsuperadmin@test.com' });
        await makeSuperAdmin(User, superAdmin.payload.username);
        superAdminToken = await loginAs('modsuperadmin');

        reviewsWriteToken = await makeBareAdmin('reviewswriteadmin', { permissions: { reviews: 'write' } });
        bareAdminToken = await makeBareAdmin('modbareadmin');

        const product = await Product.create({ ...validProduct, createdBy: null });
        product.reviews.push({ rating: 4, comment: 'Solid purchase overall', userId: undefined });
        await product.save();
        productId = product._id.toString();
        reviewId = product.reviews[0]._id.toString();
    });

    it('rejects listing reviews for a bare admin', async () => {
        const res = await request(app).get('/api/admin/reviews').set('Authorization', `Bearer ${bareAdminToken}`);
        expect(res.statusCode).toBe(403);
    });

    it('lists all reviews across products for super_admin', async () => {
        const res = await request(app).get('/api/admin/reviews').set('Authorization', `Bearer ${superAdminToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.reviews.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects toggling visibility for a bare admin', async () => {
        const res = await request(app)
            .patch(`/api/admin/reviews/${productId}/${reviewId}/toggle`)
            .set('Authorization', `Bearer ${bareAdminToken}`);
        expect(res.statusCode).toBe(403);
    });

    it('toggles review visibility for an admin with reviews:write', async () => {
        const res = await request(app)
            .patch(`/api/admin/reviews/${productId}/${reviewId}/toggle`)
            .set('Authorization', `Bearer ${reviewsWriteToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.review.isHidden).toBe(true);

        const hidden = await Product.findById(productId);
        expect(hidden.reviews[0].isHidden).toBe(true);
    });

    it('deletes a review and recalculates the product rating for an admin with reviews:write', async () => {
        const res = await request(app)
            .delete(`/api/admin/reviews/${productId}/${reviewId}`)
            .set('Authorization', `Bearer ${reviewsWriteToken}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.totalReviews).toBe(0);
        expect(res.body.newRating).toBe(0);
    });
});
