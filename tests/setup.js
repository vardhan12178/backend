import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

let replSet;

// Connect to In-Memory MongoDB before all tests
beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1 },
    });
    const uri = replSet.getUri();

    // Prevent re-connection errors if tests run in parallel
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }

    await mongoose.connect(uri);
});

// Clear database after each test suite
afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
        await collections[key].deleteMany();
    }
});

// Disconnect after all tests
afterAll(async () => {
    // Stop the in-memory server first to avoid noisy ECONNRESET logs on teardown.
    if (replSet) await replSet.stop();
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }
});
