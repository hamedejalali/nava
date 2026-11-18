import type { NavaContext } from "../../bot-context.js";
import type { Language } from "../../i18n/index.js";
import { getUser } from "../../db/models/user.js";
import { queueEntryExists, SEARCH_TIMEOUT_MS, type SearchType } from "../../db/models/matchQueue.js";
import { rescanQueued } from "./engine.js";
import { announceMatch, countdownKeyboard, finishSearchTimeout, runCountdown, SEED_SCRIPT_BUDGET_MS } from "./search.js";
import { runSeedScript, SEED_SEARCH_LEAD_MS, trySeedMatch } from "./seedMatch.js";
import type { Scheduler, SearchStepPayload } from "../../services/qstash.js";

type Api = NavaContext["api"];

/** Seconds (from the press) at which a scan + countdown-number step runs. Few on purpose: every step is one QStash message. */
export const SCAN_MARKS = [10, 20, 30];

/**
 * v1.33.0 — QStash-driven search. The webhook invocation only sends the status message, queues the person and
 * schedules these steps; NO function stays alive for 40 s any more:
 *   scan   (10/20/30 s)  one extra partner scan + the number on the button
 *   seed   (deadline-3s) the default-member fallback (same rules as before)
 *   expire (deadline)    the timeout (same atomic claim as the in-process countdown)
 * Every step re-checks the queue entry of THIS search (createdAt) and is idempotent; a lost / late / repeated step
 * can never double-match or double-notify. The partner is found mainly at ENTRY (attemptMatchOrQueue scans, then enqueues,
 * then scans again — the later of two people always sees the earlier one), so the scans are only a safety net.
 * If QStash refuses the schedule, the caller falls back to the old in-process countdown, so searching never breaks.
 */
export async function scheduleSearch(
  scheduler: Scheduler,
  base: Omit<SearchStepPayload, "kind" | "display">,
  opts: { totalMs?: number; noSeed?: boolean } = {},
): Promise<void> {
  const total = (opts.totalMs ?? SEARCH_TIMEOUT_MS) / 1000;
  const elapsed = Math.max(0, (Date.now() - base.pressedAt) / 1000);
  const rel = (sec: number) => Math.max(1, sec - elapsed);
  const steps: Array<{ delaySeconds: number; body: SearchStepPayload }> = [];
  for (const m of SCAN_MARKS) if (m < total - SEED_SEARCH_LEAD_MS / 1000 - 1) steps.push({ delaySeconds: rel(m), body: { ...base, kind: "scan", display: m } });
  if (!opts.noSeed) steps.push({ delaySeconds: rel(total - SEED_SEARCH_LEAD_MS / 1000), body: { ...base, kind: "seed" } });
  steps.push({ delaySeconds: rel(total), body: { ...base, kind: "expire" } });
  await scheduler(steps);
}

export async function runSearchStep(api: Api, p: SearchStepPayload): Promise<void> {
  const before = new Date(p.createdAt);
  const lang = (p.lang || "fa") as Language;
  const dropStatus = () => api.deleteMessage(p.chatId, p.statusMessageId).catch(() => {});

  if (p.kind === "expire") {
    await finishSearchTimeout(api, p.userId, p.chatId, p.statusMessageId, lang, before);
    return;
  }

  // scan / seed only act while THIS search is still waiting
  if (!(await queueEntryExists(p.userId, { createdBefore: before }))) return;
  const user = await getUser(p.userId);
  if (!user) return;

  const r = await rescanQueued(user as any, p.searchType as SearchType);
  if (r.status === "matched") {
    await announceMatch(api, user as any, lang, r, { chatId: p.chatId, messageId: p.statusMessageId });
    return;
  }
  if (r.status === "matched_elsewhere" || r.status === "busy") {
    await dropStatus();
    return;
  }

  if (p.kind === "seed") {
    const sm = await trySeedMatch(api, user as any, p.searchType as SearchType, { chatId: p.chatId, messageId: p.statusMessageId }, { createdBefore: before });
    if (sm.status === "matched") {
      await runSeedScript(api, sm.sessionId, { hardStopAt: p.pressedAt + SEED_SCRIPT_BUDGET_MS });
      return;
    }
    if (sm.status === "gone") await dropStatus();
    return;
  }

  // scan: refresh the number on the button (a deleted / replaced message is simply ignored)
  if (p.display !== undefined) await api.editMessageReplyMarkup(p.chatId, p.statusMessageId, { reply_markup: countdownKeyboard(lang, p.display) }).catch(() => {});
}

/** Starts a search timer: QStash when it is configured and accepts the schedule, otherwise the in-process countdown. */
export async function startSearchTimer(args: {
  api: Api;
  user: any;
  chatId: number;
  statusMessageId: number;
  lang: Language;
  searchType: SearchType;
  pressedAt: number;
  enabled: boolean;
  scheduler: Scheduler;
  /** runs the fallback (the caller wraps it in waitUntil) */
  fallback: (run: Promise<void>) => void;
}): Promise<"qstash" | "inprocess"> {
  if (args.enabled) {
    try {
      const { getQueueEntry } = await import("../../db/models/matchQueue.js");
      const entry = await getQueueEntry(args.user._id);
      if (entry) {
        await scheduleSearch(args.scheduler, {
          userId: args.user._id,
          createdAt: entry.createdAt.getTime(),
          chatId: args.chatId,
          statusMessageId: args.statusMessageId,
          lang: args.lang,
          searchType: args.searchType,
          pressedAt: args.pressedAt,
        });
        return "qstash";
      }
    } catch (err) {
      console.error("[search] QStash schedule failed, using the in-process countdown:", err instanceof Error ? err.name : "unknown");
    }
  }
  args.fallback(
    runCountdown(args.api, args.user, args.chatId, args.statusMessageId, args.lang, args.searchType, { searchStartedAt: args.pressedAt }).catch((err) => {
      console.error("[search] runCountdown crashed (background task):", err instanceof Error ? err.name : "unknown");
    }),
  );
  return "inprocess";
}
