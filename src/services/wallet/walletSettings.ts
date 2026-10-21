import { getDb } from "../../db/connect.js";

/** Owner switch for the Wallet deposit feature (admin panel «🔌 اتصال ولت»). Default ON when keys exist. */
export async function isWalletIntegrationEnabled(): Promise<boolean> {
  const doc = await (await getDb()).collection<any>("wallet_integration").findOne({ _id: "singleton" });
  return doc?.enabled !== false;
}
export async function setWalletIntegrationEnabled(on: boolean, by: number): Promise<void> {
  await (await getDb()).collection<any>("wallet_integration").updateOne({ _id: "singleton" }, { $set: { enabled: on, changedAt: new Date(), changedBy: by } }, { upsert: true });
}
