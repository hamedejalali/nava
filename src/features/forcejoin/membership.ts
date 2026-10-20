import type { Api } from "grammy";
import { env } from "../../config/env.js";

/**
 * ONE definition of "is this person in the channel", used by the bot guard AND the mini-app (they used to disagree).
 *
 *  - member / administrator / creator            -> joined
 *  - restricted WITH is_member === true           -> joined (a muted member is still a member; counting him as "not joined"
 *                                                   made the mini-app demand a join the bot could not explain)
 *  - left / kicked / restricted(is_member=false)  -> not joined
 *  - Telegram error: a short retry for rate limits / network blips (a burst of ~100 people opening the app at once hits
 *    Telegram's limits); a lasting error is a CONFIGURATION problem (bot not admin / channel gone) -> the owner is told
 *    once an hour, and the person is treated as not joined (fail closed, as before).
 */

export type MemberLike = { status: string; is_member?: boolean };

export function isJoinedStatus(m: MemberLike): boolean {
  if (m.status === "member" || m.status === "administrator" || m.status === "creator") return true;
  if (m.status === "restricted") return m.is_member === true;
  return false;
}

export type MembershipVerdict = "joined" | "not_joined" | "error";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function checkMembership(api: Pick<Api, "getChatMember">, chatRef: string | number, userId: number): Promise<MembershipVerdict> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return isJoinedStatus(await api.getChatMember(chatRef, userId)) ? "joined" : "not_joined";
    } catch (err: any) {
      const code = Number(err?.error_code);
      const desc = String(err?.description ?? err?.message ?? "");
      if (/user not found|PARTICIPANT_ID_INVALID/i.test(desc)) return "not_joined"; // never talked to / never joined
      const retryable = code === 429 || code >= 500 || /ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(desc);
      if (retryable && attempt < 2) {
        const wait = Number(err?.parameters?.retry_after);
        await sleep(Math.min(1500, wait > 0 ? wait * 1000 : 250 * (attempt + 1)));
        continue;
      }
      return "error";
    }
  }
  return "error";
}

const alerted = new Map<string, number>();
/** tells the owner (at most once per hour per channel) that a required channel cannot be checked */
export async function alertChannelProblem(api: Pick<Api, "sendMessage">, channelRef: string, title: string): Promise<void> {
  const now = Date.now();
  if ((alerted.get(channelRef) ?? 0) > now - 3_600_000) return;
  alerted.set(channelRef, now);
  if (env.OWNER_ID === undefined) return;
  await api
    .sendMessage(env.OWNER_ID, `⚠️ نمی‌تونم عضویت کاربرها رو توی کانال اجباری «${title}» بررسی کنم (ربات اونجا ادمین نیست یا کانال حذف/تغییر کرده). تا درست نشه، کاربرها ممکنه گیر کنن.`)
    .catch(() => {});
}
