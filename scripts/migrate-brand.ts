import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { applyBrandMigration, planBrandMigration, rollbackBrandMigration } from "../src/services/brandMigration.js";

/**
 *   npx tsx scripts/migrate-brand.ts                      → DRY RUN (default, writes nothing)
 *   npx tsx scripts/migrate-brand.ts --apply --backup b.json   → applies; b.json holds the old values (REQUIRED)
 *   npx tsx scripts/migrate-brand.ts --rollback b.json    → restores the old values from that backup
 * Take a full database backup (mongodump) BEFORE --apply. The database name is read from MONGODB_DB_NAME and is never changed here.
 */
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
if (process.argv.includes("--rollback")) {
  const file = arg("--rollback");
  if (!file) throw new Error("--rollback needs a backup file");
  console.log(JSON.stringify(await rollbackBrandMigration(JSON.parse(readFileSync(file, "utf8"))), null, 2));
  process.exit(0);
}
const plan = await planBrandMigration();
console.log(JSON.stringify({ mode: process.argv.includes("--apply") ? "APPLY" : "DRY_RUN", scannedContentDocs: plan.scanned, willChange: plan.changes.map((c) => ({ id: c.id, before: c.before.slice(0, 80), after: c.after.slice(0, 80) })), settingsToReviewManually: plan.settingsReport }, null, 2));
if (process.argv.includes("--apply")) {
  const backupFile = arg("--backup");
  if (!backupFile) { console.error("Refusing to apply without --backup <file>."); process.exit(1); }
  writeFileSync(backupFile, JSON.stringify(plan.changes, null, 2)); // written BEFORE any change
  const r = await applyBrandMigration(plan);
  writeFileSync(backupFile, JSON.stringify(r.backup, null, 2));
  console.log(JSON.stringify({ applied: r.applied, skippedBecauseEditedMeanwhile: r.skippedChanged, integrity: r.integrity }, null, 2));
  if (!r.integrity.ok) process.exit(2);
}
process.exit(0);
