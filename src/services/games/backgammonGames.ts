import { randomBytes } from "node:crypto";
import { getDb } from "../../db/connect.js";
import { isBlockedEitherWay } from "../../db/models/blocks.js";
import { checkRateLimit } from "../../utils/rateLimit.js";
import { SocialError, toBriefs, usersCol, type Brief } from "../nava/common.js";
import { doRoll, initialState, legalMoves, play, rollDice, type BgState, type Move, type Player } from "./backgammon.js";

/**
 * Two-player backgammon in the Mini App (experimental). One document per game in `bg_games`; every write is an
 * optimistic-concurrency update on `v`, so two taps / two devices can never apply the same move twice.
 * Players are addressed by their public Nava id; Telegram ids never leave the server.
 */
export interface BgGameDoc {
  _id: string;
  status: "waiting" | "active" | "finished";
  /** [white, black] telegram ids; black is 0 while waiting */
  players: [number, number];
  state: BgState | null;
  v: number;
  /** last thing that happened (for the animation / log line): roll, move, pass, resign… */
  last: { by: Player; kind: "roll" | "move" | "pass" | "resign" | "timeout"; dice?: number[]; move?: Move } | null;
  endedBy?: "win" | "resign" | "timeout" | "cancel";
  createdAt: Date;
  updatedAt: Date;
}

const IDLE_MS = 5 * 60_000; // a player who does not move for 5 minutes loses the game
const WAIT_MS = 15 * 60_000; // an open table nobody joined disappears

async function games() {
  return (await getDb()).collection<BgGameDoc>("bg_games");
}

let indexed = false;
async function ensureIdx() {
  if (indexed) return;
  const c = await games();
  await c.createIndexes([
    { key: { status: 1, updatedAt: -1 }, name: "status_updated" },
    { key: { createdAt: 1 }, name: "ttl", expireAfterSeconds: 3 * 86_400 },
  ]);
  indexed = true;
}

const idOf = () => randomBytes(7).toString("base64url");

/** Lazy housekeeping: a stale waiting table is cancelled, a stale active game is lost by the player who stopped moving. */
async function expire(g: BgGameDoc): Promise<BgGameDoc> {
  const now = Date.now();
  const c = await games();
  if (g.status === "waiting" && now - g.updatedAt.getTime() > WAIT_MS) {
    await c.updateOne({ _id: g._id, status: "waiting" }, { $set: { status: "finished", endedBy: "cancel", updatedAt: new Date() }, $inc: { v: 1 } });
    return (await c.findOne({ _id: g._id }))!;
  }
  if (g.status === "active" && g.state && g.state.winner === null && now - g.updatedAt.getTime() > IDLE_MS) {
    const loser = g.state.turn;
    const winner = (1 - loser) as Player;
    await c.updateOne({ _id: g._id, status: "active", v: g.v }, { $set: { status: "finished", endedBy: "timeout", "state.winner": winner, last: { by: loser, kind: "timeout" }, updatedAt: new Date() }, $inc: { v: 1 } });
    return (await c.findOne({ _id: g._id }))!;
  }
  return g;
}

async function myUnfinished(userId: number): Promise<BgGameDoc | null> {
  const c = await games();
  const g = await c.findOne({ status: { $in: ["waiting", "active"] }, players: userId } as any);
  if (!g) return null;
  const f = await expire(g);
  return f.status === "finished" ? null : f;
}

export interface GameView {
  gid: string;
  status: BgGameDoc["status"];
  /** which colour I am: 0 = white (moves 24→1), 1 = black (moves 1→24) */
  me: Player;
  v: number;
  state: BgState | null;
  /** moves I may play right now (empty when it is not my turn / I must roll) */
  legal: Move[];
  canRoll: boolean;
  white: Brief | null;
  black: Brief | null;
  last: BgGameDoc["last"];
  winner: Player | null;
  endedBy: BgGameDoc["endedBy"] | null;
  /** seconds until the player on turn loses by timeout */
  idleLeft: number | null;
}

async function view(me: any, g: BgGameDoc): Promise<GameView> {
  const mine: Player = g.players[0] === me._id ? 0 : 1;
  const ids = g.players.filter((x) => x > 0);
  const docs = ids.length ? await (await usersCol()).find({ _id: { $in: ids } }).toArray() : [];
  const briefs = await toBriefs(me._id, docs);
  const by = new Map<number, Brief>(docs.map((d: any, i: number) => [d._id as number, briefs[i]!]));
  const st = g.state;
  const myTurn = g.status === "active" && !!st && st.winner === null && st.turn === mine;
  return {
    gid: g._id,
    status: g.status,
    me: mine,
    v: g.v,
    state: st,
    legal: myTurn && st?.remaining ? legalMoves(st) : [],
    canRoll: myTurn && !!st && !st.remaining,
    white: by.get(g.players[0]) ?? null,
    black: g.players[1] ? (by.get(g.players[1]) ?? null) : null,
    last: g.last,
    winner: st?.winner ?? null,
    endedBy: g.endedBy ?? null,
    idleLeft: g.status === "active" && st && st.winner === null ? Math.max(0, Math.ceil((IDLE_MS - (Date.now() - g.updatedAt.getTime())) / 1000)) : null,
  };
}

export async function lobby(me: any): Promise<{ mine: { gid: string; status: string } | null; open: Array<{ gid: string; host: Brief; at: number }> }> {
  await ensureIdx();
  const mine = await myUnfinished(me._id);
  const c = await games();
  const rows = await c.find({ status: "waiting", updatedAt: { $gt: new Date(Date.now() - WAIT_MS) }, players: { $ne: me._id } } as any).sort({ updatedAt: -1 }).limit(20).toArray();
  const docs = rows.length ? await (await usersCol()).find({ _id: { $in: rows.map((r) => r.players[0]) }, banned: { $ne: true } }).toArray() : [];
  const briefs = await toBriefs(me._id, docs);
  const by = new Map<number, Brief>(docs.map((d: any, i: number) => [d._id as number, briefs[i]!]));
  const open: Array<{ gid: string; host: Brief; at: number }> = [];
  for (const r of rows) {
    const host = by.get(r.players[0]);
    if (host && !(await isBlockedEitherWay(me._id, r.players[0]))) open.push({ gid: r._id, host, at: r.updatedAt.getTime() });
  }
  return { mine: mine ? { gid: mine._id, status: mine.status } : null, open };
}

export async function create(me: any): Promise<GameView> {
  await ensureIdx();
  const existing = await myUnfinished(me._id);
  if (existing) return view(me, existing);
  const rl = await checkRateLimit(me._id, "bg-create", 12, 3_600_000);
  if (!rl.allowed) throw new SocialError("too_fast");
  const now = new Date();
  const g: BgGameDoc = { _id: idOf(), status: "waiting", players: [me._id, 0], state: null, v: 1, last: null, createdAt: now, updatedAt: now };
  await (await games()).insertOne(g as any);
  return view(me, g);
}

export async function join(me: any, gid: unknown): Promise<GameView> {
  await ensureIdx();
  if (typeof gid !== "string" || gid.length > 16) throw new SocialError("not_found");
  if (await myUnfinished(me._id)) throw new SocialError("busy");
  const c = await games();
  const g0 = await c.findOne({ _id: gid });
  if (!g0 || g0.status !== "waiting" || g0.players[0] === me._id) throw new SocialError("not_found");
  if (await isBlockedEitherWay(me._id, g0.players[0])) throw new SocialError("not_found");
  const starter: Player = Math.random() < 0.5 ? 0 : 1;
  const updated = await c.findOneAndUpdate(
    { _id: gid, status: "waiting", v: g0.v },
    { $set: { status: "active", "players.1": me._id, state: initialState(starter), updatedAt: new Date() }, $inc: { v: 1 } },
    { returnDocument: "after" },
  );
  if (!updated) throw new SocialError("not_found"); // somebody else took the seat first
  return view(me, updated);
}

async function loadMine(me: any, gid: unknown): Promise<BgGameDoc> {
  if (typeof gid !== "string" || gid.length > 16) throw new SocialError("not_found");
  const g = await (await games()).findOne({ _id: gid, players: me._id } as any);
  if (!g) throw new SocialError("not_found");
  return expire(g);
}

export async function getState(me: any, gid: unknown, since?: unknown): Promise<GameView | { unchanged: true; v: number }> {
  const g = await loadMine(me, gid);
  if (typeof since === "number" && since === g.v && g.status !== "active") return { unchanged: true, v: g.v };
  return view(me, g);
}

async function mutate(me: any, gid: unknown, fn: (g: BgGameDoc, mine: Player) => Partial<BgGameDoc> & { state?: BgState | null }): Promise<GameView> {
  const g = await loadMine(me, gid);
  if (g.status !== "active" || !g.state) throw new SocialError("not_found");
  const mine: Player = g.players[0] === me._id ? 0 : 1;
  const patch = fn(g, mine);
  const updated = await (await games()).findOneAndUpdate({ _id: g._id, status: "active", v: g.v }, { $set: { ...patch, updatedAt: new Date() }, $inc: { v: 1 } }, { returnDocument: "after" });
  if (!updated) return view(me, (await (await games()).findOne({ _id: g._id }))!); // someone else's write won: return the fresh state
  return view(me, updated);
}

export function roll(me: any, gid: unknown): Promise<GameView> {
  return mutate(me, gid, (g, mine) => {
    const st = g.state!;
    if (st.winner !== null || st.turn !== mine || st.remaining) throw new SocialError("not_your_turn");
    const dice = rollDice();
    const r = doRoll(st, dice);
    return { state: r.state, last: { by: mine, kind: r.passed ? "pass" : "roll", dice } };
  });
}

export function move(me: any, gid: unknown, m: { from: unknown; to: unknown; die: unknown }): Promise<GameView> {
  return mutate(me, gid, (g, mine) => {
    const st = g.state!;
    if (st.winner !== null || st.turn !== mine || !st.remaining) throw new SocialError("not_your_turn");
    const from = m.from === "bar" ? "bar" : Number.isInteger(m.from) ? (m.from as number) : null;
    const to = m.to === "off" ? "off" : Number.isInteger(m.to) ? (m.to as number) : null;
    const die = Number.isInteger(m.die) ? (m.die as number) : null;
    if (from === null || to === null || die === null) throw new SocialError("bad_input");
    let next: BgState;
    try {
      next = play(st, { from, to, die });
    } catch {
      throw new SocialError("illegal_move");
    }
    const done = next.winner !== null;
    return { state: next, last: { by: mine, kind: "move", move: { from, to, die } }, ...(done ? { status: "finished" as const, endedBy: "win" as const } : {}) };
  });
}

export async function resign(me: any, gid: unknown): Promise<GameView> {
  const g = await loadMine(me, gid);
  const mine: Player = g.players[0] === me._id ? 0 : 1;
  const c = await games();
  if (g.status === "waiting") {
    await c.updateOne({ _id: g._id, status: "waiting" }, { $set: { status: "finished", endedBy: "cancel", updatedAt: new Date() }, $inc: { v: 1 } });
  } else if (g.status === "active" && g.state && g.state.winner === null) {
    await c.updateOne({ _id: g._id, status: "active" }, { $set: { status: "finished", endedBy: "resign", "state.winner": (1 - mine) as Player, last: { by: mine, kind: "resign" }, updatedAt: new Date() }, $inc: { v: 1 } });
  }
  return view(me, (await c.findOne({ _id: g._id }))!);
}
