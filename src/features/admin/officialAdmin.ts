import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { createOfficialAccount } from "../../db/models/seeds.js";
import { isOwner } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { logAdminAction } from "../../db/models/adminLog.js";

/** Owner-only «🏛 ساخت اکانت حقوقی»: a legal-entity account, run by the owner exactly like «Nava» (blue tick + gold coin, never a real person).
 *  Flow: name → photo (or «رد»). Afterwards it shows up in the Mini App account switcher, where the chat-request switch lives. */
const FLOW = "official_add";

export function registerOfficialAdmin(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const text = ctx.message.text.trim();
    if (text === ADMIN_MENU_LABELS.officialAdd) {
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "name" });
      await ctx.reply("نام اکانت حقوقی رو بفرست (مثلاً «پشتیبانی مویا»). برای لغو: /cancel");
      return;
    }
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    if (flow.stage === "name") {
      const name = text.replace(/\s+/g, " ").slice(0, 32);
      if (name.length < 2) return void (await ctx.reply("نام خیلی کوتاهه. دوباره بفرست."));
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "photo", data: { name } });
      await ctx.reply("حالا عکس پروفایل رو بفرست (یا بنویس «رد» تا بعداً از مینی‌اپ بذاری).");
      return;
    }
    if (flow.stage === "photo") {
      if (text !== "رد") return void (await ctx.reply("عکس بفرست یا «رد» بنویس."));
      await finish(ctx, String((flow.data as any)?.name ?? ""), undefined);
    }
  });

  composer.on("message:photo", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW || flow.stage !== "photo") return next();
    const p = ctx.message.photo;
    await finish(ctx, String((flow.data as any)?.name ?? ""), p[p.length - 1]?.file_id);
  });
}

async function finish(ctx: NavaContext, name: string, fileId: string | undefined) {
  await setAdminFlow(ctx.from!.id, null);
  const u = await createOfficialAccount(name, fileId);
  await logAdminAction(ctx.from!.id, "official_create", `${u._id}:${u.anonId}`).catch(() => {});
  await ctx.reply(`✅ اکانت حقوقی «${name}» ساخته شد (${u.anonId}).\nاز مینی‌اپ ← تعویض اکانت واردش شو؛ از منوی ☰ همون‌جا می‌تونی «درخواست چت» رو روشن/خاموش کنی.`);
}
