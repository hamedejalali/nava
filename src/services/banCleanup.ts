import type { Api } from "grammy";
import { getDb } from "../db/connect.js";
import { setBanned, getUser, type UserDoc } from "../db/models/user.js";
import { claimQueueEntry } from "../db/models/matchQueue.js";
import { closeSessionAtomic } from "../db/models/sessionClose.js";
import { otherParticipant } from "../db/models/chatSession.js";
import { banNoticeMarkup, banNoticeText } from "../features/support/banNotice.js";
import { buildMainMenuReplyKeyboard } from "../features/menu/mainMenu.js";

/**
 * Bans a person EVERYWHERE (bot and Mini App read the same `banned` flag) and cleans up what they leave behind:
 *  - their search (queue entry) is removed, their timeout notice voided;
 *  - an active chat is closed ATOMICALLY and the partner gets their Relic back (the chat was cut short);
 *  - pending chat requests from/to them are closed;
 *  - the banned person receives the notice with a "message support" link button.
 * Idempotent: repeating it changes nothing further. Telegram notices are best-effort.
 */
export async function banUser(api: Pick<Api, "sendMessage">, targetId: number, reason: string): Promise<UserDoc | null> {
  const user = await setBanned(targetId, true, reason);
  if (!user) return null;

  await claimQueueEntry(targetId).catch((e) => console.error("[ban] queue cleanup failed:", e instanceof Error ? e.name : "unknown"));

  const sessionId = user.activeChatSessionId;
  if (sessionId) {
    try {
      const r = await closeSessionAtomic(sessionId, targetId, (s) => {
        const other = otherParticipant(s, targetId);
        return other ? [other] : [];
      }, "banned");
      if (r.status === "ended") {
        const partnerId = otherParticipant(r.session, targetId);
        if (partnerId) {
          const partner = await getUser(partnerId).catch(() => null);
          await api
            .sendMessage(partnerId, "⚠️ مخاطبت دیگه در دسترس نیست و چت تموم شد. ژتونت برگشت داده شد.", { reply_markup: buildMainMenuReplyKeyboard(partner?.languageCode ?? "fa") })
            .catch(() => {});
        }
      }
    } catch (e) {
      console.error("[ban] chat cleanup failed:", e instanceof Error ? e.name : "unknown");
    }
  }

  try {
    const db = await getDb();
    await db.collection<any>("chat_requests").updateMany({ status: "pending", $or: [{ fromId: targetId }, { toId: targetId }] }, { $set: { status: "declined", respondedAt: new Date() } });
  } catch (e) {
    console.error("[ban] request cleanup failed:", e instanceof Error ? e.name : "unknown");
  }

  await api.sendMessage(targetId, banNoticeText(reason), { parse_mode: "HTML", reply_markup: await banNoticeMarkup() }).catch(() => {});
  return user;
}

export async function unbanUser(api: Pick<Api, "sendMessage">, targetId: number): Promise<UserDoc | null> {
  const user = await setBanned(targetId, false);
  if (user) await api.sendMessage(targetId, "✅ دسترسی شما به ربات دوباره فعال شد.").catch(() => {});
  return user;
}
