import { randomUUID } from "node:crypto";
import type { Api } from "grammy";
import { getDb } from "../db/connect.js";
import { env } from "../config/env.js";
import { creditAdminBulkOnce } from "../db/models/relic.js";
import { advanceJetonJob, claimJetonLease, claimJetonLog, releaseJetonLease, type JetonJobDoc, type JetonMode } from "../db/models/jetonJobs.js";
import { getLogChatId } from "./channelRouting.js";
import { recordAdminActionQuiet } from "../db/models/adminLog.js";

const BATCH = 40;
const LEASE_MS = 90_000;
/** pause between people (Telegram ≈30 msg/s). Tests set it to 0. */
export const JETON_PACE = { ms: 40 };
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const MODE_FA: Record<JetonMode, string> = { inactive: "کاربران کم‌فعالیت", gender: "بر اساس جنسیت", users: "کاربران مشخص‌شده" };

/** Real people only: finished sign-up, not banned, not a default member / official account, never the owner himself. */
function baseFilter(): Record<string, unknown> {
  return {
    onboardingStep: "COMPLETED",
    banned: { $ne: true },
    isSeed: { $ne: true },
    official: { $ne: true },
    seedDeleted: { $ne: true },
    ...(env.OWNER_ID !== undefined ? { _id: { $ne: env.OWNER_ID } } : {}),
  };
}

export function recipientFilter(mode: JetonMode, params: JetonJobDoc["params"]): Record<string, unknown> {
  const base = baseFilter();
  if (mode === "inactive") {
    const cutoff = params.cutoff ?? new Date();
    return { ...base, $or: [{ lastActivityAt: { $lt: cutoff } }, { lastActivityAt: { $exists: false } }] };
  }
  if (mode === "gender") return { ...base, gender: params.gender };
  // explicit ids: the owner chose them, so only "a real, non-fake account" is required
  return { isSeed: { $ne: true }, _id: { $in: params.ids ?? [] } };
}

export async function countRecipients(mode: JetonMode, params: JetonJobDoc["params"]): Promise<number> {
  return (await getDb()).collection("users").countDocuments(recipientFilter(mode, params));
}

type SendKind = "ok" | "gone" | "retry";
function classify(err: unknown): SendKind {
  const code = (err as { error_code?: number })?.error_code;
  return code === 403 || code === 400 ? "gone" : "retry";
}

/** Works on a job for up to `budgetMs`. Safe to call from the button AND the cron: a leased / finished job is a no-op.
 *  Per person: credit (exactly once, ledger-guarded) → the owner's message(s) only. No other notice is ever sent to the person. */
export async function processJetonJob(api: Pick<Api, "sendMessage">, job: JetonJobDoc, opts: { budgetMs?: number } = {}): Promise<void> {
  const owner = randomUUID();
  const claimed = await claimJetonLease(job._id, owner, LEASE_MS);
  if (!claimed) return;
  const deadline = Date.now() + (opts.budgetMs ?? 40_000);
  let cursor = claimed.cursorId;
  const filter = recipientFilter(claimed.mode, claimed.params);
  try {
    const users = (await getDb()).collection<any>("users");
    for (;;) {
      const batch = await users.find({ $and: [filter, { _id: { $gt: cursor } }] }).sort({ _id: 1 }).limit(BATCH).project({ _id: 1 }).toArray();
      if (batch.length === 0) {
        await advanceJetonJob(job._id, owner, cursor, cursor, { credited: 0, delivered: 0, undelivered: 0 }, true, LEASE_MS);
        return;
      }
      for (const u of batch) {
        const credited = await creditAdminBulkOnce(job._id, u._id, claimed.amount, claimed.createdBy);
        let delivered = 0;
        let undelivered = 0;
        if (claimed.messages.length) {
          let kind: SendKind = "ok";
          for (const m of claimed.messages) {
            try {
              await api.sendMessage(u._id, m);
            } catch (err) {
              kind = classify(err);
              break;
            }
          }
          if (kind === "retry") return; // transient (429/5xx): stay BEFORE this person; the credit is already safe and is not repeated
          if (kind === "ok") delivered = 1;
          else undelivered = 1;
        }
        const moved = await advanceJetonJob(job._id, owner, cursor, u._id, { credited: credited ? 1 : 0, delivered, undelivered }, false, LEASE_MS);
        if (!moved) return; // lease lost: stop at once, never double count
        cursor = u._id;
        if (Date.now() > deadline) return;
        await sleep(JETON_PACE.ms);
      }
      if (Date.now() > deadline) return;
    }
  } finally {
    await releaseJetonLease(job._id, owner).catch(() => {});
  }
}

export function summaryText(job: JetonJobDoc, who: string, extra = ""): string {
  const lines = [
    "🪙 ارسال ژتون با موفقیت انجام شد",
    "",
    `گروه: ${MODE_FA[job.mode]}${job.mode === "inactive" && job.params.days ? ` (بدون فعالیت در ${job.params.days} روز اخیر)` : ""}${job.mode === "gender" ? ` (${job.params.gender === "female" ? "دختر" : "پسر"}ها)` : ""}`,
    `تعداد دریافت‌کننده: ${job.credited} نفر`,
    `به ازای هر نفر: ${job.amount} ژتون`,
    `مجموع ژتون ارسال‌شده: ${job.credited * job.amount} ژتون`,
  ];
  if (job.messages.length) lines.push(`پیام (${job.messages.length} عدد) به ${job.delivered} نفر رسید${job.undelivered ? ` — ${job.undelivered} نفر ربات را بلاک کرده‌اند (ژتونشان ثبت شد)` : ""}`);
  lines.push(`توسط: ${who}${extra}`);
  return lines.join("\n");
}

/** ONE message to the log channel for the whole send (never one per person). Exactly once per job. */
export async function sendJetonSummaryOnce(api: Pick<Api, "sendMessage">, jobId: string, who: string): Promise<boolean> {
  const job = await claimJetonLog(jobId);
  if (!job) return false;
  await recordAdminActionQuiet(job.createdBy, "jeton_mass_send", `${MODE_FA[job.mode]}:${job.amount}:${job.credited}`).catch(() => {});
  const chat = await getLogChatId("adminLog");
  if (chat !== undefined) await api.sendMessage(chat, summaryText(job, who)).catch(() => {});
  return true;
}
