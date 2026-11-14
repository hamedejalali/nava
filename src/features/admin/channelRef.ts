/**
 * v1.31.0 (owner rule): a channel is NEVER set by its numeric id. The owner gives one of: an @username, a t.me link, or a forwarded
 * post of the channel. The numeric id (only needed internally for Telegram calls) comes from the forwarded post and is never shown.
 */
const NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export function channelRefFromMessage(msg: any): string | null {
  const origin = msg?.forward_origin;
  if (origin?.type === "channel" && origin.chat) return origin.chat.username ? `@${origin.chat.username}` : String(origin.chat.id);
  const raw = String(msg?.text ?? msg?.caption ?? "").trim();
  if (!raw) return null;
  const m = /^(?:https?:\/\/)?(?:t|telegram)\.(?:me|dog)\/([A-Za-z0-9_]+)(?:\/\d+)?\/?(?:\?.*)?$/i.exec(raw) ?? /^@([A-Za-z0-9_]+)$/.exec(raw);
  const name = m?.[1];
  return name && NAME.test(name) ? `@${name}` : null;
}

export const CHANNEL_REF_HELP = "یکی از این‌ها رو بفرست: ۱) یوزرنیم مثل @mychannel ۲) لینک کانال مثل t.me/mychannel ۳) یک پست فوروارد‌شده از خود کانال. ربات باید داخلش ادمین باشه.";
