import { jest } from '@jest/globals';
import { createStatefulRedisMock } from './helpers.js';

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
const { default: Pincode } = await import('../models/Pincode.js');
const { resetDirectoryCache } = await import('../services/delivery.service.js');

describe('GET /api/v2/delivery/:pincode', () => {
    beforeEach(() => resetDirectoryCache());

    test('before the directory is imported, estimates from the PIN code prefix', async () => {
        const res = await request(app).get('/api/v2/delivery/560038');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            pincode: '560038', valid: true, serviceable: true, zone: 'metro', source: 'prefix',
            place: { district: 'Bengaluru', state: 'Karnataka' }, days: { min: 1, max: 2 },
        });
    });

    test('with the directory, unknown codes are invalid and known ones name the area', async () => {
        await Pincode.create([
            { _id: '560038', area: 'Indiranagar', district: 'Bengaluru Urban', state: 'Karnataka', location: { lat: 12.975, lng: 77.641 } },
            { _id: '795001', area: 'Imphal', district: 'Imphal West', state: 'Manipur' },
        ]);

        const known = await request(app).get('/api/v2/delivery/560038?category=appliances');
        expect(known.body).toMatchObject({
            valid: true, source: 'india-post', zone: 'metro', installation: true, days: { min: 2, max: 3 },
            place: { area: 'Indiranagar', district: 'Bengaluru Urban', state: 'Karnataka' },
        });

        const remote = await request(app).get('/api/v2/delivery/795001');
        expect(remote.body).toMatchObject({ zone: 'remote', days: { min: 6, max: 9 } });

        const unknown = await request(app).get('/api/v2/delivery/560999');
        expect(unknown.body).toMatchObject({ valid: false });
    });

    test('rejects malformed input', async () => {
        expect((await request(app).get('/api/v2/delivery/56003')).body).toMatchObject({ valid: false });
        expect((await request(app).get('/api/v2/delivery/901234')).body).toMatchObject({ valid: true, serviceable: false });
        expect((await request(app).get('/api/v2/delivery/560038?category=DROP%20TABLE')).status).toBe(400);
    });
});
