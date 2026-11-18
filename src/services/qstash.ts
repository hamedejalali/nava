import { Client, Receiver } from "@upstash/qstash";
import { env } from "../config/env.js";

/**
 * v1.33.0 — the external timer (technique borrowed from the uploader bot): QStash — not a function of ours — holds the
 * clock and calls /api/search-step when a delay is over. No invocation has to stay alive for 40 s.
 * It is OFF (the old in-process countdown runs) until QSTASH_TOKEN + both signing keys + a public base URL are set.
 */
export function qstashEnabled(): boolean {
  return !!(env.QSTASH_TOKEN && env.QSTASH_CURRENT_SIGNING_KEY && env.QSTASH_NEXT_SIGNING_KEY && env.APP_BASE_URL);
}

export interface SearchStepPayload {
  kind: "scan" | "seed" | "expire";
  userId: number;
  /** queue entry createdAt (ms): a step only ever acts on THIS search, never on a newer one by the same person */
  createdAt: number;
  chatId: number;
  statusMessageId: number;
  lang: string;
  searchType: string;
  /** the number shown on the countdown button (scan steps) */
  display?: number;
  /** when the person pressed the button (ms) — the seed script's hard stop is measured from here */
  pressedAt: number;
}

export type Scheduler = (steps: Array<{ delaySeconds: number; body: SearchStepPayload }>) => Promise<void>;

/** Publishes every step in ONE round trip. Throws if QStash refuses (the caller then falls back to the in-process countdown). */
export const scheduleSearchSteps: Scheduler = async (steps) => {
  const client = new Client({ token: env.QSTASH_TOKEN! });
  const url = `${env.APP_BASE_URL}/api/search-step`;
  await client.batchJSON(steps.map((s) => ({ url, body: s.body, delay: `${Math.max(0, Math.round(s.delaySeconds))}s` as `${bigint}s`, retries: 3 })));
};

export async function verifyQStash(signature: string | undefined, body: string): Promise<boolean> {
  if (!signature || !qstashEnabled()) return false;
  try {
    const r = new Receiver({ currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY!, nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY! });
    return await r.verify({ signature, body, url: `${env.APP_BASE_URL}/api/search-step` });
  } catch {
    return false;
  }
}
