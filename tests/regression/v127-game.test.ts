/** v1.27.0 — own game link, invite states, game share card (photo from the panel), bot username. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com/miniapp/", OWNER_ID: "1" });
const bg = await import("../../src/services/games/backgammonGames.js");
const { prepareGameShare } = await import("../../src/services/games/gameShare.js");
const { setAppVar, resetAppVarsCache } = await import("../../src/services/appVars.js");

const user = (id: number, name: string) => seedUser({ id, anonId: `user_T${id}`, nickname: name, age: 25, relicBalance: 100, relicInitialized: true, onboardingStep: "COMPLETED" } as any);

beforeEach(() => {
  resetState();
  h.resetCalls();
  resetAppVarsCache();
  user(7, "علی");
  user(8, "حامد");
});

test("V1. the HOST opening his own link is NOT told «your friend invited you»", async () => {
  const view = await bg.create({ _id: 8 }, 0);
  await h.text(8, `/start g_${view.gid}`);
  await h.settle();
  const msgs = h.of("sendMessage", 8);
  const all = msgs.map((c) => String(c.payload.text)).join("\n");
  assert.ok(!all.includes("دعوت کرده"), all);
  assert.ok(all.includes("میز تخته‌نرد تو آماده"), all);
  assert.ok(msgs.some((c) => c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app), "still gets the open-table button");
});

test("V2. a friend gets the invitation text with the host's name and the stake", async () => {
  const view = await bg.create({ _id: 8 }, 5);
  await h.text(7, `/start g_${view.gid}`);
  await h.settle();
  const all = h.of("sendMessage", 7).map((c) => String(c.payload.text)).join("\n");
  assert.ok(all.includes("حامد") && all.includes("دعوت کرده"), all);
  assert.ok(all.includes("ژتون روی میز"), all);
});

test("V3. a missing / finished table says so and shows no dead button", async () => {
  await h.text(7, "/start g_doesnotexist1");
  await h.settle();
  const msgs = h.of("sendMessage", 7);
  assert.ok(msgs.some((c) => String(c.payload.text).includes("وجود نداره")));
  assert.ok(!msgs.some((c) => c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app));
});

test("V4. share: photo from the panel variable → prepared photo message with the t.me start link", async () => {
  const view = await bg.create({ _id: 8 }, 0);
  await setAppVar("GAME_SHARE_PHOTO", "FILEID123");
  let sent: any = null;
  const api = { raw: { savePreparedInlineMessage: async (a: any) => ((sent = a), { id: "prep1" }) } };
  const r = await prepareGameShare({ _id: 8 }, view.gid, { api, bot: "MoyaBot" });
  assert.equal(r.id, "prep1");
  assert.equal(sent.result.type, "photo");
  assert.equal(sent.result.photo_file_id, "FILEID123");
  assert.equal(sent.result.reply_markup.inline_keyboard[0][0].url, `https://t.me/MoyaBot?start=g_${view.gid}`);
});

test("V5. share without a photo falls back to a text card; a stranger cannot share someone else's table", async () => {
  const view = await bg.create({ _id: 8 }, 0);
  let sent: any = null;
  const api = { raw: { savePreparedInlineMessage: async (a: any) => ((sent = a), { id: "prep2" }) } };
  await prepareGameShare({ _id: 8 }, view.gid, { api, bot: "MoyaBot" });
  assert.equal(sent.result.type, "article");
  await assert.rejects(() => prepareGameShare({ _id: 7 }, view.gid, { api, bot: "MoyaBot" }), /not_found/);
});

test("V6. a stale photo file_id retries as text instead of failing", async () => {
  const view = await bg.create({ _id: 8 }, 0);
  await setAppVar("GAME_SHARE_PHOTO", "BADFILE");
  let calls = 0;
  const api = { raw: { savePreparedInlineMessage: async (a: any) => { calls++; if (a.result.type === "photo") throw new Error("wrong file identifier"); return { id: "prep3" }; } } };
  const r = await prepareGameShare({ _id: 8 }, view.gid, { api, bot: "MoyaBot" });
  assert.equal(r.id, "prep3");
  assert.equal(calls, 2);
});
