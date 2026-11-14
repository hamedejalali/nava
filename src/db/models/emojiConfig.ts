import { getDb } from "../connect.js";
import { setOwnerPremium } from "../../services/emojiSyntax.js";
import { loadUiButtons } from "./uiConfig.js";
import { loadTextOverrides } from "../../services/textOverrides.js";
import { cleanEmojiId, currentEmojiOverrides, emojiOverridesLoadedAt, setEmojiOverrides, DEFAULT_EMOJI, type EmojiKey } from "../../config/emojis.js";

/** Emoji settings edited from the admin panel (premium on/off + per-emoji override). One doc: `emoji_config/main`. */
interface Doc {
  _id: string;
  enabled?: boolean;
  map?: Record<string, string>;
  /** v1.31.0: did the OWNER account have Telegram Premium on his latest update (premium emoji need it) */
  ownerPremium?: boolean;
}
const col = async () => (await getDb()).collection<Doc>("emoji_config");

/** Loads the panel values into memory (cached 20 s). Never throws: a DB hiccup keeps the last known values. */
export async function loadEmojiConfig(force = false): Promise<void> {
  await loadUiButtons(force);
  await loadTextOverrides(force);
  if (!force && Date.now() - emojiOverridesLoadedAt() < 20_000) return;
  try {
    const d = await (await col()).findOne({ _id: "main" });
    setEmojiOverrides({ enabled: d?.enabled, map: d?.map ?? {} });
    setOwnerPremium(d?.ownerPremium === true);
  } catch {
    /* keep what we have */
  }
}

export async function setPremiumEnabled(on: boolean | null): Promise<void> {
  const c = await col();
  if (on === null) await c.updateOne({ _id: "main" }, { $unset: { enabled: "" } }, { upsert: true });
  else await c.updateOne({ _id: "main" }, { $set: { enabled: on } }, { upsert: true });
  await loadEmojiConfig(true);
}

/** value: a premium-emoji ID (or pasted <tg-emoji …>), a plain emoji, or "ID + plain emoji". null removes the override. */
export async function setEmojiOverride(key: EmojiKey, value: string | null): Promise<boolean> {
  if (!(key in DEFAULT_EMOJI)) return false;
  const c = await col();
  if (value === null) await c.updateOne({ _id: "main" }, { $unset: { [`map.${key}`]: "" } }, { upsert: true });
  else {
    const v = value.trim();
    if (!v || v.length > 200 || (!cleanEmojiId(v) && /[<>]/.test(v))) return false;
    await c.updateOne({ _id: "main" }, { $set: { [`map.${key}`]: v } }, { upsert: true });
  }
  await loadEmojiConfig(true);
  return true;
}

export const emojiKeys = (): EmojiKey[] => Object.keys(DEFAULT_EMOJI) as EmojiKey[];
export { currentEmojiOverrides };

/** Called with every update that comes from the owner: remembers whether his account currently has Premium (re-checked each time). */
export async function noteOwnerPremium(isPremium: boolean): Promise<void> {
  const { getOwnerPremium } = await import("../../services/emojiSyntax.js");
  if (getOwnerPremium() === isPremium) return;
  setOwnerPremium(isPremium);
  await (await col()).updateOne({ _id: "main" }, { $set: { ownerPremium: isPremium } }, { upsert: true });
}
