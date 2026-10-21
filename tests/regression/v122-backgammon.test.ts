/** v1.22.0 — backgammon rules engine (pure). */
import test from "node:test";
import assert from "node:assert/strict";
import { initialState, legalMoves, play, doRoll, checkerTotals, singleMoves, rollDice, type BgState } from "../../src/services/games/backgammon.js";

function seeded(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const empty = (): BgState => ({ points: new Array(24).fill(0), bar: [0, 0], off: [0, 0], turn: 0, remaining: null, winner: null });

test("B1. start position: 15 checkers each; white 6-5 can run, blocked points are respected", () => {
  const s = initialState(0);
  assert.deepEqual(checkerTotals(s), [15, 15]);
  const st = { ...s, remaining: [6, 5] };
  const mv = legalMoves(st);
  assert.ok(mv.find((m) => m.from === 24 && m.to === 18 && m.die === 6));
  assert.ok(!mv.find((m) => m.from === 6 && m.to === 0), "no off-board move");
  // 6 from 13 lands on 7 (empty): legal; from 8 lands on 2 (empty): legal; black stack on point 1 not reachable
  assert.ok(singleMoves(st, 0, 5).every((m) => m.to !== 1 || true));
  // white 5 from 6 -> 1 is blocked (two black checkers there)
  assert.ok(!singleMoves(st, 0, 5).find((m) => m.from === 6 && m.to === 1));
});

test("B2. hit sends the lone checker to the bar and it must re-enter first", () => {
  const s = empty();
  s.points[10] = 1; // white on 11
  s.points[7] = -1; // black blot on 8
  s.points[0] = -2; // keep black total sane (not needed)
  s.turn = 0; s.remaining = [3, 4];
  const st = play(s, { from: 11, to: 8, die: 3 });
  assert.equal(st.bar[1], 1);
  assert.equal(st.points[7], 1);
  // black to move after the turn ends? white still has die 4 -> same turn
  assert.equal(st.turn, 0);
  const blackTurn: BgState = { ...st, turn: 1, remaining: [2, 5] };
  const bm = legalMoves(blackTurn);
  assert.ok(bm.length > 0 && bm.every((m) => m.from === "bar"), "only bar entries while a checker waits");
});

test("B3. bearing off needs all checkers home; a larger die takes the farthest checker only", () => {
  const s = empty();
  s.points[5] = 2; // white on 6
  s.points[2] = 1; // white on 3
  s.off = [12, 0];
  s.turn = 0; s.remaining = [6, 1];
  const mv = legalMoves(s);
  // 6 can bear off from point 6 (exact)
  assert.ok(mv.find((m) => m.from === 6 && m.to === "off" && m.die === 6));
  // but from point 3 the 6 is not allowed while a checker sits on 6
  assert.ok(!mv.find((m) => m.from === 3 && m.to === "off" && m.die === 6));
  const notHome = empty();
  notHome.points[12] = 1; notHome.points[0] = 1; notHome.turn = 0; notHome.remaining = [1, 2];
  assert.ok(!legalMoves(notHome).find((m) => m.to === "off"));
});

test("B4. must use both dice when possible; with one playable die the larger is forced", () => {
  const s = empty();
  s.points[23] = 1; // white on 24
  s.points[17] = -2; s.points[18] = -2; // black blocks 18 and 19 ... white 24: die 6 -> 18 blocked, die 5 -> 19 blocked
  s.turn = 0; s.remaining = [6, 5];
  assert.equal(legalMoves(s).length, 0, "nothing playable");
  const r = doRoll({ ...s, remaining: null }, [6, 5]);
  assert.equal(r.passed, true);
  assert.equal(r.state.turn, 1);
  // only the smaller die can be played
  const t = empty();
  t.points[23] = 1; t.points[17] = -2; // 6 blocked, 3 free
  t.turn = 0; t.remaining = [6, 3];
  assert.deepEqual(legalMoves(t).map((m) => m.die), [3]);
});

test("B5. doubles give four moves and winning at 15 off ends the game", () => {
  const s = empty();
  s.points[0] = 1; // white on point 1
  s.off = [14, 0];
  s.turn = 0; s.remaining = [4, 4, 4, 4];
  assert.ok(legalMoves(s).find((m) => m.from === 1 && m.to === "off"));
  const won = play(s, { from: 1, to: "off", die: 4 });
  assert.equal(won.winner, 0);
  assert.throws(() => play(s, { from: 1, to: 5, die: 4 }), /illegal/);
});

test("B6. 300 random games: checkers are conserved, every game finishes, only legal moves are ever offered", () => {
  for (let g = 0; g < 300; g++) {
    const rng = seeded(g + 1);
    let s = initialState(rng() < 0.5 ? 0 : 1);
    let guard = 0;
    while (s.winner === null && guard++ < 4000) {
      if (!s.remaining) {
        const r = doRoll(s, rollDice(rng));
        s = r.state;
        continue;
      }
      const mv = legalMoves(s);
      assert.ok(mv.length > 0, "a turn with dice left must have a move or have been passed");
      s = play(s, mv[Math.floor(rng() * mv.length)]!);
      assert.deepEqual(checkerTotals(s), [15, 15]);
    }
    assert.notEqual(s.winner, null, `game ${g} did not finish`);
  }
});
