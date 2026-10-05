import { getDb } from "../connect.js";

/** Per-user conversation state of the wallet bot (one active flow per user). */
export interface WalletBotState {
  _id: number;
  step: string;
  data: Record<string, any>;
  updatedAt: Date;
}
const col = async () => (await getDb()).collection<WalletBotState>("wallet_bot_state");

export async function getState(userId: number): Promise<WalletBotState | null> {
  const s = await (await col()).findOne({ _id: userId });
  if (!s) return null;
  if (Date.now() - s.updatedAt.getTime() > 30 * 60_000) { // stale flows expire
    await clearState(userId);
    return null;
  }
  return s;
}
export async function setState(userId: number, step: string, data: Record<string, any> = {}): Promise<void> {
  await (await col()).updateOne({ _id: userId }, { $set: { step, data, updatedAt: new Date() } }, { upsert: true });
}
export async function clearState(userId: number): Promise<void> {
  await (await col()).deleteOne({ _id: userId });
}
