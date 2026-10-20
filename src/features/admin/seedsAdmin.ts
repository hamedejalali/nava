import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { getBotSettings } from "../../db/models/settings.js";
import { countSeeds, createSeed, deleteSeed, getSeed, listSeeds, setSeedChatEnabled, setSeedsHidden, updateSeed, type SeedPatch } from "../../db/models/seeds.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { isAdmin } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { isValidPersianNickname } from "../onboarding/nickname.js";
import { PROVINCES, isValidProvince } from "../../data/provinces.js";
import { citiesForProvince } from "../../data/cities.js";
import { MAX_AGE, MIN_AGE, MAX_BIO_LENGTH } from "../matching/profileEdit.js";
import { toAsciiDigits } from "../../utils/digits.js";
import { escapeHtml } from "../../utils/html.js";
import type { UserDoc } from "../../db/models/user.js";

/**
 * Admin panel «🎭 ممبرهای پیش‌فرض» (from ⚙️ تنظیمات ربات): create members that look and behave like ordinary users
 * (photo, name, age, province/city, bio, verified tick, their own Nava ID) and control them:
 *   - نمایش/عدم نمایش: show them to real users in the Mini App, or hide them from everybody except the owner's
 *     account switcher;
 *   - اتصال در جستجو: allow/forbid connecting them to a real user whose random search found nobody.
 * The owner works AS a member from the Mini App's account switcher (public/miniapp).
 */

export const SEED_CB = {
  open: "admin:seed:open",
  toggleHidden: "admin:seed:th",
  toggleChat: "admin:seed:tc",
  add: "admin:seed:add",
  list: "admin:seed:l:", // + page
  view: "admin:seed:v:", // + id
  verify: "admin:seed:vf:", // + id
  edit: "admin:seed:e:", // + id
  editField: "admin:seed:ef:", // + id:field
  del: "admin:seed:d:", // + id
  delOk: "admin:seed:do:", // + id
  gender: "admin:seed:g:", // + male|female
} as const;

const FLOW_ADD = "seed_add";
const FLOW_EDIT = "seed_edit";
const PAGE = 8;

type AddData = { nickname?: string; gender?: "male" | "female"; age?: number; province?: string; city?: string; bio?: string; photo?: string };

const norm = (t: string) => t.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\s+/g, " ").trim();

/**
 * One-message member: six lines (or separated by "|") — name, gender, age, province, city, bio (optional).
 * Returns null when the text is not in this shape (the step-by-step flow then continues as before).
 */
export function parseQuickSeed(raw: string): { ok: true; data: AddData } | { ok: false; error: string } | null {
  const lines = raw.split(/\r?\n|\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
  if (lines.length < 5) return null;
  const [nick, g, a, prov, cit, ...rest] = lines as [string, string, string, string, string, ...string[]];
  if (!isValidPersianNickname(nick)) return { ok: false, error: `نام «${nick}» معتبر نیست (باید فارسی باشه). همه رو دوباره بفرست:` };
  const gender = /زن|دختر|خانم|female/i.test(g) ? "female" : /مرد|پسر|آقا|male/i.test(g) ? "male" : null;
  if (!gender) return { ok: false, error: "جنسیت (خط دوم) باید «زن» یا «مرد» باشه. همه رو دوباره بفرست:" };
  const age = Number(toAsciiDigits(a));
  if (!Number.isInteger(age) || age < MIN_AGE || age > MAX_AGE) return { ok: false, error: `سن (خط سوم) باید عدد بین ${MIN_AGE} تا ${MAX_AGE} باشه. همه رو دوباره بفرست:` };
  const province = PROVINCES.find((p) => norm(p.nameFa) === norm(prov));
  if (!province) return { ok: false, error: "استان (خط چهارم) معتبر نیست؛ دقیقاً مثل فهرست بنویس:\n" + PROVINCES.map((p) => p.nameFa).join("، ") };
  const city = citiesForProvince(province.id).find((c) => norm(c.nameFa) === norm(cit));
  if (!city) return { ok: false, error: `شهر «${cit}» داخل استان ${province.nameFa} پیدا نشد. همه رو دوباره بفرست:` };
  const bio = rest.join("\n");
  const cleanBio = bio === "-" ? "" : bio;
  if ([...cleanBio].length > MAX_BIO_LENGTH) return { ok: false, error: `بیو حداکثر ${MAX_BIO_LENGTH} کاراکتر باشه. همه رو دوباره بفرست:` };
  return { ok: true, data: { nickname: nick, gender, age, province: province.id, city: city.id, bio: cleanBio } };
}

const QUICK_HELP =
  "➕ <b>ممبر جدید</b>\n\nهمه‌چیز رو <b>تو یک پیام</b> بفرست (اگه عکس داری، عکس رو با همین متن به‌عنوان کپشن بفرست):\n\n" +
  "<code>مریم\nزن\n24\nتهران\nتهران\nعاشق کوه و کتاب</code>\n\n" +
  "(نام / جنسیت / سن / استان / شهر / بیو — بیو اختیاریه)\nیا فقط نام رو بفرست تا مرحله‌به‌مرحله بپرسم.";

export async function startSeedAdd(ctx: NavaContext) {
  await setAdminFlow(ctx.from!.id, { flow: FLOW_ADD, stage: "nickname", data: {} });
  await ctx.reply(QUICK_HELP, { parse_mode: "HTML", reply_markup: cancelKeyboard() });
}

export async function seedsScreen(): Promise<{ text: string; reply_markup: ReturnType<typeof inlineKeyboard> }> {
  const s = await getBotSettings();
  const n = await countSeeds();
  const text =
    `🎭 <b>ممبرهای پیش‌فرض</b>\n\n` +
    `تعداد: <b>${n}</b>\n` +
    `نمایش برای کاربران در مینی‌اپ: ${s.seedsHidden ? "🔴 مخفی" : "🟢 نمایش داده میشن"}\n` +
    `اتصال در جستجوی چت: ${s.seedChatEnabled ? "🟢 فعال" : "🔴 غیرفعال"}\n\n` +
    `ممبرها مثل کاربر عادی نمایش داده میشن. هیچ XP‌ی ندارن و هیچ‌وقت به هم وصل نمیشن. وقتی «اتصال در جستجو» فعاله و کسی تا ۳ ثانیه مونده به پایان تایمر پیدا نشد، یکی از ممبرها وصل میشه (رایگان برای کاربر). برای کار با اکانتشون در مینی‌اپ از بخش تعویض اکانت پروفایل استفاده کن.`;
  return {
    text,
    reply_markup: inlineKeyboard([
      [glassButton(s.seedsHidden ? "👁 نمایش ممبرها به کاربران" : "🙈 مخفی کردن ممبرها از کاربران", SEED_CB.toggleHidden, s.seedsHidden ? "success" : "danger")],
      [glassButton(s.seedChatEnabled ? "⛔ غیرفعال کردن اتصال در جستجو" : "✅ فعال کردن اتصال در جستجو", SEED_CB.toggleChat, s.seedChatEnabled ? "danger" : "success")],
      [glassButton("➕ افزودن ممبر", SEED_CB.add, "success"), glassButton("📋 لیست ممبرها", `${SEED_CB.list}0`, "primary")],
      [glassButton("📦 ساخت دسته‌ای (تعداد + عکس‌ها + نام‌ها)", "admin:seed:batch", "success")],
    ]),
  };
}

function card(u: UserDoc): string {
  return (
    `🎭 <b>${escapeHtml(u.nickname ?? "-")}</b>${u.verified ? " ✅" : ""}\n` +
    `کد نوا: <code>${escapeHtml(u.anonId)}</code>\n` +
    `${u.gender === "female" ? "زن" : "مرد"} • ${u.age ?? "-"} ساله • ${escapeHtml(u.province ?? "-")} / ${escapeHtml(u.city ?? "-")}\n` +
    `بیو: ${u.bio ? escapeHtml(u.bio) : "—"}\n` +
    `عکس: ${u.profilePhotoFileId ? "دارد" : "ندارد"}\n` +
    `نمایش: ${u.seedHidden ? "مخفی" : "نمایش"} • اتصال در جستجو: ${u.seedChatEnabled ? "فعال" : "غیرفعال"}`
  );
}

async function showCard(ctx: NavaContext, u: UserDoc) {
  const kb = inlineKeyboard([
    [glassButton(u.verified ? "لغو وریفای" : "✅ وریفای", `${SEED_CB.verify}${u._id}`, u.verified ? "danger" : "success"), glassButton("✏️ ویرایش", `${SEED_CB.edit}${u._id}`, "primary")],
    [glassButton("🗑 حذف", `${SEED_CB.del}${u._id}`, "danger"), glassButton("↩️ لیست", `${SEED_CB.list}0`, "primary")],
  ]);
  if (u.profilePhotoFileId) {
    try {
      await ctx.replyWithPhoto(u.profilePhotoFileId, { caption: card(u), parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall back to text */
    }
  }
  await ctx.reply(card(u), { parse_mode: "HTML", reply_markup: kb });
}

async function listScreen(ctx: NavaContext, page: number) {
  const { items, total } = await listSeeds(page * PAGE, PAGE);
  const rows = items.map((u) => [glassButton(`${u.verified ? "✅ " : ""}${u.nickname ?? "-"} • ${u.age ?? "-"} • ${u.city ?? "-"}`, `${SEED_CB.view}${u._id}`, "primary")]);
  const nav = [];
  if (page > 0) nav.push(glassButton("◀️ قبلی", `${SEED_CB.list}${page - 1}`, "primary"));
  if ((page + 1) * PAGE < total) nav.push(glassButton("بعدی ▶️", `${SEED_CB.list}${page + 1}`, "primary"));
  if (nav.length) rows.push(nav);
  rows.push([glassButton("↩️ بازگشت", SEED_CB.open, "primary")]);
  await ctx.reply(total ? `📋 ممبرهای پیش‌فرض (${total})` : "هنوز ممبری نساختی.", { reply_markup: inlineKeyboard(rows) });
}

function genderKeyboard() {
  return inlineKeyboard([
    [glassButton("👩 زن", `${SEED_CB.gender}female`, "primary"), glassButton("👨 مرد", `${SEED_CB.gender}male`, "primary")],
    [glassButton("❌ لغو", "flow:cancel", "danger")],
  ]);
}

const PROVINCE_HINT = () => `استان رو دقیقاً مثل یکی از این‌ها بنویس:\n${PROVINCES.map((p) => p.nameFa).join("، ")}`;

export function registerSeedsAdmin(composer: Composer<NavaContext>) {
  composer.callbackQuery(SEED_CB.open, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const s = await seedsScreen();
    await ctx.reply(s.text, { parse_mode: "HTML", reply_markup: s.reply_markup });
  });

  composer.callbackQuery([SEED_CB.toggleHidden, SEED_CB.toggleChat], async (ctx) => {
    if (!isAdmin(ctx)) return;
    const s = await getBotSettings();
    if (ctx.callbackQuery.data === SEED_CB.toggleHidden) {
      await setSeedsHidden(!s.seedsHidden);
      await logAdminAction(ctx.from!.id, "seed_hidden", String(!s.seedsHidden));
    } else {
      await setSeedChatEnabled(!s.seedChatEnabled);
      await logAdminAction(ctx.from!.id, "seed_chat", String(!s.seedChatEnabled));
    }
    await ctx.answerCallbackQuery({ text: "انجام شد ✅" });
    await ctx.deleteMessage().catch(() => {});
    const scr = await seedsScreen();
    await ctx.reply(scr.text, { parse_mode: "HTML", reply_markup: scr.reply_markup });
  });

  composer.callbackQuery(new RegExp(`^${SEED_CB.list}(\\d+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    await listScreen(ctx, Number(ctx.match![1]));
  });

  composer.callbackQuery(new RegExp(`^${SEED_CB.view}(\\d+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const u = await getSeed(Number(ctx.match![1]));
    if (!u) return void (await ctx.reply("این ممبر پیدا نشد."));
    await ctx.deleteMessage().catch(() => {});
    await showCard(ctx, u);
  });

  composer.callbackQuery(new RegExp(`^${SEED_CB.verify}(\\d+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const u = await getSeed(Number(ctx.match![1]));
    if (!u) return void (await ctx.answerCallbackQuery({ text: "پیدا نشد" }));
    const upd = await updateSeed(u._id, { verified: !u.verified });
    await logAdminAction(ctx.from!.id, "seed_verify", `${u._id}:${!u.verified}`);
    await ctx.answerCallbackQuery({ text: u.verified ? "وریفای برداشته شد" : "وریفای شد ✅" });
    await ctx.deleteMessage().catch(() => {});
    if (upd) await showCard(ctx, upd);
  });

  composer.callbackQuery(new RegExp(`^${SEED_CB.del}(\\d+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await ctx.reply("⚠️ این ممبر برای همیشه حذف میشه (پست‌ها/فالو/کامنت‌هاش از بین میرن). مطمئنی؟", {
      reply_markup: inlineKeyboard([[glassButton("✅ بله، حذف کن", `${SEED_CB.delOk}${ctx.match![1]}`, "danger"), glassButton("❌ انصراف", `${SEED_CB.list}0`, "primary")]]),
    });
  });

  composer.callbackQuery(new RegExp(`^${SEED_CB.delOk}(\\d+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const ok = await deleteSeed(Number(ctx.match![1]));
    if (ok) await logAdminAction(ctx.from!.id, "seed_delete", ctx.match![1]!);
    await ctx.answerCallbackQuery({ text: ok ? "حذف شد" : "پیدا نشد" });
    await ctx.deleteMessage().catch(() => {});
    await listScreen(ctx, 0);
  });

  /* ------------------------------------------------------------- add flow */
  composer.callbackQuery(SEED_CB.add, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await startSeedAdd(ctx);
  });

  // direct buttons of the «🎭 ممبرهای پیش‌فرض» category of the admin keyboard
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const t = ctx.message.text.trim();
    if (t !== ADMIN_MENU_LABELS.seedPanel && t !== ADMIN_MENU_LABELS.seedAdd && t !== ADMIN_MENU_LABELS.seedList) return next();
    await setAdminFlow(ctx.from!.id, null);
    if (t === ADMIN_MENU_LABELS.seedAdd) return void (await startSeedAdd(ctx));
    if (t === ADMIN_MENU_LABELS.seedList) return void (await listScreen(ctx, 0));
    const scr = await seedsScreen();
    await ctx.reply(scr.text, { parse_mode: "HTML", reply_markup: scr.reply_markup });
  });

  composer.callbackQuery(new RegExp(`^${SEED_CB.gender}(male|female)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW_ADD || flow.stage !== "gender") return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW_ADD, stage: "age", data: { ...(flow.data ?? {}), gender: ctx.match![1] } });
    await ctx.reply(`سن رو بفرست (${MIN_AGE} تا ${MAX_AGE}):`, { reply_markup: cancelKeyboard() });
  });

  /* ------------------------------------------------------------ edit flow */
  composer.callbackQuery(new RegExp(`^${SEED_CB.edit}(\\d+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const id = ctx.match![1]!;
    await ctx.reply("کدوم قسمت رو ویرایش کنم؟", {
      reply_markup: inlineKeyboard([
        [glassButton("نام", `${SEED_CB.editField}${id}:nickname`, "primary"), glassButton("سن", `${SEED_CB.editField}${id}:age`, "primary")],
        [glassButton("بیو", `${SEED_CB.editField}${id}:bio`, "primary"), glassButton("عکس", `${SEED_CB.editField}${id}:photo`, "primary")],
        [glassButton("استان و شهر", `${SEED_CB.editField}${id}:province`, "primary")],
        [glassButton("↩️ بازگشت", `${SEED_CB.view}${id}`, "primary")],
      ]),
    });
  });

  composer.callbackQuery(new RegExp(`^${SEED_CB.editField}(\\d+):(nickname|age|bio|photo|province)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match![1]);
    const field = ctx.match![2]!;
    if (!(await getSeed(id))) return void (await ctx.reply("این ممبر پیدا نشد."));
    await setAdminFlow(ctx.from!.id, { flow: FLOW_EDIT, stage: field, data: { id } });
    const prompt: Record<string, string> = {
      nickname: "نام مستعار جدید (فارسی):",
      age: `سن جدید (${MIN_AGE} تا ${MAX_AGE}):`,
      bio: `بیوگرافی جدید (حداکثر ${MAX_BIO_LENGTH} کاراکتر؛ برای خالی کردن «-» بفرست):`,
      photo: "عکس جدید رو بفرست:",
      province: PROVINCE_HINT(),
    };
    await ctx.reply(prompt[field]!, { reply_markup: cancelKeyboard() });
  });

  /* --------------------------------------------------------------- photos */
  // Registered early (registerAdmin runs first in bot.ts) so the photo is never taken as a profile upload.
  composer.on("message:photo", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow) return next();
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1]?.file_id;
    if (!fileId) return next();
    if (flow.flow === FLOW_ADD && flow.stage === "photo") {
      await finishAdd(ctx, (flow.data ?? {}) as AddData, fileId);
      return;
    }
    if (flow.flow === FLOW_ADD && flow.stage === "nickname") {
      const cap = ctx.message.caption?.trim();
      if (cap) {
        const q = parseQuickSeed(cap);
        if (q && !q.ok) return void (await ctx.reply(q.error, { reply_markup: cancelKeyboard() }));
        if (q && q.ok) return void (await finishAdd(ctx, q.data, fileId));
        if (isValidPersianNickname(cap)) {
          await setAdminFlow(ctx.from!.id, { flow: FLOW_ADD, stage: "gender", data: { nickname: cap, photo: fileId } });
          return void (await ctx.reply("عکس رو گرفتم. جنسیت:", { reply_markup: genderKeyboard() }));
        }
      }
      await setAdminFlow(ctx.from!.id, { flow: FLOW_ADD, stage: "nickname", data: { ...((flow.data ?? {}) as object), photo: fileId } });
      return void (await ctx.reply("✅ عکس رو گرفتم. حالا نام و بقیه‌ی مشخصات رو بفرست (۶ خط، یا فقط نام).", { reply_markup: cancelKeyboard() }));
    }
    if (flow.flow === FLOW_EDIT && flow.stage === "photo") {
      const id = Number((flow.data as any)?.id);
      await setAdminFlow(ctx.from!.id, null);
      const upd = await updateSeed(id, { profilePhotoFileId: fileId });
      await logAdminAction(ctx.from!.id, "seed_edit", `${id}:photo`);
      if (upd) await showCard(ctx, upd);
      else await ctx.reply("این ممبر پیدا نشد.");
      return;
    }
    return next();
  });

  /* ----------------------------------------------------------------- text */
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || (flow.flow !== FLOW_ADD && flow.flow !== FLOW_EDIT)) return next();
    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    const data = (flow.data ?? {}) as Record<string, any>;
    const retry = (msg: string) => ctx.reply(msg, { reply_markup: cancelKeyboard() });
    const parseAge = () => {
      const n = Number(toAsciiDigits(text));
      return Number.isInteger(n) && n >= MIN_AGE && n <= MAX_AGE ? n : null;
    };

    if (flow.flow === FLOW_ADD) {
      switch (flow.stage) {
        case "nickname": {
          const q = parseQuickSeed(text);
          if (q && !q.ok) return void (await retry(q.error));
          if (q && q.ok) return void (await finishAdd(ctx, q.data, data.photo as string | undefined));
          if (!isValidPersianNickname(text)) return void (await retry("نام باید فارسی و معتبر باشه. دوباره بفرست:"));
          await setAdminFlow(ctx.from!.id, { flow: FLOW_ADD, stage: "gender", data: { ...data, nickname: text } });
          return void (await ctx.reply("جنسیت:", { reply_markup: genderKeyboard() }));
        }
        case "gender":
          return void (await ctx.reply("جنسیت رو با دکمه‌ها انتخاب کن:", { reply_markup: genderKeyboard() }));
        case "age": {
          const age = parseAge();
          if (age === null) return void (await retry(`سن باید عدد بین ${MIN_AGE} تا ${MAX_AGE} باشه:`));
          await setAdminFlow(ctx.from!.id, { flow: FLOW_ADD, stage: "province", data: { ...data, age } });
          return void (await retry(PROVINCE_HINT()));
        }
        case "province":
          if (!isValidProvince(text)) return void (await retry("استان معتبر نیست. دقیقاً مثل فهرست بنویس:\n" + PROVINCES.map((p) => p.nameFa).join("، ")));
          await setAdminFlow(ctx.from!.id, { flow: FLOW_ADD, stage: "city", data: { ...data, province: text } });
          return void (await retry("شهر رو بنویس (باید شهری از همین استان باشه):"));
        case "city": {
          const city = citiesForProvince(data.province).find((c) => c.nameFa === text);
          if (!city) return void (await retry("این شهر داخل این استان پیدا نشد. دوباره بنویس:"));
          await setAdminFlow(ctx.from!.id, { flow: FLOW_ADD, stage: "bio", data: { ...data, city: city.id } });
          return void (await retry(`بیوگرافی (حداکثر ${MAX_BIO_LENGTH} کاراکتر) یا «-» برای رد کردن:`));
        }
        case "bio": {
          const bio = text === "-" ? "" : text;
          if ([...bio].length > MAX_BIO_LENGTH) return void (await retry(`بیو حداکثر ${MAX_BIO_LENGTH} کاراکتر باشه:`));
          await setAdminFlow(ctx.from!.id, { flow: FLOW_ADD, stage: "photo", data: { ...data, bio } });
          return void (await retry("عکس پروفایل رو بفرست (یا «-» برای ساخت بدون عکس):"));
        }
        case "photo":
          if (text === "-") return void (await finishAdd(ctx, data as AddData, data.photo as string | undefined));
          return void (await retry("باید عکس بفرستی (یا «-»):"));
      }
      return next();
    }

    // edit
    const id = Number(data.id);
    const done = async (patch: SeedPatch) => {
      await setAdminFlow(ctx.from!.id, null);
      const upd = await updateSeed(id, patch);
      await logAdminAction(ctx.from!.id, "seed_edit", `${id}:${Object.keys(patch).join(",")}`);
      if (upd) await showCard(ctx, upd);
      else await ctx.reply("این ممبر پیدا نشد.");
    };
    switch (flow.stage) {
      case "nickname":
        if (!isValidPersianNickname(text)) return void (await retry("نام باید فارسی و معتبر باشه. دوباره بفرست:"));
        return void (await done({ nickname: text }));
      case "age": {
        const age = parseAge();
        if (age === null) return void (await retry(`سن باید عدد بین ${MIN_AGE} تا ${MAX_AGE} باشه:`));
        return void (await done({ age }));
      }
      case "bio": {
        const bio = text === "-" ? "" : text;
        if ([...bio].length > MAX_BIO_LENGTH) return void (await retry(`بیو حداکثر ${MAX_BIO_LENGTH} کاراکتر باشه:`));
        return void (await done({ bio }));
      }
      case "province":
        if (!isValidProvince(text)) return void (await retry("استان معتبر نیست. دقیقاً مثل فهرست بنویس."));
        await setAdminFlow(ctx.from!.id, { flow: FLOW_EDIT, stage: "city", data: { id, province: text } });
        return void (await retry("شهر رو بنویس (از همین استان):"));
      case "city": {
        const city = citiesForProvince(data.province).find((c) => c.nameFa === text);
        if (!city) return void (await retry("این شهر داخل این استان پیدا نشد. دوباره بنویس:"));
        return void (await done({ province: data.province, city: city.id }));
      }
      case "photo":
        return void (await retry("باید عکس بفرستی:"));
    }
    return next();
  });
}

async function finishAdd(ctx: NavaContext, d: AddData, photo: string | undefined) {
  await setAdminFlow(ctx.from!.id, null);
  if (!d.nickname || !d.gender || !d.age || !d.province || !d.city) {
    await ctx.reply("اطلاعات ناقص بود؛ از اول شروع کن.");
    return;
  }
  const u = await createSeed({ nickname: d.nickname, gender: d.gender, age: d.age, province: d.province, city: d.city, bio: d.bio ?? "", profilePhotoFileId: photo ?? d.photo });
  await logAdminAction(ctx.from!.id, "seed_create", String(u._id));
  await ctx.reply("✅ ممبر ساخته شد.");
  await showCard(ctx, u);
}
