import type { Composer } from "grammy";
import { waitUntil } from "@vercel/functions";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, glassUrlButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { escapeHtml } from "../../utils/html.js";
import { getShopConfig, type ShopButton, type ShopColor } from "../../db/models/shopConfig.js";
import { getPackages } from "../../db/models/pricing.js";
import { getOrCreateStarsOrder } from "../../db/models/starsOrder.js";
import { hasUnlimitedXp } from "../../db/models/relic.js";
import { MENU_CALLBACKS } from "../menu/mainMenu.js";
import { depositAvailable, describeWalletError, getDepositAddress, syncWalletDeposits, watchUserDeposit } from "../../services/wallet/walletDeposits.js";
import { checkRateLimit } from "../../utils/rateLimit.js";

/**
 * «ژتون» purchase menu. ONE bot message: every button edits it in place and every sub-screen ends with a
 * glass «بازگشت» button that edits it back — nothing new is sent while the user browses.
 *   🏠 shop:home    → three methods: ⭐ استارز / 🪙 ژتون / 📥 آدرس ولت
 *   ⭐ shop:stars   → admin text + admin-defined buttons (link buttons, or «pay N Stars → get M ژتون»)
 *   🪙 shop:jeton   → admin text + admin-defined link buttons
 *   📥 shop:wallet  → the user's Wallet deposit address (Flow A) + how to use it
 * The texts, the buttons, their colours and links are edited in the admin panel («🛒 منوی خرید»).
 */
export const SHOP_CB = { home: "shop:home", stars: "shop:stars", jeton: "shop:jeton", wallet: "shop:wallet", check: "shop:chk", buyPrefix: "shop:b:" } as const;

export const fmtBalance = (n: number | undefined) => String(Number((n ?? 0).toFixed(4)));

function back() {
  return [glassButton("🔙 بازگشت", SHOP_CB.home, "danger", buttonIcon("BACK"))];
}

function toButtons(btns: ShopButton[]) {
  return btns.map((b) =>
    b.kind === "url" ? [glassUrlButton(b.label, b.url!, b.color)] : [glassButton(b.label, `${SHOP_CB.buyPrefix}${b.id}`, b.color)],
  );
}

/** Stars buttons: the owner's own buttons; while none exist the old package list keeps working. */
export async function starsButtons(configured: ShopButton[]): Promise<ShopButton[]> {
  if (configured.length > 0) return configured;
  const pk = await getPackages("stars");
  const colors: ShopColor[] = ["primary", "success"];
  return pk.map((p, i) => ({ id: `p${i}`, kind: "stars", label: `⭐ ${p.price} = ${p.relic} ژتون`, color: colors[i % 2]!, price: p.price, relic: p.relic }));
}

async function home(ctx: NavaContext) {
  const cfg = await getShopConfig();
  const bal = ctx.from && hasUnlimitedXp(ctx.from.id) ? "∞" : fmtBalance(ctx.dbUser?.relicBalance);
  return {
    text: escapeHtml(cfg.mainText).replace(/\{balance\}/g, bal),
    kb: inlineKeyboard([
      [glassButton("⭐ استارز", SHOP_CB.stars, "primary")],
      [glassButton("🪙 ژتون", SHOP_CB.jeton, "success")],
      [glassButton("📥 آدرس ولت", SHOP_CB.wallet, "primary")],
    ]),
  };
}

/** Edits the message the button belongs to; a menu tap (no message) sends the first and only message. */
async function show(ctx: NavaContext, text: string, kb: ReturnType<typeof inlineKeyboard>) {
  const base = { parse_mode: "HTML" as const, reply_markup: kb, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, base);
    } catch (err: any) {
      if (/not modified/i.test(String(err?.description ?? err?.message))) return;
      await ctx.reply(text, base).catch(() => {});
    }
    return;
  }
  await ctx.reply(text, base);
}

export async function showRelicScreen(ctx: NavaContext): Promise<void> {
  const h = await home(ctx);
  await show(ctx, h.text, h.kb);
}

async function walletScreen(ctx: NavaContext) {
  const cfg = await getShopConfig();
  if (!(await depositAvailable())) {
    return show(ctx, `${escapeHtml(cfg.wallet.text)}\n\nدریافت از ولت فعلاً در دسترس نیست.`, inlineKeyboard([back()]));
  }
  const rl = await checkRateLimit(ctx.from!.id, "wallet-address", 10, 60_000);
  if (!rl.allowed) return void (await ctx.answerCallbackQuery({ text: "کمی صبر کن.", show_alert: false }).catch(() => {}));
  const r = await getDepositAddress(ctx.from!.id);
  if (!r.ok) {
    return show(ctx, `${escapeHtml(cfg.wallet.text)}\n\n${r.reason === "unavailable" ? "دریافت از ولت فعلاً در دسترس نیست." : escapeHtml(describeWalletError(r.code ?? ""))}`, inlineKeyboard([back()]));
  }
  await show(
    ctx,
    `${escapeHtml(cfg.wallet.text)}\n\n<b>آدرس ولت تو در مویا:</b>\n<code>${r.address}</code>\n\n` +
      "توی ربات ولت: 📤 ارسال ← این آدرس رو بچسبون ← مبلغ رو بنویس ← «✅ تایید انتقال» رو بزن.\n" +
      "<blockquote>بعد از تایید توی ولت، ژتون خودکار به حسابت اضافه میشه و همین‌جا بهت خبر میدم.</blockquote>",
    inlineKeyboard([[glassButton("🔄 بررسی واریز", SHOP_CB.check, "success")], back()]),
  );
  // while the user is on this screen: ask the Wallet every 5 seconds (the global sweep is every minute)
  const api = ctx.api;
  const uid = ctx.from!.id;
  waitUntil(watchUserDeposit(api, uid).catch(() => {}));
}

export function registerShop(composer: Composer<NavaContext>) {
  composer.callbackQuery(MENU_CALLBACKS.relicCoin, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showRelicScreen(ctx);
  });

  composer.callbackQuery(SHOP_CB.home, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showRelicScreen(ctx);
  });

  composer.callbackQuery(SHOP_CB.stars, async (ctx) => {
    await ctx.answerCallbackQuery();
    const cfg = await getShopConfig();
    const btns = await starsButtons(cfg.stars.buttons);
    await show(ctx, escapeHtml(cfg.stars.text), inlineKeyboard([...toButtons(btns), back()]));
  });

  composer.callbackQuery(SHOP_CB.jeton, async (ctx) => {
    await ctx.answerCallbackQuery();
    const cfg = await getShopConfig();
    await show(ctx, escapeHtml(cfg.jeton.text), inlineKeyboard([...toButtons(cfg.jeton.buttons), back()]));
  });

  composer.callbackQuery(SHOP_CB.wallet, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await walletScreen(ctx);
  });

  composer.callbackQuery(SHOP_CB.check, async (ctx) => {
    const rl = await checkRateLimit(ctx.from!.id, "wallet-check", 12, 60_000);
    if (!rl.allowed) return void (await ctx.answerCallbackQuery({ text: "کمی صبر کن." }));
    const r = await syncWalletDeposits(ctx.api, { force: true });
    await ctx.answerCallbackQuery({
      text: r.error ? "الان ارتباط با ولت برقرار نشد؛ چند لحظه بعد دوباره امتحان کن." : r.credited > 0 ? "✅ واریز دریافت شد؛ پیامش برات اومد." : "هنوز واریزی از ولت نرسیده. بعد از «تایید انتقال» توی ولت دوباره بزن.",
      show_alert: true,
    });
  });

  // pay N Stars → the order is stored with the price/amount OFFERED now (see db/models/starsOrder.ts)
  composer.callbackQuery(new RegExp(`^${SHOP_CB.buyPrefix}([A-Za-z0-9]{1,16})$`), async (ctx) => {
    const id = String(ctx.match![1]);
    const cfg = await getShopConfig();
    const list = await starsButtons(cfg.stars.buttons);
    const idx = list.findIndex((b) => b.id === id);
    const b = list[idx];
    if (!b || b.kind !== "stars" || !b.price || !b.relic) return void (await ctx.answerCallbackQuery({ text: "این گزینه دیگه معتبر نیست." }));
    await ctx.answerCallbackQuery();
    const order = await getOrCreateStarsOrder(ctx.from!.id, idx, { price: b.price, relic: b.relic });
    await ctx.api.sendInvoice(ctx.chat!.id, `${order.relic} ژتون`, `خرید ${order.relic} ژتون برای مویا`, `relic:o:${order._id}`, "XTR", [{ label: `${order.relic} ژتون`, amount: order.price }], { provider_token: "" });
  });
}
