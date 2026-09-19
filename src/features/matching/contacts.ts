import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { addContact, removeContact, listContacts } from "../../db/models/contacts.js";
import { blockUser } from "../../db/models/blocks.js";
import { getUser, setActiveChatSession } from "../../db/models/user.js";
import { getSession, otherParticipant, endSessionOnce } from "../../db/models/chatSession.js";
import { CHAT_CALLBACKS } from "./constants.js";
import { buildProfileText, buildProfileKeyboard, resolveProfilePhoto } from "./profile.js";

const CB = {
  remove: "contacts:remove:", // + targetId
};

async function renderContactsList(ctx: NavaContext) {
  const ids = await listContacts(ctx.from!.id);
  if (ids.length === 0) {
    await ctx.reply("هنوز کسی رو به مخاطبینت اضافه نکردی.");
    return;
  }

  const rows = [];
  for (const id of ids) {
    const u = await getUser(id);
    if (!u) continue;
    rows.push([
      glassButton(`👤 ${u.nickname ?? u.anonId}`, `profile:view:${id}`, "primary"),
      glassButton("🗑 حذف", `${CB.remove}${id}`, "danger"),
    ]);
  }
  await ctx.reply("👥 مخاطبین من:", { reply_markup: inlineKeyboard(rows) });
}

export function registerContacts(composer: Composer<NavaContext>) {
  composer.callbackQuery(new RegExp(`^${CHAT_CALLBACKS.addContact}:(\\d+)$`), async (ctx) => {
    const targetId = Number(ctx.match![1]);
    if (targetId === ctx.from!.id) {
      await ctx.answerCallbackQuery();
      return;
    }
    const added = await addContact(ctx.from!.id, targetId);
    await ctx.answerCallbackQuery({ text: added ? "✅ به مخاطبین اضافه شد" : "قبلاً اضافه شده بود" });
  });

  composer.callbackQuery(new RegExp(`^${CB.remove}(\\d+)$`), async (ctx) => {
    const targetId = Number(ctx.match![1]);
    await removeContact(ctx.from!.id, targetId);
    await ctx.answerCallbackQuery({ text: "حذف شد" });
    await ctx.deleteMessage().catch(() => {});
    await renderContactsList(ctx);
  });

  // Opening a contact's card from the list — full "lookup" profile (not
  // in an active chat with them), matching the username-lookup view.
  composer.callbackQuery(new RegExp(`^profile:view:(\\d+)$`), async (ctx) => {
    const targetId = Number(ctx.match![1]);
    const target = await getUser(targetId);
    if (!target) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    const text = buildProfileText(ctx.userLang, target, ctx.dbUser);
    const kb = buildProfileKeyboard(ctx.userLang, target, "lookup");
    const photo = resolveProfilePhoto(target);
    if (photo) {
      await ctx.replyWithPhoto(photo, { caption: text, parse_mode: "HTML", reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }
  });

  composer.callbackQuery(new RegExp(`^${CHAT_CALLBACKS.block}:(\\d+)$`), async (ctx) => {
    const targetId = Number(ctx.match![1]);
    if (targetId === ctx.from!.id) {
      await ctx.answerCallbackQuery();
      return;
    }

    await blockUser(ctx.from!.id, targetId);

    // If currently chatting with exactly this person, end that chat too —
    // blocking mid-conversation must not leave a dangling "active" session.
    const sessionId = ctx.dbUser?.activeChatSessionId;
    if (sessionId) {
      const session = await getSession(sessionId);
      if (session && otherParticipant(session, ctx.from!.id) === targetId) {
        const result = await endSessionOnce(sessionId, ctx.from!.id);
        if (result.status === "ended") {
          await setActiveChatSession(session.userA, undefined);
          await setActiveChatSession(session.userB, undefined);
          await ctx.api.sendMessage(targetId, "🚫 مخاطب شما چت را قطع و شما را مسدود کرد.").catch(() => {});
        }
      }
    }

    await ctx.answerCallbackQuery({ text: "🚫 این کاربر مسدود شد و دیگه بهت پیشنهاد نمیشه." });
  });
}

export async function showContactsList(ctx: NavaContext): Promise<void> {
  await renderContactsList(ctx);
}
