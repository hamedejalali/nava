import { getDb } from "../connect.js";

export interface BotSettingsDoc {
  _id: "singleton";
  /** Master ON/OFF of the whole bot (+ Mini App). While true, only staff and `maintenanceAllowIds` can use it;
   *  everybody else sees the admin-editable "maintenanceText" (ویرایش متن‌ها). */
  maintenanceMode: boolean;
  /** Numeric Telegram ids that keep full access while the bot is switched off (testers). */
  maintenanceAllowIds?: number[];
  /** Numeric Telegram ids allowed to pick a Mini App @username of ANY length (1+ characters). Everybody else needs 5+. */
  shortUsernameIds?: number[];
  /** Default (seed) members — master switches. The per-member copy lives on the member document
   *  (`seedHidden` / `seedChatEnabled`) so every query can read it without a second lookup. */
  seedsHidden?: boolean;
  seedChatEnabled?: boolean;
}

async function col() {
  const db = await getDb();
  return db.collection<BotSettingsDoc>("bot_settings");
}

export async function getBotSettings(): Promise<BotSettingsDoc> {
  const c = await col();
  const doc = await c.findOne({ _id: "singleton" });
  return doc ?? { _id: "singleton", maintenanceMode: false };
}

export async function setMaintenanceMode(enabled: boolean): Promise<void> {
  const c = await col();
  await c.updateOne({ _id: "singleton" }, { $set: { maintenanceMode: enabled } }, { upsert: true });
}

/** Replaces the whole allow-list (deduplicated, positive integers only). */
export async function setMaintenanceAllowIds(ids: number[]): Promise<number[]> {
  const clean = [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const c = await col();
  await c.updateOne({ _id: "singleton" }, { $set: { maintenanceAllowIds: clean } }, { upsert: true });
  return clean;
}

export async function patchBotSettings(patch: Partial<Omit<BotSettingsDoc, "_id">>): Promise<void> {
  const c = await col();
  await c.updateOne({ _id: "singleton" }, { $set: patch }, { upsert: true });
}

/** Replaces the whole list of people who may use a short (1–4 character) Mini App username. */
export async function setShortUsernameIds(ids: number[]): Promise<number[]> {
  const clean = [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const c = await col();
  await c.updateOne({ _id: "singleton" }, { $set: { shortUsernameIds: clean } }, { upsert: true });
  return clean;
}
