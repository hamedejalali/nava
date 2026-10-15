/** v1.17.0 — Telegram contacts are forbidden in chat; ban works everywhere, cleans up, and shows a support link button. (mocked) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, seedChatSession, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: miniapp } = await import("../../api/miniapp.js");
const { setContent } = await import("../../src/db/models/content.js");
const A = 8501, B = 8502, C = 8503;
beforeEach(() => {
  resetState(); h.resetCalls();
  seedUser({ id: A, anonId: "user_V1A", nickname: "a", relicBalance: 5, relicInitialized: true, gender: "male" });
  seedUser({ id: B, anonId: "user_V1B", nickname: "b", relicBalance: 5, relicInitialized: true, gender: "female" });
  seedUser({ id: C, anonId: "user_V1C", nickname: "c", relicBalance: 5, relicInitialized: true, gender: "female" });
});
const texts = (id: number) => h.of("sendMessage", id).map((c) => String(c.payload.text));

/* ------------------------------------------------------------------ chat rules */
test("V1. a Telegram @username in chat is NOT relayed, the sender gets the warning, the message is not counted", async () => {
  seedChatSession({ userA: A, userB: B });
  await h.text(A, "بیا پی وی من @hamedejalali");
  assert.equal(texts(B).filter((t) => /hamedejalali/.test(t)).length, 0, "partner never sees it");
  assert.ok(texts(A).some((t) => /ممنوعه/.test(t)), "sender warned");
  assert.equal(col("chat_sessions").all()[0].messageCount ?? 0, 0);
});

test("V2. t.me links are blocked too; ordinary messages (incl. email-like and short @) still flow", async () => {
  seedChatSession({ userA: A, userB: B });
  await h.text(A, "https://t.me/someone_here");
  assert.equal(texts(B).length, 0);
  await h.text(A, "سلام چطوری");
  await h.text(A, "mail me: a@b.com");
  await h.text(A, "@ab کوتاهه");
  assert.deepEqual(texts(B), ["سلام چطوری", "mail me: a@b.com", "@ab کوتاهه"]);
});

test("V3. contact filter unit cases", async () => {
  const { containsTelegramContact: c } = await import("../../src/utils/contactFilter.js");
  for (const t of ["@hamedejalali", "ایدیم @hamed_j", "t.me/hamed", "telegram.me/xyz", "tg://resolve?domain=a", "＠hamedejalali", "TELEGRAM.DOG/abc"]) assert.equal(c(t), true, t);
  for (const t of ["سلام", "a@b.com", "@abc", "gmail.com/@abcdef", ""]) assert.equal(c(t), false, t);
});

/* ------------------------------------------------------------------ ban everywhere */
test("V4. banned person: first tap gets the ban notice with a support LINK button (no support id text); nothing else works", async () => {
  await setContent("supportId", "@NavaSupportTest", OWNER_ID);
  col("users").updateOne({ _id: A }, { $set: { banned: true, banReason: "توهین" } });
  await h.text(A, "/start");
  const msg = h.of("sendMessage", A)[0]!;
  assert.match(String(msg.payload.text), /مسدود شدید/);
  assert.match(String(msg.payload.text), /توهین/);
  assert.doesNotMatch(String(msg.payload.text), /NavaSupportTest/, "id is not printed");
  const btn = msg.payload.reply_markup.inline_keyboard.flat()[0];
  assert.equal(btn.url, "https://t.me/NavaSupportTest");
  h.resetCalls();
  await h.callback(A, "partner:lucky");
  assert.ok(h.of("answerCallbackQuery").length >= 1 && h.of("sendMessage", A).length === 1);
  assert.equal(col("match_queue").all().length, 0);
});

test("V5. without a configured support contact the notice is still shown (no button, no crash)", async () => {
  col("users").updateOne({ _id: A }, { $set: { banned: true } });
  await h.text(A, "hi");
  const msg = h.of("sendMessage", A)[0]!;
  assert.match(String(msg.payload.text), /مسدود شدید/);
  assert.ok(!msg.payload.reply_markup);
});

test("V6. owner bans someone who is in a chat: chat closed atomically, partner refunded + told, queue/requests cleaned, banned person told", async () => {
  await setContent("supportId", "https://t.me/NavaSupportTest", OWNER_ID);
  seedChatSession({ userA: A, userB: B, messageCount: 10 });
  col("match_queue").seed({ _id: A, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, createdAt: new Date(), expiresAt: new Date(Date.now() + 30000) });
  col("chat_requests").seed({ _id: "reqtoken01", fromId: C, toId: A, status: "pending", createdAt: new Date(), expiresAt: new Date(Date.now() + 60000) });
  await h.callback(OWNER_ID, `admin:user:ban:${A}`);
  assert.equal(col("users").byId(A).banned, true);
  const sess = col("chat_sessions").all()[0];
  assert.equal(sess.active, false); assert.equal(sess.endReason, "banned");
  assert.ok(!col("users").byId(B).activeChatSessionId); assert.ok(!col("users").byId(A).activeChatSessionId);
  assert.equal(col("users").byId(B).relicBalance, 6, "partner got the Relic back even though the chat was long");
  assert.ok(texts(B).some((t) => /تموم شد/.test(t)));
  assert.equal(col("chat_requests").byId("reqtoken01").status, "declined");
  assert.equal(col("match_queue").all().length, 0);
  assert.equal(h.of("sendMessage", A).filter((c) => /مسدود شدید/.test(String(c.payload.text))).length, 1);
  // repeating the ban changes nothing further
  await h.callback(OWNER_ID, `admin:user:ban:${A}`);
  assert.equal(col("users").byId(B).relicBalance, 6);
  // unban re-enables
  await h.callback(OWNER_ID, `admin:user:unban:${A}`);
  assert.ok(!col("users").byId(A).banned);
});

test("V7. Mini App: a banned person gets 403 banned + the support LINK (same ban as the bot)", async () => {
  await setContent("supportId", "@NavaSupportTest", OWNER_ID);
  col("users").updateOne({ _id: A }, { $set: { banned: true } });
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: A, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  const initData = new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
  let status = 0, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send() { return res; }, end() { return res; } };
  await miniapp({ method: "POST", body: { initData, action: "me" } } as any, res);
  assert.equal(status, 403);
  assert.deepEqual(payload, { error: "banned", support: "https://t.me/NavaSupportTest" });
});

/* ------------------------------------------------------------------ admin panel categories */
test("V8. admin panel: the main keyboard has category buttons (not 20 loose ones); a category opens the SAME old buttons; back returns", async () => {
  await h.text(OWNER_ID, "/start");
  const main = h.of("sendMessage", OWNER_ID).map((c) => c.payload.reply_markup).filter((m) => m?.keyboard).pop();
  const labels = main.keyboard.flat().map((b: any) => b.text);
  assert.ok(labels.includes("👥 کاربر ها"));
  assert.ok(!labels.includes("🚫 بن کاربر") && !labels.includes("🔓 آن‌بن کاربر"), "ban/unban are inside «کاربر ها» now");
  assert.ok(labels.length <= 12, `compact main panel (got ${labels.length})`);
  h.resetCalls();
  await h.text(OWNER_ID, "👥 کاربر ها");
  const sub = h.of("sendMessage", OWNER_ID)[0]!.payload.reply_markup.keyboard.flat().map((b: any) => b.text);
  for (const l of ["👥 لیست کاربران", "🚫 بن کاربر", "🔓 آن‌بن کاربر", "☑️ وریفای / تیک تأیید"]) assert.ok(sub.includes(l), l);
  h.resetCalls();
  await h.text(OWNER_ID, "🚫 بن کاربر"); // the old handler still reacts to the very same label
  assert.ok(h.of("sendMessage", OWNER_ID).length >= 1);
  h.resetCalls();
  await h.text(OWNER_ID, "↩️ بازگشت به پنل");
  assert.ok(h.of("sendMessage", OWNER_ID)[0]!.payload.reply_markup.keyboard.flat().some((b: any) => b.text === "👥 کاربر ها"));
});
