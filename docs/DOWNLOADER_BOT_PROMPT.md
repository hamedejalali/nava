# Prompt to give the Claude that is building the DOWNLOADER bot

Copy everything below the line.

---

You are integrating the **downloader bot** (its own Vercel project + its own MongoDB) with the **Premium Wallet** that lives inside the Nava project. Users hold Relic in the wallet; they must be able to (1) send Relic from the wallet to their downloader-bot account, (2) send Relic from the downloader bot back to a wallet, and (3) optionally have the wallet credit Relic when they buy something in your bot. Implement EXACTLY the contract below; do not invent fields. Reply to me when done with: the two endpoint URLs you created, the env vars you need, the Mongo collections/indexes you added, and your test results (what you actually ran).

## Facts
- Wallet API: `POST https://<NAVA_DOMAIN>/api/wallet/transfer` (I will give you the real domain).
- I will give you, from the wallet admin panel, once: `PARTNER_ID`, `WALLET_API_KEY` (`wpk_…`), `WALLET_WEBHOOK_SECRET` (`wsk_…`). Put them in env vars of the downloader project, never in code or logs.
- Amounts are positive integers (whole Relic). Every user of your bot needs a **public user token** (a random, non-guessable string, e.g. 10–12 chars from a safe alphabet) that is DIFFERENT from their Telegram id; show it in your bot (button «دریافت رلیک / توکن من») so they can paste it in the wallet's Send screen.

## 1) Endpoints you must expose (wallet → you), base path e.g. `/api/relic`
Every request carries `X-Wallet-Timestamp` (unix seconds) and `X-Wallet-Signature = hex(HMAC_SHA256(WALLET_WEBHOOK_SECRET, timestamp + "." + rawBody))`. Verify with the RAW body and `crypto.timingSafeEqual`; reject (401) a bad signature or a timestamp more than 300 s from now.

`POST /api/relic/resolve` body `{ "token": "<your user token>" }` → `200 {"ok":true,"displayName":"<first name or nickname>"}`; unknown token → `404 {"ok":false,"code":"unknown_token"}`. Do not leak anything else; rate-limit per IP.

`POST /api/relic/receive` body `{ "transferId": "tx:…", "token": "…", "amount": 10, "from": {"name": "…", "walletUserId": 123}, "createdAt": "ISO" }`
- In ONE MongoDB transaction: insert a row into `relic_inbound` with `_id = transferId` (unique) AND `$inc` the user's Relic balance by `amount`. If the insert hits a duplicate key → it was already credited → answer `200 {"ok":true,"duplicate":true}` without touching the balance.
- Answer `200 {"ok":true}` ONLY after the transaction committed. Never answer ok before the money is durably credited.
- Definitive refusal (unknown token, user banned): `200 {"ok":false,"code":"unknown_token"}` (or 4xx). The wallet will refund the sender automatically.
- Temporary failure (DB down): return 5xx — the wallet retries later with the SAME transferId. Your handler must be safe under retries and concurrent duplicates.
- Notify the user in your bot (best-effort, after commit): "✅ N Relic received from the wallet".

## 2) Calls you make (you → wallet)
Header `Authorization: Bearer <WALLET_API_KEY>`, JSON body, `POST https://<NAVA_DOMAIN>/api/wallet/transfer`:
- `{"action":"resolve","token":"RLC-XXXX-XXXX-XXXX-XXXX"}` → `{ok,displayName}` — show the owner's name to your user and require a confirm button («✅ تایید» / «❌ مغایرت») BEFORE moving money.
- `{"action":"deposit","token":"RLC-…","amount":10,"externalId":"<unique per transfer, e.g. out:<uuid>>","reason":"downloader→wallet"}` → `{ok,duplicate,txId,walletBalance}`.
  Flow for user → wallet: (a) create an `relic_outbound` row `_id=externalId, status:"pending"` and debit the user's balance in ONE transaction (fail if insufficient); (b) call `deposit`; (c) on `ok:true` mark `completed`; on a definitive error (`invalid_token`, `target_not_found`, `insufficient_partner_balance`, `invalid_amount`) refund the user in one transaction and mark `refunded`; on network error/5xx leave `pending` and retry with the SAME `externalId` (a cron/Vercel retry job + a "pending transfers" view) — never create a new externalId for the same user action. If unsure, call `{"action":"status","transferId":…}`? (status is for wallet→partner transfers; for your deposits rely on idempotent re-send of `deposit`.)
- `{"action":"credit","token":"RLC-…","amount":N,"externalId":"buy:<orderId>","reason":"purchase"}` — only if I told you credit is enabled; used when a user BUYS Relic in your bot: the wallet issues new Relic from the owner's finite supply.
- `{"action":"balance"}` → `{ok,balance}` your float; deposits cannot exceed it.

## 3) Rules
- Idempotency everywhere: unique indexes on `transferId` / `externalId`; use MongoDB transactions for balance + ledger.
- Never log request bodies, tokens, keys, secrets or signatures. Log only error names/ids.
- Concurrency: two simultaneous identical requests must credit/debit once.
- Provide tests with an in-memory fake or a real Mongo: signature valid/invalid/stale, duplicate transferId, insufficient balance on deposit, wallet down → pending → retry → completed, definitive refusal → refund.
- Telegram UI (Persian): a coloured keyboard with «💰 موجودی»، «📥 دریافت رلیک» (shows the user token + explanation), «📤 ارسال به ولت» (ask wallet token → show owner name → «تایید/مغایرت» → amount → final confirm).
