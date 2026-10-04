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
  assert.deepEqual(labels, ["💰 موجودی", "📤 ارسال", "📥 دریافت"]);
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
