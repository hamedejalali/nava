import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { getSession, otherParticipant } from "../../db/models/chatSession.js";
import { getUser, incrementLikes, type UserDoc } from "../../db/models/user.js";
import { getDb } from "../../db/connect.js";
import { CHAT_CALLBACKS } from "./constants.js";
import { levelDisplay } from "../../config/levels.js";
import { textEmoji } from "../../config/emojis.js";
import { MENU_CALLBACKS } from "../menu/mainMenu.js";
import { createReport } from "../../db/models/reports.js";
import { getAllAdminIds } from "../admin/constants.js";
import { env } from "../../config/env.js";
import { distanceKm, formatDistanceFa } from "../../utils/geo.js";
import { formatPresenceFa } from "../../utils/presence.js";

const GENDER_LABEL: Record<string, string> = { male: "پسر", female: "دختر" };
const VIEW_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

async function shouldNotifyProfileView(viewerId: number, targetId: number): Promise<boolean> {
  const db = await getDb();
  interface ProfileViewCooldownDoc { _id: string; expiresAt: Date; }
  const col = db.collection<ProfileViewCooldownDoc>("profile_view_notify_cooldown");
  try {
    await col.insertOne({ _id: `${viewerId}:${targetId}`, expiresAt: new Date(Date.now() + VIEW_NOTIFY_COOLDOWN_MS) });
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
function resolveProfilePhoto(target: UserDoc): string | undefined {
  if (target.profilePhotoFileId) return target.profilePhotoFileId;
  if (target.gender === "male") return env.DEFAULT_PHOTO_MALE;
  if (target.gender === "female") return env.DEFAULT_PHOTO_FEMALE;
  return undefined;
}

function buildProfileText(lang: Language, target: UserDoc, viewer?: UserDoc): string {
  const t = dictionary(lang);
  const labels = requireLocked(lang, "profile.labels", t.profile.labels);
  const bioLabel = requireLocked(lang, "profile.bioLabel", t.profile.bioLabel);
  const idLabel = requireLocked(lang, "profile.idLabel", t.profile.idLabel);
  const distanceLabel = requireLocked(lang, "profile.distanceLabel", t.profile.distanceLabel);

  const [nameLine, ageLine, genderLine, provinceLine, cityLine] = labels.split("\n");
  const genderText = target.gender ? (GENDER_LABEL[target.gender] ?? target.gender) : "-";

  // Verified / not-verified — always shown, per owner request, right above
  // the online/last-seen line.
  const verifiedLine = target.verified
    ? `${textEmoji("VERIFIED_BADGE", "☑️")} (کاربر تایید شده از طرف ادمین)`
    : `${textEmoji("VERIFIED_BADGE", "❌")} (تایید نشده)`;

  // Real online/offline is impossible for a bot to know (Bot API has no
  // access to Telegram's own presence system) — this is the honest
  // substitute: activity with THIS bot. See src/utils/presence.ts.
  const presenceLine = formatPresenceFa(target.lastActivityAt);

  const lines = [
    `${nameLine} ${target.nickname ?? "-"}`,
    `${ageLine} ${target.age ?? "-"}`,
    `${genderLine} ${genderText}`,
    `${provinceLine} ${target.province ?? "-"}`,
    `${cityLine} ${target.city ?? "-"}`,
    `⭐ سطح کاربر: ${levelDisplay(target.level)}`,
  ];
  if (target.bio) lines.push("", `${bioLabel} ${target.bio}`);

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

function buildProfileKeyboard(lang: Language, target: UserDoc) {
  const t = dictionary(lang);
  const like = requireLocked(lang, "profile.likeButton", t.profile.likeButton)(target.likesCount ?? 0);
  const chatRequest = requireLocked(lang, "profile.chatRequestButton", t.profile.chatRequestButton);
  const directMessage = requireLocked(lang, "profile.directMessageButton", t.profile.directMessageButton);
  const addContact = requireLocked(lang, "profile.addContactButton", t.profile.addContactButton);
  const block = requireLocked(lang, "profile.blockButton", t.profile.blockButton);
  const report = requireLocked(lang, "profile.reportButton", t.profile.reportButton);
  const notifyOnEnd = requireLocked(lang, "profile.notifyOnEndButton", t.profile.notifyOnEndButton);
  const transfer = requireLocked(lang, "relic.transferButton", t.relic.transferButton);

  return inlineKeyboard([
    [glassButton(like, `${CHAT_CALLBACKS.like}:${target._id}`, "danger", buttonIcon("HEART"))],
    [glassButton(transfer, `${CHAT_CALLBACKS.transfer}:${target._id}`, "primary", buttonIcon("CROWN"))],
    [
      glassButton(chatRequest, CHAT_CALLBACKS.chatRequest, "primary", buttonIcon("MESSAGE")),
      glassButton(directMessage, CHAT_CALLBACKS.directMessage, "primary", buttonIcon("LETTER")),
    ],
    [glassButton(addContact, CHAT_CALLBACKS.addContact, "primary", buttonIcon("PLUS"))],
    [
      glassButton(block, CHAT_CALLBACKS.block, "danger", buttonIcon("LOCK")),
      glassButton(report, `${CHAT_CALLBACKS.report}:${target._id}`, "danger", buttonIcon("REPORT")),
    ],
    [glassButton(notifyOnEnd, CHAT_CALLBACKS.notifyOnEnd, "primary", buttonIcon("NOTIFICATION"))],
  ]);
}

export async function showOwnProfile(ctx: NavaContext): Promise<void> {
  if (!ctx.dbUser) return;
  const text = buildProfileText(ctx.userLang, ctx.dbUser);
  const kb = inlineKeyboard([[glassButton("📝 ویرایش پروفایل", "profile:edit", "primary")]]);
  const photo = resolveProfilePhoto(ctx.dbUser);

  if (photo) {
    await ctx.replyWithPhoto(photo, { caption: text, parse_mode: "HTML", reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
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
    const text = buildProfileText(ctx.userLang, partner, ctx.dbUser);
    const kb = buildProfileKeyboard(ctx.userLang, partner);
    const photo = resolveProfilePhoto(partner);

    if (photo) {
      await ctx.replyWithPhoto(photo, { caption: text, parse_mode: "HTML", reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }

    if (await shouldNotifyProfileView(ctx.from!.id, partnerId)) {
      const partnerLang: Language = partner.languageCode ?? "fa";
      const t = dictionary(partnerLang);
      const notifyText = requireLocked(partnerLang, "matching.profileViewNotification", t.matching.profileViewNotification);
      await ctx.api.sendMessage(partnerId, notifyText).catch(() => {});
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
      await ctx.answerCallbackQuery({ text: "❤️" });
    } catch (err: any) {
      if (err?.code === 11000) {
        await ctx.answerCallbackQuery(); // already liked — no double-count
        return;
      }
      throw err;
    }
  });

  composer.callbackQuery(new RegExp(`^${CHAT_CALLBACKS.report}:(\\d+)$`), async (ctx) => {
    const targetId = Number(ctx.match![1]);
    if (targetId === ctx.from!.id) {
      await ctx.answerCallbackQuery();
      return;
    }

    const report = await createReport(ctx.from!.id, targetId, ctx.dbUser?.activeChatSessionId);
    await ctx.answerCallbackQuery({ text: "گزارش ثبت شد، ممنون از همکاریت 🙏" });

    for (const adminId of await getAllAdminIds()) {
      await ctx.api
        .sendMessage(
          adminId,
          `⚠️ گزارش جدید\n\nگزارش‌دهنده: ${ctx.from!.id}\nگزارش‌شده: ${targetId}\nشناسه‌ی گزارش: ${report._id}`
        )
        .catch(() => {});
    }
  });
}
