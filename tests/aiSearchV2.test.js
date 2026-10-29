import { jest } from '@jest/globals';

const { sanitizeIntent, buildFilters, rrfFuse, applyRanking, chatV2, needsIntent, MAX_RESULTS } = await import('../services/aiSearchV2.js');
const { default: CatalogProduct } = await import('../models/CatalogProduct.js');

const doc = (slug, extra = {}) => ({
    slug,
    title: `Brand ${slug}`,
    brand: 'Brand',
    category: 'mobiles',
    categoryPath: ['electronics', 'mobiles'],
    status: 'draft',
    media: { groupBy: 'Color', groups: { Black: [{ key: `mobiles/${slug}/black-1`, alt: slug }] }, common: [] },
    variants: [{ sku: `${slug}-1`, options: { Color: 'Black' }, price: 20000, mrp: 25000, stock: 5, isDefault: true }],
    priceRange: { min: 20000, max: 20000 },
    inStock: true,
    ...extra,
});

describe('aiSearchV2 helpers', () => {
    it('sanitizes the intent the model returns', () => {
        const intent = sanitizeIntent({ query: 'gaming phone', category: 'mobiles', minPrice: 40000, maxPrice: 20000, minRamGB: 'lots', is5G: 'yes', sort: 'random' }, 'msg');
        expect(intent).toMatchObject({ query: 'gaming phone', category: 'mobiles', minPrice: 20000, maxPrice: 40000, minRamGB: null, is5G: null, sort: null });
        expect(sanitizeIntent({ category: 'spaceships' }, 'raw message')).toMatchObject({ query: 'raw message', category: null });
        expect(sanitizeIntent(null, 'x y')).toMatchObject({ query: 'x y' });
    });

    it('puts indexed filters in the vector pre-filter and the rest in a post-match', () => {
        const f = buildFilters({ category: 'fashion-women', maxPrice: 3000, minRamGB: null, brand: null });
        expect(f.pre).toMatchObject({ category: 'fashion', inStock: true, 'priceRange.min': { $lte: 3000 } });
        expect(f.post).toEqual({ 'keySpecs.gender': 'Women' });
        expect(buildFilters({ category: 'appliances' }).pre.category).toEqual({ $in: ['refrigerators', 'washing-machines', 'air-conditioners'] });
        expect(buildFilters({ category: 'mobiles', minBatteryMah: 5000, is5G: true }).pre).toMatchObject({ 'keySpecs.batteryMah': { $gte: 5000 }, 'keySpecs.is5G': true });
    });

    it('fuses ranked lists with RRF', () => {
        const a = { _id: 'a' }, b = { _id: 'b' }, c = { _id: 'c' };
        const fused = rrfFuse([[a, b], [b, c]]);
        expect(fused.map((e) => e.doc._id)).toEqual(['b', 'a', 'c']);
        expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61);
    });

    it('validates the model ranking and falls back to fused order', () => {
        const list = ['p1', 'p2', 'p3', 'p4', 'p5'].map((s) => ({ slug: s }));
        const ok = applyRanking(list, { rankedIndexes: [3, 3, 9, 1, 'x'], reasons: { 3: 'best battery' } });
        expect(ok.items.map((i) => i.doc.slug)).toEqual(['p3', 'p1']);
        expect(ok.items[0].reason).toBe('best battery');
        const bad = applyRanking(list, { rankedIndexes: 'nope' });
        expect(bad.reranked).toBe(false);
        expect(bad.items).toHaveLength(MAX_RESULTS);
    });
});

describe('needsIntent', () => {
    it('skips the intent call for plain names and descriptions, not for prices, specs or follow-ups', () => {
        for (const m of ['OnePlus 15R', 'iPhone 16', 'noise cancelling earbuds for flights']) expect(needsIntent(m)).toBe(false);
        for (const m of ['phone under 40k', 'phone 25000', 'phone with 12gb ram', 'saree for women', 'cheaper ones']) expect(needsIntent(m)).toBe(true);
        expect(needsIntent('OnePlus 15R', [{ role: 'user', content: 'hi' }])).toBe(true);
    });
});

describe('chatV2', () => {
    beforeEach(async () => {
        await CatalogProduct.syncIndexes();
        await CatalogProduct.insertMany([
            doc('galaxy-gaming', { title: 'Samsung Galaxy Gaming Phone', brand: 'Samsung', searchText: 'gaming phone big battery 6000mAh', priceRange: { min: 35000, max: 35000 } }),
            doc('budget-phone', { title: 'Redmi Budget Phone', brand: 'Redmi', searchText: 'budget phone 5000mAh', priceRange: { min: 9000, max: 9000 } }),
            doc('flagship', { title: 'Apple Flagship Phone', brand: 'Apple', searchText: 'premium phone camera', priceRange: { min: 90000, max: 90000 } }),
            doc('sold-out-gaming', { title: 'Old Gaming Phone', searchText: 'gaming phone', inStock: false }),
        ]);
    });

    // Without Atlas, $vectorSearch fails; the keyword side must carry the answer on its own
    const ai = (intent, answer) => ({
        intent: jest.fn(async () => intent),
        answer: jest.fn(async () => answer),
        embed: jest.fn(async () => { throw new Error('no vector index here'); }),
    });

    it('answers from keyword search with filters, in stock only, in the model order', async () => {
        const fake = ai({ query: 'gaming phone', category: 'mobiles', maxPrice: 40000 }, { rankedIndexes: [1], reasons: { 1: 'Fits the budget' }, response: { summary: 'One good pick.', points: [] } });
        const res = await chatV2('gaming phone under 40k', [], fake);
        expect(res.products.map((p) => p.slug)).toEqual(['galaxy-gaming']);
        expect(res.products[0]).toMatchObject({ catalog: 'v2', sku: 'galaxy-gaming-1', price: 35000, stock: 1, reason: 'Fits the budget' });
        expect(res.products[0].thumbnail).toMatch(/black-1-md\.webp$/);
        expect(res.structured.response.summary).toBe('One good pick.');
        expect(fake.answer).toHaveBeenCalledTimes(1);
    });

    it('relaxes filters when nothing matches and says so', async () => {
        const fake = ai({ query: 'gaming phone', category: 'mobiles', maxPrice: 1000 }, { rankedIndexes: [1], response: { summary: 'Closest.' } });
        const res = await chatV2('gaming phone under 1000', [], fake);
        expect(res.products[0].slug).toBe('galaxy-gaming');
        expect(res.structured.response.summary).toMatch(/closest options/);
    });

    it('still answers when the model calls fail', async () => {
        const fake = { intent: jest.fn(async () => { throw new Error('quota'); }), answer: jest.fn(async () => { throw new Error('quota'); }), embed: jest.fn(async () => { throw new Error('quota'); }) };
        const res = await chatV2('budget phone', [], fake);
        expect(res.products.map((p) => p.slug)).toContain('budget-phone');
    });

    it('skips the intent call for a plain name and embeds each query once', async () => {
        const fake = ai({}, { rankedIndexes: [1] });
        fake.embed = jest.fn(async () => { throw new Error('no vector index here'); });
        const res = await chatV2('Samsung Galaxy Gaming Phone', [], fake);
        expect(fake.intent).not.toHaveBeenCalled();
        expect(fake.embed).toHaveBeenCalledTimes(1);
        expect(res.products[0].slug).toBe('galaxy-gaming');
    });
});
