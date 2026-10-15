# Nava Bot v1.17.0 — Feature delivery report (items a–p)

**Honesty box.**
* All automated tests run against the in-memory MongoDB fake (`tests/harness/fakeMongo.ts`) and a recording fake Telegram
  API. **No test talked to a real MongoDB or real Telegram.** Real-DB isolation, unique-index behaviour under true
  parallelism, and real Telegram payloads are *reviewed, not proven*.
* The Mini App UI was exercised with Playwright/Chromium against a static server with a **mocked** `/api/miniapp` and a
  stubbed Telegram WebApp object (not a real Telegram client, not a real device). The script is not part of the ZIP.
* The Lottie path was tested with a synthetic Lottie JSON, not real Telegram `.tgs` files. `getAvailableGifts` was tested
  against a stub only.
* Production (Vercel/Atlas/Telegram settings) was not accessible.

| Item | What was built | Tested (mocked) | Limits / deviations |
|---|---|---|---|
| a | Gift notification glass button `gr:<pub>` → confirm `grc:` → chat request to sender; **both** charged 1 Relic atomically at **accept** | `v117-gifts` | Charge happens at accept, not at confirm (so nobody pays for a request that is declined). No Relic → message points to the wallet bot (no wallet code in Nava). |
| b | `@username` filter in chat relay (`src/utils/contactFilter.ts`) | `v117-bans-and-chat-rules` | Heuristic regex; cannot stop obfuscated spellings. |
| c | Story text overlay (add/edit/drag/colour/background/size, ≤5), composited into the JPEG client-side; open/crossfade/slide animations | Playwright (placed, dragged, exported, text pixels present) | Not tested on a real phone WebView. |
| d | Custom animated gifts from Telegram stickers (`mini_gift_defs`), TGS→Lottie JSON served with HMAC-signed URL, vendored lottie-web; WEBM/WEBP via video/img | gift-admin tests + Playwright (synthetic Lottie) | Real TGS files unverified. |
| e | Owner lists a user's gifts, deletes or takes one (owner only) | `v117-gift-admin` | "Take" is silent (previous owner is not notified). |
| f | Unique single-copy gifts: partial unique index `{giftId:1}` where `uniqueGift:true`; E11000 → `sold_out` | G3 (+ mutation check: removing the index fails it) | Deleting a unique gift makes it purchasable again. |
| g | Owner-editable gift prices (`mini_settings`) | gift-admin tests | — |
| h | Auction (escrow bids, refund of previous top, atomic settle) and giveaway (unique entries, random winner, banned skipped) posted to the Nava-gram channel | B1–B6, D1–D2 (+ mutation check on refund) | Settlement on Hobby relies on webhook traffic (30 s gap), the daily cron, or the manual end button. |
| i | Re-gift: single atomic `findOneAndUpdate({pub, receiverId: me})` | G4 (+ mutation check on ownership guard) | — |
| j | Anonymous gifting: sender hidden everywhere, no reply button, `gr:` refused | G-series | Anonymous to the receiver only; staff can see the sender in the DB. |
| k | Data survives redeploys (nothing stored in code) | — (documentation) | See `docs/DATA_SAFETY.md`. |
| l | Vendored Vazirmatn + Aref Ruqaa (OFL), no Google Fonts; start/story animations | Playwright (fonts load locally) | Licences in `public/miniapp/vendor/LICENSES.txt`. |
| m | `chat: "with_you"` badge when both are in the same active session | moderation tests | — |
| n | Staff (OWNER_ID + env ADMIN_IDS) see all profiles and delete posts/comments/stories (logged, author notified); user reports → `post_reports`, owner buttons delete / delete+ban / ignore | M1–M5 | Direct-visibility bypass applies to env staff, not DB-granted admins; destructive actions also allow DB admins. |
| o | Ban synced: bot notice (sent to the user's DM, never the channel) and Mini App `403 banned` screen with a support **link button** | V-series + Playwright | Support link comes from the existing support setting. |
| p | Admin panel categories (sub-keyboards with the unchanged old labels, so handlers are untouched) | admin tests | — |

## Mutation checks performed
Removing the unique partial index fails G3; removing the outbid refund fails B2/B3/B4; removing the regift ownership
guard fails G4. Files were restored afterwards.

## Verification (see final command log in the delivery message)
`npm ci`, `npx tsc --noEmit`, `npm run build`, `npm test`, `npm audit --omit=dev`, secret scan of the extracted ZIP.

## Security note
A real `.env` was present in the sandbox from an upload. It is not in the ZIP. Treat BOT_TOKEN, the Mongo password,
WEBHOOK_SECRET and CRON_SECRET as exposed to the chat and rotate them.
