import { env } from "../config/env.js";

export interface ModerationCheckResult {
  /** true when the AI could not be reached/parsed — callers must treat
   *  this the same as "flagged" (fail closed to manual admin review, never
   *  fail open to auto-publishing unchecked content). */
  serviceUnavailable: boolean;
  flagged: boolean;
  score: number;
  classification: string;
}

/**
 * Runs a Telegram-hosted image through Sightengine's nudity model.
 * `fileUrl` must be a real, publicly-fetchable HTTPS URL (Telegram's own
 * `https://api.telegram.org/file/bot<token>/<path>` works directly —
 * Sightengine fetches it server-side, so we never upload the raw bytes
 * ourselves and never run a heavy model inside this serverless function).
 */
export async function checkImage(fileUrl: string): Promise<ModerationCheckResult> {
  const { apiUser, apiSecret, threshold } = env.sightengine;

  if (!apiUser || !apiSecret) {
    // eslint-disable-next-line no-console
    console.error("[sightengine] SIGHTENGINE_API_USER/SECRET not configured — failing closed to manual review.");
    return { serviceUnavailable: true, flagged: true, score: 1, classification: "not_configured" };
  }

  const url = new URL("https://api.sightengine.com/1.0/check.json");
  url.searchParams.set("url", fileUrl);
  url.searchParams.set("models", "nudity-2.1");
  url.searchParams.set("api_user", apiUser);
  url.searchParams.set("api_secret", apiSecret);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Sightengine HTTP ${res.status}`);
    const data: any = await res.json();
    if (data.status !== "success") throw new Error(`Sightengine status: ${data.status}`);

    const n = data.nudity ?? {};
    // Take the highest-risk relevant sub-score from the nudity-2.1 model.
    const score = Math.max(n.sexual_activity ?? 0, n.sexual_display ?? 0, n.erotica ?? 0, n.suggestive ?? n.raw ?? 0);

    return {
      serviceUnavailable: false,
      flagged: score >= threshold,
      score,
      classification: score >= threshold ? "flagged_nudity" : "safe",
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[sightengine] Moderation check failed, failing closed to manual review:", err);
    return { serviceUnavailable: true, flagged: true, score: 1, classification: "service_error" };
  }
}
