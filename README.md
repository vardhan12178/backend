# VKart API

Backend for [VKart](https://vkart.balavardhan.dev), a full-stack e-commerce portfolio project: a 264-product catalog with variants, AI-assisted search, Razorpay payments, Prime membership, price and stock alerts, verified-buyer reviews and an admin panel with role-based access.

- **Frontend repo:** https://github.com/vardhan12178/vkart
- **Live site:** https://vkart.balavardhan.dev
- **Stack:** Node.js 24, Express (ESM), MongoDB Atlas (Mongoose, Atlas Search and Vector Search), Redis, Socket.io, Razorpay, Google Gemini, AWS S3, Resend

## Try it without signing up

- `POST /api/auth/demo/shopper` signs in a shared demo shopper (can browse, order in Razorpay test mode and write a review on a seeded delivered order).
- `POST /api/auth/demo/admin` signs in a read-only admin (products, orders, coupons, sales, membership and reviews; no customer data, and every write is rejected by `middleware/demoGuard.js`).

Both accounts have random, unknown passwords; these two endpoints are the only way in. Set `DEMO_LOGINS=false` to turn them off.

## Architecture

```text
routes/        HTTP routes and request validation (express-validator)
controllers/   request handlers, thin
services/      business logic: catalog, stock and pricing, search, alerts, reviews, refunds, delivery
models/        Mongoose schemas
middleware/    auth (JWT), RBAC permissions, security (CORS, CSRF, rate limits), demo guard
scripts/       catalog import, image pipeline, search evaluation, pincode import, cleanup
data/          catalog product files and sample review content
tests/         Jest + Supertest + mongodb-memory-server
docs/          design notes (see below)
```

Key behaviours:

- **Catalog** (`/api/v2`, admin at `/api/admin/v2`): products with variants (colour, storage, size), per-category filters with facet counts, rating and discount sorting, and sale pricing computed from MRP per request. Cached in Redis under `catalog:r4:*`; bump `SHAPE` in `controllers/catalog.controller.js` when a response shape changes.
- **Ask VKart** (`/api/ai`): an intent step, then Atlas `$vectorSearch` and `$text` run in parallel and are fused with Reciprocal Rank Fusion, then a rerank step. `npm run catalog:eval` scores keyword, vector and hybrid retrieval on 24 labelled queries.
- **Checkout:** server-priced orders, atomic per-variant stock reservation (restored on cancellation), Razorpay with signature checks and webhooks, wallet, coupons and refunds.
- **Reviews:** only shoppers with a delivered order can review a product, once; helpful votes; moderators can hide reviews.
- **Alerts:** price-drop and back-in-stock alerts by email.
- **Auth and security:** HTTP-only JWT cookie, CSRF token, rate limits, helmet, token revocation, optional TOTP 2FA, Google sign-in. Admin permissions are checked against the database on every request (`middleware/permissions.js`).

## Getting started

Requires Node 24 and a MongoDB Atlas cluster (Redis is optional locally).

```bash
npm install
cp .env.example .env   # then fill in the values below
npm start              # http://localhost:5000
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port (default 5000) |
| `MONGO_URI` | MongoDB Atlas connection string |
| `REDIS_URL` | Redis connection (cache, sessions, token blacklist) |
| `JWT_SECRET`, `AES_KEY` | Token signing; 32-byte key for encrypting 2FA secrets |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Payments (use test keys) |
| `GOOGLE_CLIENT_ID` | Google sign-in |
| `GEMINI_API_KEY` | Embeddings and the AI assistant |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_REGION`, `S3_PUBLIC_BASE_URL` | Product image storage |
| `RESEND_API_KEY`, `FROM_EMAIL` | Transactional email |
| `APP_URL`, `APP_ORIGIN` | Public site URL for email links; extra allowed CORS origin |
| `CATALOG_ACTIVE_ONLY` | `true` to show only `active` products (publish drafts first) |
| `DEMO_LOGINS` | `false` disables the demo shopper and admin |

Optional tuning: `AI_V2_MODEL`, `AI_V2_TIMEOUT_MS`, `AI_V2_RANK_TIMEOUT_MS`, `AI_V2_VECTOR_MIN_SCORE`, `GEMINI_EMBEDDING_MODEL`, `EMBEDDING_DIM`, `CATALOG_V2_VECTOR_INDEX`.

### Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the API |
| `npm test` | Run the test suite (in-memory MongoDB; first run downloads a MongoDB binary) |
| `npm run catalog:import` | Load products from `data/catalog` into MongoDB (new products start as `draft`) |
| `npm run catalog:images -- --category=<slug>` | Fetch, convert to WebP and upload product images to S3 |
| `npm run catalog:eval` | Retrieval quality: Recall@4 and MRR for keyword, vector and hybrid search |
| `npm run pincodes:import -- --file=<csv>` | Import the India Post pincode directory for delivery estimates |
| `npm run cleanup:old-catalog` | Report (add `-- --apply` to delete) data left from the retired product catalog |
| `npm run set-super-admin` | Promote a user to super admin |

## Testing

`npm test` runs 380+ tests with Jest, Supertest and mongodb-memory-server: auth and 2FA, Razorpay payments and webhooks, orders and refunds, coupons, wallet, membership, catalog API and filters, reviews, alerts, delivery, RBAC, support chat and the AI search pipeline. GitHub Actions runs them on every push and pull request.

## Deployment

Deployed on Render (auto-deploys from `main`). `engines.node` is pinned to `24.x`; an open range once let Render pick a newer Node that broke a dependency.

## Docs

- [`docs/CATALOG_SCHEMA.md`](docs/CATALOG_SCHEMA.md): collections, fields, image pipeline and REST API.
- [`docs/AI_UPGRADE_PLAN.md`](docs/AI_UPGRADE_PLAN.md): how Ask VKart search was designed and evaluated.

## License

Source-available for learning and portfolio review; see [LICENSE](LICENSE).

Author: Bala Vardhan Pula
