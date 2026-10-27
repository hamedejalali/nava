import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { buttonIcon } from "../../config/emojis.js";
import { getDb } from "../../db/connect.js";
import { getUser, type UserDoc } from "../../db/models/user.js";
import { createChatRequest } from "../../db/models/chatRequest.js";
import { hasUnlimitedXp } from "../../db/models/relic.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { escapeHtml } from "../../utils/html.js";
import { distanceKm, formatDistanceFa } from "../../utils/geo.js";
import { isFlowCancelSignal } from "../admin/flowState.js";
import { cancelKeyboard, clearAllUserFlows } from "../common/userFlows.js";
import { sendRestore } from "../common/keyboardState.js";
import { isOfficial } from "../../services/nava/common.js";
import { buildProfileKeyboard, replyWithProfile, shouldNotifyProfileView } from "../matching/profile.js";
import { sendRevealNotification } from "../matching/profileReveal.js";
import { sendChatRequestToTarget } from "../matching/chatRequest.js";
import { CHAT_CALLBACKS } from "../matching/constants.js";
import { isAdmin } from "../admin/constants.js";

/**
 * v1.27 — «🔎 جستجوی کاربران» and «📍 افراد نزدیک» work INSIDE the bot (they used to answer "coming soon").
 *
 *  - Search: by anonymous id / nickname (typed, with the single red «❌ لغو» keyboard), or a quick list
 *    (suggested / girls / boys). Every result is a button that opens the normal profile card.
 *  - Nearby: real distance when both people shared a location (profile → edit → location); without a location the
 *    list falls back to people of the same city, then the same province.
 *  - The profile card's «درخواست چت» / «پیام مستقیم» / «اطلاع بده» buttons (they were dead stubs) work here too.
 */

const PAGE = 8;
const FLOW = "user_search_flow";

const CB = {
  menu: "usr:m",
  byQuery: "usr:q",
  list: "usr:l", // usr:l:<mode>:<page>
  view: "usr:v", // usr:v:<id>
  nearby: "usr:n", // usr:n:<page>
} as const;

export const PROFILE_CB = {
  chat: `${CHAT_CALLBACKS.chatRequest}:`, // + targetId
  dm: `${CHAT_CALLBACKS.directMessage}:`,
  notify: `${CHAT_CALLBACKS.notifyOnEnd}:`,
  confirm: "pcr:", // pcr:<b|m>:<id>
} as const;

type Mode = "sug" | "f" | "m";

const usersCol = async () => (await getDb()).collection<UserDoc>("users");
const flowCol = async () => (await getDb()).collection<{ _id: number; stage: string }>(FLOW);

/** Who may appear in the lists: finished profile, not banned, not a hidden default member, not an official account, not me. */
function visibleFilter(meId: number): Record<string, unknown> {
  return {
    _id: { $ne: meId },
    onboardingStep: "COMPLETED",
    banned: { $ne: true },
    seedHidden: { $ne: true },
    official: { $ne: true },
  };
}

const GENDER_ICON: Record<string, string> = { male: "👨", female: "👩" };

function rowLabel(u: UserDoc, km?: number): string {
  const parts = [`${u.gender ? (GENDER_ICON[u.gender] ?? "") : ""} ${u.nickname ?? "کاربر"}`.trim()];
  if (u.age) parts.push(String(u.age));
  if (km !== undefined) parts.push(formatDistanceFa(km));
  else if (u.city) parts.push(u.city);
  return (u.verified ? "✅ " : "") + parts.join(" · ");
}

function pagerRow(prefix: string, page: number, hasMore: boolean) {
  const row = [];
  if (page > 0) row.push(glassButton("⬅️ قبلی", `${prefix}:${page - 1}`, "primary"));
  if (hasMore) row.push(glassButton("بعدی ➡️", `${prefix}:${page + 1}`, "primary"));
  return row;
}

function resultKeyboard(users: Array<{ u: UserDoc; km?: number }>, pager: ReturnType<typeof pagerRow>) {
  const rows = users.map(({ u, km }) => [glassButton(rowLabel(u, km), `${CB.view}:${u._id}`, "primary")]);
  if (pager.length) rows.push(pager);
  rows.push([glassButton("🔎 جستجوی جدید", CB.menu, "primary")]);
  return inlineKeyboard(rows);
}

// ---------------------------------------------------------------- search

export async function showSearchMenu(ctx: NavaContext): Promise<void> {
  await ctx.reply("🔎 <b>جستجوی کاربران</b>\n\nچطور دنبال کسی بگردم؟", {
    parse_mode: "HTML",
    reply_markup: inlineKeyboard([
      [glassButton("🆔 با آیدی یا نام", CB.byQuery, "primary", buttonIcon("SEARCH"))],
      [glassButton("✨ پیشنهادی", `${CB.list}:sug:0`, "success"), glassButton("👩 دخترها", `${CB.list}:f:0`, "primary"), glassButton("👨 پسرها", `${CB.list}:m:0`, "primary")],
      [glassButton("📍 افراد نزدیک", CB.nearby + ":0", "primary", buttonIcon("LOCATION"))],
    ]),
  });
}

async function runList(meId: number, mode: Mode, page: number): Promise<{ users: UserDoc[]; hasMore: boolean }> {
  const filter: Record<string, unknown> = visibleFilter(meId);
  if (mode === "f") filter.gender = "female";
  if (mode === "m") filter.gender = "male";
  const col = await usersCol();
  const rows = await col
    .find(filter as any)
    .sort({ lastActivityAt: -1 })
    .skip(page * PAGE)
    .limit(PAGE + 1)
    .toArray();
  return { users: rows.slice(0, PAGE), hasMore: rows.length > PAGE };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runQuery(meId: number, raw: string): Promise<UserDoc[]> {
  const q = raw.trim().replace(/^[@/]/, "");
  const col = await usersCol();
  const base = visibleFilter(meId);
  if (/^user_[A-Za-z0-9]{6}$/.test(q)) {
    const one = await col.find({ ...base, anonId: q } as any).limit(1).toArray();
    return one;
  }
  const rx = new RegExp(escapeRegex(q), "i");
  return col
    .find({ ...base, $or: [{ nickname: { $regex: rx } }, { miniUsername: { $regex: rx } }] } as any)
    .limit(PAGE)
    .toArray();
}

// --------------------------------------------------------------- nearby

export async function showNearby(ctx: NavaContext, page = 0, edit = false): Promise<void> {
  const me = ctx.dbUser ?? (ctx.from ? await getUser(ctx.from.id) : null);
  if (!me) return;
  const col = await usersCol();
  const base = visibleFilter(me._id);
  let list: Array<{ u: UserDoc; km?: number }> = [];
  let title = "";

  if (me.location) {
    const withLoc = await col.find({ ...base, location: { $exists: true } } as any).limit(600).toArray();
    list = withLoc
      .filter((u) => u.location)
      .map((u) => ({ u, km: distanceKm(me.location!, u.location!) }))
      .sort((a, b) => a.km! - b.km!);
    title = "📍 <b>افراد نزدیک</b>\nبر اساس موقعیتی که ثبت کردی، از نزدیک به دور:";
  }
  if (list.length === 0 && me.city) {
    const same = await col.find({ ...base, city: me.city } as any).sort({ lastActivityAt: -1 }).limit(300).toArray();
    list = same.map((u) => ({ u }));
    title = `📍 <b>هم‌شهری‌ها</b>\nکاربرانی از ${escapeHtml(me.city)}${me.location ? "" : "\n<blockquote>برای دیدن فاصله‌ی دقیق، موقعیت مکانیت رو ثبت کن: پروفایل ← ویرایش پروفایل ← موقعیت مکانی.</blockquote>"}`;
  }
  if (list.length === 0 && me.province) {
    const same = await col.find({ ...base, province: me.province } as any).sort({ lastActivityAt: -1 }).limit(300).toArray();
    list = same.map((u) => ({ u }));
    title = `📍 <b>هم‌استانی‌ها</b>\nکاربرانی از ${escapeHtml(me.province)}`;
  }

  const body = list.slice(page * PAGE, page * PAGE + PAGE);
  const text = body.length === 0 ? "📍 فعلاً کسی نزدیک تو پیدا نشد. کمی بعد دوباره سر بزن." : title;
  const kb = resultKeyboard(body, pagerRow(CB.nearby, page, list.length > (page + 1) * PAGE));
  const opts = { parse_mode: "HTML" as const, reply_markup: kb };
  if (edit) {
    await ctx.editMessageText(text, opts).catch(async () => void (await ctx.reply(text, opts)));
  } else {
    await ctx.reply(text, opts);
  }
}

// -------------------------------------------------------------- profile

async function openProfile(ctx: NavaContext, targetId: number): Promise<void> {
  const me = ctx.dbUser;
  if (!me) return;
  const target = await getUser(targetId);
  if (!target || target.banned || target.onboardingStep !== "COMPLETED" || (target as any).seedHidden) {
    await ctx.reply("این کاربر دیگه در دسترس نیست.");
    return;
  }
  await replyWithProfile(ctx, target, me, buildProfileKeyboard(ctx.userLang, target, "lookup"));
  if (isAdmin(ctx)) return; // moderation looks never notify the other side
  if (await shouldNotifyProfileView(me._id, target._id, "lookup")) await sendRevealNotification(ctx.api, me._id, target);
}

// ------------------------------------------------- chat-end watch (notify)

const WATCH = "chat_end_watch";

/** Called when a chat of `userId` ends: tells everyone who asked «به محض اتمام چت اطلاع بده». Never throws. */
export async function notifyChatEndWatchers(api: { sendMessage: (chatId: number, text: string, other?: any) => Promise<unknown> }, userId: number): Promise<void> {
  try {
    const col = (await getDb()).collection<{ _id: string; watcherId: number; targetId: number }>(WATCH);
    const watchers = await col.find({ targetId: userId }).toArray();
    if (watchers.length === 0) return;
    const target = await getUser(userId);
    await col.deleteMany({ targetId: userId });
    for (const w of watchers) {
      await api
        .sendMessage(w.watcherId, `🔔 چت ${escapeHtml(target?.nickname ?? "این کاربر")} تموم شد و الان آزاده.`, {
          parse_mode: "HTML",
          reply_markup: target ? inlineKeyboard([[glassButton("👤 مشاهده پروفایل", `${CB.view}:${userId}`, "primary")]]) : undefined,
        })
        .catch(() => {});
    }
  } catch {
    /* best-effort */
  }
}

// ------------------------------------------------------------- register

export function registerUserSearch(composer: Composer<NavaContext>) {
  const done = async (ctx: NavaContext) => ctx.answerCallbackQuery().catch(() => {});

  composer.callbackQuery(CB.menu, async (ctx) => {
    await done(ctx);
    await showSearchMenu(ctx);
  });

  composer.callbackQuery(CB.byQuery, async (ctx) => {
    await done(ctx);
    await clearAllUserFlows(ctx.from!.id);
    await (await flowCol()).updateOne({ _id: ctx.from!.id }, { $set: { stage: "await_query" } }, { upsert: true });
    await ctx.reply("آیدی ناشناس (مثل user_AbC123) یا بخشی از نام مستعار رو بفرست:", { reply_markup: cancelKeyboard() });
  });

  composer.callbackQuery(new RegExp(`^${CB.list}:(sug|f|m):(\\d+)$`), async (ctx) => {
    await done(ctx);
    const mode = ctx.match![1] as Mode;
    const page = Number(ctx.match![2]);
    const { users, hasMore } = await runList(ctx.from!.id, mode, page);
    const title = mode === "f" ? "👩 دخترها" : mode === "m" ? "👨 پسرها" : "✨ پیشنهادی";
    const text = users.length ? `${title} (فعال‌های اخیر):` : "فعلاً کسی پیدا نشد.";
    const kb = resultKeyboard(users.map((u) => ({ u })), pagerRow(`${CB.list}:${mode}`, page, hasMore));
    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => void (await ctx.reply(text, { reply_markup: kb })));
  });

  composer.callbackQuery(new RegExp(`^${CB.nearby}:(\\d+)$`), async (ctx) => {
    await done(ctx);
    await showNearby(ctx, Number(ctx.match![1]), true);
  });

  composer.callbackQuery(new RegExp(`^${CB.view}:(\\d+)$`), async (ctx) => {
    await done(ctx);
    await openProfile(ctx, Number(ctx.match![1]));
  });

  // typed query
  composer.on("message:text", async (ctx, next) => {
    const flow = await (await flowCol()).findOne({ _id: ctx.from!.id });
    if (flow?.stage !== "await_query") return next();
    const raw = ctx.message.text.trim();
    if (isFlowCancelSignal(raw)) return next(); // the generic cancel handler owns it
    if (raw.length < 2 || raw.length > 40) {
      await ctx.reply("حداقل ۲ و حداکثر ۴۰ حرف بفرست.", { reply_markup: cancelKeyboard() });
      return;
    }
    await (await flowCol()).deleteOne({ _id: ctx.from!.id });
    const found = await runQuery(ctx.from!.id, raw);
    await sendRestore(ctx, found.length ? `🔎 ${found.length} نتیجه پیدا شد:` : "کسی با این مشخصات پیدا نشد.");
    if (found.length) {
      await ctx.reply("نتیجه‌ها:", { reply_markup: resultKeyboard(found.map((u) => ({ u })), []) });
    } else {
      await ctx.reply("می‌تونی دوباره امتحان کنی:", { reply_markup: inlineKeyboard([[glassButton("🔎 جستجوی جدید", CB.menu, "primary")]]) });
    }
  });

  // ---- profile card buttons that used to be dead stubs
  const cleanKb = { inline_keyboard: [] as never[] };

  composer.callbackQuery(new RegExp(`^${PROFILE_CB.chat}(\\d+)$`), async (ctx) => {
    await done(ctx);
    await askConfirm(ctx, "b", Number(ctx.match![1]));
  });
  composer.callbackQuery(new RegExp(`^${PROFILE_CB.dm}(\\d+)$`), async (ctx) => {
    await done(ctx);
    await askConfirm(ctx, "m", Number(ctx.match![1]));
  });

  composer.callbackQuery(/^pcr:no$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "لغو شد." });
    await ctx.editMessageReplyMarkup({ reply_markup: cleanKb }).catch(() => {});
  });

  composer.callbackQuery(/^pcr:(b|m):(\d+)$/, async (ctx) => {
    await ctx.editMessageReplyMarkup({ reply_markup: cleanKb }).catch(() => {});
    const origin = ctx.match![1] === "m" ? "miniapp" : "bot";
    const me = ctx.from!.id;
    const [from, target] = await Promise.all([getUser(me), getUser(Number(ctx.match![2]))]);
    const block = checkCanRequest(from, target);
    if (block) return void (await ctx.answerCallbackQuery({ text: block, show_alert: true }));
    const created = await createChatRequest(me, target!._id, new Date(), origin);
    if (created.status === "already_pending") return void (await ctx.answerCallbackQuery({ text: "قبلاً درخواست دادی؛ منتظر جواب باش.", show_alert: true }));
    if (created.status === "rate_limited") return void (await ctx.answerCallbackQuery({ text: "تعداد درخواست‌هات زیاد شده؛ کمی بعد امتحان کن.", show_alert: true }));
    const delivered = await sendChatRequestToTarget(created.request, from!, target!, ctx.api);
    await ctx.answerCallbackQuery();
    await ctx.reply(delivered ? `✅ درخواست برای ${escapeHtml(target!.nickname ?? "کاربر")} رفت. اگه قبول کنه خبرت می‌کنم.` : "این کاربر الان در دسترس نیست.", { parse_mode: "HTML" });
  });

  composer.callbackQuery(new RegExp(`^${PROFILE_CB.notify}(\\d+)$`), async (ctx) => {
    const targetId = Number(ctx.match![1]);
    const target = await getUser(targetId);
    if (!target) return void (await ctx.answerCallbackQuery());
    if (!target.activeChatSessionId) return void (await ctx.answerCallbackQuery({ text: "این کاربر الان توی چت نیست؛ می‌تونی همین الان بهش درخواست بدی.", show_alert: true }));
    const col = (await getDb()).collection<{ _id: string; watcherId: number; targetId: number }>(WATCH);
    await col.updateOne({ _id: `${ctx.from!.id}:${targetId}` }, { $set: { watcherId: ctx.from!.id, targetId } }, { upsert: true });
    await ctx.answerCallbackQuery({ text: "✅ وقتی چتش تموم بشه بهت خبر میدم.", show_alert: true });
  });
}

function checkCanRequest(from: UserDoc | null, target: UserDoc | null): string | null {
  if (!from || !target || target.banned) return "الان نمیشه به این کاربر درخواست داد.";
  if (from._id === target._id) return "این خودتی 🙂";
  if (isOfficial(target) && (target as any).officialChatOpen !== true) return "این اکانت رسمیه و درخواست چت نمی‌گیره.";
  if (from.activeChatSessionId) return "الان توی یه چت هستی. اول اون رو تموم کن.";
  if (!hasUnlimitedXp(from._id) && (from.relicBalance ?? 0) < 1) return "موجودی ژتونت برای شروع چت کافی نیست.";
  return null;
}

async function askConfirm(ctx: NavaContext, kind: "b" | "m", targetId: number): Promise<void> {
  const [from, target] = await Promise.all([getUser(ctx.from!.id), getUser(targetId)]);
  const block = checkCanRequest(from, target);
  if (block) return void (await ctx.reply(`⚠️ ${block}`));
  const where = kind === "m" ? "توی مویاگرام" : "توی همین ربات";
  await ctx.reply(
    `💬 درخواست چت ${where} برای ${escapeHtml(target!.nickname ?? "این کاربر")}\n<blockquote>اگه قبول کنه از هر دو نفر ۱ ژتون کم میشه. اگه قبول نکنه چیزی کم نمیشه.</blockquote>\nتأیید می‌کنی؟`,
    {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([[glassButton("تأیید", `${PROFILE_CB.confirm}${kind}:${targetId}`, "success", buttonIcon("GREEN_CHECK")), glassButton("انصراف", "pcr:no", "danger", buttonIcon("BAN"))]]),
    }
  );
}
