import type { Transformer } from "grammy";

/**
 * Small, bounded retry for Telegram's 429 ("Too Many Requests"). Applied to
 * BOTH bots' `bot.api.config`. At higher concurrency (many users hitting
 * the bot at once) Telegram's per-bot rate limit can be hit even when every
 * individual call is well-formed; without this, a single transient 429
 * would surface as a hard failure for that one call (e.g. the search
 * countdown treats "the edit failed" as "the message was deleted" and stops
 * the countdown early — see src/features/matching/search.ts).
 *
 * Deliberately NOT a general-purpose retry library: at most ONE retry, and
 * only for 429s with a small `retry_after` (Telegram sometimes reports very
 * long backoffs for account-wide restrictions — retrying those would just
 * hold the serverless invocation open for no benefit).
 */
const MAX_RETRY_AFTER_SECONDS = 3;

export const telegramRetryTransformer: Transformer = async (prev, method, payload, signal) => {
  const result = await prev(method, payload, signal);
  if (
    !result.ok &&
    result.error_code === 429 &&
    typeof result.parameters?.retry_after === "number" &&
    result.parameters.retry_after <= MAX_RETRY_AFTER_SECONDS
  ) {
    await new Promise((resolve) => setTimeout(resolve, (result.parameters!.retry_after! + 0.1) * 1000));
    return prev(method, payload, signal);
  }
  return result;
};
