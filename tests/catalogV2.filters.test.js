import { filtersFor, parseSelections, matchFor, shapeFacet, narrowStages } from '../services/catalogV2.filters.js';

const filter = (category, key) => filtersFor(category).find((f) => f.key === key);

describe('catalog v2 spec filters', () => {
    test('selections keep only known filters and values, cast to the field type', () => {
        expect(parseSelections({ f_ram: '8,12,abc', f_5g: '1', f_battery: '6000,bogus', f_nope: 'x', brand: 'Apple' }, 'mobiles'))
            .toEqual({ ram: [8, 12], '5g': ['1'], battery: ['6000'] });
        expect(parseSelections({ f_ram: '8' }, 'fashion-men')).toEqual({});
        expect(parseSelections({ f_ram: '8' }, undefined)).toEqual({});
    });

    test('variant-level ranges use $elemMatch so one variant has to satisfy the whole range', () => {
        const f = { key: 'x', kind: 'ranges', field: 'variants.keySpecs.screenInch', options: [{ value: 'a', min: 40, max: 50 }] };
        expect(matchFor(f, ['a'])).toEqual({ $or: [{ variants: { $elemMatch: { 'keySpecs.screenInch': { $gte: 40, $lt: 50 } } } }] });
        expect(matchFor(filter('mobiles', 'battery'), ['6000'])).toEqual({ $or: [{ 'keySpecs.batteryMah': { $gte: 6000 } }] });
        expect(matchFor(filter('mobiles', 'ram'), [8, 12])).toEqual({ 'variants.keySpecs.ramGB': { $in: [8, 12] } });
        expect(matchFor(filter('tvs', 'screen'), [55])).toEqual({ $or: [{ 'keySpecs.screenInch': { $in: [55] } }, { 'variants.keySpecs.screenInch': { $in: [55] } }] });
    });

    test('clothing sizes and colours are matched by pattern', () => {
        const size = matchFor(filter('fashion-women', 'size'), ['S']);
        const re = new RegExp(size['variants.options.Size'].$regex, 'i'); // one value: a plain condition
        expect(['S', 'S-38', 'XS', 'XS-36'].map((v) => re.test(v))).toEqual([true, true, false, false]);
        const colours = matchFor(filter('fashion-men', 'color'), ['Blue', 'Gold']);
        expect(colours.$or).toHaveLength(2);
        expect(new RegExp(colours.$or[0]['variants.options.Color'].$regex, 'i').test('Navy Blue')).toBe(true);
    });

    test('facets merge raw values into clean choices and count each product once', () => {
        const raw = [
            { _id: 'S', ids: ['p1', 'p2'] }, { _id: 'S-38', ids: ['p2', 'p3'] }, { _id: 'UK 7', ids: ['p4'] },
            { _id: '7', ids: ['p5'] }, { _id: 'One Size', ids: ['p6'] }, { _id: 'XS', ids: ['p1'] },
        ];
        expect(shapeFacet(filter('fashion-men', 'size'), raw, 6).options).toEqual([
            { value: 'XS', label: 'XS', count: 1 },
            { value: 'S', label: 'S', count: 3 },
            { value: '7', label: 'UK 7', count: 2 },
        ]);
    });

    test('filters that cannot narrow the list are hidden, unless already selected', () => {
        const fiveG = filter('mobiles', '5g');
        expect(shapeFacet(fiveG, [{ _id: '1', count: 10 }], 10)).toBeNull();
        expect(shapeFacet(fiveG, [{ _id: '1', count: 7 }], 10)).toMatchObject({ kind: 'flag', options: [{ value: '1', label: '5G', count: 7 }] });
        const os = filter('mobiles', 'os');
        expect(shapeFacet(os, [{ _id: 'Android', ids: ['a'] }], 5)).toBeNull();
        expect(shapeFacet(os, [], 5, ['iOS']).options).toEqual([{ value: 'iOS', label: 'iOS', count: 0 }]);
    });

    test('narrowing can leave one filter out, for that filter\'s own counts', () => {
        const sel = { ram: [8], '5g': ['1'] };
        expect(narrowStages('mobiles', sel)).toHaveLength(2);
        expect(narrowStages('mobiles', sel, 'ram')).toEqual([{ $match: { 'keySpecs.is5G': true } }]);
    });
});
