import { getDb } from "../connect.js";

/**
 * v1.31.0 — «طراحی داخلی ربات»: owner-made changes to the user-visible main reply-keyboard.
 * Collection `ui_buttons`:
 *   built-in button  { _id: "b:<menuKey>", label?, style?, hidden? }     (only the fields the owner changed)
 *   custom button    { _id: "c:<n>", custom: true, label, style, reply, order }
 * The values are mirrored in memory (reloaded at most every 20 s per instance) so the synchronous keyboard builder stays synchronous.
 */
export type BtnStyle = "primary" | "success" | "danger" | "default";
export interface UiButtonDoc {
  _id: string;
  custom?: boolean;
  label?: string;
  style?: BtnStyle;
  hidden?: boolean;
  reply?: string;
  order?: number;
}
export const MAX_CUSTOM_BUTTONS = 12;

let cache: { at: number; list: UiButtonDoc[] } = { at: 0, list: [] };
const col = async () => (await getDb()).collection<UiButtonDoc>("ui_buttons");

export async function loadUiButtons(force = false): Promise<void> {
  if (!force && Date.now() - cache.at < 20_000) return;
  try {
    const list = await (await col()).find({}).sort({ order: 1, _id: 1 }).toArray();
    cache = { at: Date.now(), list };
  } catch {
    /* keep the last known list */
  }
}
export const uiButtons = (): UiButtonDoc[] => cache.list;
export const builtinOverride = (key: string): UiButtonDoc | undefined => cache.list.find((b) => b._id === `b:${key}`);
export const customButtons = (): UiButtonDoc[] => cache.list.filter((b) => b.custom && !b.hidden);

export async function patchBuiltin(key: string, set: Partial<Pick<UiButtonDoc, "label" | "style" | "hidden">>, unset: string[] = []): Promise<void> {
  const u: any = {};
  if (Object.keys(set).length) u.$set = set;
  if (unset.length) u.$unset = Object.fromEntries(unset.map((k) => [k, ""]));
  if (!u.$set && !u.$unset) return;
  await (await col()).updateOne({ _id: `b:${key}` }, u, { upsert: true });
  await loadUiButtons(true);
}
export async function resetBuiltin(key: string): Promise<void> {
  await (await col()).deleteOne({ _id: `b:${key}` });
  await loadUiButtons(true);
}
export async function addCustomButton(label: string, style: BtnStyle, reply: string): Promise<{ ok: true; id: string } | { ok: false; reason: "limit" | "dup" }> {
  const c = await col();
  const all = await c.find({ custom: true }).toArray();
  if (all.length >= MAX_CUSTOM_BUTTONS) return { ok: false, reason: "limit" };
  const n = Math.max(0, ...all.map((b) => Number(b._id.slice(2)) || 0)) + 1;
  const id = `c:${n}`;
  await c.insertOne({ _id: id, custom: true, label, style, reply, order: n });
  await loadUiButtons(true);
  return { ok: true, id };
}
export async function patchCustom(id: string, set: Partial<Pick<UiButtonDoc, "label" | "style" | "reply">>): Promise<void> {
  await (await col()).updateOne({ _id: id, custom: true }, { $set: set });
  await loadUiButtons(true);
}
export async function deleteCustom(id: string): Promise<void> {
  await (await col()).deleteOne({ _id: id, custom: true });
  await loadUiButtons(true);
}
