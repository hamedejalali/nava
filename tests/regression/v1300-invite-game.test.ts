/** v1.30.0 — M2: the inline «@bot» game invite: list → /start ig_<token> → forced-join → English name → age → «ورود به بازی»;
 *  «complete your info» answers + «شروع»; table entry with the age-band rule. MOCK TESTS: fake MongoDB / Telegram. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com/miniapp/", BOT_USERNAME: "NavaTestBot" });
const { INVITE_TOKEN_RE, getInvite, ensureInvite } = await import("../../src/services/games/invites.js");
const { enterInvite } = await import("../../src/services/games/backgammonGames.js");
const { GAME_GUEST_ACTIONS, GAME_ERRORS } = await import("../../src/services/games/index.js");
const { addChannel } = await import("../../src/db/models/channel.js");
const { PROVINCES } = await import("../../src/data/provinces.js");
const { citiesForProvince } = await import("../../src/data/cities.js");
const province = PROVINCES.find((p) => p.nameFa === "تهران")!;
const city = citiesForProvince(province.id)[0]!;

const HOST = 7001, P2 = 7002, NEW = 7003;
beforeEach(() => { resetState(); h.resetCalls(); h.clearFailures(); });
const user = (id: number) => col("users").all().find((u: any) => u._id === id);
const texts = (id: number) => h.of("sendMessage", id).map((c) => String(c.payload.text));
const lastKb = (id: number) => h.of("sendMessage", id).at(-1)?.payload.reply_markup;

async function tokenFor(host = HOST): Promise<string> {
  await h.inline(host, "");
  const ans = h.of("answerInlineQuery").at(-1)!;
  const r = ans.payload.results[0];
  return String(r.reply_markup.inline_keyboard[0][0].url).split("ig_")[1]!;
}

test("I1. «@bot » lists the games; the button carries an opaque token (no Telegram id); repeating gives the same token; invite stored", async () => {
  await h.inline(HOST, "");
  const ans = h.of("answerInlineQuery").at(-1)!;
  assert.equal(ans.payload.results.length, 1);
  const r = ans.payload.results[0];
  const url = r.reply_markup.inline_keyboard[0][0].url as string;
  assert.match(url, /^https:\/\/t\.me\/NavaTestBot\?start=ig_[A-Za-z0-9_-]{16}$/);
  assert.equal(JSON.stringify(ans.payload).includes(String(HOST)), false, "host id must not be exposed");
  assert.equal(ans.payload.is_personal, true);
  const t1 = url.split("ig_")[1]!;
  assert.match(t1, INVITE_TOKEN_RE);
  assert.equal(await tokenFor(), t1, "same host + game + day = same token");
  assert.notEqual(await tokenFor(HOST + 50), t1);
  assert.equal(col("game_invites").all().length, 2);
  assert.ok(await getInvite(t1));
  await h.inline(HOST, "zzz-nothing");
  assert.equal(h.of("answerInlineQuery").at(-1)!.payload.results.length, 0);
});

test("I2. unknown / malformed / expired token: a clear message, no onboarding started", async () => {
  await h.text(NEW, "/start ig_AAAAAAAAAAAAAAAA");
  assert.ok(texts(NEW).some((t) => /منقضی/.test(t)));
  assert.equal(user(NEW)?.inviteFlow, undefined);
  assert.equal(user(NEW)?.nickname, undefined);
  const t = await tokenFor();
  await col("game_invites").updateOne({ _id: t } as any, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  h.resetCalls();
  await h.text(NEW, `/start ig_${t}`);
  assert.ok(texts(NEW).some((x) => /منقضی/.test(x)));
});

test("I3. a brand-new person: name (English only) → age → main keyboard + ONE «ورود به بازی» web_app button on ?go=ig_<token>; not COMPLETED", async () => {
  const t = await tokenFor();
  h.resetCalls();
  await h.text(NEW, `/start ig_${t}`);
  assert.ok(texts(NEW).some((x) => /حروف انگلیسی/.test(x)), "asks for the name");
  for (const bad of ["علی", "Ali9"]) { await h.text(NEW, bad); assert.equal(user(NEW).nickname, undefined, bad); }
  await h.text(NEW, "Sara");
  assert.equal(user(NEW).nickname, "Sara");
  h.resetCalls();
  await h.text(NEW, "abc");
  await h.text(NEW, "7");
  assert.equal(user(NEW).age, undefined);
  h.resetCalls();
  await h.text(NEW, "۲۲"); // Persian digits
  assert.equal(user(NEW).age, 22);
  const kbs = h.of("sendMessage", NEW).map((c) => c.payload.reply_markup);
  assert.ok(kbs.some((k: any) => k?.keyboard), "main reply keyboard");
  const entry = lastKb(NEW).inline_keyboard.flat();
  assert.equal(entry.length, 1);
  assert.equal(entry[0].text.includes("ورود به بازی"), true);
  assert.equal(entry[0].web_app.url, `https://nava.example.com/miniapp/?go=ig_${t}`);
  assert.notEqual(user(NEW).onboardingStep, "COMPLETED");
  assert.equal(user(NEW).inviteFlow.step, "READY");
});

test("I4. until the profile is complete every other tap answers «complete your info» with a «شروع» button; «شروع» runs gender → province → city and keeps the name/age", async () => {
  const t = await tokenFor();
  await h.text(NEW, `/start ig_${t}`);
  await h.text(NEW, "Sara"); await h.text(NEW, "22");
  h.resetCalls();
  await h.text(NEW, "🔎 جستجو");
  assert.ok(texts(NEW).some((x) => /اطلاعاتت رو کامل کنی/.test(x)));
  const btn = lastKb(NEW).inline_keyboard.flat()[0];
  assert.equal(btn.callback_data, "inv:go");
  h.resetCalls();
  await h.callback(NEW, "inv:go");
  assert.equal(user(NEW).onboardingStep, "GENDER_PENDING");
  assert.equal(user(NEW).inviteFlow, undefined);
  await h.callback(NEW, "gender:female");
  assert.equal(user(NEW).onboardingStep, "AGE_DONE", "the age question is not asked again");
  assert.equal(user(NEW).age, 22);
  await h.text(NEW, province.nameFa);
  await h.text(NEW, city.nameFa);
  const u = user(NEW);
  assert.equal(u.onboardingStep, "COMPLETED");
  assert.equal(u.nickname, "Sara");
  assert.equal(u.age, 22);
  assert.equal(u.gender, "female");
});

test("I5. forced-join first: the invite waits, «عضو شدم» continues it with the name question", async () => {
  await addChannel({ title: "کانال", chatRef: "@navatest", url: "https://t.me/navatest", handle: "@navatest" });
  let left = true;
  (h.bot.api.config as any).use(async (prev: any, method: string, payload: any) => {
    if (method === "getChatMember" && payload.user_id === NEW) return { ok: true, result: { status: left ? "left" : "member", user: { id: NEW, is_bot: false, first_name: "x" } } };
    return prev(method, payload);
  });
  const t = await tokenFor();
  h.resetCalls();
  await h.text(NEW, `/start ig_${t}`);
  const urls = lastKb(NEW).inline_keyboard.flat().map((b: any) => b.url ?? b.callback_data);
  assert.ok(urls.includes("https://t.me/navatest"));
  assert.equal(user(NEW).inviteFlow.step, "JOIN");
  assert.equal(texts(NEW).some((x) => /حروف انگلیسی/.test(x)), false);
  left = false;
  h.resetCalls();
  await h.callback(NEW, "forcejoin:verify");
  assert.ok(texts(NEW).some((x) => /حروف انگلیسی/.test(x)), "name question after joining");
  assert.equal(user(NEW).inviteFlow.step, "NAME");
});

test("I6. table: the host opens it, the guest sits down; waiting_host before the host entered; same age band required", async () => {
  seedUser({ id: HOST, nickname: "Host", age: 30 });
  seedUser({ id: P2, nickname: "Guest", age: 28, onboardingStep: "LANGUAGE_PENDING" } as any);
  const token = await ensureInvite(HOST, "backgammon");
  const inv = async () => (await getInvite(token))!;
  await assert.rejects(enterInvite({ _id: P2 }, await inv(), true), /waiting_host/);
  const t1 = await enterInvite({ _id: HOST }, await inv(), false);
  assert.equal(t1.status, "waiting");
  assert.equal((await getInvite(token))!.gid, t1.gid);
  const again = await enterInvite({ _id: HOST }, await inv(), false);
  assert.equal(again.gid, t1.gid, "host re-entering gets the same table");
  const v2 = await enterInvite({ _id: P2 }, await inv(), true);
  assert.equal(v2.status, "active");
  assert.equal(col("bg_games").all().length, 1);
});

test("I7. age-band stays enforced: a minor guest can not sit at an adult's table (neutral not_found), the table stays free", async () => {
  seedUser({ id: HOST, nickname: "Host", age: 30 });
  seedUser({ id: P2, nickname: "Kid", age: 15, onboardingStep: "LANGUAGE_PENDING" } as any);
  const token = await ensureInvite(HOST, "backgammon");
  const t1 = await enterInvite({ _id: HOST }, (await getInvite(token))!, false);
  await assert.rejects(enterInvite({ _id: P2 }, (await getInvite(token))!, true), /not_found/);
  assert.equal(col("bg_games").byId(t1.gid).status, "waiting");
  seedUser({ id: NEW, nickname: "Noage", onboardingStep: "LANGUAGE_PENDING", age: undefined } as any);
  await assert.rejects(enterInvite({ _id: NEW }, (await getInvite(token))!, true), /not_found/, "no age on file = refused");
});

test("I8. a third person can not take a taken seat; the action is open to guests and its error code is mapped", async () => {
  seedUser({ id: HOST, nickname: "Host", age: 30 });
  seedUser({ id: P2, nickname: "Guest", age: 28 });
  seedUser({ id: NEW, nickname: "Third", age: 29 });
  const token = await ensureInvite(HOST, "backgammon");
  await enterInvite({ _id: HOST }, (await getInvite(token))!, false);
  await enterInvite({ _id: P2 }, (await getInvite(token))!, false);
  await assert.rejects(enterInvite({ _id: NEW }, (await getInvite(token))!, false), /not_found/);
  assert.ok(GAME_GUEST_ACTIONS.includes("game_invite"));
  assert.equal(GAME_ERRORS.waiting_host, 409);
});

test("I9. a finished, normal user opening an invite goes straight to the button; the flow never traps a completed account", async () => {
  seedUser({ id: P2, nickname: "Guest", age: 28 });
  const t = await tokenFor();
  h.resetCalls();
  await h.text(P2, `/start ig_${t}`);
  const entry = lastKb(P2).inline_keyboard.flat();
  assert.equal(entry[0].web_app.url, `https://nava.example.com/miniapp/?go=ig_${t}`);
  assert.equal(user(P2).inviteFlow, undefined);
  h.resetCalls();
  await h.text(P2, "/start");
  assert.equal(texts(P2).some((x) => /اطلاعاتت رو کامل کنی/.test(x)), false);
});
