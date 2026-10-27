import { InputFile } from "grammy";
import { escapeHtml } from "../../utils/html.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import {  } from "../../features/admin/constants.js";
import { getRecipients } from "../channelRouting.js";
import { botApi } from "../miniapp.js";
import { C, SocialError, col, findVisibleUser, parsePid } from "./common.js";
import { loadMedia } from "./media.js";
import type { PostDoc } from "./posts.js";

export const REPORT_REASONS = ["nudity", "spam", "abuse", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
const REASON_FA: Record<ReportReason, string> = { nudity: "محتوای مستهجن", spam: "اسپم / تبلیغ", abuse: "توهین / آزار", other: "سایر" };

/** callback data of the buttons the owner gets: pr:d:<postId> delete, pr:i:<postId> ignore, pr:b:<postId> delete + ban the author */
export const PR = { del: "pr:d:", ignore: "pr:i:", ban: "pr:b:" };

export const POST_REPORTS = "post_reports";
/** the owner is told at the first report of a post and again when this many different people reported it */
const REPEAT_NOTIFY_AT = [3, 10];

export async function ensurePostReportIndexes(db: { collection: (n: string) => any }): Promise<void> {
  await db.collection(POST_REPORTS).createIndexes([{ key: { postId: 1, createdAt: -1 }, name: "post_created" }]);
}

/**
 * A user reports somebody's post. One report per person per post (a second tap is a harmless "duplicate"); you cannot
 * report your own post; only a post the reporter can actually see. The owner is notified (best effort) with the picture
 * and buttons to delete / ignore / ban the author.
 */
export async function reportPost(viewer: any, pidRaw: unknown, reasonRaw: unknown): Promise<{ status: "reported" | "duplicate" }> {
  const pid = parsePid(pidRaw);
  if (!pid || pid.kind !== "post") throw new SocialError("bad_input");
  const reason: ReportReason = (REPORT_REASONS as readonly string[]).includes(reasonRaw as string) ? (reasonRaw as ReportReason) : "other";
  const post = (await (await col<PostDoc>(C.posts)).findOne({ _id: pid.id } as any)) as PostDoc | null;
  if (!post) throw new SocialError("not_found");
  if (post.ownerId === viewer._id) throw new SocialError("self");
  const owner = await (await import("./common.js")).usersCol().then((u) => u.findOne({ _id: post.ownerId }, { projection: { anonId: 1 } }));
  if (!owner || !(await findVisibleUser(viewer._id, owner.anonId))) throw new SocialError("not_found");

  const reports = await col<any>(POST_REPORTS);
  try {
    await reports.insertOne({ _id: `${post._id}:${viewer._id}`, postId: post._id, ownerId: post.ownerId, reporterId: viewer._id, reason, createdAt: new Date() });
  } catch (err: any) {
    if (err?.code === 11000) return { status: "duplicate" };
    throw err;
  }
  const count = await reports.countDocuments({ postId: post._id });
  if (count === 1 || REPEAT_NOTIFY_AT.includes(count)) void notifyStaff(post, reason, count).catch(() => {});
  return { status: "reported" };
}

async function notifyStaff(post: PostDoc, reason: ReportReason, count: number): Promise<void> {
  const text =
    `🚩 <b>گزارش پست مویاگرام</b>\n\n` +
    `دلیل: ${REASON_FA[reason]}\nتعداد گزارش‌دهنده‌ها: ${count}\nصاحب پست: <code>${post.ownerId}</code>\n` +
    (post.caption ? `کپشن: <blockquote>${escapeHtml(post.caption.slice(0, 300))}</blockquote>` : "");
  const reply_markup = inlineKeyboard([
    [glassButton("🗑 حذف پست", `${PR.del}${post._id}`, "danger"), glassButton("🚫 حذف + بن", `${PR.ban}${post._id}`, "danger")],
    [glassButton("✅ مشکلی نیست", `${PR.ignore}${post._id}`, "success")],
  ]);
  const media = await loadMedia(post.mediaId).catch(() => null);
  for (const id of await getRecipients("postReport")) {
    try {
      if (media) await botApi().sendPhoto(id, new InputFile(media.buffer), { caption: text, parse_mode: "HTML", reply_markup });
      else await botApi().sendMessage(id, text, { parse_mode: "HTML", reply_markup });
    } catch {
      /* owner may not have started the bot */
    }
  }
}

export async function clearReports(postId: string): Promise<void> {
  await (await col<any>(POST_REPORTS)).deleteMany({ postId });
}
