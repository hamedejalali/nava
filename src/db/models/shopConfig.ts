import { randomBytes } from "node:crypto";
import { getDb } from "../connect.js";

/**
 * Configuration of the purchase menu («ژتون» button): everything the owner edits from the admin panel.
 * Section ids: "stars" | "jeton". The «آدرس ولت» section only has a text (the address itself comes from the Wallet).
 */
export type ShopColor = "primary" | "success" | "danger";
export type ShopSection = "stars" | "jeton";

export interface ShopButton {
  id: string;
  kind: "url" | "stars";
  label: string;
  color: ShopColor;
  url?: string; // kind "url"
  price?: number; // kind "stars": Telegram Stars charged
  relic?: number; // kind "stars": ژتون credited (the DB field keeps its old name)
}

export interface ShopConfig {
  _id: "singleton";
  mainText: string;
  stars: { text: string; buttons: ShopButton[] };
  jeton: { text: string; buttons: ShopButton[] };
  wallet: { text: string };
}

export const DEFAULT_SHOP: Omit<ShopConfig, "_id"> = {
  mainText: "🪙 موجودی ژتون شما: {balance}\n\nاز کدوم روش می‌خوای خرید کنی؟",
  stars: { text: "⭐ خرید ژتون با Telegram Stars\n\nیکی از گزینه‌های زیر رو انتخاب کن:", buttons: [] },
  jeton: { text: "🪙 خرید ژتون\n\nیکی از گزینه‌های زیر رو انتخاب کن:", buttons: [] },
  wallet: { text: "📥 دریافت ژتون از ولت" },
};

async function col() {
  return (await getDb()).collection<ShopConfig>("shop_config");
}

export async function getShopConfig(): Promise<Omit<ShopConfig, "_id">> {
  const doc = await (await col()).findOne({ _id: "singleton" });
  return {
    mainText: doc?.mainText ?? DEFAULT_SHOP.mainText,
    stars: { text: doc?.stars?.text ?? DEFAULT_SHOP.stars.text, buttons: doc?.stars?.buttons ?? [] },
    jeton: { text: doc?.jeton?.text ?? DEFAULT_SHOP.jeton.text, buttons: doc?.jeton?.buttons ?? [] },
    wallet: { text: doc?.wallet?.text ?? DEFAULT_SHOP.wallet.text },
  };
}

export async function setShopText(which: "main" | "stars" | "jeton" | "wallet", text: string): Promise<void> {
  const path = which === "main" ? "mainText" : `${which}.text`;
  await (await col()).updateOne({ _id: "singleton" }, { $set: { [path]: text } }, { upsert: true });
}

export const newButtonId = () => randomBytes(4).toString("hex");

export function validColor(c: unknown): c is ShopColor {
  return c === "primary" || c === "success" || c === "danger";
}

export function validateButton(b: Partial<ShopButton>, section: ShopSection): string | null {
  if (!b.label || b.label.trim().length === 0 || b.label.length > 40) return "متن دکمه باید بین ۱ تا ۴۰ حرف باشه.";
  if (!validColor(b.color)) return "رنگ نامعتبره.";
  if (b.kind === "url") {
    if (!b.url || !/^https?:\/\/[^\s]{3,500}$/i.test(b.url) && !/^tg:\/\/[^\s]{3,500}$/i.test(b.url)) return "لینک باید با https:// یا http:// شروع بشه.";
    return null;
  }
  if (b.kind === "stars") {
    if (section !== "stars") return "دکمه‌ی پرداخت استارز فقط داخل بخش استارز ممکنه.";
    if (!Number.isSafeInteger(b.price) || (b.price as number) <= 0 || (b.price as number) > 100_000) return "قیمت استارز باید یه عدد صحیح مثبت باشه.";
    if (!Number.isSafeInteger(b.relic) || (b.relic as number) <= 0 || (b.relic as number) > 1_000_000_000) return "تعداد ژتون باید یه عدد صحیح مثبت باشه.";
    return null;
  }
  return "نوع دکمه نامعتبره.";
}

export async function addShopButton(section: ShopSection, b: Omit<ShopButton, "id">): Promise<ShopButton> {
  const err = validateButton(b, section);
  if (err) throw new Error(err);
  const btn: ShopButton = { ...b, id: newButtonId(), label: b.label.trim() };
  await (await col()).updateOne({ _id: "singleton" }, { $push: { [`${section}.buttons`]: btn } as any }, { upsert: true });
  return btn;
}

export async function removeShopButton(section: ShopSection, id: string): Promise<void> {
  await (await col()).updateOne({ _id: "singleton" }, { $pull: { [`${section}.buttons`]: { id } } as any });
}

export async function updateShopButton(section: ShopSection, id: string, patch: Partial<Omit<ShopButton, "id">>): Promise<string | null> {
  const cfg = await getShopConfig();
  const cur = cfg[section].buttons.find((b) => b.id === id);
  if (!cur) return "دکمه پیدا نشد.";
  const next = { ...cur, ...patch };
  const err = validateButton(next, section);
  if (err) return err;
  await (await col()).updateOne({ _id: "singleton" }, { $set: { [`${section}.buttons.$[b]`]: next } }, { arrayFilters: [{ "b.id": id }], upsert: false });
  return null;
}

export async function moveShopButton(section: ShopSection, id: string, dir: -1 | 1): Promise<void> {
  const cfg = await getShopConfig();
  const arr = [...cfg[section].buttons];
  const i = arr.findIndex((b) => b.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  await (await col()).updateOne({ _id: "singleton" }, { $set: { [`${section}.buttons`]: arr } }, { upsert: true });
}
