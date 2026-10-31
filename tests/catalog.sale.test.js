import { saleFor, salePrice, applySale, saleKey, storefrontCategoryOf } from '../services/catalog.service.js';

const sale = {
    _id: 'sale1', name: 'Diwali Sale', updatedAt: '2026-10-30T10:00:00Z',
    categories: [{ category: 'mobiles', discountPercent: 20, primeDiscountPercent: 25 }, { category: 'fashion-women', discountPercent: 30 }],
};
const phone = {
    slug: 'p', category: 'mobiles', categoryPath: ['electronics', 'mobiles'],
    variants: [{ sku: 'A', price: 70000, mrp: 80000 }, { sku: 'B', price: 50000, mrp: 90000 }],
    priceRange: { min: 50000, max: 70000 },
};

describe('sale pricing', () => {
    test('matches products by storefront category', () => {
        expect(saleFor(phone, sale)).toEqual({ id: 'sale1', name: 'Diwali Sale', percent: 20, primePercent: 25 });
        const kurti = { category: 'fashion', categoryPath: ['fashion', 'women'], keySpecs: { gender: 'Women' } };
        expect(storefrontCategoryOf(kurti)).toBe('fashion-women');
        expect(saleFor(kurti, sale)).toMatchObject({ percent: 30, primePercent: null });
        expect(saleFor({ ...kurti, keySpecs: { gender: 'Men' } }, sale)).toBeNull();
        expect(saleFor(phone, null)).toBeNull();
    });

    test('takes the discount off MRP but never raises a price', () => {
        const terms = saleFor(phone, sale);
        expect(salePrice(phone.variants[0], terms)).toBe(64000); // 80000 - 20%
        expect(salePrice(phone.variants[0], terms, true)).toBe(60000); // Prime: 25%
        expect(salePrice(phone.variants[1], terms)).toBe(50000); // already below 90000 - 20%
        expect(salePrice(phone.variants[0], null)).toBe(70000);
    });

    test('applies to every variant and the price range', () => {
        const { product, terms } = applySale(phone, sale);
        expect(product.variants.map((v) => v.price)).toEqual([64000, 50000]);
        expect(product.priceRange).toEqual({ min: 50000, max: 64000 });
        expect(terms.name).toBe('Diwali Sale');
        expect(phone.variants[0].price).toBe(70000); // the stored product is untouched
    });

    test('cache keys change when a sale starts or is edited', () => {
        expect(saleKey(null)).toBe('s0');
        expect(saleKey(sale)).not.toBe(saleKey({ ...sale, updatedAt: '2026-10-31T10:00:00Z' }));
    });
});
