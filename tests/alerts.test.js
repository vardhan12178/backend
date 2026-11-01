import { jest } from '@jest/globals';
import { createStatefulRedisMock, registerAndLogin } from './helpers.js';

const redisMock = createStatefulRedisMock(jest);
jest.unstable_mockModule('../utils/redis.js', () => ({
    default: redisMock,
    CACHE_TTL: { PRODUCTS_LIST: 300, PRODUCT_DETAIL: 600, PROFILE: 3600, SALE: 60, HOME: 300, TWO_FA: 300 },
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('resend', () => ({
    Resend: class { constructor() { this.emails = { send: jest.fn().mockResolvedValue({ id: 'mock' }) }; } }
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
const { default: CatalogProduct } = await import('../models/CatalogProduct.js');
const { default: Notification } = await import('../models/Notification.js');
const { default: ProductAlert } = await import('../models/ProductAlert.js');
const { restoreLine } = await import('../services/catalog.stock.js');

const variant = (sku, price, stock, extra = {}) => ({ sku, options: { Storage: sku.split('-').pop() }, price, mrp: price + 5000, stock, isDefault: false, ...extra });

describe('Price-drop and back-in-stock alerts', () => {
    let shopper;
    let shopperId;
    let admin;
    let phone;

    const asUser = (token) => ({
        get: (u) => request(app).get(u).set('Authorization', `Bearer ${token}`),
        post: (u, b) => request(app).post(u).set('Authorization', `Bearer ${token}`).send(b),
        patch: (u, b) => request(app).patch(u).set('Authorization', `Bearer ${token}`).send(b),
        del: (u) => request(app).delete(u).set('Authorization', `Bearer ${token}`),
    });

    beforeEach(async () => {
        phone = await CatalogProduct.create({
            slug: 'phone-a', title: 'Phone A', brand: 'Brand', category: 'mobiles', categoryPath: ['electronics', 'mobiles'], status: 'active',
            variantOptions: [{ name: 'Storage', values: [{ value: '128GB' }, { value: '256GB' }] }],
            media: { groupBy: 'Storage', groups: {}, common: [] },
            variants: [variant('A-128GB', 20000, 10, { isDefault: true }), variant('A-256GB', 24000, 0)],
            priceRange: { min: 20000, max: 24000 }, inStock: true, searchText: 'phone a',
        });
        const a = await registerAndLogin(request, app, { username: `shopper${Date.now()}`, email: `s${Date.now()}@test.com` });
        shopper = a.token;
        shopperId = (await User.findOne({ username: a.payload.username }))._id;
        const b = await registerAndLogin(request, app, { username: `adm${Date.now()}`, email: `a${Date.now()}@test.com` });
        await User.updateOne({ username: b.payload.username }, { $set: { roles: ['admin'], adminRole: 'super_admin' } });
        admin = b.token;
    });

    it('sets, lists and removes alerts for the signed-in shopper', async () => {
        const made = await asUser(shopper).post('/api/alerts', { productId: String(phone._id), sku: 'A-128GB', kind: 'price' });
        expect(made.status).toBe(201);
        expect(made.body).toMatchObject({ sku: 'A-128GB', kind: 'price', basePrice: 20000, slug: 'phone-a', label: '128GB' });
        // Setting the same alert again doesn't duplicate it
        await asUser(shopper).post('/api/alerts', { productId: String(phone._id), sku: 'A-128GB', kind: 'price' });
        const list = await asUser(shopper).get('/api/alerts');
        expect(list.body.alerts).toHaveLength(1);

        expect((await asUser(shopper).del(`/api/alerts/${made.body._id}`)).status).toBe(200);
        expect((await asUser(shopper).get('/api/alerts')).body.alerts).toEqual([]);
        expect((await asUser(shopper).del(`/api/alerts/${made.body._id}`)).status).toBe(404);
    });

    it('validates the request and needs a signed-in shopper', async () => {
        expect((await request(app).get('/api/alerts')).status).toBe(401);
        expect((await asUser(shopper).post('/api/alerts', { productId: 'nope', sku: 'A', kind: 'price' })).status).toBe(400);
        expect((await asUser(shopper).post('/api/alerts', { productId: String(phone._id), sku: 'A-128GB', kind: 'sale' })).status).toBe(400);
        expect((await asUser(shopper).post('/api/alerts', { productId: String(phone._id), sku: 'NOPE', kind: 'price' })).status).toBe(404);
        // A stock alert only makes sense for something that is out of stock
        const inStock = await asUser(shopper).post('/api/alerts', { productId: String(phone._id), sku: 'A-128GB', kind: 'stock' });
        expect(inStock.body.message).toMatch(/in stock right now/);
    });

    it('notifies a shopper when an admin lowers the price, once', async () => {
        await asUser(shopper).post('/api/alerts', { productId: String(phone._id), sku: 'A-128GB', kind: 'price' });

        // A price rise sends nothing
        await asUser(admin).patch(`/api/admin/v2/products/${phone._id}/variants/A-128GB`, { price: 21000 });
        expect(await Notification.countDocuments({ userId: shopperId })).toBe(0);

        // Back below the price the alert was set at (20000)
        await asUser(admin).patch(`/api/admin/v2/products/${phone._id}/variants/A-128GB`, { price: 18500 });
        const notes = await Notification.find({ userId: shopperId }).lean();
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({ type: 'alert', title: 'Price drop', link: '/products/phone-a?variant=A-128GB' });
        expect(notes[0].message).toContain('₹18,500');
        expect(notes[0].message).toContain('₹20,000');
        expect(await ProductAlert.countDocuments()).toBe(0); // one-shot
    });

    it('notifies when an out-of-stock variant is restocked, by an admin or a cancelled order', async () => {
        await asUser(shopper).post('/api/alerts', { productId: String(phone._id), sku: 'A-256GB', kind: 'stock' });
        await asUser(admin).patch(`/api/admin/v2/products/${phone._id}/variants/A-256GB`, { stock: 5 });
        let notes = await Notification.find({ userId: shopperId }).lean();
        expect(notes.map((n) => n.title)).toEqual(['Back in stock']);

        // Again, through restoring an order line
        await CatalogProduct.updateOne({ _id: phone._id, 'variants.sku': 'A-256GB' }, { $set: { 'variants.$.stock': 0 } });
        await asUser(shopper).post('/api/alerts', { productId: String(phone._id), sku: 'A-256GB', kind: 'stock' });
        await restoreLine({ productId: phone._id, sku: 'A-256GB', quantity: 2 });
        notes = await Notification.find({ userId: shopperId }).lean();
        expect(notes.map((n) => n.title)).toEqual(['Back in stock', 'Back in stock']);
    });
});
