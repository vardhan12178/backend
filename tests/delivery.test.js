import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stateFromPrefix, zoneFor, estimate, nearestHub } from '../services/delivery.service.js';
import { parseCsv, normalizeRecord, aggregate, cleanOffice, titleCase } from '../scripts/pincodes/lib.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('PIN code prefixes', () => {
    test('map to the postal circle, with the smaller exceptions first', () => {
        expect(stateFromPrefix('560038')).toBe('Karnataka');
        expect(stateFromPrefix('403001')).toBe('Goa');
        expect(stateFromPrefix('834001')).toBe('Jharkhand');
        expect(stateFromPrefix('682555')).toBe('Lakshadweep');
        expect(stateFromPrefix('682001')).toBe('Kerala');
    });

    test('unused ranges and malformed codes are rejected', () => {
        expect(stateFromPrefix('350001')).toBeNull();
        expect(stateFromPrefix('012345')).toBeNull();
        expect(stateFromPrefix('56003')).toBeNull();
    });
});

describe('delivery estimate', () => {
    test('zones: warehouse city, same state, elsewhere, remote', () => {
        expect(zoneFor({ pin: '560038', state: 'Karnataka' })).toBe('metro');
        expect(zoneFor({ pin: '570001', state: 'Karnataka' })).toBe('regional');
        expect(zoneFor({ pin: '302001', state: 'Rajasthan' })).toBe('national');
        expect(zoneFor({ pin: '795001', state: 'Manipur' })).toBe('remote');
    });

    test('coordinates, when known, decide the zone by distance to the nearest warehouse', () => {
        expect(nearestHub({ lat: 12.98, lng: 77.64 }).city).toBe('Bengaluru');
        expect(zoneFor({ pin: '562125', state: 'Karnataka', location: { lat: 12.95, lng: 77.75 } })).toBe('metro');
        expect(zoneFor({ pin: '302001', state: 'Rajasthan', location: { lat: 26.91, lng: 75.79 } })).toBe('regional');
    });

    test('large appliances take a day longer and include installation', () => {
        const phone = estimate({ pin: '560038', place: { state: 'Karnataka', source: 'prefix' } });
        const ac = estimate({ pin: '560038', category: 'appliances', place: { state: 'Karnataka', source: 'prefix' } });
        expect(phone).toMatchObject({ valid: true, serviceable: true, zone: 'metro', days: { min: 1, max: 2 }, cod: true, installation: false });
        expect(phone.place).toEqual({ area: null, district: 'Bengaluru', state: 'Karnataka' });
        expect(ac.days).toEqual({ min: 2, max: 3 });
        expect(ac.installation).toBe(true);
    });

    test('no cash on delivery for the islands and Ladakh; no delivery to Army post offices', () => {
        expect(estimate({ pin: '744101', place: { state: 'Andaman and Nicobar Islands' } })).toMatchObject({ zone: 'remote', cod: false });
        expect(estimate({ pin: '901234', place: { state: 'Army Postal Service' } })).toMatchObject({ valid: true, serviceable: false });
    });
});

describe('India Post directory import', () => {
    const rows = parseCsv(fs.readFileSync(path.join(here, 'fixtures/pincodes-sample.csv'), 'utf8'));

    test('parses the CSV and cleans names', () => {
        expect(rows).toHaveLength(6);
        expect(cleanOffice('Indiranagar S.O (Bangalore)')).toBe('Indiranagar');
        expect(cleanOffice('IMPHAL H.O')).toBe('Imphal');
        expect(titleCase('ANDAMAN AND NICOBAR ISLANDS')).toBe('Andaman and Nicobar Islands');
    });

    test('one document per PIN code, named after its main delivery office', () => {
        const docs = aggregate(rows.map(normalizeRecord));
        expect(docs.map((d) => d._id)).toEqual(['560038', '795001', '744101']);
        expect(docs[0]).toEqual({
            _id: '560038', area: 'Indiranagar', district: 'Bengaluru Urban', state: 'Karnataka', delivery: true,
            location: { lat: 12.9751, lng: 77.641 },
        });
        expect(docs[2].state).toBe('Andaman and Nicobar Islands');
    });

    test('accepts the data.gov.in API field names too', () => {
        expect(normalizeRecord({ officename: 'Fort S.O', pincode: 400001, officetype: 'S.O', deliverystatus: 'Delivery', districtname: 'MUMBAI', statename: 'MAHARASHTRA' }))
            .toMatchObject({ pincode: '400001', office: 'Fort', officeType: 'SO', delivery: true, district: 'Mumbai', state: 'Maharashtra', location: null });
    });
});
