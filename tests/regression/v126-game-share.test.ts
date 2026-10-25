/** v1.26.0 — shared game link: /start g_<gid> → glass web_app button; games façade routes actions. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com/miniapp/", OWNER_ID: "1" });
const g = await import("../../src/services/games/index.js");
const { GAME_START_RE, gameAppUrl } = await import("../../src/features/games/shareStart.js");

beforeEach(() => {
  resetState();
  h.resetCalls();
  seedUser({ id: 7, anonId: "user_W7", nickname: "علی", age: 25, relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
});

test("G1. /start g_<gid> answers with one web_app button that opens the table", async () => {
  await h.text(7, "/start g_abc12345");
  await h.settle();
  const m = h.of("sendMessage", 7).find((c) => c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app);
  assert.ok(m, "web_app button sent");
  const url = m!.payload.reply_markup.inline_keyboard[0][0].web_app.url as string;
  assert.match(url, /go=g_abc12345/);
});

test("G2. start-payload shape and url builder", () => {
  assert.ok(GAME_START_RE.test("g_abcd"));
  assert.ok(!GAME_START_RE.test("g_a"));
  assert.ok(!GAME_START_RE.test("msg_user_ABCDEF"));
  assert.match(gameAppUrl("xyz1234")!, /go=g_xyz1234/);
});

test("G3. games façade owns the game actions", () => {
  for (const a of ["game_lobby", "game_create", "game_join", "game_state", "game_roll", "game_move", "game_resign"]) assert.ok(g.isGameAction(a));
  assert.ok(!g.isGameAction("feed"));
  assert.ok(g.GAME_ACTING_NEVER.includes("game_move"));
});
