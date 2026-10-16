import { C, col } from "./common.js";

/** Owner-controlled switches of the Navagram Mini App. Stored in MongoDB (never in env). */
export interface MiniSettings {
  _id: "singleton";
  /** When on, a copy of every new post is sent (once) to the channel below. */
  postsChannelEnabled: boolean;
  postsChannelId: number | null;
  postsChannelTitle: string | null;
  giftPrices: Record<string, number>;
  giftsDisabled: Record<string, boolean>;
  /** gifts of which only ONE copy may ever exist (sold once; resold only by being re-gifted) */
  giftUnique: Record<string, boolean>;
}

const DEFAULTS: MiniSettings = { _id: "singleton", postsChannelEnabled: false, postsChannelId: null, postsChannelTitle: null, giftPrices: {}, giftsDisabled: {}, giftUnique: {} };

export async function getMiniSettings(): Promise<MiniSettings> {
  const c = await col<MiniSettings>(C.settings);
  const doc = await c.findOne({ _id: "singleton" });
  return { ...DEFAULTS, ...(doc ?? {}), giftPrices: { ...(doc?.giftPrices ?? {}) }, giftsDisabled: { ...(doc?.giftsDisabled ?? {}) }, giftUnique: { ...(doc?.giftUnique ?? {}) } };
}

async function patch(update: Record<string, unknown>): Promise<void> {
  const c = await col<MiniSettings>(C.settings);
  await c.updateOne({ _id: "singleton" }, { $set: update }, { upsert: true });
}

export const setPostsChannelEnabled = (on: boolean) => patch({ postsChannelEnabled: on });
export const setPostsChannel = (id: number | null, title: string | null) => patch({ postsChannelId: id, postsChannelTitle: title });
export async function setGiftPrice(giftId: string, price: number): Promise<void> {
  const s = await getMiniSettings();
  await patch({ giftPrices: { ...s.giftPrices, [giftId]: price } });
}
export async function setGiftEnabled(giftId: string, enabled: boolean): Promise<void> {
  const s = await getMiniSettings();
  await patch({ giftsDisabled: { ...s.giftsDisabled, [giftId]: !enabled } });
}
export async function setGiftUnique(giftId: string, unique: boolean): Promise<void> {
  const s = await getMiniSettings();
  await patch({ giftUnique: { ...s.giftUnique, [giftId]: unique } });
}
