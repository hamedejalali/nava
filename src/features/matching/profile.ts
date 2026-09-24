import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { getSession, otherParticipant } from "../../db/models/chatSession.js";
import { getUser, incrementLikes, type UserDoc } from "../../db/models/user.js";
import { getDb } from "../../db/connect.js";
import { CHAT_CALLBACKS, VERIFY_REQUEST_CALLBACK } from "./constants.js";
import { levelDisplay } from "../../config/levels.js";
import { textEmoji } from "../../config/emojis.js";
import { MENU_CALLBACKS, buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";
import { env } from "../../config/env.js";
import { distanceKm, formatDistanceFa } from "../../utils/geo.js";
import { formatPresenceFa } from "../../utils/presence.js";
import { escapeHtml } from "../../utils/html.js";

const GENDER_LABEL: Record<string, string> = { male: "پسر", female: "دختر" };
const VIEW_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

export async function shouldNotifyProfileView(viewerId: number, targetId: number, scope: "chat" | "lookup" = "chat"): Promise<boolean> {
  const db = await getDb();
  interface ProfileViewCooldownDoc { _id: string; expiresAt: Date; }
  const col = db.collection<ProfileViewCooldownDoc>("profile_view_notify_cooldown");
  try {
    await col.insertOne({ _id: scope === "chat" ? `${viewerId}:${targetId}` : `${scope}:${viewerId}:${targetId}`, expiresAt: new Date(Date.now() + VIEW_NOTIFY_COOLDOWN_MS) });
    return true;
  } catch (err: any) {
    if (err?.code === 11000) return false; // notified recently, skip spamming
    throw err;
  }
}

export async function ensureProfileViewIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection("profile_view_notify_cooldown").createIndexes([{ key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 }]);
}

/** file_id (or https URL) of the target's own photo, or a gender-based
 *  default if they haven't uploaded one and a default has been configured
 *  (see DEFAULT_PHOTO_MALE/FEMALE in .env) — never crashes if neither is
 *  set, the profile just renders with no photo, same as before. */
export function resolveProfilePhoto(target: UserDoc): string | undefined {
  if (target.profilePhotoFileId) return target.profilePhotoFileId;
  if (target.gender === "male") return env.DEFAULT_PHOTO_MALE;
  if (target.gender === "female") return env.DEFAULT_PHOTO_FEMALE;
  return undefined;
}

export function buildProfileText(lang: Language, target: UserDoc, viewer?: UserDoc): string {
  const t = dictionary(lang);
  const labels = requireLocked(lang, "profile.labels", t.profile.labels);
  const bioLabel = requireLocked(lang, "profile.bioLabel", t.profile.bioLabel);
  const idLabel = requireLocked(lang, "profile.idLabel", t.profile.idLabel);
  const distanceLabel = requireLocked(lang, "profile.distanceLabel", t.profile.distanceLabel);

  const [nameLine, ageLine, genderLine, provinceLine, cityLine] = labels.split("\n");
  const genderText = target.gender ? (GENDER_LABEL[target.gender] ?? target.gender) : "-";

  // Verified / not-verified — always shown, per owner request, right above
  // the online/last-seen line.
  // (The premium badge is used ONLY for verified users — an unverified user
  // must never be shown a blue tick, so ❌ stays a plain emoji.)
  const verifiedBadge = textEmoji("VERIFIED_BADGE", "🔵");
  const verifiedLine = target.verified
    ? `${verifiedBadge} (کاربر تایید شده از طرف ادمین)`
    : `❌ (تایید نشده)`;

  // Real online/offline is impossible for a bot to know (Bot API has no
  // access to Telegram's own presence system) — this is the honest
  // substitute: activity with THIS bot. See src/utils/presence.ts.
  const presenceLine = formatPresenceFa(target.lastActivityAt);

  // Blue tick right next to the name for verified users.
  const nameBadge = target.verified ? ` ${verifiedBadge}` : "";

  // Every user-controlled value is HTML-escaped: this message is sent with
  // parse_mode HTML, and one stray "<" or "&" in a bio used to make
  // Telegram reject the whole profile.
  const lines = [
    `${nameLine} ${escapeHtml(target.nickname ?? "-")}${nameBadge}`,
    `${ageLine} ${escapeHtml(target.age ?? "-")}`,
    `${genderLine} ${escapeHtml(genderText)}`,
    `${provinceLine} ${escapeHtml(target.province ?? "-")}`,
    `${cityLine} ${escapeHtml(target.city ?? "-")}`,
    `⭐ سطح کاربر: ${levelDisplay(target.level)}`,
  ];
  if (target.bio) lines.push("", `${bioLabel} ${escapeHtml(target.bio)}`);

  lines.push("", verifiedLine, presenceLine);
  // Tap-to-copy id: <code> renders as monospace, which Telegram clients
  // make copyable with a single tap — intentionally with NO "@" prefix so
  // it isn't mistaken for a tappable mention/link (per owner request).
  lines.push(`${idLabel} <code>${target.anonId}</code>`);

  // Distance: only ever shown when BOTH sides have shared a location —
  // never a "location not set" placeholder, just omitted entirely,
  // per owner request.
  if (viewer?.location && target.location) {
    const km = distanceKm(viewer.location, target.location);
    lines.push(`${distanceLabel} ${formatDistanceFa(km)}`);
  }

  return lines.join("\n");
}

type ProfileViewContext = "chat" | "lookup";

export type { ProfileViewContext };
export function buildProfileKeyboard(lang: Language, target: UserDoc, viewContext: ProfileViewContext) {
  const t = dictionary(lang);
  const like = requireLocked(lang, "profile.likeButton", t.profile.likeButton)(target.likesCount ?? 0);
  const addContact = requireLocked(lang, "profile.addContactButton", t.profile.addContactButton);
  const block = requireLocked(lang, "profile.blockButton", t.profile.blockButton);
  const report = requireLocked(lang, "profile.reportButton", t.profile.reportButton);
  const transfer = requireLocked(lang, "relic.transferButton", t.relic.transferButton);

  const likeRow = [glassButton(like, `${CHAT_CALLBACKS.like}:${target._id}`, "danger", buttonIcon("HEART"))];
  const transferRow = [glassButton(transfer, `${CHAT_CALLBACKS.transfer}:${target._id}`, "primary", buttonIcon("CROWN"))];
  const contactRow = [glassButton(addContact, `${CHAT_CALLBACKS.addContact}:${target._id}`, "primary", buttonIcon("PLUS"))];
  const moderationRow = [
    glassButton(block, `${CHAT_CALLBACKS.block}:${target._id}`, "danger", buttonIcon("LOCK")),
    glassButton(report, `${CHAT_CALLBACKS.report}:${target._id}`, "danger", buttonIcon("REPORT")),
  ];

  // While actively connected in a chat, per owner spec, ONLY these 5
  // actions are ever shown — chat-request/direct-message/notify-on-end
  // (below) only make sense for someone you are NOT already talking to.
  if (viewContext === "chat") {
    return inlineKeyboard([likeRow, transferRow, contactRow, moderationRow]);
  }

  const chatRequest = requireLocked(lang, "profile.chatRequestButton", t.profile.chatRequestButton);
  const directMessage = requireLocked(lang, "profile.directMessageButton", t.profile.directMessageButton);
  const notifyOnEnd = requireLocked(lang, "profile.notifyOnEndButton", t.profile.notifyOnEndButton);

  return inlineKeyboard([
    likeRow,
    transferRow,
    [
      glassButton(chatRequest, CHAT_CALLBACKS.chatRequest, "primary", buttonIcon("MESSAGE")),
      glassButton(directMessage, CHAT_CALLBACKS.directMessage, "primary", buttonIcon("LETTER")),
    ],
    contactRow,
    moderationRow,
    [glassButton(notifyOnEnd, CHAT_CALLBACKS.notifyOnEnd, "primary", buttonIcon("NOTIFICATION"))],
  ]);
}


/** Sends a profile card (photo + caption, or text-only). If the photo can't
 *  be sent (a file_id from another bot, deleted file, ...) the profile is
 *  sent as plain text instead of the whole screen failing. */
export async function replyWithProfile(ctx: NavaContext, target: UserDoc, viewer: UserDoc | undefined, kb: ReturnType<typeof buildProfileKeyboard> | ReturnType<typeof inlineKeyboard>): Promise<void> {
  const text = buildProfileText(ctx.userLang, target, viewer);
  const photo = resolveProfilePhoto(target);
  if (photo) {
    try {
      await ctx.replyWithPhoto(photo, { caption: text, parse_mode: "HTML", reply_markup: kb });
      return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[profile] photo could not be sent, falling back to text:", err);
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function showOwnProfile(ctx: NavaContext): Promise<void> {
  if (!ctx.dbUser) return;
  const rows = [[glassButton("ویرایش پروفایل", "profile:edit", "primary", buttonIcon("BIOGRAPHY"))]];
  // Right under "ویرایش پروفایل": the glass "درخواست وریفای" button (hidden
  // once the user is already verified — nothing left to request).
  if (!ctx.dbUser.verified) {
    rows.push([glassButton("درخواست وریفای", VERIFY_REQUEST_CALLBACK, "primary", buttonIcon("VERIFY_REQUEST"))]);
  }
  await replyWithProfile(ctx, ctx.dbUser, undefined, inlineKeyboard(rows));
}

export function registerProfile(composer: Composer<NavaContext>) {
  composer.callbackQuery(MENU_CALLBACKS.profile, async (ctx) => {
    if (!ctx.dbUser) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    await showOwnProfile(ctx);
  });

  composer.callbackQuery(CHAT_CALLBACKS.partnerProfile, async (ctx) => {
    const sessionId = ctx.dbUser?.activeChatSessionId;
    if (!sessionId) {
      await ctx.answerCallbackQuery();
      return;
    }
    const session = await getSession(sessionId);
    if (!session) {
      await ctx.answerCallbackQuery();
      return;
    }
    const partnerId = otherParticipant(session, ctx.from!.id);
    if (!partnerId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const partner = await getUser(partnerId);
    if (!partner) {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
    const kb = buildProfileKeyboard(ctx.userLang, partner, "chat");
    await replyWithProfile(ctx, partner, ctx.dbUser, kb);

    if (await shouldNotifyProfileView(ctx.from!.id, partnerId)) {
      const partnerLang: Language = partner.languageCode ?? "fa";
      const t = dictionary(partnerLang);
      const notifyTemplate = requireLocked(partnerLang, "matching.profileViewNotification", t.matching.profileViewNotification);
      const navaEmoji = textEmoji("NAVA", "🌐");
      const notifyText = notifyTemplate.split("{{NAVA_EMOJI}}").join(navaEmoji);
      await ctx.api.sendMessage(partnerId, notifyText, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  composer.callbackQuery(new RegExp(`^${CHAT_CALLBACKS.like}:(\\d+)$`), async (ctx) => {
    const targetId = Number(ctx.match![1]);
    if (targetId === ctx.from!.id) {
      await ctx.answerCallbackQuery(); // can't like yourself; silently ignore
      return;
    }

    const db = await getDb();
    const likesCol = db.collection<{ _id: string; createdAt: Date }>("profile_likes");
    try {
      await likesCol.insertOne({ _id: `${ctx.from!.id}:${targetId}`, createdAt: new Date() });
      await incrementLikes(targetId);
      await ctx.answerCallbackQuery({ text: "❤️ لایک شد" });

      // Reflect the new count on the button itself, not just the toast —
      // otherwise the number the user is looking at never visibly changes.
      const target = await getUser(targetId);
      if (target) {
        const inChatWithTarget = ctx.dbUser?.activeChatSessionId
          ? (await getSession(ctx.dbUser.activeChatSessionId).then((s) => (s ? otherParticipant(s, ctx.from!.id) : undefined))) === targetId
          : false;
        await ctx.editMessageReplyMarkup({
          reply_markup: buildProfileKeyboard(ctx.userLang, target, inChatWithTarget ? "chat" : "lookup"),
        }).catch(() => {});
      }
    } catch (err: any) {
      if (err?.code === 11000) {
        await ctx.answerCallbackQuery({ text: "قبلاً لایک کرده بودی 👍" });
        return;
      }
      throw err;
    }
  });

}
