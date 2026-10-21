/**
 * BACKGAMMON — pure rules engine (no I/O). Standard rules except: no doubling cube, no gammon scoring, and the
 * opening roll is a normal two-dice roll for a randomly chosen starter.
 *
 * Board: points 1..24. `points[i-1] > 0` = that many WHITE checkers (player 0), `< 0` = BLACK (player 1).
 *   WHITE moves 24 → 1 and bears off from 1..6;  BLACK moves 1 → 24 and bears off from 19..24.
 * `bar[p]` = checkers of player p waiting to re-enter, `off[p]` = checkers borne off. First to bear off 15 wins.
 */

export type Player = 0 | 1;
export type From = number | "bar"; // 1..24 or "bar"
export type To = number | "off"; // 1..24 or "off"

export interface BgState {
  points: number[]; // length 24
  bar: [number, number];
  off: [number, number];
  turn: Player;
  /** null = the player on turn still has to roll; else the dice values that are still unused (4 entries after a double) */
  remaining: number[] | null;
  winner: Player | null;
}

export interface Move {
  from: From;
  to: To;
  die: number;
}

export function initialState(starter: Player): BgState {
  const p = new Array(24).fill(0) as number[];
  const set = (pt: number, n: number) => (p[pt - 1] = n);
  set(24, 2); set(13, 5); set(8, 3); set(6, 5); // white
  set(1, -2); set(12, -5); set(17, -3); set(19, -5); // black
  return { points: p, bar: [0, 0], off: [0, 0], turn: starter, remaining: null, winner: null };
}

const own = (n: number, p: Player) => (p === 0 ? n > 0 : n < 0);
const cnt = (n: number) => Math.abs(n);
const dir = (p: Player) => (p === 0 ? -1 : 1);
/** the point a checker enters on from the bar with die d */
const entryPoint = (p: Player, d: number) => (p === 0 ? 25 - d : d);

function allHome(s: BgState, p: Player): boolean {
  if (s.bar[p] > 0) return false;
  for (let pt = 1; pt <= 24; pt++) {
    if (own(s.points[pt - 1]!, p) && !(p === 0 ? pt <= 6 : pt >= 19)) return false;
  }
  return true;
}

/** distance from the player's own "exit" (1 = the point next to the edge) */
const dist = (pt: number, p: Player) => (p === 0 ? pt : 25 - pt);

/** every single legal move for ONE die value, ignoring the "use as many dice as possible" rule */
export function singleMoves(s: BgState, p: Player, d: number): Move[] {
  const out: Move[] = [];
  const blocked = (pt: number) => {
    const v = s.points[pt - 1]!;
    return !own(v, p) && cnt(v) >= 2;
  };
  if (s.bar[p] > 0) {
    const pt = entryPoint(p, d);
    if (!blocked(pt)) out.push({ from: "bar", to: pt, die: d });
    return out;
  }
  const home = allHome(s, p);
  let farthest = 0;
  if (home) for (let pt = 1; pt <= 24; pt++) if (own(s.points[pt - 1]!, p)) farthest = Math.max(farthest, dist(pt, p));
  for (let pt = 1; pt <= 24; pt++) {
    if (!own(s.points[pt - 1]!, p)) continue;
    const dest = pt + dir(p) * d;
    if (dest >= 1 && dest <= 24) {
      if (!blocked(dest)) out.push({ from: pt, to: dest, die: d });
    } else if (home) {
      const need = dist(pt, p);
      if (d === need || (d > need && need === farthest)) out.push({ from: pt, to: "off", die: d });
    }
  }
  return out;
}

export function applyMove(s: BgState, p: Player, m: Move): BgState {
  const points = s.points.slice();
  const bar: [number, number] = [s.bar[0], s.bar[1]];
  const off: [number, number] = [s.off[0], s.off[1]];
  const sign = p === 0 ? 1 : -1;
  if (m.from === "bar") bar[p]--;
  else points[m.from - 1] = points[m.from - 1]! - sign;
  if (m.to === "off") off[p]++;
  else {
    const v = points[m.to - 1]!;
    if (!own(v, p) && cnt(v) === 1) {
      bar[(1 - p) as Player]++; // hit
      points[m.to - 1] = sign;
    } else points[m.to - 1] = v + sign;
  }
  const rem = s.remaining ? s.remaining.slice() : [];
  const i = rem.indexOf(m.die);
  if (i >= 0) rem.splice(i, 1);
  const winner: Player | null = off[p] === 15 ? p : null;
  return { points, bar, off, turn: s.turn, remaining: rem, winner };
}

/** longest legal sequence length (0..4) reachable from this position with these dice — the "must use as many as possible" rule */
function maxSequence(s: BgState, p: Player, dice: number[]): number {
  let best = 0;
  const seen = new Set<string>();
  const rec = (st: BgState, rem: number[], used: number) => {
    best = Math.max(best, used);
    if (best === dice.length || st.winner !== null) return;
    const tried = new Set<number>();
    for (let i = 0; i < rem.length; i++) {
      const d = rem[i]!;
      if (tried.has(d)) continue;
      tried.add(d);
      for (const m of singleMoves(st, p, d)) {
        const next = applyMove({ ...st, remaining: rem }, p, m);
        const rest = rem.slice(0, i).concat(rem.slice(i + 1));
        const key = JSON.stringify([next.points, next.bar, next.off, rest]);
        if (seen.has(key)) continue;
        seen.add(key);
        rec(next, rest, used + 1);
        if (best === dice.length) return;
      }
    }
  };
  rec(s, dice, 0);
  return best;
}

/** The moves the player on turn may make right now, honouring "use both dice if you can" and "if only one die can be
 *  played, it must be the larger when possible". */
export function legalMoves(s: BgState): Move[] {
  if (s.winner !== null || !s.remaining || s.remaining.length === 0) return [];
  const p = s.turn;
  const dice = s.remaining;
  const need = maxSequence(s, p, dice);
  if (need === 0) return [];
  const out: Move[] = [];
  const tried = new Set<number>();
  for (let i = 0; i < dice.length; i++) {
    const d = dice[i]!;
    if (tried.has(d)) continue;
    tried.add(d);
    const rest = dice.slice(0, i).concat(dice.slice(i + 1));
    for (const m of singleMoves(s, p, d)) {
      const after = applyMove(s, p, m);
      const len = 1 + (after.winner !== null ? 0 : maxSequence(after, p, rest));
      if (len >= need || after.winner !== null) out.push(m);
    }
  }
  // only one die playable although two were rolled (non-double): the larger die must be played if it can be
  if (need === 1 && dice.length === 2 && dice[0] !== dice[1]) {
    const hi = Math.max(dice[0]!, dice[1]!);
    if (out.some((m) => m.die === hi)) return out.filter((m) => m.die === hi);
  }
  return out;
}

export function rollDice(rng: () => number = Math.random): number[] {
  const a = 1 + Math.floor(rng() * 6);
  const b = 1 + Math.floor(rng() * 6);
  return a === b ? [a, a, a, a] : [a, b];
}

/** A roll for the player on turn. If nothing can be played the turn passes at once (`passed: true`). */
export function doRoll(s: BgState, dice: number[]): { state: BgState; passed: boolean } {
  if (s.winner !== null || s.remaining) throw new Error("cannot roll now");
  const st: BgState = { ...s, remaining: dice };
  if (legalMoves(st).length === 0) return { state: pass(st), passed: true };
  return { state: st, passed: false };
}

function pass(s: BgState): BgState {
  return { ...s, turn: (1 - s.turn) as Player, remaining: null };
}

/** Plays one move; ends the turn when no dice are left or none can be played. Throws on an illegal move. */
export function play(s: BgState, m: Move): BgState {
  const ok = legalMoves(s).find((x) => x.from === m.from && x.to === m.to && x.die === m.die);
  if (!ok) throw new Error("illegal move");
  const next = applyMove(s, s.turn, ok);
  if (next.winner !== null) return { ...next, remaining: [] };
  if (!next.remaining || next.remaining.length === 0 || legalMoves(next).length === 0) return pass(next);
  return next;
}

export function checkerTotals(s: BgState): [number, number] {
  let w = s.bar[0] + s.off[0], b = s.bar[1] + s.off[1];
  for (const v of s.points) v > 0 ? (w += v) : (b -= v);
  return [w, b];
}
