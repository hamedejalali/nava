import "dotenv/config";
import { reconcileBgStakes } from "../src/services/games/bgReconcile.js";

/** npx tsx scripts/bg-reconcile.ts           → report only (safe)
 *  npx tsx scripts/bg-reconcile.ts --apply   → also refunds PROVABLE losses (idempotent). Take a database backup first. */
const apply = process.argv.includes("--apply");
const r = await reconcileBgStakes({ apply });
console.log(JSON.stringify({ mode: apply ? "APPLY" : "REPORT_ONLY", ...r }, null, 2));
process.exit(0);
