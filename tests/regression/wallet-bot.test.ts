/** Wallet bot (v1.11.0): keyboard, send flow with owner confirmation, admin panel, task review auth. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
process.env.WALLET_BOT_TOKEN = "777:WALLET-TEST";
process.env.WALLET_MINIAPP_URL = "https://wallet.example";
process.env.OWNER_ID = "900";
process.env.ADMIN_IDS = "901";
installFakeMongo();
const { createWalletBot } = await import("../../src/walletBot.js");
const C = await import("../../src/db/models/walletCore.js");
const NT = await import("../../src/services/walletNotify.js");
export const notes: { bot: string; chat: number; text: string }[] = [];
NT.setNotifySender(async (bot, chat, text) => { notes.push({ bot, chat, text }); });

const OWNER = 900;
let calls: { method: string; payload: any }[] = [];
let uid = 1;
const bot = createWalletBot();
bot.botInfo = { id: 777, is_bot: true, first_name: "W", username: "wallet_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any;
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (method.startsWith("send")) return { ok: true, result: { message_id: 5000 + calls.length, date: 0, chat: { id: (payload as any).chat_id, type: "private" } } } as any;
  return { ok: true, result: true } as any;
});

beforeEach(async () => {
  resetFakeMongo();
  calls = [];
  await col("wallet_supply").insertOne({ _id: "supply", cap: 1000, remaining: 1000, issued: 0, feesCollected: 0 } as any);
  for (const id of [1, 2, OWNER]) seedUser({ id, nickname: `N${id}`, anonId: `user_AAA${id}`, relicBalance: 0 });
});

const from = (id: number) => ({ id, is_bot: false, first_name: `U${id}`, language_code: "fa" });
const text = async (id: number, t: string) =>
  bot.handleUpdate({ update_id: uid++, message: { message_id: uid, date: 0, chat: { id, type: "private" }, from: from(id), text: t, ...(t.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: t.split(" ")[0]!.length }] } : {}) } } as any);
const press = async (id: number, data: string) =>
  bot.handleUpdate({ update_id: uid++, callback_query: { id: String(uid), from: from(id), chat_instance: "x", data, message: { message_id: 77, date: 0, chat: { id, type: "private" }, text: "orig" } } } as any);
const sent = (to?: number) => calls.filter((c) => c.method === "sendMessage" && (to === undefined || c.payload.chat_id === to)).map((c) => String(c.payload.text));
const lastSent = () => sent().at(-1) ?? "";
const lastMarkup = () => calls.filter((c) => c.method === "sendMessage").at(-1)?.payload.reply_markup;
const buttonsOf = (m: any): any[] => (m?.keyboard ?? m?.inline_keyboard ?? []).flat();
const cbOf = (data: RegExp) => {
  const m = calls.filter((c) => c.method === "sendMessage").flatMap((c) => buttonsOf(c.payload.reply_markup)).reverse().find((b) => data.test(b.callback_data ?? ""));
  return m?.callback_data as string;
};

test("/start creates the wallet account; keyboard has coloured Balance/Send/Receive; admin gets the settings button, users don't", async () => {
  await text(1, "/start");
  assert.ok(col("wallet_accounts").byId(1).token);
  const kb = calls.find((c) => c.payload.reply_markup?.keyboard)!.payload.reply_markup;
  const labels = buttonsOf(kb).map((b) => b.text);
  assert.deepEqual(labels, ["💰 موجودی", "📤 ارسال", "📥 دریافت", "🛒 خرید رلیک"]);
  assert.ok(buttonsOf(kb).every((b) => typeof b.style === "string"));
  assert.ok(calls.some((c) => JSON.stringify(c.payload.reply_markup ?? {}).includes("web_app")));
  calls = [];
  await text(OWNER, "/start");
  assert.ok(buttonsOf(calls.find((c) => c.payload.reply_markup?.keyboard)!.payload.reply_markup).some((b) => b.text === "⚙️ تنظیمات ولت"));
});

test("balance and receive buttons each do their own job (real data)", async () => {
  await text(1, "/start");
  await col("wallet_accounts").updateOne({ _id: 1 }, { $set: { balance: 42 } });
  await text(1, "💰 موجودی");
  assert.match(lastSent(), /42/);
  await text(1, "📥 دریافت");
  assert.ok(lastSent().includes(col("wallet_accounts").byId(1).token));
  assert.match(lastSent(), /توکن/);
});

test("send flow: token -> owner name confirm -> amount -> confirm moves the money once", async () => {
  await text(1, "/start"); await text(2, "/start");
  await col("wallet_accounts").updateOne({ _id: 1 }, { $set: { balance: 30 } });
  await col("wallet_supply").updateOne({ _id: "supply" }, { $set: { remaining: 970, issued: 30 } });
  await text(1, "📤 ارسال");
  await press(1, "ws:d:wallet");
  await text(1, col("wallet_accounts").byId(2).token);
  assert.match(lastSent(), /N2/);
  await press(1, "ws:owner_ok");
  await text(1, "12");
  assert.match(lastSent(), /12/);
  const go = cbOf(/^ws:go:/);
  assert.ok(go);
  await press(1, go); await press(1, go); // double tap
  assert.equal(col("wallet_accounts").byId(1).balance, 18);
  assert.equal(col("wallet_accounts").byId(2).balance, 12);
  assert.equal(col("wallet_ledger").all().filter((l: any) => l.kind === "transfer").length, 1);
});

test("send flow: mismatch aborts; bad token / self / insufficient give clear errors and move nothing", async () => {
  await text(1, "/start"); await text(2, "/start");
  await text(1, "📤 ارسال"); await press(1, "ws:d:wallet");
  await text(1, col("wallet_accounts").byId(2).token);
  await press(1, "ws:mismatch");
  await text(1, "5");
  assert.equal(col("wallet_ledger").all().length, 0);
  await text(1, "📤 ارسال"); await press(1, "ws:d:wallet");
  await text(1, "hello");
  assert.match(lastSent(), /توکن معتبر نیست/);
  await text(1, col("wallet_accounts").byId(1).token);
  assert.match(lastSent(), /خودت/);
  await text(1, "📤 ارسال"); await press(1, "ws:d:wallet");
  await text(1, col("wallet_accounts").byId(2).token);
  await press(1, "ws:owner_ok");
  await text(1, "5");
  assert.match(lastSent(), /موجودی کافی نیست/);
  assert.equal(col("wallet_accounts").byId(2).balance, 0);
});

test("admin panel is invisible and inert for normal users", async () => {
  await text(1, "/start");
  calls = [];
  await text(1, "⚙️ تنظیمات ولت");
  await text(1, "💎 شارژ موجودی کل");
  await press(1, "wa:supply:add");
  await text(1, "999999");
  assert.equal(sent(1).length, 0);
  assert.equal(col("wallet_supply").byId("supply").cap, 1000);
  await press(1, "wtask:ok:abc:2");
  assert.ok(calls.some((c) => c.method === "answerCallbackQuery" && /دسترسی/.test(c.payload.text ?? "")));
});

test("admin: top-up supply, signup bonus, fees, tx channel and task wizard all persist to the DB (not env)", async () => {
  await text(OWNER, "/start");
  await text(OWNER, "⚙️ تنظیمات ولت");
  await text(OWNER, "💎 شارژ موجودی کل"); await press(OWNER, "wa:supply:add"); await text(OWNER, "500");
  assert.equal(col("wallet_supply").byId("supply").cap, 1500);
  assert.equal(col("wallet_supply").byId("supply").remaining, 1500);
  await text(OWNER, "🎁 پاداش ثبت‌نام"); await text(OWNER, "3");
  assert.equal(col("wallet_settings").byId("settings").signupBonus, 3);
  await text(OWNER, "💸 کارمزدها"); await press(OWNER, "wa:fee:nava"); await text(OWNER, "2 1");
  assert.deepEqual(col("wallet_settings").byId("settings").feeNava, { pct: 2, fixed: 1 });
  await text(OWNER, "💸 کارمزدها"); await press(OWNER, "wa:fee:wallet"); await text(OWNER, "abc");
  assert.match(lastSent(), /فرمت/);
  await text(OWNER, "/start"); // a command cancels the flow
  await text(OWNER, "⚙️ تنظیمات ولت");
  await text(OWNER, "📣 کانال تراکنش‌ها"); await text(OWNER, "-1001234567890");
  assert.equal(col("wallet_settings").byId("settings").txLogChatId, -1001234567890);
  assert.ok(calls.some((c) => c.method === "sendMessage" && c.payload.chat_id === -1001234567890));

  await text(OWNER, "✅ تسک‌ها"); await press(OWNER, "wa:t:new");
  await text(OWNER, "عضویت در کانال"); await text(OWNER, "-");
  await press(OWNER, "wa:t:type:channel"); await text(OWNER, "https://t.me/x"); await text(OWNER, "@mychan"); await text(OWNER, "4");
  await press(OWNER, "wa:t:gate:yes"); await text(OWNER, "5");
  const t = col("wallet_tasks").all()[0];
  assert.deepEqual([t.title, t.type, t.chatRef, t.reward, t.gate, t.afterTaps], ["عضویت در کانال", "channel", "@mychan", 4, true, 5]);
});

test("admin: partner creation shows the keys once; a new bonus applies to the next signup from the supply", async () => {
  await text(OWNER, "/start");
  await text(OWNER, "🔌 پارتنرها"); await press(OWNER, "wa:p:new");
  await text(OWNER, "dl"); await text(OWNER, "ربات دانلودر"); await text(OWNER, "https://dl.example/api/relic");
  await press(OWNER, "wa:p:issue:yes");
  assert.match(lastSent(), /wpk_[0-9a-f]{48}/);
  const p = col("wallet_partners").byId("dl");
  assert.ok(!JSON.stringify(p).includes(lastSent().match(/wpk_[0-9a-f]{48}/)![0]), "raw API key is not stored");
  assert.equal(p.canIssue, true);
  await C.updateSettings({ signupBonus: 2 });
  await text(2, "/start");
  assert.equal(col("wallet_accounts").byId(2).balance, 2);
  assert.equal(col("wallet_supply").byId("supply").remaining, 998);
});

test("task review buttons: only admins; approve pays once and notifies the user", async () => {
  const K = await import("../../src/db/models/walletTasks.js");
  K.setReviewNotifier(async () => {});
  await text(1, "/start");
  const t = await K.createTask({ title: "insta", type: "instagram", reward: 6 });
  await K.claimTask(1, t._id);
  await press(2, `wtask:ok:${t._id}:1`); // non-admin
  assert.equal(col("wallet_accounts").byId(1).balance, 0);
  await press(OWNER, `wtask:ok:${t._id}:1`);
  await press(OWNER, `wtask:ok:${t._id}:1`);
  assert.equal(col("wallet_accounts").byId(1).balance, 6);
  assert.ok(sent(1).some((m) => /تایید شد/.test(m)));
});

test("buy: owner builds glass buttons in the admin panel; user sees them with their own token; payment API credit adds the owner-set Relic once", async () => {
  await text(OWNER, "/start");
  await press(OWNER, "wa:pk:new");
  await text(OWNER, "۵۰ رلیک ۱۰۰ هزار تومان");
  await text(OWNER, "https://pay.example/buy?u={uid}&t={token}");
  await text(OWNER, "50");
  const pk = (await C.getSettings()).packages!;
  assert.equal(pk.length, 1);
  assert.equal(pk[0]!.relic, 50);

  await text(1, "/start");
  calls = [];
  await text(1, "🛒 خرید رلیک");
  const btn = buttonsOf(lastMarkup()).find((b) => b.url);
  assert.equal(btn.text, "۵۰ رلیک ۱۰۰ هزار تومان");
  const token = col("wallet_accounts").byId(1).token;
  assert.ok(btn.url.includes("u=1") && btn.url.includes(encodeURIComponent(token)));

  // payment confirmation through the partner API (can issue)
  const P = await import("../../src/db/models/walletPartners.js");
  const k = await P.createPartner({ id: "shop", name: "Shop", baseUrl: "https://shop.example", canIssue: true });
  const partner = (await P.authenticatePartner(`Bearer ${k.apiKey}`))!;
  notes.length = 0;
  const r1 = await P.handlePartnerRequest(partner, { action: "credit", token, packageId: pk[0]!.id, externalId: "pay-1" });
  const r2 = await P.handlePartnerRequest(partner, { action: "credit", token, packageId: pk[0]!.id, externalId: "pay-1" });
  assert.equal(r1.status, 200);
  assert.equal((r2.body as any).duplicate, true);
  assert.equal(col("wallet_accounts").byId(1).balance, 50);
  assert.equal(col("wallet_supply").byId("supply").remaining, 950);
  assert.equal(notes.filter((n) => n.chat === 1).length, 1);
  assert.match(notes[0]!.text, /TX-/);
  // unknown package is refused, nothing credited
  const r3 = await P.handlePartnerRequest(partner, { action: "credit", token, packageId: "nope", externalId: "pay-2" });
  assert.equal(r3.status, 404);
  assert.equal(col("wallet_accounts").byId(1).balance, 50);
  // balance button shows it
  calls = [];
  await text(1, "💰 موجودی");
  assert.match(lastSent(), /50/);
});

test("admin hub: inline menu opens every section", async () => {
  await text(OWNER, "/start");
  calls = [];
  await text(OWNER, "⚙️ تنظیمات ولت");
  const keys = ["stats", "topup", "bonus", "fees", "limits", "txch", "revch", "tasks", "packs", "texts", "partners", "pending", "track"];
  for (const k of keys) assert.ok(cbOf(new RegExp(`^wa:m:${k}$`)), `hub button ${k}`);
  for (const k of keys) {
    calls = [];
    await press(OWNER, `wa:m:${k}`);
    assert.ok(calls.some((c) => c.method === "sendMessage"), `section ${k} replies`);
    await text(OWNER, "/start");
  }
});

test("transfer: both parties get the tracking code; owner finds it in the admin panel", async () => {
  await text(1, "/start"); await text(2, "/start");
  await col("wallet_accounts").updateOne({ _id: 1 }, { $set: { balance: 30 } });
  await col("wallet_supply").updateOne({ _id: "supply" }, { $inc: { remaining: -30, issued: 30 } });
  const T = await import("../../src/db/models/walletTransfers.js");
  const q = await T.createQuote(1, { dest: "wallet", token: col("wallet_accounts").byId(2).token, amount: 10 });
  notes.length = 0;
  const r = await T.confirmQuote(1, q.intentId);
  assert.match(r.code!, /^TX-/);
  assert.ok(notes.some((n) => n.chat === 1 && n.text.includes(r.code!)));
  assert.ok(notes.some((n) => n.chat === 2 && n.text.includes(r.code!)));
  await T.confirmQuote(1, q.intentId); // replay
  assert.equal(notes.length, 2, "no duplicate notifications");
  calls = [];
  await text(OWNER, "🔎 پیگیری تراکنش");
  await text(OWNER, r.code!.toLowerCase());
  assert.match(lastSent(), new RegExp(r.code!));
  await text(OWNER, "🔎 پیگیری تراکنش");
  await text(OWNER, "TX-ZZZZZZZZ");
  assert.match(lastSent(), /code_not_found/);
});

test("admin wizard: add a manual task end-to-end (title -> desc -> type -> url -> reward -> gate)", async () => {
  await text(OWNER, "/start");
  calls = [];
  await text(OWNER, "✅ تسک‌ها");
  assert.ok(cbOf(/^wa:t:new$/), "new-task button shown");
  await press(OWNER, "wa:t:new");
  await text(OWNER, "عضویت در اینستاگرام");
  await text(OWNER, "-");
  await press(OWNER, "wa:t:type:instagram");
  await text(OWNER, "https://instagram.com/x");
  await text(OWNER, "5");
  await press(OWNER, "wa:t:gate:no");
  const tasks = col("wallet_tasks").all();
  assert.equal(tasks.length, 1, "task created");
  assert.equal(tasks[0].reward, 5);
});
