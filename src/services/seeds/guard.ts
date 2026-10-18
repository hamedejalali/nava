import type { Transformer } from "grammy";
import { isSeedId } from "./ids.js";

/**
 * OUTGOING-REQUEST GUARD for default (seed) members.
 *
 * A seed member is not a Telegram account, so any request addressed to one (a relayed chat message, a
 * "profile viewed" notice, a gift notification, a chat request, a broadcast, a reaction…) must never reach
 * Telegram: it would fail with "chat not found", and several flows read such a failure as "this person
 * blocked the bot" and undo the chat / refund. Instead the request is answered locally with a plausible
 * success, so every existing flow keeps working unchanged and nothing is ever delivered anywhere.
 *
 * Installed FIRST on every Api instance (the bot's and the Mini App's `botApi()`).
 */

let fakeMessageId = 2_000_000_000;

function addressedSeed(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const key of ["chat_id", "user_id"] as const) {
    const v = p[key];
    if (isSeedId(v)) return v;
    if (typeof v === "string" && /^\d{16}$/.test(v) && isSeedId(Number(v))) return Number(v);
  }
  return null;
}

export const seedGuardTransformer: Transformer = async (prev, method, payload, signal) => {
  const seedId = addressedSeed(payload);
  if (seedId === null) return prev(method, payload, signal);
  // message-like methods return a Message; everything else (reactions, deletes, edits, chat actions) returns true
  if (/^(send|copy|forward)/.test(method) && method !== "sendChatAction") {
    return { ok: true, result: { message_id: ++fakeMessageId, date: Math.floor(Date.now() / 1000), chat: { id: seedId, type: "private" } } } as any;
  }
  return { ok: true, result: true } as any;
};
