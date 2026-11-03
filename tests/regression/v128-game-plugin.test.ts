/** v1.28.1 — game plug-in registry + Jeton wallet contract (mocked Mongo) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

await createHarness({});
const { buildRegistry } = await import("../../src/services/games/registry.js");
const gi = await import("../../src/services/games/index.js");
const { gameWallet } = await import("../../src/services/games/wallet.js");
const { runInTransaction, TxAbort } = await import("../../src/db/tx.js");
const bal = (id: number) => (col("users").byId(id) as any).relicBalance as number;
beforeEach(() => { resetState(); seedUser({ id: 1, anonId: "user_P0001", nickname: "a", relicBalance: 100, relicInitialized: true } as any); seedUser({ id: 2, anonId: "user_P0002", nickname: "b", relicBalance: 100, relicInitialized: true } as any); });

const ok = async () => ({});
test("P1. the registry derives actions / guest / acting rules and rejects bad modules", () => {
  const r = buildRegistry([{ id: "chess", title: "c", actions: { chess_move: { handle: ok, guest: true }, chess_state: { handle: ok, actingBlocked: false } }, errors: { bad_move: 400 } }]);
  assert.ok(r.actions.has("chess_move") && r.guestActions.has("chess_move") && !r.guestActions.has("chess_state"));
  assert.ok(r.actingNever.has("chess_move") && !r.actingNever.has("chess_state"));
  assert.equal(r.errors.bad_move, 400);
  assert.throws(() => buildRegistry([{ id: "chess", title: "c", actions: { move: { handle: ok } } }]), /must start with/);
  assert.throws(() => buildRegistry([{ id: "Chess!", title: "c", actions: {} }]), /invalid/);
  const a = { id: "ludo", title: "l", actions: { ludo_x: { handle: ok } } };
  assert.throws(() => buildRegistry([a, a]), /duplicate game id/);
});

test("P2. backgammon is served through the registry with its legacy action names", () => {
  for (const a of ["game_lobby", "game_create", "game_join", "game_state", "game_roll", "game_move", "game_resign", "game_share"]) assert.ok(gi.isGameAction(a), a);
  assert.ok(gi.GAME_GUEST_ACTIONS.includes("game_join") && !gi.GAME_GUEST_ACTIONS.includes("game_create"));
  assert.ok(gi.GAME_ACTING_NEVER.includes("game_move") && !gi.GAME_ACTING_NEVER.includes("game_lobby"));
  assert.equal(gi.GAME_ERRORS.stakes_disabled, 400);
});

test("P3. wallet: staked flow is off by default; when on, hold / pay / refund are exactly-once", async () => {
  await assert.rejects(gameWallet("chess", "g1", { enabled: false }).hold(1, 5, {} as any), /disabled/);
  const w = gameWallet("chess", "g1", { enabled: true });
  await runInTransaction(async (s) => { assert.equal(await w.hold(1, 10, s), true); assert.equal(await w.hold(2, 10, s), true); });
  assert.deepEqual([bal(1), bal(2)], [90, 90]);
  assert.equal(await w.settleWinner(1, 2, 20), true);
  assert.equal(await w.settleWinner(1, 2, 20), false, "second settle pays nothing");
  assert.deepEqual([bal(1), bal(2)], [110, 90]);
  // refund path for another game, twice
  const w2 = gameWallet("chess", "g2", { enabled: true });
  await runInTransaction(async (s) => { await w2.hold(1, 5, s); });
  await w2.settleRefund([1], 5); await w2.settleRefund([1], 5);
  assert.equal(bal(1), 110);
  // not enough Jeton → false and nothing moves
  await runInTransaction(async (s) => { if (!(await gameWallet("chess", "g3", { enabled: true }).hold(2, 999, s))) throw new TxAbort("insufficient"); }).catch(() => {});
  assert.equal(bal(2), 90);
  await assert.rejects(gameWallet("chess", "g4", { enabled: true }).pay(1, -5, {} as any), /positive integer/);
});
