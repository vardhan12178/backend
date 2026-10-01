# VKart Backend — Action Items

Tracked from a code review (Jul 2026). Portfolio/demo context — not blocking, but do not lose track before going live with real money.

**Status (Oct 2026):** every item below was resolved in roadmap Phase 2 (branch `ccr-d558e8f9-ithgfk`). Each fix is covered by `tests/hardening.test.js`, and the race tests were confirmed to fail against the pre-fix code.

---

## P0 — Money correctness

- [x] **ORIGINAL refunds never hit Razorpay**
  Real refunds have gone through `services/refund.service.js` since Aug 2026, confirmed by the `refund.processed` webhook. The leftover in `services/refund.scheduler.js` also flipped no-gateway-payment orders (legacy/COD) to COMPLETED and emailed the customer although nothing was paid back. It now flags them to admins once and leaves them INITIATED.

## P1 — Auth / access

- [x] **Admin role & blocked status stuck in JWT (30d)**
  `middleware/auth.js` → `resolveAuthToken()` reads `roles` / `adminRole` / `blocked` from the DB on every authenticated request (one `_id` lookup). Demotion takes effect on the next request. Blocked accounts get a 401 and are signed out. Socket.io connections use the same resolver, so admin rooms follow the current role too.

## P1 — Race conditions (money)

- [x] **Checkout payment token race**
  - Unique partial indexes on `Order.paymentId` / `paymentOrderId` are the hard guarantee.
  - A Redis `SET NX` claim per verification token turns a concurrent duplicate into a clean 409.
  - The token is consumed after commit.
  - `/razorpay/verify` is idempotent: a repeat returns the same token.
  - Session pops are atomic (`MULTI GET+DEL`).

- [x] **Wallet / membership double-credit race**
  - Wallet: credit + transaction record happen in one conditional update that only matches if the `paymentId` isn't recorded yet.
  - Membership: compare-and-set on the current `endDate` plus `paymentId`, retried on conflict. Two different payments landing at once both count.

## P2 — Abuse / UX

- [x] **Public AI chat cost surface**
  - Daily quota shared by chat, NL search and compare (`middleware/aiQuota.js`): 100/day signed-in, 20/day per guest IP, tunable via `AI_DAILY_LIMIT_USER` / `AI_DAILY_LIMIT_GUEST`.
  - Guest per-minute chat limit lowered from 30 to 10.
  - The chat UI shows the quota message.

- [x] **Google signup username collision**
  The email local part is cleaned to the allowed charset; a random suffix is added on conflict, including when the insert itself races.

- [x] **Coupon usage limits race**
  `reserveCouponUsage()` claims a use inside the order transaction, with `usageLimit` / `perUserLimit` enforced by the update filter itself. The post-commit `recordCouponUsage` is gone.

## P3 — Nice to have

- [x] Razorpay checkout order is priced on the server (`services/checkout.pricing.service.js`, the same quote `createOrder` uses). The legacy `amount` request is still accepted for one release so an older cached storefront doesn't break during deploy. **Remove it in Phase 3.**
- [x] Inactive products return 404 from `getProductById` for shoppers (admins still see them). Malformed ids are 404 instead of 500.
- [x] Unique DB indexes on `Order.paymentId` / `paymentOrderId` where set.
- [x] `multer` 1.x → 2.x.

## Deploy notes

- The new unique indexes are built by Mongoose on startup. If production already has two orders with the same `paymentId` (or `paymentOrderId`), the index build fails: Mongoose logs it and the app still runs, but without the guarantee. Check before deploying:
  `db.orders.aggregate([{ $match: { paymentId: { $type: "string" } } }, { $group: { _id: "$paymentId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])`
- New optional env vars: `AI_DAILY_LIMIT_USER`, `AI_DAILY_LIMIT_GUEST`.

## Known follow-ups (not in scope of Phase 2)

- Coupon uses are not returned when an order is cancelled (unchanged behaviour).
- If a sale starts or ends between "Pay" and order placement, the re-priced order no longer matches the payment and is rejected (the customer was charged). Phase 3 could honour the quoted price for the life of the Razorpay order.

---

## Already in good shape (don’t re-litigate)

- Server-owned order pricing (DB products, sale, coupon).
- Online pay gated by verification token + amount match.
- Helmet / CORS / sanitize / rate limits / CSRF (double-submit).
- Password & 2FA secrets `select: false`; JWT cookie httpOnly; logout blacklist.
- Backend `.env` gitignored.
