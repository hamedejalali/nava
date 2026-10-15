import type { Update } from "grammy/types";
import { GrammyError, HttpError } from "grammy";
import { inboxCollection, type UpdateInboxDoc } from "../db/models/updateInbox.js";

/**
 * Webhook failure strategy (v1.16.3).
 *
 * Facts verified against the installed grammY: `bot.handleUpdate` THROWS a BotError when a handler throws
 * (the `bot.catch` handler only runs in `bot.start()` / `handleUpdates`, i.e. long polling) — so in webhook
 * mode every handler failure reaches api/webhook.ts, which answers non-2xx and makes Telegram redeliver the
 * same update with backoff. Telegram's redelivery is the retry mechanism; what was missing around it:
 *   - nothing recognised a duplicate delivery of an update that had ALREADY succeeded (e.g. the 200 was lost);
 *   - a deterministic failure (a bug) was redelivered over and over, and the user never heard anything;
 *   - two concurrent deliveries of the same update could run the handlers twice at once.
 * The inbox adds exactly those three guarantees on top of Telegram's retry, using MongoDB as the single
 * source of truth (works across any number of serverless instances):
 *   200 means "processed OR deliberately parked (dead-letter)";  5xx means "not done yet, please redeliver".
 * It stores only the update_id + state, NOT the update itself: Telegram keeps the payload and redelivers it,
 * so nothing sensitive is copied. (If Telegram's own retry window passes, a failed update is lost — that is
 * Telegram's documented limit; the dead-letter notice tells the user to repeat the action.)
 */

export type ProcessOutcome = "processed" | "duplicate" | "in_progress" | "retry" | "dead_letter" | "inbox_unavailable";
export interface ProcessResult {
  outcome: ProcessOutcome;
  /** HTTP status the webhook must answer with. */
  http: 200 | 500 | 503;
}

const LEASE_MS = 60_000;
export const MAX_ATTEMPTS_TRANSIENT = 10;
export const MAX_ATTEMPTS_PERMANENT = 3;

/** Database / network / Telegram-side trouble that is likely to disappear on its own. */
export function isTransientFailure(err: unknown): boolean {
  const inner = (err as any)?.error ?? err; // BotError wraps the real error in `.error`
  if (inner instanceof HttpError) return true;
  if (inner instanceof GrammyError) return inner.error_code === 429 || inner.error_code >= 500;
  const name = String((inner as any)?.name ?? "");
  if (/^Mongo(Network|ServerSelection|NotConnected|Pool|Topology)/.test(name) || name === "MongoNetworkTimeoutError") return true;
  const labels = (inner as any)?.errorLabels;
  if (Array.isArray(labels) && labels.includes("TransientTransactionError")) return true;
  return false;
}

function kindOf(u: Update): string {
  for (const k of Object.keys(u)) if (k !== "update_id") return k;
  return "unknown";
}

export interface ProcessOptions {
  /** best-effort: tell the user their request could not be completed (called once, when parked as dead) */
  onDead?: (update: Update, err: unknown) => Promise<void>;
  collection?: Awaited<ReturnType<typeof inboxCollection>>;
}

export async function processUpdateOnce(update: Update, handle: (u: Update) => Promise<void>, opts: ProcessOptions = {}): Promise<ProcessResult> {
  const id = update.update_id;
  if (typeof id !== "number") {
    // not a Telegram update (never happens in production): process without bookkeeping
    try {
      await handle(update);
      return { outcome: "processed", http: 200 };
    } catch {
      return { outcome: "retry", http: 500 };
    }
  }

  let attempts = 1;
  let inbox: Awaited<ReturnType<typeof inboxCollection>>;
  try {
    inbox = opts.collection ?? (await inboxCollection());
    const now = new Date();
    try {
      await inbox.insertOne({ _id: id, state: "processing", attempts: 1, leaseUntil: new Date(now.getTime() + LEASE_MS), kind: kindOf(update), createdAt: now, updatedAt: now });
    } catch (err) {
      if ((err as any)?.code !== 11000) throw err;
      const reclaimed = await inbox.findOneAndUpdate(
        { _id: id, $or: [{ state: "failed" }, { state: "processing", leaseUntil: { $lte: now } }] },
        { $set: { state: "processing", leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now }, $inc: { attempts: 1 } },
        { returnDocument: "after" },
      );
      if (!reclaimed) {
        const existing = await inbox.findOne({ _id: id });
        if (!existing || existing.state === "done" || existing.state === "dead") return { outcome: "duplicate", http: 200 };
        return { outcome: "in_progress", http: 500 }; // someone else is processing it right now: redeliver later
      }
      attempts = reclaimed.attempts;
    }
  } catch (err) {
    // The update was NOT durably accepted: do not acknowledge it, Telegram redelivers.
    console.error("[nava:webhook] inbox unavailable:", err instanceof Error ? err.name : "unknown");
    return { outcome: "inbox_unavailable", http: 503 };
  }

  const finish = async (patch: Partial<UpdateInboxDoc>) => {
    try {
      await inbox.updateOne({ _id: id }, { $set: { ...patch, updatedAt: new Date() }, $unset: { leaseUntil: "" } } as any);
    } catch (e) {
      console.error("[nava:webhook] could not record inbox state:", e instanceof Error ? e.name : "unknown");
    }
  };

  try {
    await handle(update);
  } catch (err) {
    const transient = isTransientFailure(err);
    const cap = transient ? MAX_ATTEMPTS_TRANSIENT : MAX_ATTEMPTS_PERMANENT;
    const inner = (err as any)?.error ?? err;
    console.error("[nava:webhook] handleUpdate failed:", inner instanceof Error ? `${inner.name}: ${inner.message}` : "unknown error");
    const label = `${transient ? "transient" : "permanent"}:${String((err as any)?.error?.name ?? (err as any)?.name ?? "Error")}`;
    if (attempts >= cap) {
      console.error(`[nava:webhook] update ${id} parked as dead after ${attempts} attempts (${label})`);
      await finish({ state: "dead", lastError: label });
      await opts.onDead?.(update, err).catch(() => {});
      return { outcome: "dead_letter", http: 200 };
    }
    await finish({ state: "failed", lastError: label });
    return { outcome: "retry", http: 500 };
  }
  await finish({ state: "done" });
  return { outcome: "processed", http: 200 };
}
