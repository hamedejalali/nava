import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { createSeed } from "../../db/models/seeds.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { isAdmin } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { isValidPersianNickname } from "../onboarding/nickname.js";
import { PROVINCES } from "../../data/provinces.js";
import { citiesForProvince } from "../../data/cities.js";
import { toAsciiDigits } from "../../utils/digits.js";
import { escapeHtml } from "../../utils/html.js";

/**
 * «📦 ساخت دسته‌ای ممبر»: the owner/admin says how many members he wants (N), sends N photos, then N names (one per
 * line, same order as the photos). Everything else is filled in automatically — age 18..32, gender (his choice or
 * random), a random province + one of ITS cities — and every field stays editable from the member's card afterwards.
 *
 * Photos of an album arrive as separate updates (possibly handled at the same moment), so they are stored one
 * document each in `seed_batch_photos` (unique per photo) instead of being appended to one flow document.
 */

export const BATCH_CB = { start: "admin:seed:batch", gender: "admin:seed:bg:" } as const; // + female|male|mix
const FLOW = "seed_batch";
export const BATCH_MAX = 40;
export const BATCH_MIN_AGE = 18;
export const BATCH_MAX_AGE = 32;
const PHOTOS = "seed_batch_photos";

export type GenderMode = "female" | "male" | "mix";

export interface PlannedSeed {
  nickname: string;
  gender: "male" | "female";
  age: number;
  province: string;
  city: string;
  profilePhotoFileId: string;
}

/** Pure planner (unit-tested): pairs photo[i] with name[i] and fills the rest randomly. `rnd()` returns [0,1). */
export function planBatch(names: string[], photos: string[], mode: GenderMode, rnd: () => number = Math.random): PlannedSeed[] {
  const pick = <T>(a: T[]): T => a[Math.min(a.length - 1, Math.floor(rnd() * a.length))]!;
  return names.map((nickname, i) => {
    const province = pick(PROVINCES.filter((p) => citiesForProvince(p.id).length > 0));
    const city = pick(citiesForProvince(province.id));
    return {
      nickname,
      gender: mode === "mix" ? (rnd() < 0.5 ? "female" : "male") : mode,
      age: BATCH_MIN_AGE + Math.floor(rnd() * (BATCH_MAX_AGE - BATCH_MIN_AGE + 1)),
      province: province.id,
      city: city.id,
      profilePhotoFileId: photos[i]!,
    };
  });
}

export function parseNames(raw: string, n: number): { ok: true; names: string[] } | { ok: false; error: string } {
  const names = raw.split(/\r?\n|،|,/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (names.length !== n) return { ok: false, error: `${n} نام لازمه (هر نام تو یک خط) ولی ${names.length} تا فرستادی. دوباره بفرست:` };
  const bad = names.find((x) => !isValidPersianNickname(x));
  if (bad) return { ok: false, error: `نام «${bad}» معتبر نیست (باید فارسی باشه). همه‌ی نام‌ها رو دوباره بفرست:` };
  return { ok: true, names };
}

async function photosCol() {
  return (await getDb()).collection<any>(PHOTOS);
}

export async function startBatch(ctx: NavaContext) {
  await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "count", data: {} });
  await ctx.reply(`📦 <b>ساخت دسته‌ای ممبر</b>\n\nچند تا ممبر می‌خوای بسازی؟ (۱ تا ${BATCH_MAX})`, { parse_mode: "HTML", reply_markup: cancelKeyboard() });
}

export function registerSeedsBatch(composer: Composer<NavaContext>) {
  composer.callbackQuery(BATCH_CB.start, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await startBatch(ctx);
  });

  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const t = ctx.message.text.trim();
    if (t === ADMIN_MENU_LABELS.seedBatch) {
      await startBatch(ctx);
      return;
    }
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    if (isFlowCancelSignal(t)) {
      await (await photosCol()).deleteMany({ adminId: ctx.from!.id });
      await setAdminFlow(ctx.from!.id, null);
      if (t.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    const data = (flow.data ?? {}) as { n?: number; mode?: GenderMode };

    if (flow.stage === "count") {
      const n = Number(toAsciiDigits(t));
      if (!Number.isInteger(n) || n < 1 || n > BATCH_MAX) return void (await ctx.reply(`یه عدد بین ۱ تا ${BATCH_MAX} بفرست:`, { reply_markup: cancelKeyboard() }));
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "gender", data: { n } });
      await ctx.reply("جنسیت این ممبرها چیه؟", {
        reply_markup: inlineKeyboard([
          [glassButton("👩 همه زن", `${BATCH_CB.gender}female`, "primary"), glassButton("👨 همه مرد", `${BATCH_CB.gender}male`, "primary")],
          [glassButton("🎲 ترکیبی (تصادفی)", `${BATCH_CB.gender}mix`, "success")],
        ]),
      });
      return;
    }
    if (flow.stage === "gender") return void (await ctx.reply("جنسیت رو با دکمه‌ها انتخاب کن.", { reply_markup: cancelKeyboard() }));
    if (flow.stage === "photos") {
      const have = await (await photosCol()).countDocuments({ adminId: ctx.from!.id });
      return void (await ctx.reply(`الان ${have} از ${data.n} عکس رسیده. عکس‌ها رو بفرست (می‌تونی چندتا رو با هم به‌صورت آلبوم بفرستی).`, { reply_markup: cancelKeyboard() }));
    }
    if (flow.stage === "names") {
      const r = parseNames(t, data.n!);
      if (!r.ok) return void (await ctx.reply(r.error, { reply_markup: cancelKeyboard() }));
      const photos = (await (await photosCol()).find({ adminId: ctx.from!.id }).sort({ order: 1, _id: 1 }).limit(BATCH_MAX).toArray()).map((p: any) => p.fileId as string);
      if (photos.length < data.n!) return void (await ctx.reply("عکس‌ها کامل نیست؛ دوباره از اول شروع کن."));
      const plan = planBatch(r.names, photos, data.mode ?? "mix");
      await setAdminFlow(ctx.from!.id, null);
      const made: string[] = [];
      for (const p of plan) {
        const u = await createSeed({ ...p, bio: "" });
        made.push(`• ${escapeHtml(p.nickname)} — ${p.gender === "female" ? "زن" : "مرد"}، ${p.age} ساله، ${escapeHtml(p.city)} (${escapeHtml(u.anonId)})`);
      }
      await (await photosCol()).deleteMany({ adminId: ctx.from!.id });
      await logAdminAction(ctx.from!.id, "seed_batch", String(plan.length));
      await ctx.reply(`✅ ${plan.length} ممبر ساخته شد:\n\n${made.join("\n")}\n\nسن، استان/شهر، بیو و عکس هر کدوم از «📋 لیست ممبرها ← ✏️ ویرایش» قابل تغییره.`, { parse_mode: "HTML" });
      return;
    }
    return next();
  });

  composer.callbackQuery(new RegExp(`^${BATCH_CB.gender}(female|male|mix)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW || flow.stage !== "gender") return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const data = { ...((flow.data ?? {}) as object), mode: ctx.match![1] as GenderMode };
    await (await photosCol()).deleteMany({ adminId: ctx.from!.id });
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "photos", data });
    await ctx.reply(`حالا ${(data as any).n} عکس بفرست (به ترتیبی که می‌خوای نام‌ها بهشون بخوره).`, { reply_markup: cancelKeyboard() });
  });

  composer.on("message:photo", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW || flow.stage !== "photos") return next();
    const n = Number((flow.data as any)?.n);
    const sizes = ctx.message.photo;
    const best = sizes[sizes.length - 1];
    if (!best) return;
    const col = await photosCol();
    const have = await col.countDocuments({ adminId: ctx.from!.id });
    if (have >= n) return void (await ctx.reply(`✋ ${n} عکس کافیه؛ عکس اضافه نادیده گرفته شد.`).catch(() => {}));
    try {
      await col.insertOne({ _id: `${ctx.from!.id}:${ctx.message.message_id}`, adminId: ctx.from!.id, fileId: best.file_id, order: ctx.message.message_id, at: new Date() });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      return;
    }
    const now = await col.countDocuments({ adminId: ctx.from!.id });
    if (now >= n) {
      // moves on exactly once, even if the last two photos of an album are handled at the same time
      const fresh = await getAdminFlow(ctx.from!.id);
      if (fresh?.flow === FLOW && fresh.stage === "photos") {
        await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "names", data: fresh.data });
        await ctx.reply(`📸 ${n} عکس رسید ✅\nحالا ${n} نام فارسی بفرست؛ <b>هر نام تو یک خط</b> و به همون ترتیب عکس‌ها.`, { parse_mode: "HTML", reply_markup: cancelKeyboard() });
      }
    }
  });
}
