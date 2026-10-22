import { InputFile, type Api } from "grammy";
import { getDb } from "../../db/connect.js";
import { blockUser, unblockUser, getBlockedCounterparts } from "../../db/models/blocks.js";
import { createReport } from "../../db/models/reports.js";
import { closeSessionAtomic } from "../../db/models/sessionClose.js";
import { getSession, otherParticipant } from "../../db/models/chatSession.js";
import { getRequestRecipientIds } from "../../features/admin/constants.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { escapeHtml } from "../../utils/html.js";
import { checkRateLimit } from "../../utils/rateLimit.js";
import { C, SocialError, col, isAnonId, isOfficial, toBriefs, usersCol, type Brief } from "./common.js";
import { decodeImage, loadMedia } from "./media.js";

/**
 * Block / report from INSIDE the Mini App — the very same records the bot uses (`blocks`, `reports`), so a block made
 * here hides the person in the bot and vice-versa, and a report lands in the admins' chat exactly like a bot report
 * (same buttons, same decision flow) — now with evidence: the reason, an optional photo and, when the two were chatting
 * in Navagram, the last messages of that chat.
 */

async function target(anonId: unknown): Promise<any> {
  if (!isAnonId(anonId)) throw new SocialError("not_found");
  const t = await (await usersCol()).findOne({ anonId });
  if (!t) throw new SocialError("not_found");
  return t;
}

export async function blockInApp(me: any, anonId: unknown, api: Pick<Api, "sendMessage">): Promise<void> {
  const t = await target(anonId);
  if (t._id === me._id) throw new SocialError("self");
  if (isOfficial(t)) throw new SocialError("forbidden"); // the official account cannot be blocked
  await blockUser(me._id, t._id);
  const d = await getDb();
  // like Instagram: a block removes the follow in both directions and any waiting request
  await d.collection<any>(C.follows).deleteMany({ $or: [{ followerId: me._id, followeeId: t._id }, { followerId: t._id, followeeId: me._id }] });
  await d.collection<any>(C.followRequests).deleteMany({ $or: [{ fromId: me._id, toId: t._id }, { fromId: t._id, toId: me._id }] });
  await d.collection<any>("chat_requests").updateMany({ status: "pending", $or: [{ fromId: me._id, toId: t._id }, { fromId: t._id, toId: me._id }] }, { $set: { status: "declined", respondedAt: new Date() } });
  // chatting with exactly this person (bot chat OR in-app chat): the chat ends, like the bot's block button
  const sid = me.activeChatSessionId;
  if (sid) {
    const s = await getSession(sid);
    if (s && s.active && otherParticipant(s, me._id) === t._id) {
      const r = await closeSessionAtomic(sid, me._id, (x) => ((x.messageCount ?? 0) < 4 ? [t._id] : []));
      if (r.status === "ended") await api.sendMessage(t._id, "🚫 چت پایان یافت — مخاطب شما، شما را مسدود کرد.").catch(() => {});
    }
  }
}

export async function unblockInApp(me: any, anonId: unknown): Promise<void> {
  const t = await target(anonId);
  await unblockUser(me._id, t._id);
}

export async function listBlocked(me: any): Promise<Brief[]> {
  const rows = await (await getDb()).collection<any>("blocks").find({ blockerId: me._id }).sort({ createdAt: -1 }).limit(200).toArray();
  if (!rows.length) return [];
  const docs = await (await usersCol()).find({ _id: { $in: rows.map((r: any) => r.blockedId) } }).toArray();
  return toBriefs(me._id, docs);
}

export const REPORT_REASONS: Record<string, string> = {
  spam: "اسپم یا تبلیغ",
  fake: "حساب جعلی / جعل هویت",
  nudity: "محتوای نامناسب یا برهنگی",
  abuse: "توهین، تهدید یا آزار",
  scam: "کلاهبرداری",
  other: "دلیل دیگر",
};

export async function reportInApp(me: any, anonId: unknown, input: { reason?: unknown; text?: unknown; image?: unknown }, api: Pick<Api, "sendMessage" | "sendPhoto">): Promise<void> {
  const t = await target(anonId);
  if (t._id === me._id) throw new SocialError("self");
  if (isOfficial(t)) throw new SocialError("forbidden");
  const key = typeof input.reason === "string" && REPORT_REASONS[input.reason] ? input.reason : "other";
  const text = typeof input.text === "string" ? input.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 500) : "";
  if (key === "other" && text.length < 3) throw new SocialError("bad_text");
  const rl = await checkRateLimit(me._id, "inapp-report", 6, 24 * 3_600_000);
  if (!rl.allowed) throw new SocialError("too_many");
  // the same person is not reported again and again within the hour
  const reports = (await getDb()).collection<any>("reports");
  if (await reports.findOne({ reporterId: me._id, reportedId: t._id, createdAt: { $gt: new Date(Date.now() - 3_600_000) } })) throw new SocialError("too_fast");

  const buf = input.image ? decodeImage(input.image) : null;
  const reason = `${REPORT_REASONS[key]}${text ? " — " + text : ""}`;
  const sid = me.activeChatSessionId && (await getSession(me.activeChatSessionId))?.userA !== undefined ? me.activeChatSessionId : undefined;
  const report = await createReport(me._id, t._id, sid, reason);

  // evidence from a Navagram direct-message chat between the two of them (last 12 text lines, newest last)
  let chatLines = "";
  const dmSession = await (await getDb()).collection<any>("chat_sessions").findOne({ origin: "miniapp", $or: [{ userA: me._id, userB: t._id }, { userA: t._id, userB: me._id }] }, { sort: { createdAt: -1 } } as any);
  let evidencePhoto: Buffer | null = buf;
  if (dmSession) {
    const rows = await (await getDb()).collection<any>("dm_messages").find({ sessionId: dmSession._id, kind: { $in: ["text", "photo"] }, deleted: { $ne: true } }).sort({ seq: -1 }).limit(12).toArray();
    chatLines = rows.reverse().map((r: any) => `${r.senderId === me._id ? "گزارش‌دهنده" : "گزارش‌شده"}: ${r.kind === "photo" ? "[عکس]" : escapeHtml(String(r.text ?? "").slice(0, 160))}`).join("\n");
    if (!evidencePhoto) {
      const lastPhoto = rows.find((r: any) => r.kind === "photo" && r.senderId === t._id && r.mediaId);
      if (lastPhoto) evidencePhoto = (await loadMedia(lastPhoto.mediaId))?.buffer ?? null;
    }
  }
  const [mu] = [me.miniUsername ? `@${me.miniUsername}` : "-"];
  const caption =
    `⚠️ گزارش جدید (از مینی‌اپ نوا گرام)\n\n` +
    `گزارش‌دهنده:\n• آیدی نوا: <code>${me.anonId}</code>\n• آیدی عددی: <code>${me._id}</code>\n• یوزرنیم نوا گرام: ${mu}\n\n` +
    `گزارش‌شده:\n• آیدی نوا: <code>${t.anonId}</code>\n• آیدی عددی: <code>${t._id}</code>\n• یوزرنیم نوا گرام: ${t.miniUsername ? "@" + t.miniUsername : "-"}\n\n` +
    `دلیل: ${escapeHtml(reason)}\n` +
    (chatLines ? `\nمستندات (آخرین پیام‌های چت):\n<blockquote>${chatLines}</blockquote>\n` : "") +
    `شناسه گزارش: <code>${report._id}</code>`;
  const kb = inlineKeyboard([[glassButton("✅ تایید (۵ XP پاداش)", `admin:report:approve:${report._id}`, "success"), glassButton("❌ رد", `admin:report:reject:${report._id}`, "danger")]]);
  for (const adminId of await getRequestRecipientIds()) {
    if (evidencePhoto) {
      const sent = await api.sendPhoto(adminId, new InputFile(evidencePhoto, "evidence.jpg"), { caption: caption.slice(0, 1020), parse_mode: "HTML", reply_markup: kb }).catch(() => null);
      if (sent && !report.photoFileId) await (await getDb()).collection<any>("reports").updateOne({ _id: report._id }, { $set: { photoFileId: sent.photo[sent.photo.length - 1]!.file_id } }).catch(() => {});
      if (sent) continue;
    }
    await api.sendMessage(adminId, caption, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  }
}

export { getBlockedCounterparts, col };
