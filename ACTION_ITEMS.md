# VKart Backend — Action Items

Tracked from a code review (Jul 2026). Portfolio/demo context — not blocking, but do not lose track before going live with real money.

---

## P0 — Money correctness

- [ ] **ORIGINAL refunds never hit Razorpay**  
  `services/refund.scheduler.js` marks `refundStatus: COMPLETED` and emails the user, but never calls the Razorpay refund API. Same INITIATED path from cancel / admin refund.  
  **Fix:** Call Razorpay refunds (or keep status as pending/manual and never claim “completed”).

## P1 — Auth / access

- [ ] **Admin role & blocked status stuck in JWT (30d)**  
  `middleware/auth.js` trusts `roles` from the token. Demoting admin or blocking a user does not revoke existing JWTs.  
  **Fix:** Re-check `roles` / `blocked` from DB on protected routes, or use short-lived access tokens + refresh / force logout on role/block change.

## P1 — Race conditions (money)

- [ ] **Checkout payment token race**  
  Place-order reads verification token, commits order, then consumes token async → concurrent requests can double-create paid orders.  
  **Fix:** Atomic consume (`GETDEL` / Lua) *before* commit; unique index on `paymentId` / `paymentOrderId`.

- [ ] **Wallet / membership double-credit race**  
  Session consumed, then user credited with a non-atomic “already used paymentId” check.  
  **Fix:** Atomic credit (transaction + unique paymentId constraint) or consume-and-credit in one critical section.

## P2 — Abuse / UX

- [ ] **Public AI chat cost surface**  
  `POST /api/ai/chat` is optional-auth + 30/min/IP — fine for demo, easy Gemini cost burn if exposed.  
  **Fix:** Require auth, tighter limits, and/or daily caps.

- [ ] **Google signup username collision**  
  `username = email.split('@')[0]` can hit unique index → opaque “Google sign-in failed”.  
  **Fix:** Append suffix / random suffix on conflict.

- [ ] **Coupon usage limits race**  
  `applyCoupon` then `recordCouponUsage` after commit can exceed `usageLimit` / `perUserLimit`.  
  **Fix:** Atomic increment with limit check inside the order transaction.

## P3 — Nice to have

- [ ] Create Razorpay checkout order from a **server-priced** session (not client `amount`).
- [ ] Hide inactive products from `getProductById` (or return 404).
- [ ] Unique DB indexes on `Order.paymentId` / `paymentOrderId` where set.

---

## Already in good shape (don’t re-litigate)

- Server-owned order pricing (DB products, sale, coupon).
- Online pay gated by verification token + amount match.
- Helmet / CORS / sanitize / rate limits / CSRF (double-submit).
- Password & 2FA secrets `select: false`; JWT cookie httpOnly; logout blacklist.
- Backend `.env` gitignored.
