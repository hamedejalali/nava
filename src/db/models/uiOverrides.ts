import { getDb } from "../connect.js";
import { CATALOG, type CatalogEntry } from "../../generated/textCatalog.js";
import { labelTapForms, renderButtonLabel } from "../../services/emojiSyntax.js";

/**
 * «🎨 طراحی داخلی ربات» storage. Collection `ui_overrides` (additive, nothing else reads it):
 *   { _id: "t<hash>", text }                          owner's replacement of one catalogued text
 *   { _id: "b<hash>", text?, style?, hidden? }        owner's change of one catalogued button (name / colour / hidden)
 *   { _id: "tpl:profileCard", text }                  the profile-card template ({variables} stay)
 *   { _id: "c:<n>", custom: true, label, style, reply, order }   a button the owner created (+ the message it sends)
 * Mirrored in memory (reload ≤ every 20 s per instance) so the outgoing-message layer stays synchronous.
 */
export type BtnStyle = "primary" | "success" | "danger" | "default";
export interface OvDoc {
  _id: string;
  text?: string;
  style?: BtnStyle;
  hidden?: boolean;
  custom?: boolean;
  label?: string;
  reply?: string;
  order?: number;
}
export const MAX_CUSTOM_BUTTONS = 12;
export const CATALOG_BY_ID = new Map<string, CatalogEntry>(CATALOG.map((e) => [e.id, e]));

const col = async () => (await getDb()).collection<OvDoc>("ui_overrides");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Compiled {
  id: string;
  lit?: string;
  re?: RegExp;
  vars: string[];
  doc: OvDoc;
  hadTag: boolean;
}
let state: { at: number; docs: OvDoc[]; texts: Compiled[]; buttons: Compiled[] } = { at: 0, docs: [], texts: [], buttons: [] };

function compile(id: string, e: CatalogEntry, doc: OvDoc): Compiled | null {
  const hadTag = e.parts.some((p) => p.includes("<"));
  if (!e.vars.length) return { id, lit: e.parts[0]!, vars: [], doc, hadTag };
  if (e.parts.join("").trim().length < 6) return null; // too generic to match safely
  return { id, re: new RegExp(e.parts.map(esc).join("([\\s\\S]*?)"), "g"), vars: e.vars, doc, hadTag };
}

export async function loadOverrides(force = false): Promise<void> {
  if (!force && Date.now() - state.at < 20_000) return;
  try {
    const docs = await (await col()).find({}).toArray();
    const texts: Compiled[] = [];
    const buttons: Compiled[] = [];
    for (const d of docs) {
      const e = CATALOG_BY_ID.get(d._id);
      if (!e) continue;
      const c = compile(d._id, e, d);
      if (!c) continue;
      if (e.kind === "text" && d.text !== undefined) texts.push(c);
      else if (e.kind === "button" && (d.text !== undefined || d.style || d.hidden)) buttons.push(c);
    }
    state = { at: Date.now(), docs, texts, buttons };
  } catch {
    /* keep the last known state */
  }
}
export const compiledTexts = () => state.texts;
export const compiledButtons = () => state.buttons;
export const allDocs = () => state.docs;
export const getDoc = (id: string) => state.docs.find((d) => d._id === id);
export const customButtons = () => state.docs.filter((d) => d.custom).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

export async function saveDoc(id: string, set: Partial<OvDoc>, unset: string[] = []): Promise<void> {
  const u: any = {};
  if (Object.keys(set).length) u.$set = set;
  if (unset.length) u.$unset = Object.fromEntries(unset.map((k) => [k, ""]));
  if (!u.$set && !u.$unset) return;
  await (await col()).updateOne({ _id: id }, u, { upsert: true });
  await loadOverrides(true);
}
export async function resetDoc(id: string): Promise<void> {
  await (await col()).deleteOne({ _id: id });
  await loadOverrides(true);
}

export async function addCustomButton(label: string, style: BtnStyle, reply: string): Promise<{ ok: true; id: string } | { ok: false }> {
  const c = await col();
  const all = await c.find({ custom: true }).toArray();
  if (all.length >= MAX_CUSTOM_BUTTONS) return { ok: false };
  const n = Math.max(0, ...all.map((b) => Number(b._id.slice(2)) || 0)) + 1;
  const id = `c:${n}`;
  await c.insertOne({ _id: id, custom: true, label, style, reply, order: n });
  await loadOverrides(true);
  return { ok: true, id };
}

/** Texts a tap on a (renamed) button may arrive as → the ORIGINAL label the handlers know. */
export function inboundOriginal(text: string): string | undefined {
  for (const b of state.buttons) {
    if (b.doc.text === undefined || b.lit === undefined) continue;
    const forms = labelTapForms(b.doc.text);
    if (forms.includes(text)) return b.lit;
  }
  return undefined;
}

/** a custom button's tap text(s) */
export function matchCustomButton(text: string): OvDoc | undefined {
  return customButtons().find((c) => c.label && !c.hidden && labelTapForms(c.label).includes(text));
}
export { renderButtonLabel };
