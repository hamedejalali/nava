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

const GENDER_LABEL: Record<string, string> = { male: "پسر", female: "دختر" };
const VIEW_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

interface ProfileViewCooldownDoc {
  _id: string;
  expiresAt: Date;
}

async function shouldNotifyProfileView(viewerId: number, targetId: number): Promise<boolean> {
  const db = await getDb();
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

function buildProfileText(lang: Language, target: UserDoc): string {
  const t = dictionary(lang);
  const labels = requireLocked(lang, "profile.labels", t.profile.labels);
  const bioLabel = requireLocked(lang, "profile.bioLabel", t.profile.bioLabel);
  const onlineStatus = requireLocked(lang, "profile.onlineNowStatus", t.profile.onlineNowStatus);
  const idLabel = requireLocked(lang, "profile.idLabel", t.profile.idLabel);
  const distanceLabel = requireLocked(lang, "profile.distanceLabel", t.profile.distanceLabel);
  const locationMissing = requireLocked(lang, "profile.partnerLocationMissing", t.profile.partnerLocationMissing);

  const [nameLine, ageLine, genderLine, provinceLine, cityLine] = labels.split("\n");
  const genderText = target.gender ? (GENDER_LABEL[target.gender] ?? target.gender) : "-";
  const verifiedBadge = target.verified ? ` ${textEmoji("VERIFIED_BADGE", "☑️")}` : "";

  const lines = [
    `${nameLine} ${target.nickname ?? "-"}${verifiedBadge}`,
    `${ageLine} ${target.age ?? "-"}`,
    `${genderLine} ${genderText}`,
    `${provinceLine} ${target.province ?? "-"}`,
    `${cityLine} ${target.city ?? "-"}`,
    `⭐ سطح کاربر: ${levelDisplay(target.level)}`,
  ];
  if (target.bio) lines.push("", `${bioLabel} ${target.bio}`);
  lines.push("", onlineStatus, `${idLabel} @${target.anonId}`, `${distanceLabel} ${locationMissing}`);

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

export function registerProfile(composer: Composer<NavaContext>) {
  composer.callbackQuery(MENU_CALLBACKS.profile, async (ctx) => {
    if (!ctx.dbUser) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(buildProfileText(ctx.userLang, ctx.dbUser), {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([[glassButton("📝 ویرایش پروفایل", "profile:edit", "primary")]]),
    });
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
    await ctx.reply(buildProfileText(ctx.userLang, partner), {
      parse_mode: "HTML",
      reply_markup: buildProfileKeyboard(ctx.userLang, partner),
    });

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