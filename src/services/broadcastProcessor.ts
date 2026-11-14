import { randomUUID } from "node:crypto";
import type { Api } from "grammy";
import { getDb } from "../db/connect.js";
import { addBroadcastFailReason, advanceBroadcast, claimBroadcastLease, claimBroadcastLog, getPendingBroadcastJobs, releaseBroadcastLease, unclaimBroadcastLog, type BroadcastJobDoc } from "../db/models/broadcast.js";
import { emojiSyntaxToHtml, emojiSyntaxToPlain } from "./emojiSyntax.js";
import { getLogChatId } from "./channelRouting.js";
import { env } from "../config/env.js";
import { escapeHtml } from "../utils/html.js";

const BATCH_SIZE = 40;
const LEASE_MS = 90_000; // longer than any single user send; renewed with every checkpoint
/** pacing between sends (Telegram allows ≈30 messages/second to different chats). Tests set it to 0. */
export const BROADCAST_PACE = { ms: 40 };

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

type SendKind = "ok" | "gone" | "retry";
/** 403 (blocked) / 400 (chat not found, deactivated) = this user will never get it → count as failed and move on.
 *  429 / 5xx / network = transient → STOP, do not advance past this user (the next run retries him). */
function classify(err: unknown): SendKind {
  const code = (err as { error_code?: number })?.error_code;
  if (code === 403 || code === 400) return "gone";
  return "retry";
}

/** short machine reason for the final log (never the raw error) */
export function failReason(err: unknown): string {
  const d = String((err as { description?: string })?.description ?? "").toLowerCase();
  if (d.includes("blocked")) return "blocked";
  if (d.includes("deactivated")) return "deactivated";
  if (d.includes("chat not found")) return "chat_not_found";
  if (d.includes("can't be sent") || d.includes("forbidden")) return "forbidden";
  return "other";
}
const REASON_FA: Record<string, string> = { blocked: "ربات رو بلاک کرده", deactivated: "اکانت حذف/غیرفعال شده", chat_not_found: "چت پیدا نشد", forbidden: "تلگرام اجازه‌ی ارسال نداد", other: "دلیل دیگر" };

/** ONE complete report in the log channel when a broadcast is finished: delivered, failed (+why) and the message text. */
export async function sendBroadcastLog(api: Api, jobId: string): Promise<void> {
  const job = await claimBroadcastLog(jobId);
  if (!job) return;
  const reasons = Object.entries(job.failReasons ?? {}).map(([k, n]) => `• ${REASON_FA[k] ?? k}: ${n}`).join("\n");
  const body = emojiSyntaxToPlain(job.message);
  const text =
    `📢 <b>گزارش پیام همگانی</b>\n\n` +
    `✅ ارسال موفق: ${job.sentCount}\n❌ ناموفق: ${job.failCount}\n` +
    (reasons ? `${reasons}\n` : "") +
    `\n<b>متن پیام:</b>\n${escapeHtml(body.length > 2500 ? body.slice(0, 2500) + "…" : body)}`;
  const chat = (await getLogChatId("adminLog").catch(() => undefined)) ?? env.OWNER_ID;
  if (chat === undefined) return void (await unclaimBroadcastLog(jobId));
  try {
    await api.sendMessage(chat, text, { parse_mode: "HTML" });
  } catch {
    await unclaimBroadcastLog(jobId).catch(() => {});
  }
}

/** Sends the broadcast to users after the job's cursor for up to `budgetMs`, in lease-protected batches.
 *  Two workers can never send the same batch: the lease is claimed atomically and every checkpoint is a compare-and-set
 *  on (owner, cursor). The cursor is saved after EVERY user, so a crash can repeat at most the one message in flight.
 *  Safe to call repeatedly from the admin action AND the cron job — a done / leased job is a no-op. */
export async function processBroadcastBatch(api: Api, job: BroadcastJobDoc, opts: { budgetMs?: number } = {}): Promise<void> {
  await processBroadcastBatchInner(api, job, opts);
  await sendBroadcastLog(api, job._id).catch(() => {});
}

async function processBroadcastBatchInner(api: Api, job: BroadcastJobDoc, opts: { budgetMs?: number } = {}): Promise<void> {
  const owner = randomUUID();
  const claimed = await claimBroadcastLease(job._id, owner, LEASE_MS);
  if (!claimed) return;
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  let cursor = claimed.cursorId;
  try {
    const db = await getDb();
    for (;;) {
      const users = await db
        .collection<any>("users")
        .find({ _id: { $gt: cursor }, banned: { $ne: true }, isSeed: { $ne: true } })
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .project({ _id: 1 })
        .toArray();
      if (users.length === 0) {
        await advanceBroadcast(job._id, owner, cursor, cursor, 0, 0, true, LEASE_MS);
        return;
      }
      for (const u of users) {
        let kind: SendKind;
        let reason = "";
        try {
          await api.sendMessage(u._id, emojiSyntaxToHtml(claimed.message), { parse_mode: "HTML" });
          kind = "ok";
        } catch (err) {
          kind = classify(err);
          reason = failReason(err);
        }
        if (kind === "retry") return; // transient: leave the cursor BEFORE this user
        const moved = await advanceBroadcast(job._id, owner, cursor, u._id, kind === "ok" ? 1 : 0, kind === "gone" ? 1 : 0, false, LEASE_MS);
        if (!moved) return; // lease lost to another worker: stop immediately, never double count
        cursor = u._id;
        if (kind === "gone") await addBroadcastFailReason(job._id, reason).catch(() => {});
        if (Date.now() > deadline) return;
        await sleep(BROADCAST_PACE.ms);
      }
      if (users.length < BATCH_SIZE) {
        await advanceBroadcast(job._id, owner, cursor, cursor, 0, 0, true, LEASE_MS);
        return;
      }
      if (Date.now() > deadline) return;
    }
  } finally {
    await releaseBroadcastLease(job._id, owner).catch(() => {});
  }
}

export async function processAllPendingOneBatchEach(api: Api, opts: { budgetMs?: number } = {}): Promise<void> {
  const jobs = await getPendingBroadcastJobs();
  const budget = opts.budgetMs ?? 45_000;
  const t0 = Date.now();
  for (const job of jobs) {
    const left = budget - (Date.now() - t0);
    if (left <= 0) break;
    await processBroadcastBatch(api, job, { budgetMs: left });
  }
}
