import { getDb } from "../connect.js";

export interface BotSettingsDoc {
  _id: "singleton";
  maintenanceMode: boolean;
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
