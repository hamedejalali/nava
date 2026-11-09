/**
 * v1.29.6 — bounded external reads. Only for IDEMPOTENT requests (downloading a Telegram file): an aborted GET is safe to repeat.
 * Never use it to wrap a financial or messaging write — those must not be retried blindly (see docs/PERFORMANCE_AND_TIMEOUTS.md).
 */
export const TELEGRAM_FILE_TIMEOUT_MS = 20_000;
/** Telegram Bot API call ceilings (grammY default is 500 s, far beyond a serverless function's life) */
export const TELEGRAM_API_TIMEOUT_S = { bot: 25, miniapp: 15, cron: 25 } as const;

export function fetchWithTimeout(url: string, init: RequestInit = {}, ms: number = TELEGRAM_FILE_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) });
}
