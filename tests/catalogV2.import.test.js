import { jest } from '@jest/globals';

const { loadProducts, validateCatalog, validateProduct, buildSearchText, derive } = await import('../scripts/catalog-v2/lib.js');
const { runImport } = await import('../scripts/catalog-v2/import.js');
const { default: CatalogProduct } = await import('../models/CatalogProduct.js');

const entries = loadProducts();

describe('catalog v2 data files', () => {
    it('all pass validation', () => {
        expect(entries.length).toBeGreaterThan(200);
        expect(validateCatalog(entries)).toEqual([]);
    });

    it('flags bad products', () => {
        const doc = structuredClone(entries[0].doc);
        doc.variants.forEach((v) => { v.isDefault = false; });
        doc.variants[0].mrp = doc.variants[0].price - 1;
        const errors = validateProduct(doc);
        expect(errors).toContain('needs exactly one default variant');
        expect(errors.some((e) => e.includes('mrp below price'))).toBe(true);
    });

    it('builds a readable search text with price and brand', () => {
        const { doc } = entries.find((e) => e.doc.category === 'mobiles');
        const text = buildSearchText(doc);
        expect(text.startsWith(doc.title)).toBe(true);
        expect(text).toContain(doc.brand);
        expect(text).toContain('₹');
        expect(text).not.toMatch(/undefined|null|\[object/);
    });
});

describe('runImport', () => {
    const sample = entries.slice(0, 5);
    const fakeEmbed = Object.assign(jest.fn(async () => Array(768).fill(0.1)), { delay: 0 });

    beforeEach(async () => {
        fakeEmbed.mockClear();
        await CatalogProduct.syncIndexes();
    });

    it('upserts, derives fields, embeds, and skips unchanged products on re-run', async () => {
        const log = jest.fn();
        const first = await runImport({ entries: sample, embed: fakeEmbed, log });
        expect(first).toEqual({ created: 5, updated: 0, skipped: 0, embedded: 5, failed: 0 });

        const saved = await CatalogProduct.findOne({ slug: sample[0].doc.slug }).select('+embedding').lean();
        expect(saved.priceRange).toEqual(derive(sample[0].doc).priceRange);
        expect(saved.inStock).toBe(true);
        expect(saved.variants.every((v) => v.stock > 0)).toBe(true);
        expect(saved.embedding).toHaveLength(768);
        expect(saved.searchText).toBe(buildSearchText(sample[0].doc));

        const second = await runImport({ entries: sample, embed: fakeEmbed, log });
        expect(second).toEqual({ created: 0, updated: 0, skipped: 5, embedded: 0, failed: 0 });
        expect(fakeEmbed).toHaveBeenCalledTimes(5);
    });

    it('re-embeds only changed products and can override status', async () => {
        await runImport({ entries: sample, embed: fakeEmbed, log: jest.fn() });
        fakeEmbed.mockClear();
        const changed = sample.map((e, i) => (i === 0 ? { ...e, doc: { ...e.doc, title: `${e.doc.title} (2026)` } } : e));
        const stats = await runImport({ entries: changed, embed: fakeEmbed, log: jest.fn() });
        expect(stats).toMatchObject({ updated: 1, skipped: 4, embedded: 1 });

        await runImport({ entries: sample.slice(1, 2), status: 'active', log: jest.fn() });
        expect((await CatalogProduct.findOne({ slug: sample[1].doc.slug })).status).toBe('active');
    });

    it('writes nothing on a dry run', async () => {
        const stats = await runImport({ entries: sample, dryRun: true, log: jest.fn() });
        expect(stats.created).toBe(5);
        expect(await CatalogProduct.countDocuments()).toBe(0);
    });
});
