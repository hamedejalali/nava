import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { cancelButton } from "../../ui/cancelButton.js";
import { buttonIcon } from "../../config/emojis.js";
import { listAllChannels, addChannel, toggleChannelActive, removeChannel } from "../../db/models/channel.js";
import { isAdmin } from "./constants.js";

const CB = {
  open: "admin:channels",
  add: "admin:channels:add",
  addCancel: "admin:channels:add:cancel",
  toggle: "admin:channels:toggle:", // + id
  remove: "admin:channels:remove:", // + id
};
export { CB as CHANNEL_ADMIN_CALLBACKS };

// Tiny dedicated (MongoDB-backed, not in-memory) flag for "this admin is
// currently expected to send a channel @username next". Reuses the same
// db connection; kept in its own collection to avoid overloading the
// generic content-edit session shape used by guides.ts.
import { getDb } from "../../db/connect.js";
async function setAwaitingChannel(adminId: number, waiting: boolean): Promise<void> {
  const db = await getDb();
  if (waiting) {
    await db.collection("admin_channel_add").updateOne({ _id: adminId }, { $set: { startedAt: new Date() } }, { upsert: true });
  } else {
    await db.collection("admin_channel_add").deleteOne({ _id: adminId });
  }
}
async function isAwaitingChannel(adminId: number): Promise<boolean> {
  const db = await getDb();
  const doc = await db.collection("admin_channel_add").findOne({ _id: adminId });
  return !!doc;
}

async function renderChannelsScreen(ctx: NavaContext) {
  const channels = await listAllChannels();

  const lines =
    channels.length === 0
      ? "هیچ کانالی تنظیم نشده."
      : channels.map((c, i) => `${i + 1}. ${c.isActive ? "✅" : "⛔"} ${c.title} (${c.handle})`).join("\n");

  const rows = channels.map((c) => [
    glassButton(c.isActive ? "غیرفعال کردن" : "فعال کردن", `${CB.toggle}${c._id}`, c.isActive ? "danger" : "success"),
    glassButton("🗑 حذف", `${CB.remove}${c._id}`, "danger"),
  ]);

  if (channels.length < 10) {
    rows.push([glassButton("➕ افزودن کانال", CB.add, "primary")]);
  }

  await ctx.reply(`کانال‌های جوین اجباری:\n\n${lines}`, { reply_markup: inlineKeyboard(rows) });
}

export function registerAdminChannels(composer: Composer<NavaContext>) {
  composer.callbackQuery(CB.open, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await renderChannelsScreen(ctx);
  });

  composer.callbackQuery(CB.add, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await ctx.reply("یوزرنیم عمومی کانال رو بفرست (مثلا @nava). ربات باید ادمین اون کانال باشه.", {
      reply_markup: inlineKeyboard([[cancelButton("لغو", CB.addCancel)]]),
    });
    await setAwaitingChannel(ctx.from!.id, true);
  });

  composer.callbackQuery(CB.addCancel, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await setAwaitingChannel(ctx.from!.id, false);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("لغو شد.").catch(() => {});
  });

  composer.callbackQuery(new RegExp(`^${CB.toggle}(\\d+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await toggleChannelActive(Number(ctx.match![1]));
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    await renderChannelsScreen(ctx);
  });

  composer.callbackQuery(new RegExp(`^${CB.remove}(\\d+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await removeChannel(Number(ctx.match![1]));
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    await renderChannelsScreen(ctx);
  });

  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const waiting = await isAwaitingChannel(ctx.from!.id);
    if (!waiting) return next();

    const raw = ctx.message.text.trim();
    const username = raw.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "");

    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) {
      await ctx.reply("یوزرنیم معتبر نیست. یه یوزرنیم عمومی مثل @nava بفرست یا لغو کن.");
      return;
    }

    try {
      const chat = await ctx.api.getChat(`@${username}`);
      const title = "title" in chat && chat.title ? chat.title : username;

      const result = await addChannel({
        title,
        chatRef: `@${username}`,
        url: `https://t.me/${username}`,
        handle: `@${username}`,
      });

      await setAwaitingChannel(ctx.from!.id, false);

      if (result.status === "limit_reached") {
        await ctx.reply("حداکثر ۱۰ کانال قابل تنظیمه.");
        return;
      }
      await ctx.reply(`✅ کانال «${title}» اضافه شد.`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[admin/channels] getChat failed:", err);
      await ctx.reply(
        "نتونستم این کانال رو پیدا کنم. مطمئن شو یوزرنیم درسته، کانال عمومیه، و ربات توی اون کانال ادمینه — بعد دوباره بفرست یا لغو کن."
      );
    }
  });
}
