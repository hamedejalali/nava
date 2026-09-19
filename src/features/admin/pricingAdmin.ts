import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getPackages, setPackages, parsePackagesJson, type PricingKind } from "../../db/models/pricing.js";
import { isAdmin } from "./constants.js";
import { setAdminFlow, getAdminFlow, isFlowCancelSignal } from "./flowState.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

const CB = { stars: "admin:pricing:stars", gateway: "admin:pricing:gateway" };

function exampleFor(kind: PricingKind): string {
  return kind === "stars"
    ? '[{"price":50,"relic":10},{"price":100,"relic":25},{"price":250,"relic":75}]\n(price = تعداد استارز)'
    : '[{"price":50000,"relic":10},{"price":100000,"relic":25}]\n(price = مبلغ به تومان)';
}

async function showCurrent(ctx: NavaContext, kind: PricingKind) {
  const packages = await getPackages(kind);
  const label = kind === "stars" ? "استارز" : "درگاه (تومان)";
  await ctx.reply(
    `قیمت‌های فعلیِ خرید با ${label}:\n\n<code>${JSON.stringify(packages)}</code>\n\n` +
      `برای تغییر، یه JSON جدید به همین فرمت بفرست:\n${exampleFor(kind)}`,
    { parse_mode: "HTML" }
  );
  await setAdminFlow(ctx.from!.id, { flow: "pricing", stage: kind });
}

export function registerPricingAdmin(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    if (ctx.message.text.trim() === ADMIN_MENU_LABELS.pricing) {
      await ctx.reply("قیمت کدوم روش رو می‌خوای تنظیم کنی؟", {
        reply_markup: inlineKeyboard([
          [glassButton("⭐ قیمت‌های استارز", CB.stars, "primary")],
          [glassButton("💳 قیمت‌های درگاه", CB.gateway, "primary")],
        ]),
      });
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== "pricing") return next();
    const kind = flow.stage as PricingKind;

    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    try {
      const packages = parsePackagesJson(text);
      await setPackages(kind, packages, ctx.from!.id);
      await setAdminFlow(ctx.from!.id, null);
      await ctx.reply("✅ قیمت‌ها بروزرسانی شد.");
    } catch (err: any) {
      await ctx.reply(`❌ ${err?.message ?? "فرمت نامعتبر"}\n\nدوباره بفرست یا «لغو» بنویس.`);
    }
  });

  composer.callbackQuery(CB.stars, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await showCurrent(ctx, "stars");
  });
  composer.callbackQuery(CB.gateway, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await showCurrent(ctx, "gateway");
  });
}
