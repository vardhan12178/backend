const { ratingFor, reviewsFor, breakdown } = await import('../services/catalog.reviews.js');
const { loadProducts } = await import('../scripts/catalog/lib.js');

const products = loadProducts().map(({ doc }) => doc);

describe('catalog sample reviews', () => {
    it('covers every product, with unique reviewer names and review text', () => {
        const names = new Set();
        const bodies = new Set();
        let total = 0;
        for (const p of products) {
            const r = reviewsFor(p);
            expect(r).not.toBeNull();
            for (const review of r.reviews) {
                total++;
                names.add(review.name);
                bodies.add(review.body);
            }
        }
        expect(names.size).toBe(total);
        expect(bodies.size).toBe(total);
    });

    it('builds a star breakdown whose mean is the average', () => {
        for (const avg of [3.8, 4.1, 4.4, 4.7]) {
            const b = breakdown(avg);
            expect(b.reduce((a, x) => a + x, 0)).toBeCloseTo(1);
            expect(b[0] * 5 + b[1] * 4 + b[2] * 3 + b[3] * 2 + b[4]).toBeCloseTo(avg);
        }
    });

    it('is deterministic, newest first, and never dated before an electronics launch', () => {
        const phone = products.find((p) => p.slug === 'apple-iphone-18-pro');
        const a = reviewsFor(phone);
        expect(reviewsFor(phone)).toEqual(a);
        expect(a.reviews.map((r) => r.date)).toEqual([...a.reviews.map((r) => r.date)].sort().reverse());
        expect(a.reviews.every((r) => r.date >= phone.launchDate)).toBe(true);
        expect(a.stars.reduce((n, s) => n + s.count, 0)).toBeCloseTo(a.count, -1);
        expect(ratingFor({ slug: 'not-in-catalog' })).toBeNull();
    });
});
