import { InputFile, type Api } from "grammy";
import { getDb } from "../../db/connect.js";
import { env } from "../../config/env.js";
import { checkRateLimit } from "../../utils/rateLimit.js";
import { containsTelegramContact } from "../../utils/contactFilter.js";
import { isBlockedEitherWay } from "../../db/models/blocks.js";
import { closeSessionAtomic } from "../../db/models/sessionClose.js";
import { otherParticipant, type ChatSessionDoc } from "../../db/models/chatSession.js";
import { acceptChatRequest } from "../chatRequestAccept.js";
import { declineChatRequestOnce, type ChatRequestDoc } from "../../db/models/chatRequest.js";
import { createPhotoModerationLog } from "../../db/models/photoModerationLog.js";
import { getRequestRecipientIds } from "../../features/admin/constants.js";
import { checkImage } from "../sightengine.js";
import { deliverSession } from "../../features/matching/matchDelivery.js";
import { SocialError, toBriefs, usersCol, type Brief } from "./common.js";
import { decodeImage, deleteMedia, storeMedia } from "./media.js";

/**
 * NAVAGRAM DIRECT MESSAGES. A chat that was requested from the Mini App and accepted lives INSIDE the app:
 * the session is an ordinary `chat_sessions` document (same one-chat-at-a-time rule, same 1-XP cost, same refund
 * for a chat that never got going) with `origin: "miniapp"`; its messages are in `dm_messages` and nothing is relayed
 * through the bot. The bot's rules still apply: no Telegram @username / t.me links in text, every photo is delivered at
 * once AND a copy goes to the moderation log channel with delete / ban buttons.
 */

export const DM_KEEP_MS = 14 * 86_400_000;
export const DM_MAX_TEXT = 1000;
const PAGE = 60;
const OVERLAP = 6; // late-committed lower numbers (two people typing at once) are still delivered
const LIVE_MS = 45_000; // the partner polled the thread this recently => they are looking at it, no bot push
const PUSH_EVERY_MS = 10 * 60_000;

export interface DmDoc {
  _id: string; // `${sessionId}:${seq}`
  sessionId: string;
  seq: number;
  senderId: number; // 0 = system
  kind: "text" | "photo" | "system";
  text?: string;
  mediaId?: string | null;
  cid?: string;
  deleted?: boolean;
  at: Date;
}

export interface DmMessage {
  seq: number;
  mine: boolean;
  kind: "text" | "photo" | "system";
  text?: string;
  mediaId?: string | null;
  deleted?: boolean;
  at: number;
}

async function db() {
  return getDb();
}
async function msgs() {
  return (await db()).collection<DmDoc>("dm_messages");
}
async function sessionsCol() {
  return (await db()).collection<ChatSessionDoc>("chat_sessions");
}

let indexed = false;
export async function ensureDmIndexes(): Promise<void> {
  if (indexed) return;
  const c = await msgs();
  await c.createIndexes([
    { key: { sessionId: 1, seq: 1 }, name: "session_seq" },
    { key: { sessionId: 1, senderId: 1, cid: 1 }, name: "cid_unique", unique: true, partialFilterExpression: { cid: { $type: "string" } } },
    { key: { at: 1 }, name: "ttl", expireAfterSeconds: Math.floor(DM_KEEP_MS / 1000) },
  ]);
  indexed = true;
}

const isA = (s: ChatSessionDoc, id: number) => s.userA === id;

async function mySession(me: any, sid: unknown): Promise<ChatSessionDoc | null> {
  if (typeof sid !== "string" || !sid || sid.length > 64) return null;
  return (await sessionsCol()).findOne({ _id: sid, origin: "miniapp", $or: [{ userA: me._id }, { userB: me._id }] } as any);
}

/* ------------------------------------------------------------------ lists */

export interface ThreadItem {
  sid: string;
  partner: Brief | null;
  partnerGone: boolean;
  active: boolean;
  last: { kind: DmMessage["kind"]; text?: string; mine: boolean; at: number } | null;
  readonly?: boolean;
  unread: number;
  at: number;
}

export interface DmOverview {
  /** an anonymous bot chat is running (nothing about the other person is shown here — it stays anonymous) */
  botChat: boolean;
  items: ThreadItem[];
  requests: { incoming: number; outgoing: number };
}

export async function overview(me: any): Promise<DmOverview> {
  await ensureDmIndexes();
  const since = new Date(Date.now() - DM_KEEP_MS);
  const sessions = await (await sessionsCol())
    .find({ origin: "miniapp", $and: [{ $or: [{ createdAt: { $gt: since } }, { readonly: true }] }, { $or: [{ userA: me._id }, { userB: me._id }] }] } as any)
    .sort({ createdAt: -1 })
    .limit(40)
    .toArray();
  const partnerIds = sessions.map((s) => otherParticipant(s, me._id)!).filter(Boolean);
  const users = await usersCol();
  const partners = partnerIds.length ? await users.find({ _id: { $in: partnerIds } }).toArray() : [];
  const briefs = await toBriefs(me._id, partners.filter((p: any) => !p.banned));
  const byId = new Map<number, Brief>();
  partners.filter((p: any) => !p.banned).forEach((p: any, i: number) => byId.set(p._id, briefs[i]!));
  const c = await msgs();
  const items: ThreadItem[] = [];
  for (const s of sessions) {
    const pid = otherParticipant(s, me._id)!;
    const cleared = ((isA(s, me._id) ? (s as any).clearA : (s as any).clearB) as number | undefined) ?? 0;
    if (cleared > 0 && (s.dmSeq ?? 0) <= cleared) continue; // deleted by me and nothing new since
    const [last] = await c.find({ sessionId: s._id, seq: { $gt: cleared } }).sort({ seq: -1 }).limit(1).toArray();
    if (cleared > 0 && !last) continue;
    const myRead = (isA(s, me._id) ? s.readA : s.readB) ?? 0;
    const unread = s.active ? await c.countDocuments({ sessionId: s._id, senderId: pid, seq: { $gt: myRead }, kind: { $ne: "system" } } as any) : 0;
    items.push({
      sid: s._id,
      partner: byId.get(pid) ?? null,
      partnerGone: !byId.has(pid),
      active: s.active,
      ...((s as any).readonly && s.userA !== me._id ? { readonly: true } : {}),
      last: last ? { kind: last.kind, text: last.deleted ? undefined : last.text, mine: last.senderId === me._id, at: last.at.getTime() } : null,
      unread,
      at: (last?.at ?? s.createdAt).getTime(),
    });
  }
  items.sort((a, b) => Number(b.active) - Number(a.active) || b.at - a.at);
  const reqs = await requestCounts(me._id);
  let botChat = false;
  if (me.activeChatSessionId) {
    const s = await (await sessionsCol()).findOne({ _id: me.activeChatSessionId }, { projection: { origin: 1, active: 1 } });
    botChat = !!s && s.active !== false && s.origin !== "miniapp";
  }
  return { botChat, items, requests: reqs };
}

async function requestCounts(userId: number): Promise<{ incoming: number; outgoing: number }> {
  const now = new Date();
  const r = (await db()).collection<ChatRequestDoc>("chat_requests");
  const [incoming, outgoing] = await Promise.all([
    r.countDocuments({ toId: userId, status: "pending", expiresAt: { $gt: now } }),
    r.countDocuments({ fromId: userId, status: "pending", expiresAt: { $gt: now } }),
  ]);
  return { incoming, outgoing };
}

/** One small answer for the live pulse (every few seconds): how many unread messages / waiting requests. */
export async function dmPulse(me: any): Promise<{ unread: number; requests: number; sid: string | null }> {
  const reqs = await requestCounts(me._id);
  const sid: string | null = typeof me.activeChatSessionId === "string" ? me.activeChatSessionId : null;
  let unread = 0;
  let live: string | null = null;
  if (sid) {
    const s = await (await sessionsCol()).findOne({ _id: sid });
    if (s && s.active && s.origin === "miniapp") {
      live = sid;
      const myRead = (isA(s, me._id) ? s.readA : s.readB) ?? 0;
      if ((s.dmSeq ?? 0) > myRead) unread = await (await msgs()).countDocuments({ sessionId: sid, senderId: otherParticipant(s, me._id)!, seq: { $gt: myRead }, kind: { $ne: "system" } } as any);
    }
  }
  // read-only threads from official accounts (warnings / notices) count as unread too
  const ro = await (await sessionsCol()).find({ origin: "miniapp", readonly: true, active: true, userB: me._id } as any).limit(50).toArray();
  for (const s of ro) if ((s.dmSeq ?? 0) > (s.readB ?? 0)) unread += 1;
  return { unread, requests: reqs.incoming, sid: live };
}

/* ----------------------------------------------------------------- thread */

const toMsg = (m: DmDoc, me: number): DmMessage => ({
  seq: m.seq,
  mine: m.senderId === me,
  kind: m.kind,
  ...(m.kind === "text" && !m.deleted ? { text: m.text } : {}),
  ...(m.kind === "photo" ? { mediaId: m.deleted ? null : (m.mediaId ?? null) } : {}),
  ...(m.deleted ? { deleted: true } : {}),
  at: m.at.getTime(),
});

export interface ThreadView {
  sid: string;
  active: boolean;
  partner: Brief | null;
  partnerGone: boolean;
  messages: DmMessage[];
  /** highest message number the other person has read (for ✓✓) */
  theirRead: number;
  last: number;
  endedAt: number | null;
  /** an official account's notice thread: the user can read it but never answer */
  readonly: boolean;
}

/** Opens / polls a thread. `since` = highest number the client already has (0 = first load → the latest page). */
export async function openThread(me: any, sid: unknown, since: unknown): Promise<ThreadView | null> {
  await ensureDmIndexes();
  const s = await mySession(me, sid);
  if (!s) return null;
  const c = await msgs();
  const cleared = ((isA(s, me._id) ? (s as any).clearA : (s as any).clearB) as number | undefined) ?? 0;
  const from0 = typeof since === "number" && Number.isFinite(since) && since > 0 ? Math.max(0, Math.floor(since) - OVERLAP) : 0;
  const from = from0;
  let rows: DmDoc[];
  if (from > 0) rows = await c.find({ sessionId: s._id, seq: { $gt: Math.max(from, cleared) } }).sort({ seq: 1 }).limit(200).toArray();
  else rows = (await c.find({ sessionId: s._id, seq: { $gt: cleared } }).sort({ seq: -1 }).limit(PAGE).toArray()).reverse();
  const pid = otherParticipant(s, me._id)!;
  const users = await usersCol();
  const partner: any = await users.findOne({ _id: pid });
  const gone = !partner || !!partner.banned;
  const [brief] = gone ? [null] : await toBriefs(me._id, [partner]);
  const last = s.dmSeq ?? 0;
  // read marker (✓✓ for the other side) + "I am looking at it right now" (no bot push while I am here)
  const mine = isA(s, me._id) ? "A" : "B";
  const myRead = (mine === "A" ? s.readA : s.readB) ?? 0;
  const liveField = `live${mine}`;
  const nowMs = Date.now();
  const set: Record<string, unknown> = {};
  if (last > myRead) set[`read${mine}`] = last;
  if (nowMs - (((s as any)[liveField] as number) ?? 0) > 10_000) set[liveField] = nowMs;
  if (Object.keys(set).length) await (await sessionsCol()).updateOne({ _id: s._id }, { $set: set });
  const theirRead = (mine === "A" ? s.readB : s.readA) ?? 0;
  return { sid: s._id, active: s.active, partner: brief ?? null, partnerGone: gone, messages: rows.map((r) => toMsg(r, me._id)), theirRead, last, endedAt: s.endedAt ? s.endedAt.getTime() : null, readonly: !!(s as any).readonly && s.userA !== me._id };
}

async function nextSeq(sid: string): Promise<number> {
  const upd = await (await sessionsCol()).findOneAndUpdate({ _id: sid }, { $inc: { dmSeq: 1 } }, { returnDocument: "after" });
  if (!upd) throw new SocialError("not_found");
  return upd.dmSeq ?? 1;
}

async function insertMsg(s: ChatSessionDoc, sender: number, kind: DmDoc["kind"], extra: Partial<DmDoc> = {}): Promise<DmDoc> {
  const seq = await nextSeq(s._id);
  const doc: DmDoc = { _id: `${s._id}:${seq}`, sessionId: s._id, seq, senderId: sender, kind, at: new Date(), ...extra };
  await (await msgs()).insertOne(doc as any);
  return doc;
}

function cleanCid(x: unknown): string | undefined {
  return typeof x === "string" && /^[A-Za-z0-9_-]{6,40}$/.test(x) ? x : undefined;
}

async function usable(me: any, sid: unknown): Promise<{ s: ChatSessionDoc; pid: number }> {
  const s = await mySession(me, sid);
  if (!s) throw new SocialError("not_found");
  if (!s.active) throw new SocialError("chat_ended");
  if ((s as any).readonly) throw new SocialError("read_only");
  const pid = otherParticipant(s, me._id)!;
  if (await isBlockedEitherWay(me._id, pid)) throw new SocialError("chat_ended");
  return { s, pid };
}

export async function sendText(me: any, sid: unknown, raw: unknown, cidRaw: unknown, api: Pick<Api, "sendMessage">): Promise<DmMessage> {
  await ensureDmIndexes();
  if (typeof raw !== "string") throw new SocialError("bad_text");
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new SocialError("bad_text");
  if ([...text].length > DM_MAX_TEXT) throw new SocialError("text_too_long");
  const own = await mySession(me, sid);
  if (own && (own as any).readonly && own.userA === me._id) {
    // an official account writing in its own notice thread: no filters, no XP, no request
    await sendOfficialMessage(api as any, me._id, own.userB, text);
    const last = await (await msgs()).find({ sessionId: own._id }).sort({ seq: -1 }).limit(1).toArray();
    return toMsg(last[0]!, me._id);
  }
  const { s, pid } = await usable(me, sid);
  if (containsTelegramContact(text)) throw new SocialError("contact_forbidden");
  const rl = await checkRateLimit(me._id, "dm-text", 40, 60_000);
  if (!rl.allowed) throw new SocialError("too_fast");
  const cid = cleanCid(cidRaw);
  if (cid) {
    const dup = await (await msgs()).findOne({ sessionId: s._id, senderId: me._id, cid });
    if (dup) return toMsg(dup, me._id);
  }
  let doc: DmDoc;
  try {
    doc = await insertMsg(s, me._id, "text", { text, ...(cid ? { cid } : {}) });
  } catch (err: any) {
    if (err?.code === 11000 && cid) return toMsg((await (await msgs()).findOne({ sessionId: s._id, senderId: me._id, cid }))!, me._id);
    throw err;
  }
  await (await sessionsCol()).updateOne({ _id: s._id }, { $inc: { messageCount: 1 } });
  await pushIfAway(api, s, pid, me);
  return toMsg(doc, me._id);
}

export interface PhotoResult {
  message: DmMessage;
  /** the moderation-log copy: run it after the answer was sent (`waitUntil`) — it never blocks delivery */
  after: Promise<void>;
}

export async function sendPhoto(me: any, sid: unknown, image: unknown, api: Pick<Api, "sendMessage" | "sendPhoto" | "getFile" | "editMessageCaption">, cidRaw?: unknown): Promise<PhotoResult> {
  await ensureDmIndexes();
  const buf = decodeImage(image);
  const { s, pid } = await usable(me, sid);
  const rl = await checkRateLimit(me._id, "dm-photo", 20, 3_600_000);
  if (!rl.allowed) throw new SocialError("too_fast");
  const cid = cleanCid(cidRaw);
  if (cid) {
    const dup = await (await msgs()).findOne({ sessionId: s._id, senderId: me._id, cid });
    if (dup) return { message: toMsg(dup, me._id), after: Promise.resolve() };
  }
  const mediaId = await storeMedia(me._id, "dm", buf);
  const doc = await insertMsg(s, me._id, "photo", { mediaId, ...(cid ? { cid } : {}) });
  await (await sessionsCol()).updateOne({ _id: s._id }, { $inc: { messageCount: 1 } });
  await pushIfAway(api, s, pid, me, true);
  const after = logPhoto(api, me._id, pid, s._id, doc, buf).catch((e) => console.error("[dm] photo log failed:", e instanceof Error ? e.name : "unknown"));
  return { message: toMsg(doc, me._id), after };
}

/** Same rule as a photo in the bot chat: delivered at once; a copy goes to the moderation log with 🗑 / 🚫 buttons. */
async function logPhoto(api: Pick<Api, "sendPhoto" | "getFile" | "editMessageCaption">, senderId: number, receiverId: number, sessionId: string, doc: DmDoc, buf: Buffer): Promise<void> {
  const chatIds = env.MODERATION_LOG_CHAT_ID ? [env.MODERATION_LOG_CHAT_ID] : await getRequestRecipientIds();
  const log = await createPhotoModerationLog({ senderTelegramId: senderId, receiverTelegramId: receiverId, senderMessageId: 0, receiverMessageId: 0, chatSessionId: sessionId, fileId: "", dmMessageId: doc._id });
  const head = `📸 عکس ارسالی در چت نوا گرام (تحویل داده شد)\n\nفرستنده (آیدی تلگرام): ${senderId}\nگیرنده (آیدی تلگرام): ${receiverId}\nشناسه‌ی چت: ${sessionId}`;
  const kb = { inline_keyboard: [[{ text: "🗑 حذف", callback_data: `photomod:delete:${log._id}` }, { text: "🚫 بن فرستنده", callback_data: `photomod:ban:${log._id}` }]] };
  const sent: Array<{ chat: number; msg: number }> = [];
  let fileId = "";
  for (const chat of chatIds) {
    try {
      const m = await api.sendPhoto(chat, fileId || new InputFile(buf, "dm.jpg"), { caption: head + "\nسیستم نظارت نوا: در حال بررسی…", reply_markup: kb as any });
      if (!fileId) fileId = m.photo[m.photo.length - 1]!.file_id;
      sent.push({ chat, msg: m.message_id });
    } catch {
      /* one log chat failing must not stop the others */
    }
  }
  let flag = "سیستم نظارت نوا: بررسی ناموفق (سرویس در دسترس نبود)";
  let ai: { flagged?: boolean; score?: number; classification?: string } = {};
  if (fileId) {
    try {
      const f = await api.getFile(fileId);
      const check = await checkImage(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.file_path}`);
      ai = { flagged: check.flagged, score: check.score, classification: check.classification };
      flag = check.serviceUnavailable ? flag : check.flagged ? `سیستم نظارت نوا: مشکوک (امتیاز ${check.score?.toFixed(2) ?? "?"} / ${check.classification ?? "?"})` : `سیستم نظارت نوا: بدون مورد مشکوک (امتیاز ${check.score?.toFixed(2) ?? "?"})`;
    } catch {
      /* no AI verdict — honest caption stays */
    }
  }
  await (await db()).collection<any>("photo_moderation_log").updateOne({ _id: log._id }, { $set: { fileId, ...(ai.flagged !== undefined ? { aiFlagged: ai.flagged, aiScore: ai.score, aiClassification: ai.classification } : {}) } });
  for (const x of sent) await api.editMessageCaption(x.chat, x.msg, { caption: `${head}\n${flag}`, reply_markup: kb as any }).catch(() => {});
}

/** Moderation: remove a delivered photo (admin pressed 🗑 on the log message). */
export async function removeDmMessage(messageId: string): Promise<{ senderId: number; mediaId: string | null } | null> {
  const c = await msgs();
  const m = await c.findOneAndUpdate({ _id: messageId, deleted: { $ne: true } }, { $set: { deleted: true, mediaId: null }, $unset: { text: "" } }, { returnDocument: "before" });
  if (!m) return null;
  await deleteMedia([m.mediaId]);
  return { senderId: m.senderId, mediaId: m.mediaId ?? null };
}

/* ------------------------------------------------------------ bot push */

function appKeyboard(): any {
  const url = env.NAVA_MINIAPP_URL;
  return url ? { inline_keyboard: [[{ text: "💬 باز کردن نوا گرام", web_app: { url } }]] } : undefined;
}

async function pushIfAway(api: Pick<Api, "sendMessage">, s: ChatSessionDoc, partnerId: number, me: any, photo = false): Promise<void> {
  try {
    const fresh = await (await sessionsCol()).findOne({ _id: s._id });
    if (!fresh) return;
    const partnerSide = isA(fresh, partnerId) ? "A" : "B";
    const live = ((fresh as any)[`live${partnerSide}`] as number) ?? 0;
    if (Date.now() - live < LIVE_MS) return;
    const pushed = ((fresh as any)[`push${partnerSide}`] as number) ?? 0;
    if (Date.now() - pushed < PUSH_EVERY_MS) return;
    // claim the push slot atomically so two quick messages send one notification
    const claim = await (await sessionsCol()).updateOne({ _id: s._id, [`push${partnerSide}`]: { $in: [null, pushed] } } as any, { $set: { [`push${partnerSide}`]: Date.now() } });
    if (claim.modifiedCount !== 1) return;
    const name = me.nickname ? String(me.nickname).slice(0, 32) : "یک نفر";
    await api.sendMessage(partnerId, `💬 ${name} ${photo ? "یه عکس" : "یه پیام"} برات فرستاد.\nبرای جواب دادن نوا گرام رو باز کن.`, { reply_markup: appKeyboard() }).catch(() => {});
  } catch {
    /* best effort */
  }
}

/** «حذف گفتگو» — only for ME: the thread (and everything in it so far) disappears from my list; a new message makes it come back, empty of the old ones.
 *  A running chat has to be ended first. */
export async function deleteThreadForMe(me: any, sid: unknown): Promise<boolean> {
  const s = await mySession(me, sid);
  if (!s) throw new SocialError("not_found");
  if (s.active && !(s as any).readonly) throw new SocialError("chat_running");
  const mark = isA(s, me._id) ? "clearA" : "clearB";
  await (await sessionsCol()).updateOne({ _id: s._id }, { $set: { [mark]: s.dmSeq ?? 0, [isA(s, me._id) ? "readA" : "readB"]: s.dmSeq ?? 0 } });
  return true;
}

/* ------------------------------------------------------------ official notices */

/** A message FROM an official ("حقوقی") account — Nava itself or a legal account — to one user. It appears in the user's Directs as an
 *  ordinary thread (tick, profile, everything) but is read-only: the user cannot answer. Never touches `activeChatSessionId`,
 *  never costs XP and never blocks another chat. */
export async function sendOfficialMessage(api: Pick<Api, "sendMessage">, officialId: number, toId: number, rawText: string): Promise<void> {
  await ensureDmIndexes();
  const text = String(rawText ?? "").replace(/\r\n?/g, "\n").trim().slice(0, DM_MAX_TEXT * 2);
  if (!text) throw new SocialError("bad_text");
  const col = await sessionsCol();
  let s = await col.findOne({ origin: "miniapp", readonly: true, userA: officialId, userB: toId } as any);
  if (!s) {
    const id = `of${officialId.toString(36)}_${toId.toString(36)}`.slice(0, 60);
    await col.updateOne({ _id: id } as any, { $setOnInsert: { _id: id, userA: officialId, userB: toId, active: true, createdAt: new Date(), origin: "miniapp", readonly: true, dmSeq: 0, readA: 0, readB: 0, messageCount: 0 } }, { upsert: true });
    s = await col.findOne({ _id: id } as any);
  }
  if (!s) throw new SocialError("not_found");
  await insertMsg(s, officialId, "text", { text });
  await col.updateOne({ _id: s._id }, { $set: { readA: s.dmSeq ?? 0 } });
  const o: any = await (await usersCol()).findOne({ _id: officialId });
  // notices are important: the text itself also goes to the user's bot chat (with a button into the thread)
  await api.sendMessage(toId, `📩 ${String(o?.nickname ?? "Nava").slice(0, 32)}:\n\n${text}`, { reply_markup: appKeyboard() }).catch(() => {});
}

/* ------------------------------------------------------------ lifecycle */

/** Both people are told that the chat is open inside Navagram (+ a system line in the thread). */
export async function announceDmStarted(api: Pick<Api, "sendMessage">, sid: string, a: number, b: number): Promise<void> {
  await ensureDmIndexes();
  const s = await (await sessionsCol()).findOne({ _id: sid });
  if (s) await insertMsg(s, 0, "system", { text: "چت شروع شد 🎉 با رعایت ادب گپ بزنید. ارسال آیدی/لینک تلگرام ممنوعه." }).catch(() => {});
  for (const id of [a, b]) await api.sendMessage(id, "✅ درخواست چت قبول شد؛ چتتون الان داخل نوا گرام (بخش «پیام‌ها») فعاله.", { reply_markup: appKeyboard() }).catch(() => {});
}

export async function endThread(me: any, sid: unknown, api: Pick<Api, "sendMessage">): Promise<{ refundedOther: boolean }> {
  const s = await mySession(me, sid);
  if (!s) throw new SocialError("not_found");
  const other = otherParticipant(s, me._id)!;
  const r = await closeSessionAtomic(s._id, me._id, (sess) => ((sess.messageCount ?? 0) < 4 ? [other] : []));
  if (r.status !== "ended") return { refundedOther: false };
  await insertMsg(s, 0, "system", { text: "این چت پایان یافت." }).catch(() => {});
  await api.sendMessage(other, `🚫 چتت در نوا گرام پایان یافت — ${me.nickname ? String(me.nickname).slice(0, 32) : "مخاطبت"} چت رو بست.` + (r.refunded.includes(other) ? "\n💰 چون چت خیلی کوتاه بود، XP‌ت برگشت داده شد." : "")).catch(() => {});
  return { refundedOther: r.refunded.includes(other) };
}

/* ------------------------------------------------------------- requests */

export interface RequestItem {
  id: string;
  who: Brief;
  at: number;
  expiresAt: number;
}

export async function listRequests(me: any): Promise<{ incoming: RequestItem[]; outgoing: RequestItem[] }> {
  const now = new Date();
  const r = (await db()).collection<ChatRequestDoc>("chat_requests");
  const [inc, out] = await Promise.all([
    r.find({ toId: me._id, status: "pending", expiresAt: { $gt: now } }).sort({ createdAt: -1 }).limit(30).toArray(),
    r.find({ fromId: me._id, status: "pending", expiresAt: { $gt: now } }).sort({ createdAt: -1 }).limit(30).toArray(),
  ]);
  const users = await usersCol();
  const ids = [...new Set([...inc.map((x) => x.fromId), ...out.map((x) => x.toId)])];
  const docs = ids.length ? await users.find({ _id: { $in: ids }, banned: { $ne: true } }).toArray() : [];
  const briefs = await toBriefs(me._id, docs);
  const by = new Map<number, Brief>(docs.map((d: any, i: number) => [d._id as number, briefs[i]!]));
  const map = (x: ChatRequestDoc, other: number): RequestItem | null => {
    const who = by.get(other);
    return who ? { id: x._id, who, at: x.createdAt.getTime(), expiresAt: x.expiresAt.getTime() } : null;
  };
  return { incoming: inc.map((x) => map(x, x.fromId)).filter((x): x is RequestItem => !!x), outgoing: out.map((x) => map(x, x.toId)).filter((x): x is RequestItem => !!x) };
}

export type RespondResult = { status: "accepted"; sid: string; origin: "bot" | "miniapp" } | { status: "declined" } | { status: "not_pending" | "busy" | "blocked" | "insufficient_me" | "insufficient_other" };

export async function respondRequest(me: any, token: unknown, accept: boolean, api: Api): Promise<RespondResult> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{6,24}$/.test(token)) throw new SocialError("bad_input");
  if (!accept) {
    const d = await declineChatRequestOnce(token, me._id);
    if (!d) return { status: "not_pending" };
    await api.sendMessage(d.fromId, "😔 درخواست چتت پذیرفته نشد. می‌تونی برای بقیه درخواست بدی.").catch(() => {});
    return { status: "declined" };
  }
  await ensureDmIndexes();
  const r = await acceptChatRequest(token, me._id);
  if (r.status === "accepted") {
    if (r.origin === "miniapp") await announceDmStarted(api, r.sessionId, r.fromId, r.toId);
    else await deliverSession(api as any, r.sessionId, [r.toId, r.fromId]);
    return { status: "accepted", sid: r.sessionId, origin: r.origin };
  }
  if (r.status === "insufficient") return { status: r.userId === me._id ? "insufficient_me" : "insufficient_other" };
  return { status: r.status };
}

export async function cancelRequest(me: any, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{6,24}$/.test(token)) throw new SocialError("bad_input");
  const r = (await db()).collection<ChatRequestDoc>("chat_requests");
  const u = await r.updateOne({ _id: token, fromId: me._id, status: "pending" }, { $set: { status: "expired", respondedAt: new Date() } });
  return u.modifiedCount === 1;
}

/** Daily clean-up: photos of long-finished direct chats (their messages already expired by TTL). */
export async function purgeOldDmMedia(): Promise<number> {
  const d = await db();
  const old = await d.collection<any>("mini_media").find({ kind: "dm", createdAt: { $lt: new Date(Date.now() - DM_KEEP_MS) } }, { projection: { _id: 1 } }).limit(500).toArray();
  await deleteMedia(old.map((o: any) => String(o._id)));
  return old.length;
}
