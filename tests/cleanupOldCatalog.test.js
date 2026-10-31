import mongoose from 'mongoose';
import { cleanupOldCatalog } from '../scripts/cleanup-old-catalog.js';

const { default: Order } = await import('../models/Order.js');
const { default: User } = await import('../models/User.js');

const id = () => new mongoose.Types.ObjectId();

describe('cleanup:old-catalog', () => {
    beforeEach(async () => {
        await Order.collection.insertMany([
            { userId: id(), products: [{ productId: id(), name: 'Old phone', quantity: 1, price: 100 }] },
            { userId: id(), products: [{ productId: id(), catalog: 'v2', sku: 'A-1', name: 'New', quantity: 1, price: 100 }, { productId: id(), catalog: 'v1', name: 'Old', quantity: 1, price: 50 }] },
            { userId: id(), products: [{ productId: id(), catalog: 'v2', sku: 'B-1', name: 'New only', quantity: 2, price: 200 }] },
        ]);
        await User.collection.insertOne({
            username: 'shopper', email: 'shopper@test.com',
            cart: [{ productId: id(), catalog: 'v2', sku: 'A-1', quantity: 1 }, { productId: id(), title: 'Old', quantity: 1 }],
            wishlist: [{ productId: id(), catalog: 'v1', title: 'Old' }],
        });
        await mongoose.connection.db.collection('products').insertOne({ title: 'Old product' });
    });

    const quiet = () => {};

    it('reports without changing anything on a dry run', async () => {
        const res = await cleanupOldCatalog({ log: quiet });
        expect(res).toEqual({ orders: 2, carts: 1, wishlists: 1, products: 1, applied: false });
        expect(await Order.countDocuments()).toBe(3);
    });

    it('removes old orders, old cart and wishlist lines, and the products collection', async () => {
        await cleanupOldCatalog({ apply: true, log: quiet });
        const orders = await Order.find().lean();
        expect(orders.map((o) => o.products[0].name)).toEqual(['New only']);
        const user = await User.findOne({ username: 'shopper' }).lean();
        expect(user.cart.map((c) => c.sku)).toEqual(['A-1']);
        expect(user.wishlist).toEqual([]);
        const collections = await mongoose.connection.db.listCollections({ name: 'products' }).toArray();
        expect(collections).toHaveLength(0);
    });
});
