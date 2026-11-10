/**
 * v1.29.8 — AGE SEPARATION for a chat that is ALREADY running (audit A-03 / F-08).
 * An approved age change can move a person across the minor / adult line while a bot-relayed chat is open. The relay used to check only
 * "is the session active". Now the pair is re-checked with the SAME policy (`canContact`, fresh read of both people from the database —
 * no cached state) before every relayed message and right after an approved age change; if the pair is no longer allowed, the session is
 * closed atomically (same transaction as ban / user-end: both people freed) and both are told.
 *
 * REFUND (default, owner decision still open — change only `refundFor`): a chat cut short by this rule before 4 messages gives both people
 * their 1 Relic chat cost back (idempotent ledger ids, like every other close); a longer chat refunds nobody.
 * Nothing about F-01 / F-17: `canContact` is untouched (officials / staff keep their existing exemption).
 */
import type { Api } from "grammy";
import { getDb } from "../db/connect.js";
import { canContact } from "./ageBand.js";
import { getSession } from "../db/models/chatSession.js";
import { closeSessionAtomic } from "../db/models/sessionClose.js";
import { buildMainMenuReplyKeyboard } from "../features/menu/mainMenu.js";
import { logError } from "../utils/safeLog.js";

export const AGE_BAND_CHAT_ENDED_TEXT = "⚠️ این چت به‌خاطر محدودیت‌های سنی (زیر ۱۸ / بالای ۱۸ سال) پایان یافت.";

/** Returns true when the session was (just) closed by this call; false when the pair is still allowed, the session is not active, or on any error (fail-safe: never throws). */
export async function enforceAgeBandOnSession(api: Pick<Api, "sendMessage">, sessionId: string, endedBy: number): Promise<boolean> {
  try {
    const session = await getSession(sessionId);
    if (!session || !session.active) return false;
    const db = await getDb();
    const people = await db.collection<any>("users").find({ _id: { $in: [session.userA, session.userB] } as never }).toArray();
    const a = people.find((u) => u._id === session.userA);
    const b = people.find((u) => u._id === session.userB);
    if (canContact(a, b)) return false; // missing / banned-by-absence docs fail closed inside canContact (null → false)
    const r = await closeSessionAtomic(sessionId, endedBy, (s) => ((s.messageCount ?? 0) < 4 ? [s.userA, s.userB] : []), "age_band");
    if (r.status !== "ended") return false;
    for (const id of [r.session.userA, r.session.userB]) {
      const lang = people.find((u) => u._id === id)?.languageCode ?? "fa";
      const refunded = r.refunded.includes(id) ? "\nژتون این چت برگشت داده شد." : "";
      await api.sendMessage(id, AGE_BAND_CHAT_ENDED_TEXT + refunded, { reply_markup: buildMainMenuReplyKeyboard(lang) }).catch(() => {});
    }
    return true;
  } catch (err) {
    logError("MG-AGE-001", "age-band re-check of a running chat failed", err);
    return false;
  }
}
