# Vyra API

One modular Node.js backend for every Vyra surface — customer, admin, seller, pharmacy, delivery/rider and POS.
Node 22.9+ · Express 5 · PostgreSQL 13+ · zod. **Status: Phase 8 (notifications, audit log, hardening).** See `../MIGRATION_PLAN.md`.

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

## Phase 5 endpoints (payments, prescriptions)

| Method & path | Purpose |
|---|---|
| `GET /api/orders/:id/payment` | The order's payment(s) — owner, `orders:read_all` or `payments:manage`. |
| `POST /api/payments/:id/confirm-manual` | `payments:manage` — dev/demo stand-in for a real gateway's webhook. |
| `POST /api/webhooks/payments/:provider` | Public; authenticated by the provider's signature, not a session. |
| `POST /api/orders/:id/refund-request` | Owner or `orders:refund` — request a refund, capped at the unrefunded balance. |
| `GET /api/refunds` · `POST /api/refunds/:id/decide` | `orders:refund` (read) / `payments:manage` (decide) — approve completes the refund immediately (no gateway to wait on); reject just records why. |
| `POST /api/prescriptions` | Any signed-in customer — JPG/PNG/PDF up to 10 MB, sent as a data URL. |
| `GET /api/prescriptions` | Own uploads, or every customer's for `prescriptions:read_all` — same endpoint, server decides. |
| `GET /api/prescriptions/:id` · `/file` | Owner or `prescriptions:read_all`/`review`. The file is never a public URL. |
| `POST /api/prescriptions/:id/review` | `prescriptions:review` — approve/reject, one decision, no take-backs. |

Payments: a provider interface (`services/payments/*.provider.js`) with **cod** and **manual** (bank transfer / wallet
reference) implemented; a real gateway (eSewa/Khalti/card) plugs in as a third file behind the same interface. Every
order gets exactly one payment row created atomically with it; webhooks are verified by signature and are
idempotent per `(provider, event_id)`. Prescriptions: uploads go to private object storage (`services/storage.service.js` —
local disk by default, S3-compatible if `STORAGE_BUCKET` is set) — never a public path. **An order can no longer be
placed for a prescription-required item without an approved prescription that already covers it** — this closes the
gap Phase 3 flagged and left open.

## Phase 6 endpoints (sellers, applications, payouts)

| Method & path | Purpose |
|---|---|
| `POST /api/seller-applications` | Any signed-in user — shop details + settlement + documents (data URLs, ≤5 MB each). One open application per account. |
| `GET /api/seller-applications` | Own applications, or every one for `sellers:read_all` — the server decides. Settlement numbers always masked. |
| `POST /api/seller-applications/:id/decide` | `sellers:approve` — `approve` (optionally `commissionRate`), `reject`, `request_correction`, `suspend`. |
| `POST /api/seller-applications/:id/resubmit` | Owner, only when `rejected`. |
| `POST …/:id/documents/:documentId/verify` · `GET …/file` | Verify/reject a document (`sellers:approve`); the file is owner-or-staff, never public. |
| `GET …/:id/settlement` · `GET /api/sellers/:id/settlement` | `sellers:approve` / `payouts:approve` — the only endpoints that return a decrypted bank/wallet number. |
| `GET /api/sellers` · `GET /api/sellers/mine` · `GET /api/sellers/:id` | Directory (`sellers:read_all`), the caller's own shop, owner-or-staff detail. |
| `POST /api/sellers/:id/status` | `sellers:approve` — suspend/reinstate. The first-party seller can't be suspended. |
| `GET /api/sellers/:id/balance` | Available for payout: delivered orders, net of commission, minus every non-rejected payout. |
| `POST /api/sellers/:sellerId/payouts` · `GET …/payouts` | The shop requests (default: full balance); owner or `payouts:read_all` lists. |
| `GET /api/payouts` · `POST /api/payouts/:id/decide` | `payouts:read_all` / `payouts:approve` — approve marks it paid (ops transfers by hand), reject releases the amount. |

Products: a seller (`catalog:write_own`) uses the existing `/api/products` write routes, scoped to their own shop —
new listings are forced to `pending_review` and only staff (`catalog:write`) can approve them. Settlement account and
wallet numbers are AES-256-GCM encrypted at rest; set `DATA_ENCRYPTION_KEY` (base64, 32 bytes) — it is required.

## Phase 7 endpoints (delivery)

| Endpoint | Who / notes |
|---|---|
| `GET /api/rider/me` · `PUT /api/rider/me/availability` | `delivery:rider` **and** a `riders` profile row. |
| `GET /api/rider/deliveries?scope=active\|history` | Only the caller's own. Includes the full address + phone (never the handover code). |
| `GET /api/rider/available-orders` | Packed, unassigned orders — **area only** (no street/name/phone) — and only while the rider is *available*. |
| `POST /api/rider/orders/:orderId/claim` | Self-assign (arrives already accepted). One winner: the order lock + a partial unique index. |
| `POST /api/rider/deliveries/:id/accept · decline · pickup` | `assigned → accepted → picked_up`; decline (before pickup) returns the order to *packed*. |
| `POST /api/rider/deliveries/:id/location` | Only while `picked_up`; ≥5 s apart (faster pings dropped). |
| `POST /api/rider/deliveries/:id/deliver` | `{ otp, cashCollected }` — the **server** checks the code (5 wrong tries lock the order) and the exact COD amount. |
| `POST /api/rider/deliveries/:id/fail` | `{ reason, note }` — 1st failure → back to *packed*; 2nd → order `returned`. |
| `GET/POST/PUT /api/delivery/riders` | `delivery:manage` (+ `roles:assign` to create — it grants the `delivery` role). |
| `GET /api/delivery/active` · `POST /api/delivery/orders/:orderId/assign` · `POST /api/delivery/deliveries/:id/reassign · unassign` · `POST /api/delivery/orders/:orderId/reset-otp` | `delivery:manage` (warehouse + admin). |
| `GET /api/orders/:id/tracking` | The order's owner or staff: status, rider, live position (only while out for delivery), event timeline (customers get event *types* only). |

**Behaviour changes to Phase 3:** `POST /orders/:id/status` now stops at `packed` (`assigned`/`out_for_delivery`/`delivered` → 400/409 `USE_DELIVERY_FLOW`), so an order can no longer be marked delivered without the customer's code. The handover code is no longer a column: it is derived (`utils/deliveryCode.js`) and shown to the order's owner only.

## Phase 8 endpoints (notifications, audit log)

| Endpoint | Who / notes |
|---|---|
| `GET /api/notifications?unread&limit&before` | The caller's own in-app inbox, newest first, with the unread count. |
| `POST /api/notifications/:id/read` · `POST /api/notifications/read-all` | Scoped to the caller in SQL — someone else's id is a plain 404. |
| `GET/PUT /api/notifications/preferences` | Opt in/out of email and SMS. In-app notifications and security messages (OTP, password reset) are unaffected. |
| `GET /api/audit-logs` | `audit:read`. Filters: `entityType`, `entityId`, `action`, `actionPrefix`, `actorUserId`, `from`, `to`; paged. Sensitive-looking keys (`password`, `token`, `otp`, `secret`, card/account numbers…) are redacted on the way OUT as well as on the way in. |

**What changed elsewhere:** every place that already wrote an audit-log entry for a customer-visible outcome — order placed/packed/cancelled, prescription approved/rejected, seller application decided, payout decided, refund decided, a delivery assigned/out-for-delivery/delivered/failed — now also raises a notification in the *same transaction*, so a rolled-back action (e.g. a wrong handover code) never notifies anyone. Notification text is built from a small, audited template table (`notifications/templates.js`) and **never includes the delivery handover code** — there's a test asserting this. Self-registration is now audited too (`auth.registered`), closing a gap where account creation left no trail.

**Delivery (email/SMS):** written in the request's transaction to an outbox table, sent afterwards by an in-process worker that starts automatically with the API server whenever `JOBS_ENABLED=true` (the default outside tests) so a slow or down provider never slows down a request. It is safe to run in several API processes at once — rows are claimed with `SELECT ... FOR UPDATE SKIP LOCKED`, so two workers never send the same message. At-least-once, with exponential backoff (30s → 2m → 8m → 32m → dead after 5 tries); dead messages are kept for investigation and purged after 30 days. `NOTIFY_DRIVER=webhook` posts a signed JSON request to your own SMS/email gateway (`NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_SECRET`) — this codebase stays provider-agnostic; `console` (dev only — logs the message, including OTPs) and `disabled` remain for local/CI use.

**Retention (in-process, every 6h):** purges expired refresh tokens, password resets and OTP challenges; read notifications after 90 days and any notification after 180; sent outbox rows after 14 days, dead ones after 30; and — a safety net for the Phase 7 privacy promise — any delivery location trail left behind by a crash. Audit logs, orders, payments and stock movements are **never** purged by this job.

**`npm run preflight`:** a pre/post-deploy check (config, database connectivity, pending migrations, reference data, at least one active admin, no `@vyra.example` demo accounts in production, outbox health). Exits non-zero on any FAIL — wire it into your deploy pipeline.

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
npm test                                   # 182 unit tests, no database
TEST_DATABASE_URL=postgres://… npm run test:integration   # real Postgres; use a throwaway database
```
