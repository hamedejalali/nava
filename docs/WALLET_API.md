# Wallet → Nava XP API (v1)

> **Status honestly:** the Wallet's own contract was not available while this was built, so this is the contract Nava
> *proposes* and implements. If the Wallet already has a fixed format, only `src/services/wallet/walletAuth.ts`
> (headers / signature) and `walletApi.ts` (field names) need adapting — the crediting core (`xpCredit.ts`) stays.
> It has been tested against a mocked database only — never against a real Wallet or a real Atlas cluster.

Nava never calls the Wallet. The Wallet calls Nava. Fees are the Wallet's business: **Nava credits exactly `amount`.**

## Endpoints
Base: `https://<your-domain>/api/wallet/v1/` — `POST`, JSON body ≤ 4 KB.

| Path | Body | Answer |
|---|---|---|
| `resolve` | `{ "userToken" }` | `{ ok, recipient: { id, name } }` — who would be credited (public Nava id + nickname only) |
| `credit` | `{ "transactionId", "idempotencyKey", "userToken", "amount", "walletFee"?, "reference"? }` | `{ ok, duplicate, transfer: { transactionId, status, amount, creditedAt } }` |
| `status` | `{ "transactionId" }` | `{ ok, found, transfer? }` — resolves an uncertain outcome (timeout) safely |

* `amount`: JSON **integer** 1 … 1 000 000 000. Decimals, 0, negatives, strings, `null`, exponents → `400 invalid_amount`.
* `transactionId`, `idempotencyKey`: 8–64 chars `[A-Za-z0-9_.:-]`. `walletFee`/`reference` are stored for audit only.
* `userToken`: the `nxp_…` token the user copies from the bot («💳 انتقال XP از ولت»). One active token per user; creating a new one revokes the old; the user can revoke it. Only its SHA-256 hash is stored.

## Signing (every request)
Headers: `X-Wallet-Key-Id`, `X-Wallet-Timestamp` (unix seconds, ±300 s), `X-Wallet-Nonce` (16–64 chars `[A-Za-z0-9_-]`, single use), `X-Wallet-Signature`.

```
canonical = "v1\n" + timestamp + "\n" + nonce + "\n" + "POST" + "\n" + "/api/wallet/v1/credit" + "\n" + sha256hex(rawBody)
signature = hex( HMAC_SHA256(secret, canonical) )
```
```js
// Node example
const ts = String(Math.floor(Date.now()/1000)), nonce = crypto.randomBytes(16).toString("hex");
const raw = JSON.stringify({ transactionId, idempotencyKey, userToken, amount });
const sig = crypto.createHmac("sha256", SECRET).update(["v1", ts, nonce, "POST", "/api/wallet/v1/credit", crypto.createHash("sha256").update(raw).digest("hex")].join("\n")).digest("hex");
```
Sign the **exact bytes** you send. A used nonce is refused for 15 minutes (`replayed_request`).

## Idempotency / retries
Retrying the same `transactionId` + `idempotencyKey` + token + amount returns the stored result with `duplicate: true` (HTTP 200) and credits nothing — even if the user rotated the token meanwhile. The same `transactionId` with different data → `409 transaction_conflict`; the same `idempotencyKey` with another transaction → `409 idempotency_conflict`. After a timeout/5xx, call `status` before retrying with new ids. Each retry needs a **new nonce**.

## Errors
`{ "ok": false, "error": { "code", "message" } }` — never a stack trace.

| HTTP | code |
|---|---|
| 400 | `invalid_json`, `invalid_request` (+`field`), `invalid_amount` |
| 401 | `missing_auth_headers`, `invalid_credentials`, `invalid_timestamp`, `timestamp_out_of_window`, `invalid_nonce`, `invalid_signature`, `replayed_request` |
| 403 | `integration_disabled`, `user_unavailable` |
| 404 | `invalid_token`, `not_found` |
| 405 / 413 | `method_not_allowed` / `payload_too_large` |
| 409 | `transaction_conflict`, `idempotency_conflict` |
| 410 | `token_revoked` |
| 429 | `rate_limited` (120/min), `too_many_failures`, `too_many_invalid_tokens` |
| 500 / 503 | `server_error` (check `status` before retrying) / `integration_not_configured` |

## Environment variables (Vercel → Settings → Environment Variables; secrets only)
`WALLET_API_KEY_ID`, `WALLET_API_SECRET` (≥ 32 random chars), optional `WALLET_API_SECRET_NEXT` (rotation: put the new secret here, switch the Wallet, then promote it). Missing → API answers `503`, the rest of Nava is unaffected. The owner can switch the integration on/off from the admin panel («🔌 اتصال ولت»).

## Data (created lazily, nothing to migrate)
`xp_transfer_tokens`, `xp_wallet_transfers` (unique `_id` and `idempotencyKey`), `wallet_nonces` (TTL 15 min), `wallet_audit` (TTL 90 days, no credentials), `wallet_integration`. The credit and the ledger row (`relic_transactions`, type `WALLET_TRANSFER`) are written in ONE MongoDB transaction. The user's balance field stays `relicBalance`.

## Deploy / rollback
Deploy: set the env vars → deploy → open «🔌 اتصال ولت» in the bot and check "کلیدها ✅". Rollback: switch the integration off in the panel (instant, no deploy) or redeploy the previous version — no schema change is destructive, old versions simply ignore the new collections.
