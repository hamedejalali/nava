import { getDb } from "../db/connect.js";
import { renameBrand } from "../db/models/content.js";

/**
 * Stored-text brand migration («نوا» → «مویا», «نوا گرام» → «مویاگرام»). v1.28.0.
 *
 * SAFETY MODEL
 *  - The database NAME, collection names, ids, anonIds, usernames and every other field are never touched.
 *  - Only the `text` field of `content` documents is migrated (admin-editable bot texts). The `supportId` text is an id, not prose, and is skipped.
 *  - `bot_settings.vars.*` is only SCANNED and reported (values may be usernames / ids; a person decides).
 *  - Every write is a compare-and-set on the exact old value: a text edited meanwhile is skipped, never overwritten.
 *  - Dry run by default. Apply returns a backup list (old values) that `rollbackBrandMigration` can restore, again with compare-and-set.
 */
export interface BrandChange { collection: "content"; id: string; before: string; after: string }
export interface BrandPlan { changes: BrandChange[]; scanned: number; settingsReport: Array<{ key: string; sample: string }> }

export async function planBrandMigration(): Promise<BrandPlan> {
  const db = await getDb();
  const changes: BrandChange[] = [];
  const docs = await db.collection<any>("content").find({}).toArray();
  for (const d of docs) {
    if (d._id === "supportId" || typeof d.text !== "string") continue;
    const after = renameBrand(d.text);
    if (after !== d.text) changes.push({ collection: "content", id: String(d._id), before: d.text, after });
  }
  const settingsReport: BrandPlan["settingsReport"] = [];
  const s = await db.collection<any>("bot_settings").findOne({ _id: "singleton" } as any, { projection: { vars: 1 } });
  for (const [key, val] of Object.entries<any>(s?.vars ?? {})) if (typeof val === "string" && /نوا/.test(val)) settingsReport.push({ key, sample: val.slice(0, 60) });
  return { changes, scanned: docs.length, settingsReport };
}

export interface BrandApplyResult { applied: number; skippedChanged: number; backup: BrandChange[]; integrity: { ok: boolean; problems: string[] } }

export async function applyBrandMigration(plan: BrandPlan): Promise<BrandApplyResult> {
  const db = await getDb();
  const col = db.collection<any>("content");
  let applied = 0, skippedChanged = 0;
  const backup: BrandChange[] = [];
  for (const c of plan.changes) {
    const r = await col.updateOne({ _id: c.id, text: c.before }, { $set: { text: c.after } });
    if (r.modifiedCount === 1) { applied++; backup.push(c); } else skippedChanged++;
  }
  // integrity: every applied doc now holds exactly the planned text, nothing else changed in count
  const problems: string[] = [];
  for (const c of backup) {
    const d = await col.findOne({ _id: c.id });
    if (!d || d.text !== c.after) problems.push(`content/${c.id}: text is not the planned value`);
  }
  if ((await col.countDocuments({})) !== plan.scanned) problems.push("content: document count changed during the run (concurrent writes?)");
  return { applied, skippedChanged, backup, integrity: { ok: problems.length === 0, problems } };
}

export async function rollbackBrandMigration(backup: BrandChange[]): Promise<{ restored: number; skippedChanged: number }> {
  const col = (await getDb()).collection<any>("content");
  let restored = 0, skippedChanged = 0;
  for (const c of backup) {
    const r = await col.updateOne({ _id: c.id, text: c.after }, { $set: { text: c.before } });
    if (r.modifiedCount === 1) restored++; else skippedChanged++;
  }
  return { restored, skippedChanged };
}
