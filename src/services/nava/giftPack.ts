import { gunzipSync, gzipSync, unzipSync } from "fflate";
import { InputFile, type Api } from "grammy";
import { addCustomGift, cleanColor, cleanGlyph, MAX_GIFT_NAME, MAX_GIFT_PRICE, type StickerFormat } from "./giftDefs.js";

/**
 * GIFT PACKS — the owner sends one FILE to the bot and a whole set of gifts appears (price / emoji / name are edited afterwards
 * from the gift panel). Accepted:
 *   • .zip   — `pack.json` + the animation files it names (.tgs / Lottie .json / .png / .webp / .webm); without a pack.json every file is one gift
 *   • .json  — either a pack ({ "gifts": [...] }, animations inline as "lottie" / "tgs_b64" / "png_b64") or ONE Lottie animation
 *   • .tgs   — one Telegram animation (gzipped Lottie), exactly as exported from Telegram
 * Animations are re-uploaded to Telegram once (a document sent to the owner and deleted again) to get a durable file id, exactly
 * like the gifts picked from Telegram's own list, so the Mini App serves them the same way.
 */
export const MAX_PACK_GIFTS = 60;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PACK_PRICE = 10;

export interface PackItem {
  name: string;
  emoji: string;
  price: number;
  pattern?: string;
  c1?: string;
  c2?: string;
  format: StickerFormat;
  data: Buffer;
}

const EXT: Record<string, StickerFormat> = { tgs: "tgs", png: "png", webp: "webp", webm: "webm", jpg: "jpg", jpeg: "jpg" };

const stem = (p: string) => p.split("/").pop()!.replace(/\.[^.]+$/, "");
const extOf = (p: string) => (p.split(".").pop() ?? "").toLowerCase();
const isLottie = (o: any) => o && typeof o === "object" && Array.isArray(o.layers) && ("fr" in o || "w" in o);
const b64 = (s: unknown) => (typeof s === "string" ? Buffer.from(s.replace(/^data:[^,]*,/, ""), "base64") : null);

function fromLottie(obj: unknown): Buffer {
  return Buffer.from(gzipSync(new TextEncoder().encode(JSON.stringify(obj))));
}

function meta(raw: any, fallbackName: string) {
  const price = Number.isInteger(raw?.price) && raw.price >= 1 && raw.price <= MAX_GIFT_PRICE ? raw.price : DEFAULT_PACK_PRICE;
  return {
    name: (typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : fallbackName).slice(0, MAX_GIFT_NAME) || "هدیه",
    emoji: cleanGlyph(raw?.emoji) ?? "🎁",
    price,
    ...(cleanGlyph(raw?.pattern) ? { pattern: cleanGlyph(raw.pattern)! } : {}),
    ...(cleanColor(raw?.c1) ? { c1: cleanColor(raw.c1)! } : {}),
    ...(cleanColor(raw?.c2) ? { c2: cleanColor(raw.c2)! } : {}),
  };
}

/** raw file → list of gifts to create (throws Error with a Persian message the admin can read) */
export function parsePack(file: Buffer, filename: string): PackItem[] {
  const ext = extOf(filename);
  const out: PackItem[] = [];
  const add = (raw: any, fallback: string, format: StickerFormat, data: Buffer) => {
    if (data.length > MAX_FILE_BYTES) throw new Error(`فایل «${fallback}» بزرگ‌تر از ۲ مگابایته.`);
    out.push({ ...meta(raw, fallback), format, data });
  };

  if (ext === "tgs") {
    try { gunzipSync(file); } catch { throw new Error("این فایل .tgs معتبر نیست."); }
    add({}, stem(filename), "tgs", file);
  } else if (ext === "zip" || (file[0] === 0x50 && file[1] === 0x4b)) {
    let files: Record<string, Uint8Array>;
    try { files = unzipSync(new Uint8Array(file)); } catch { throw new Error("فایل zip خراب یا نامعتبره."); }
    const byBase = new Map<string, Uint8Array>();
    for (const [p, d] of Object.entries(files)) if (!p.endsWith("/") && !p.includes("__MACOSX")) byBase.set(p.split("/").pop()!.toLowerCase(), d);
    const packRaw = byBase.get("pack.json");
    const fromFile = (ref: string, raw: any) => {
      const base = ref.split("/").pop()!.toLowerCase();
      const d = byBase.get(base);
      if (!d) throw new Error(`فایل «${ref}» داخل zip نیست.`);
      const e = extOf(base);
      const buf = Buffer.from(d);
      if (e === "json") {
        const o = JSON.parse(buf.toString("utf8"));
        if (!isLottie(o)) throw new Error(`«${ref}» انیمیشن Lottie نیست.`);
        add(raw, stem(base), "tgs", fromLottie(o));
      } else if (EXT[e]) add(raw, stem(base), EXT[e]!, buf);
      else throw new Error(`فرمت «${ref}» پشتیبانی نمی‌شه.`);
    };
    if (packRaw) {
      let p: any;
      try { p = JSON.parse(Buffer.from(packRaw).toString("utf8")); } catch { throw new Error("pack.json خرابه."); }
      const list: any[] = Array.isArray(p) ? p : Array.isArray(p?.gifts) ? p.gifts : [];
      if (!list.length) throw new Error("pack.json هیچ هدیه‌ای نداره.");
      for (const g of list.slice(0, MAX_PACK_GIFTS)) {
        if (typeof g?.file !== "string") throw new Error("هر هدیه باید فیلد file داشته باشه.");
        fromFile(g.file, g);
      }
    } else {
      for (const [base] of byBase) if (/\.(tgs|json|png|webp|webm|jpe?g)$/.test(base) && base !== "pack.json") { fromFile(base, {}); if (out.length >= MAX_PACK_GIFTS) break; }
    }
  } else if (ext === "json") {
    let o: any;
    try { o = JSON.parse(file.toString("utf8")); } catch { throw new Error("فایل JSON خراب است."); }
    if (isLottie(o)) add({}, stem(filename), "tgs", fromLottie(o));
    else {
      const list: any[] = Array.isArray(o) ? o : Array.isArray(o?.gifts) ? o.gifts : [];
      if (!list.length) throw new Error("JSON نه انیمیشن Lottie است و نه لیست هدیه (gifts).");
      for (const g of list.slice(0, MAX_PACK_GIFTS)) {
        if (isLottie(g?.lottie)) add(g, "هدیه", "tgs", fromLottie(g.lottie));
        else if (b64(g?.tgs_b64)) add(g, "هدیه", "tgs", b64(g.tgs_b64)!);
        else if (b64(g?.png_b64)) add(g, "هدیه", "png", b64(g.png_b64)!);
        else throw new Error("هر هدیه‌ی JSON باید lottie یا tgs_b64 یا png_b64 داشته باشه.");
      }
    }
  } else throw new Error("فقط فایل zip / json / tgs قبوله.");

  if (!out.length) throw new Error("هیچ هدیه‌ای توی فایل پیدا نشد.");
  return out;
}

/** uploads every animation to Telegram (to get a file id) and creates the gifts; returns how many were created */
export async function importPack(api: Pick<Api, "sendDocument" | "deleteMessage">, ownerChatId: number, items: PackItem[], createdBy: number): Promise<{ created: Array<{ id: string; name: string }>; failed: string[] }> {
  const created: Array<{ id: string; name: string }> = [];
  const failed: string[] = [];
  for (const it of items) {
    try {
      const m: any = await api.sendDocument(ownerChatId, new InputFile(it.data, `${it.name.replace(/[^\w؀-ۿ-]+/g, "_") || "gift"}.${it.format === "jpg" ? "jpg" : it.format}`), { disable_notification: true });
      const doc = m.document;
      if (!doc?.file_id) throw new Error("no file id");
      await api.deleteMessage(ownerChatId, m.message_id).catch(() => {});
      const g = await addCustomGift({
        name: it.name, emoji: it.emoji, price: it.price,
        sticker: { fileId: doc.file_id, uniqueId: doc.file_unique_id, format: it.format },
        createdBy, pattern: it.pattern, c1: it.c1, c2: it.c2,
      });
      created.push({ id: g._id, name: g.name });
    } catch {
      failed.push(it.name);
    }
  }
  return { created, failed };
}
