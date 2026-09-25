# Vyra API

One modular Node.js backend for every Vyra surface — customer, admin, seller, pharmacy, delivery/rider and POS.
Node 22.9+ · Express 5 · PostgreSQL 13+ · zod. **Status: Phase 1 (auth, roles, audit).** See `../MIGRATION_PLAN.md`.

## Quick start

```bash
cd backend
cp .env.example .env            # then fill in DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET
npm install
npm run migrate                 # creates the schema (forward-only, checksummed)
npm run seed:reference          # roles + permissions (required in every environment)
npm run seed:demo               # optional: demo accounts (refused when NODE_ENV=production)
npm run dev                     # http://localhost:4000/api/health
```

Generate secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

Frontend (from the repo root): `npm run dev` — Vite proxies `/api` to the API so the httpOnly refresh cookie is same-origin.

### Demo accounts (`seed:demo`)
`alex.morgan@example.com` (customer), `admin@`, `pharmacist@`, `rider@`, `warehouse@`, `accountant@`, `support@`, `novatech@` `vyra.example`.
The password is `DEMO_SEED_PASSWORD`, or a random one printed once when it is empty. Nothing is hard-coded.

## Layout

```
src/
  config/        env validation (refuses weak/missing secrets), role & permission catalogue
  middleware/    requestId, validate (zod), authenticate + authorize, security (helmet/CORS/rate limits), errorHandler
  routes/        URL → middleware → controller
  controllers/   thin: validated input → service → response
  services/      use-cases (auth, users, audit, notifier). No SQL, no HTTP.
  repositories/  all SQL, parameterised, take a pool-or-transaction `db`
  models/        row → DTO mappers
  validators/    zod schemas
  db/            pool, withTransaction, migration runner
  container.js   the one place concrete implementations are wired
migrations/      001_auth_core.sql …   (never edit an applied file; add a new one)
seeds/           reference/ (all envs) · demo/ (never production)
test/            unit/ (no DB needed) · integration/ (needs TEST_DATABASE_URL)
```

## Response format

```jsonc
{ "success": true,  "data": { ... } }
{ "success": false, "message": "Insufficient stock", "code": "INSUFFICIENT_STOCK", "details": [ ... ] }
```
Validation failures are `400 VALIDATION_ERROR` with `details: [{ path: "body.mobile", message }]`. Unexpected errors are a generic `500 INTERNAL_ERROR` with a `requestId` — no stack, SQL or credentials ever leave the server; the full error is in the server log under that id.

## Phase 1 endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/auth/register/start` | – | validate sign-up, text a 4-digit code (nothing created yet) |
| `POST /api/auth/register/verify` | – | check code → create user + customer + `customer` role, sign in |
| `POST /api/auth/login` | – | `{ identifier (mobile or email), password }` |
| `POST /api/auth/refresh` | cookie + `X-Vyra-Client: web` | rotate refresh token, new access token |
| `POST /api/auth/logout` · `logout-all` | cookie / bearer | revoke this session / every session |
| `GET  /api/auth/me` | bearer | user, roles, permissions |
| `POST /api/auth/password/forgot` · `reset` · `change` | –/–/bearer | reset link is single-use, 30 min; reset signs out everywhere |
| `GET  /api/admin/users` (`users:read`) · `GET /:id` · `GET /api/admin/roles` | bearer | list / inspect |
| `PATCH /api/admin/users/:id/status` (`users:manage`) | bearer | suspend / reactivate (kills sessions, audited) |
| `PUT  /api/admin/users/:id/roles` (`roles:assign`) | bearer | replace roles (audited, kills sessions) |
| `GET  /api/health` · `/api/health/ready` | – | liveness / DB readiness |

## Phase 2 endpoints (catalogue)

Reads are public (a valid token additionally shows staff inactive products and batch costs). Writes need `catalog:write` and are audited.

| Method & path | Purpose |
|---|---|
| `GET /api/categories` · `/api/brands` | full lists; categories carry `productCount` for their whole subtree |
| `GET /api/products` | `q`, `category`, `brand` (csv), `tag`, `onSale`, `minPrice`/`maxPrice`, `minRating`, `minDiscount`, `inStock` (+`branch`), `attr.<key>=`, `ids` (csv), `sort`, `page`, `pageSize` (≤100) |
| `GET /api/products/:id` · `/api/products/facets?category=` | detail with per-branch stock (per variant when variants exist) · filter options for a category |
| `GET /api/search` · `/search/suggest?q=` · `/search/lookup?code=` | ranked prefix search · autocomplete (max 20) · exact barcode/SKU |
| `POST /api/products` · `PUT /:id` · `DELETE /:id` | create (optional `openingStock`, needs `inventory:adjust`) · full update with optional `version` check · soft delete |
| `POST /api/categories` · `PUT /:id` · `POST /:id/toggle` · `POST/PUT /api/brands` | catalogue configuration |

Migration `003` (stores, branches, inventory, batches) is a read model for now; stock-changing endpoints arrive in Phase 4.

## Phase 3 endpoints (cart, addresses, orders, wishlist)

| Method & path | Purpose |
|---|---|
| `POST /api/cart/price` | Server-priced cart preview: current prices, live per-branch stock, coupon validity, MOQ/limit checks. No login required. |
| `GET/POST /api/addresses` · `PUT/DELETE /api/addresses/:id` · `POST /:id/default` | The caller's own delivery addresses. |
| `GET /api/orders` · `GET /:id` | Mine for a plain customer; everyone's for `orders:read_all` staff — same endpoint, server decides. |
| `POST /api/orders` | Reserves stock, prices with any coupon, creates the order, auto-confirms it. |
| `POST /api/orders/:id/status` | `orders:update_status` only; one stage forward at a time. "packed" deducts real stock (FEFO for batch-tracked items). |
| `POST /api/orders/:id/cancel` | Owner or `orders:cancel` staff; only before "packed" — releases the reservation. |
| `GET /api/wishlist` · `POST /:productId/toggle` | The caller's saved products. |

## Phase 4 endpoints (inventory operations)

All need `inventory:adjust`.

| Method & path | Purpose |
|---|---|
| `POST /api/inventory/adjust` | Manual +/- stock change with a required reason; clamped at zero. |
| `POST /api/inventory/transfer` | Moves stock between two branches (FEFO-consumes batches on the sending side). |
| `GET /api/inventory/movements` · `/low-stock` | The stock-change ledger · rows at/below their reorder level. |
| `GET/POST /api/suppliers` · `/purchase-orders` · `POST /purchase-orders/:id/receive` | Suppliers, purchase orders; receiving is the only step that changes stock (creates/tops up a batch). |
| `POST /api/pos/sale` | Walk-in sale — deducts stock immediately, no reservation, FEFO for batch-tracked items. |

## Security model

* **Passwords:** scrypt (N=32768, r=8, p=1), per-user salt, upgraded transparently on login. Policy mirrors the sign-up form (8+ chars, letter + number, ≤128).
* **Sessions:** 15-minute access JWT (HS256, carries only the user id) + 30-day opaque refresh token in an `httpOnly; Secure; SameSite=Strict` cookie scoped to `/api/auth`. Refresh tokens are stored only as keyed HMACs (`JWT_REFRESH_SECRET` is the key), rotate on every use, and replaying a rotated token revokes the whole family.
* **Authorization is re-read from the database on every request** (roles → permissions). Nothing about `role`, `isStaff` or `sellerId` is accepted from the client; the `isStaff` flag the UI receives only decides which links to show.
* **Brute force:** per-account lockout (5 failures → 15 min), per-IP rate limits, per-number OTP limits, generic "incorrect mobile/email or password", equalised timing for unknown accounts.
* **CSRF:** cookie-authenticated endpoints require `X-Vyra-Client: web` on top of SameSite=Strict and a CORS allow-list.
* **Audit:** `audit_logs` is append-only (a trigger rejects UPDATE/DELETE/TRUNCATE) and is written inside the same transaction as the change it records. Never stores password hashes or tokens.
* **Config:** the process refuses to start with missing/short/placeholder secrets, `CORS_ORIGIN=*`, the console notifier, or a dev OTP in production.
* **Known limits:** rate limiting is in-memory (run one PM2 process in fork mode); registration reveals whether a mobile/email is already taken (the existing UX) — the OTP and per-IP limits bound enumeration; OTP is 4 digits to match the current UI.
* **Messaging:** OTPs and reset links go through `services/notifier.js`. Until an SMS/email provider is added (Phase 8), production runs with `NOTIFY_DRIVER=disabled`, which means **new registrations and password resets cannot send messages** — configure a provider before go-live.

## Tests

```bash
npm test                                   # 52 unit tests, no database
TEST_DATABASE_URL=postgres://… npm run test:integration   # real Postgres; use a throwaway database
```
