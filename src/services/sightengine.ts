import { env, parseModerationThreshold } from "../config/env.js";
import { getAppVar } from "../services/appVars.js";

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
  const { apiUser, apiSecret } = env.sightengine;
  const stored = await getAppVar("SIGHTENGINE_THRESHOLD");
  const threshold = parseModerationThreshold(stored) ?? env.sightengine.threshold; // invalid stored values never weaken the filter

  if (!apiUser || !apiSecret) {
    // eslint-disable-next-line no-console
    console.error("[sightengine] SIGHTENGINE_API_USER/SECRET not configured — failing closed to manual review.");
    return { serviceUnavailable: true, flagged: true, score: 1, classification: "not_configured" };
  }

  try {
    // v1.28.0: the Telegram file URL contains the BOT TOKEN — it must never be handed to a third party. We download the picture
    // ourselves (size/time limited) and UPLOAD the bytes to Sightengine; only api_user / api_secret / the image leave the server.
    const dl = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000) });
    if (!dl.ok) throw new Error(`image download HTTP ${dl.status}`);
    const bytes = await dl.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > 12 * 1024 * 1024) throw new Error("image size not acceptable");
    const form = new FormData();
    form.set("models", "nudity-2.1");
    form.set("api_user", apiUser);
    form.set("api_secret", apiSecret);
    form.set("media", new Blob([bytes]), "image");
    const res = await fetch("https://api.sightengine.com/1.0/check.json", { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Sightengine HTTP ${res.status}`);
    const data: any = await res.json();
    if (data.status !== "success") throw new Error(`Sightengine status: ${data.status}`);

    const n = data.nudity ?? {};
    // Take the highest-risk relevant sub-score from the nudity-2.1 model.
    const score = Math.max(n.sexual_activity ?? 0, n.sexual_display ?? 0, n.erotica ?? 0, n.suggestive ?? n.raw ?? 0);
    // a garbled answer (NaN / not a number) must never read as "safe"
    if (typeof score !== "number" || !Number.isFinite(score)) throw new Error("Sightengine returned a non-numeric score");

    return {
      serviceUnavailable: false,
      flagged: score >= threshold,
      score,
      classification: score >= threshold ? "flagged_nudity" : "safe",
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    // only the error NAME / message is logged — never the request (it could carry the API secret)
    console.error("[sightengine] Moderation check failed, failing closed to manual review:", err instanceof Error ? err.message : "unknown");
    return { serviceUnavailable: true, flagged: true, score: 1, classification: "service_error" };
  }
}
