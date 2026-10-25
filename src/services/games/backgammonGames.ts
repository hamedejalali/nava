import { randomBytes } from "node:crypto";
import { getDb } from "../../db/connect.js";
import { isBlockedEitherWay } from "../../db/models/blocks.js";
import { checkRateLimit } from "../../utils/rateLimit.js";
import { SocialError, toBriefs, usersCol, type Brief } from "../nava/common.js";
import { runInTransaction, TxAbort } from "../../db/tx.js";
import { chargeRelicInSession, creditLedgerInSession, hasUnlimitedXp } from "../../db/models/relic.js";
import { env } from "../../config/env.js";
import { botApi } from "../miniapp.js";
import { doRoll, initialState, legalMoves, play, rollDice, type BgState, type Move, type Player } from "./backgammon.js";

/**
 * Two-player backgammon in the Mini App. One document per game in `bg_games`; every write is an
 * optimistic-concurrency update on `v`, so two taps / two devices can never apply the same move twice.
 * Players are addressed by their public Nava id; Telegram ids never leave the server.
 *
 * v1.25.0: a player may sit in several games at once (never two against the SAME opponent), every turn has a
 * 2-minute clock with a Telegram warning 15 seconds before it runs out, a throw can (rarely) leave a die off the
 * board so the same player must throw again, and the end of a game is announced to the player who was not looking.
 */
export interface BgGameDoc {
  _id: string;
  status: "waiting" | "active" | "finished";
  /** [white, black] telegram ids; black is 0 while waiting */
  players: [number, number];
  state: BgState | null;
  v: number;
  /** last thing that happened (for the log line): roll, move, pass, cocked die, resign… */
  last: { by: Player; kind: "roll" | "move" | "pass" | "resign" | "timeout" | "cocked"; dice?: number[]; move?: Move } | null;
  /** the latest throw of the dice (the board animates it once per `rollN`). `cocked` = one die left the board, throw again. */
  roll?: { by: Player; dice: number[]; cocked?: boolean; off?: number } | null;
  rollN?: number;
  endedBy?: "win" | "resign" | "timeout" | "cancel";
  /** XP each player puts in the middle (0 = friendly game). The host's chips are held from the moment the table opens;
   *  the opponent matches them when sitting down; the winner takes the whole pot. */
  stake?: number;
  /** the pot / the host's held chips were paid out or given back (exactly once) */
  settled?: boolean;
  /** the "15 seconds left" Telegram warning of the CURRENT turn went out (reset by every move) */
  warned?: boolean;
  /** the end-of-game Telegram notices went out (exactly once) */
  notified?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const STAKES = [0, 1, 2, 5, 10, 20, 50, 100] as const;
export const IDLE_MS = 2 * 60_000; // a player who does not move for 2 minutes loses the game
export const WARN_LEFT_MS = 15_000; // …and is warned in Telegram when 15 seconds are left
const WARN_AT_MS = IDLE_MS - WARN_LEFT_MS;
const WAIT_MS = 15 * 60_000; // an open table nobody joined disappears
export const MAX_OPEN = 5; // unfinished games (waiting + active) one player may have at the same time
/** chance that a throw leaves one die off the board (the same player throws again). Tests may change it. */
export const COCKED = { p: 0.02 };

async function games() {
  return (await getDb()).collection<BgGameDoc>("bg_games");
}

let indexed = false;
async function ensureIdx() {
  if (indexed) return;
  const c = await games();
  await c.createIndexes([
    { key: { status: 1, updatedAt: -1 }, name: "status_updated" },
    { key: { players: 1, status: 1 }, name: "players_status" },
    { key: { createdAt: 1 }, name: "ttl", expireAfterSeconds: 3 * 86_400 },
  ]);
  indexed = true;
}

const idOf = () => randomBytes(7).toString("base64url");
const fa = (n: number) => n.toLocaleString("fa-IR");

/* ------------------------------------------------------------ Telegram notices */

function appKb(): any {
  const url = env.NAVA_MINIAPP_URL;
  return url ? { inline_keyboard: [[{ text: "🎲 باز کردن بازی", web_app: { url } }]] } : undefined;
}
/** best-effort: a blocked bot / deleted chat never breaks the game */
async function tell(userId: number, text: string): Promise<void> {
  try {
    await botApi().sendMessage(userId, text, { reply_markup: appKb() });
  } catch {
    /* ignore */
  }
}
async function nameOfUser(id: number): Promise<string> {
  try {
    const u: any = await (await usersCol()).findOne({ _id: id }, { projection: { miniUsername: 1, nickname: 1 } });
    return String(u?.miniUsername ?? u?.nickname ?? "حریف").slice(0, 32);
  } catch {
    return "حریف";
  }
}

/** The 15-seconds-left warning for the player whose turn it is — sent once per turn (atomic flag, never touches the clock). */
async function warnTurn(g: BgGameDoc): Promise<void> {
  if (!g.state) return;
  const c = await games();
  const r = await c.updateOne({ _id: g._id, status: "active", v: g.v, warned: { $ne: true } }, { $set: { warned: true } });
  if (r.modifiedCount !== 1) return;
  const turnId = g.players[g.state.turn];
  const other = g.players[(1 - g.state.turn) as Player];
  const stake = g.stake ?? 0;
  await tell(turnId, `⏳ وقتت داره تموم میشه!\nاگه تا ${fa(Math.round(WARN_LEFT_MS / 1000))} ثانیه‌ی دیگه حرکت نکنی، بازی تخته‌نرد با ${await nameOfUser(other)} رو می‌بازی.` + (stake > 0 ? `\n💸 ${fa(stake)} ژتون از دست می‌ره.` : ""));
}

/** Tells the player who did NOT cause the end of the game how it ended (exactly once per game). `actor` = who pressed the button. */
async function announceEnd(gid: string, actor?: number): Promise<void> {
  const c = await games();
  const flag = await c.updateOne({ _id: gid, status: "finished", notified: { $ne: true } }, { $set: { notified: true } });
  if (flag.modifiedCount !== 1) return;
  const g = await c.findOne({ _id: gid });
  if (!g) return;
  const stake = g.stake ?? 0;
  if (!g.state || g.state.winner === null || g.state.winner === undefined) {
    if (g.endedBy === "cancel" && actor === undefined && g.players[0]) await tell(g.players[0], "⌛ میز تخته‌نرد بسته شد چون کسی نیومد." + (stake > 0 ? `\n🪙 ${fa(stake)} ژتونت برگشت.` : ""));
    return;
  }
  const w = g.state.winner as Player;
  const winId = g.players[w];
  const loseId = g.players[(1 - w) as Player];
  const pot = stake * 2;
  const wn = await nameOfUser(winId);
  const ln = await nameOfUser(loseId);
  const out: Array<[number, string]> = [];
  if (g.endedBy === "resign") {
    out.push([winId, `🏳️ حریفت (${ln}) از بازی تخته‌نرد انصراف داد و تو بردی!` + (stake > 0 ? `\n🪙 ${fa(pot)} ژتون به تو رسید.` : "")]);
  } else if (g.endedBy === "timeout") {
    out.push([winId, `⌛ وقت حریفت (${ln}) تموم شد و تو بردی!` + (stake > 0 ? `\n🪙 ${fa(pot)} ژتون به تو رسید.` : "")]);
    out.push([loseId, `⌛ وقتت تموم شد و بازی تخته‌نرد با ${wn} رو باختی.` + (stake > 0 ? `\n💸 ${fa(stake)} ژتون از دست رفت.` : "")]);
  } else {
    out.push([loseId, `😔 ${wn} بازی تخته‌نرد رو برد.` + (stake > 0 ? `\n💸 ${fa(stake)} ژتون از دست رفت.` : "")]);
  }
  for (const [id, text] of out) if (id && id !== actor) await tell(id, text);
}

/* ------------------------------------------------------------------ lifecycle */

/** Lazy housekeeping: a stale waiting table is cancelled, a stale active game is lost by the player who stopped moving,
 *  and the player on turn gets the "15 seconds left" warning. Called by every poll of either player. */
async function expire(g: BgGameDoc): Promise<BgGameDoc> {
  const now = Date.now();
  const c = await games();
  if (g.status === "waiting" && now - g.updatedAt.getTime() > WAIT_MS) {
    const r = await c.updateOne({ _id: g._id, status: "waiting" }, { $set: { status: "finished", endedBy: "cancel", updatedAt: new Date() }, $inc: { v: 1 } });
    if (r.modifiedCount === 1) {
      await settle(g._id);
      await announceEnd(g._id);
    }
    return (await c.findOne({ _id: g._id })) ?? g;
  }
  if (g.status === "active" && g.state && g.state.winner === null) {
    const idle = now - g.updatedAt.getTime();
    if (idle > IDLE_MS) {
      const loser = g.state.turn;
      const winner = (1 - loser) as Player;
      const r = await c.updateOne({ _id: g._id, status: "active", v: g.v }, { $set: { status: "finished", endedBy: "timeout", "state.winner": winner, last: { by: loser, kind: "timeout" }, updatedAt: new Date() }, $inc: { v: 1 } });
      if (r.modifiedCount === 1) {
        await settle(g._id);
        await announceEnd(g._id);
      }
      return (await c.findOne({ _id: g._id })) ?? g;
    }
    if (idle >= WARN_AT_MS && !g.warned) {
      await warnTurn(g);
      return { ...g, warned: true };
    }
  }
  if (g.status === "finished" && (g.stake ?? 0) > 0 && !g.settled) {
    await settle(g._id);
    return (await c.findOne({ _id: g._id })) ?? g;
  }
  return g;
}

/** Pays out / returns the chips of a FINISHED game exactly once (idempotent: the `settled` flag and the ledger ids both guard it).
 *  win / timeout / resign → the winner takes the whole pot; a table nobody joined (cancel) → the host gets his chips back. */
export async function settle(gid: string): Promise<void> {
  const c = await games();
  const g = await c.findOne({ _id: gid });
  const stake = g?.stake ?? 0;
  if (!g || g.status !== "finished" || stake <= 0 || g.settled) return;
  try {
    await runInTransaction(async (session) => {
      const flag = await c.updateOne({ _id: gid, settled: { $ne: true } }, { $set: { settled: true } }, { session });
      if (flag.modifiedCount !== 1) throw new TxAbort("already");
      const winner = g.state?.winner;
      if (g.endedBy === "cancel" || winner === null || winner === undefined) {
        await creditLedgerInSession(`gstake-back:${gid}:${g.players[0]}`, g.players[0], stake, "GAME_REFUND", session, { reference: `bg:${gid}` });
        if (g.players[1]) await creditLedgerInSession(`gstake-back:${gid}:${g.players[1]}`, g.players[1], stake, "GAME_REFUND", session, { reference: `bg:${gid}` });
      } else {
        const wid = g.players[winner as Player];
        const lid = g.players[(1 - (winner as number)) as Player];
        await creditLedgerInSession(`gwin:${gid}`, wid, stake * 2, "GAME_WIN", session, { reference: `bg:${gid}`, counterpartyUserId: lid });
      }
    });
  } catch (e) {
    if (e instanceof TxAbort) return;
    console.error("[bg] settle failed:", e instanceof Error ? e.message : "unknown");
  }
}

/** every unfinished game of this player (stale ones are finished on the way), newest activity first */
async function myUnfinished(userId: number): Promise<BgGameDoc[]> {
  const c = await games();
  const rows = await c.find({ status: { $in: ["waiting", "active"] }, players: userId } as any).sort({ updatedAt: -1 }).limit(MAX_OPEN + 5).toArray();
  const out: BgGameDoc[] = [];
  for (const g of rows) {
    const f = await expire(g);
    if (f.status !== "finished") out.push(f);
  }
  return out;
}

/** Housekeeping for the daily cron: every table / game that nobody touched is finished, refunded and announced. */
export async function sweepStaleGames(limit = 100): Promise<number> {
  await ensureIdx();
  const c = await games();
  const rows = await c.find({ status: { $in: ["waiting", "active"] }, updatedAt: { $lt: new Date(Date.now() - IDLE_MS) } } as any).limit(limit).toArray();
  let n = 0;
  for (const g of rows) {
    const f = await expire(g);
    if (f.status === "finished") n++;
  }
  return n;
}

/* ------------------------------------------------------------------ views */

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
  /** the latest throw (animated once per `rollN`); `cocked` = a die left the board and the same player throws again */
  roll: BgGameDoc["roll"] | null;
  rollN: number;
  winner: Player | null;
  endedBy: BgGameDoc["endedBy"] | null;
  /** seconds until the player on turn loses by timeout */
  idleLeft: number | null;
  /** the whole clock of a turn, in seconds */
  idleMax: number;
  /** XP each side puts in the middle (the pot is twice this) */
  stake: number;
  /** my XP right now (null = unlimited) so the table can say whether I can match */
  myXp: number | null;
}

async function myXpOf(me: any): Promise<number | null> {
  if (hasUnlimitedXp(me._id)) return null;
  const u: any = await (await usersCol()).findOne({ _id: me._id }, { projection: { relicBalance: 1 } });
  return u?.relicBalance ?? 0;
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
    roll: g.roll ?? null,
    rollN: g.rollN ?? 0,
    winner: st?.winner ?? null,
    endedBy: g.endedBy ?? null,
    idleLeft: g.status === "active" && st && st.winner === null ? Math.max(0, Math.ceil((IDLE_MS - (Date.now() - g.updatedAt.getTime())) / 1000)) : null,
    idleMax: IDLE_MS / 1000,
    stake: g.stake ?? 0,
    myXp: await myXpOf(me),
  };
}

export interface GameRow {
  gid: string;
  status: "waiting" | "active";
  stake: number;
  /** the opponent (null while the table waits) */
  opp: Brief | null;
  myTurn: boolean;
  idleLeft: number | null;
  at: number;
}

async function rowsFor(me: any, docs: BgGameDoc[]): Promise<GameRow[]> {
  const oppIds = docs.map((g) => g.players.find((p) => p > 0 && p !== me._id) ?? 0).filter((x) => x > 0);
  const users = oppIds.length ? await (await usersCol()).find({ _id: { $in: oppIds } }).toArray() : [];
  const briefs = await toBriefs(me._id, users);
  const by = new Map<number, Brief>(users.map((d: any, i: number) => [d._id as number, briefs[i]!]));
  return docs.map((g) => {
    const mine: Player = g.players[0] === me._id ? 0 : 1;
    const oid = g.players.find((p) => p > 0 && p !== me._id) ?? 0;
    const myTurn = g.status === "active" && !!g.state && g.state.winner === null && g.state.turn === mine;
    return {
      gid: g._id,
      status: g.status as "waiting" | "active",
      stake: g.stake ?? 0,
      opp: oid ? (by.get(oid) ?? null) : null,
      myTurn,
      idleLeft: g.status === "active" && g.state && g.state.winner === null ? Math.max(0, Math.ceil((IDLE_MS - (Date.now() - g.updatedAt.getTime())) / 1000)) : null,
      at: g.updatedAt.getTime(),
    };
  });
}

export async function lobby(me: any): Promise<{ mine: GameRow[]; open: Array<{ gid: string; host: Brief; at: number; stake: number }>; stakes: readonly number[]; myXp: number | null; canCreate: boolean; max: number }> {
  await ensureIdx();
  const mineDocs = await myUnfinished(me._id);
  const c = await games();
  // tables of people I am already playing against are not offered (one game per opponent)
  const playing = new Set<number>();
  for (const g of mineDocs) if (g.status === "active") for (const p of g.players) if (p !== me._id) playing.add(p);
  const rows = await c.find({ status: "waiting", updatedAt: { $gt: new Date(Date.now() - WAIT_MS) }, players: { $ne: me._id } } as any).sort({ updatedAt: -1 }).limit(30).toArray();
  const hostIds = rows.map((r) => r.players[0]).filter((id) => !playing.has(id));
  const docs = hostIds.length ? await (await usersCol()).find({ _id: { $in: hostIds }, banned: { $ne: true } }).toArray() : [];
  const briefs = await toBriefs(me._id, docs);
  const by = new Map<number, Brief>(docs.map((d: any, i: number) => [d._id as number, briefs[i]!]));
  const open: Array<{ gid: string; host: Brief; at: number; stake: number }> = [];
  for (const r of rows) {
    if (playing.has(r.players[0])) continue;
    const host = by.get(r.players[0]);
    if (host && !(await isBlockedEitherWay(me._id, r.players[0]))) open.push({ gid: r._id, host, at: r.updatedAt.getTime(), stake: r.stake ?? 0 });
    if (open.length >= 20) break;
  }
  return {
    mine: await rowsFor(me, mineDocs),
    open,
    stakes: STAKES,
    myXp: await myXpOf(me),
    canCreate: mineDocs.length < MAX_OPEN && !mineDocs.some((g) => g.status === "waiting"),
    max: MAX_OPEN,
  };
}

/** The live pulse of the app (every few seconds): which of my games wait / are running and whose turn it is. */
export async function pulse(me: any): Promise<{ items: Array<{ gid: string; st: "w" | "a"; t: boolean; o: string | null; stake: number }> }> {
  await ensureIdx();
  const docs = await myUnfinished(me._id);
  if (!docs.length) return { items: [] };
  const oppIds = docs.map((g) => g.players.find((p) => p > 0 && p !== me._id) ?? 0).filter((x) => x > 0);
  const names = new Map<number, string>();
  if (oppIds.length) for (const u of await (await usersCol()).find({ _id: { $in: oppIds } }, { projection: { miniUsername: 1, nickname: 1 } }).toArray()) names.set((u as any)._id, String((u as any).miniUsername ?? (u as any).nickname ?? "").slice(0, 32));
  return {
    items: docs.map((g) => {
      const mine: Player = g.players[0] === me._id ? 0 : 1;
      const oid = g.players.find((p) => p > 0 && p !== me._id) ?? 0;
      return { gid: g._id, st: g.status === "waiting" ? ("w" as const) : ("a" as const), t: g.status === "active" && !!g.state && g.state.winner === null && g.state.turn === mine, o: oid ? (names.get(oid) ?? null) : null, stake: g.stake ?? 0 };
    }),
  };
}

export async function create(me: any, stakeRaw?: unknown): Promise<GameView> {
  await ensureIdx();
  const mine = await myUnfinished(me._id);
  const waiting = mine.find((g) => g.status === "waiting");
  if (waiting) return view(me, waiting); // one open table per player
  if (mine.length >= MAX_OPEN) throw new SocialError("game_limit");
  const rl = await checkRateLimit(me._id, "bg-create", 12, 3_600_000);
  if (!rl.allowed) throw new SocialError("too_fast");
  const stake = typeof stakeRaw === "number" && (STAKES as readonly number[]).includes(stakeRaw) ? stakeRaw : 0;
  const now = new Date();
  const g: BgGameDoc = { _id: idOf(), status: "waiting", players: [me._id, 0], state: null, v: 1, last: null, createdAt: now, updatedAt: now, stake };
  if (stake > 0) {
    // the host's chips go into the middle right away (held until somebody matches them or the table closes)
    try {
      await runInTransaction(async (session) => {
        const ok = await chargeRelicInSession(me._id, stake, `gstake:${g._id}:${me._id}`, "GAME_STAKE", `bg:${g._id}`, session);
        if (!ok) throw new TxAbort("insufficient");
        await (await games()).insertOne(g as any, { session });
      });
    } catch (e) {
      if (e instanceof TxAbort) throw new SocialError("insufficient");
      throw e;
    }
  } else await (await games()).insertOne(g as any);
  return view(me, g);
}

export async function join(me: any, gid: unknown): Promise<GameView> {
  await ensureIdx();
  if (typeof gid !== "string" || gid.length > 16) throw new SocialError("not_found");
  const c = await games();
  const g0 = await c.findOne({ _id: gid });
  if (!g0 || g0.status !== "waiting" || g0.players[0] === me._id) throw new SocialError("not_found");
  if (await isBlockedEitherWay(me._id, g0.players[0])) throw new SocialError("not_found");
  const mine = await myUnfinished(me._id);
  if (mine.length >= MAX_OPEN) throw new SocialError("game_limit");
  // never two games against the same opponent
  if (mine.some((g) => g.status === "active" && g.players.includes(g0.players[0]))) throw new SocialError("same_opponent");
  const starter: Player = Math.random() < 0.5 ? 0 : 1;
  const stake = g0.stake ?? 0;
  let updated: BgGameDoc | null = null;
  try {
    await runInTransaction(async (session) => {
      // the opponent matches the chips and sits down in one atomic step: either both happen or neither
      if (stake > 0) {
        const ok = await chargeRelicInSession(me._id, stake, `gstake:${gid}:${me._id}`, "GAME_STAKE", `bg:${gid}`, session);
        if (!ok) throw new TxAbort("insufficient");
      }
      updated = await c.findOneAndUpdate(
        { _id: gid, status: "waiting", v: g0.v },
        { $set: { status: "active", "players.1": me._id, state: initialState(starter), warned: false, updatedAt: new Date() }, $inc: { v: 1 } },
        { returnDocument: "after", session },
      );
      if (!updated) throw new TxAbort("taken");
    });
  } catch (e) {
    if (e instanceof TxAbort) throw new SocialError(e.outcome === "insufficient" ? "insufficient" : "not_found");
    throw e;
  }
  return view(me, updated!);
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
  const updated = await (await games()).findOneAndUpdate({ _id: g._id, status: "active", v: g.v }, { $set: { ...patch, warned: false, updatedAt: new Date() }, $inc: { v: 1 } }, { returnDocument: "after" });
  if (!updated) return view(me, (await (await games()).findOne({ _id: g._id }))!); // someone else's write won: return the fresh state
  if (updated.status === "finished") {
    await settle(updated._id);
    await announceEnd(updated._id, me._id);
    return view(me, (await (await games()).findOne({ _id: updated._id })) ?? updated);
  }
  return view(me, updated);
}

export function roll(me: any, gid: unknown): Promise<GameView> {
  return mutate(me, gid, (g, mine) => {
    const st = g.state!;
    if (st.winner !== null || st.turn !== mine || st.remaining) throw new SocialError("not_your_turn");
    const dice = rollDice();
    const pair = [dice[0]!, dice[1]!];
    const n = (g.rollN ?? 0) + 1;
    if (Math.random() < COCKED.p) {
      // a die jumps off the board: nothing is played, the same player throws again
      return { rollN: n, roll: { by: mine, dice: pair, cocked: true, off: Math.random() < 0.5 ? 0 : 1 }, last: { by: mine, kind: "cocked", dice: pair } };
    }
    const r = doRoll(st, dice);
    return { state: r.state, rollN: n, roll: { by: mine, dice: pair }, last: { by: mine, kind: r.passed ? "pass" : "roll", dice: pair } };
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
  await settle(g._id);
  await announceEnd(g._id, me._id);
  return view(me, (await c.findOne({ _id: g._id }))!);
}
