# Premium Wallet — Partner API (v1.11.0)

Lets any other bot (e.g. the downloader bot, separate Vercel + MongoDB) exchange Relic with the wallet.

Base URL: `https://<NAVA_DOMAIN>/api/wallet/transfer`  (the same endpoint users' Mini App uses; the `Authorization: Bearer` header selects the partner path)

Create a partner in the wallet bot: ⚙️ تنظیمات ولت → 🔌 پارتنرها → ➕ پارتنر جدید. You receive (once):
- `API Key` (`wpk_…`) — partner → wallet calls (`Authorization: Bearer <apiKey>`). Only its SHA-256 is stored.
- `Webhook Secret` (`wsk_…`) — wallet → partner calls are signed with it.

## Money model
- A wallet user sends Relic to a partner user: wallet debits the user, `partner.balance += amount` (the partner "float"), then calls the partner's `/receive`. The ledger row is **pending** until the partner acknowledges. A definitive refusal refunds the user automatically; network trouble keeps it pending and it is retried (cron, the user's history screen, owner button «🔁 تلاش مجدد»). Nothing is ever lost or left unexplained.
- Partner → wallet: `deposit` moves Relic out of the partner float into a wallet (cannot exceed the float). `credit` issues NEW Relic from the owner's finite supply (e.g. a user bought Relic) and needs «can issue» permission.
- All amounts are positive integers. Every call is idempotent via `externalId` / `transferId`.

## A. Wallet → Partner (you implement these two endpoints under `baseUrl`)
Headers on every call: `X-Wallet-Timestamp: <unix seconds>`, `X-Wallet-Signature: hex(HMAC_SHA256(webhookSecret, timestamp + "." + rawBody))`. Reject if the signature is wrong or the timestamp is > 5 minutes off.

`POST {baseUrl}/resolve`  body `{ "token": "<partner user token>" }`
- 200 `{ "ok": true, "displayName": "Ali" }`
- 404 or 200 `{ "ok": false, "code": "unknown_token" }` when no such user.

`POST {baseUrl}/receive`  body `{ "transferId": "tx:…", "token": "…", "amount": 10, "from": { "name": "…", "walletUserId": 123 }, "createdAt": "ISO" }`
- Credit the user **exactly once per transferId** (unique index) and only then answer `200 { "ok": true }` (also for a replay of the same transferId).
- Definitive refusal (unknown/blocked user): `200 { "ok": false, "code": "unknown_token" }` or any 4xx (except 408/429) → the wallet refunds the sender.
- Anything temporary: 5xx / timeout / 429 → the wallet retries later with the same transferId.

## B. Partner → Wallet (you call these)
`POST /api/wallet/transfer` with `Authorization: Bearer <apiKey>` and JSON body:
| action | body | result |
|---|---|---|
| `resolve` | `{token}` wallet token `RLC-…` | `{ok, displayName}` (show it to your user to confirm) |
| `deposit` | `{token, amount, externalId, reason?}` | `{ok, duplicate, txId, walletBalance}` — debit your user FIRST, then call; on `ok:false` with a definitive error, refund your user |
| `credit` | `{token, amount, externalId, reason?}` | issues new Relic (needs permission) |
| `status` | `{transferId}` | `{ok, state: completed|pending|refunded}` |
| `balance` | `{}` | `{ok, balance}` your float held by the wallet |
Errors: `{ok:false, error}` with `invalid_token`, `target_not_found`, `invalid_amount`, `invalid_external_id`, `insufficient_partner_balance`, `supply_exhausted`, `not_allowed`, `bad_action`; HTTP 401 for a bad key.

## Transparency
Every movement is a row in `wallet_ledger` and is posted to the owner's «تراکنش‌ها» channel (amount, sender, receiver, status).
