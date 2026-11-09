import "dotenv/config";
import { getDb, getClient } from "../src/db/connect.js";
import { env } from "../src/config/env.js";
import { mongoSource, reconcileLedger } from "../src/services/ledgerReconcile.js";

/**
 * READ-ONLY ledger ↔ balance reconciliation (F-10). Never writes. Never corrects a balance.
 *   npx tsx scripts/reconcile-ledger.ts [--owner-ignore] [--max=100]
 * Point MONGODB_URI / MONGODB_DB_NAME at a RESTORED COPY or staging database first (docs/BACKUP_RESTORE.md).
 */
const max = Number((process.argv.find((a) => a.startsWith("--max=")) ?? "--max=100").split("=")[1]) || 100;
const ignore = process.argv.includes("--owner-ignore") && env.OWNER_ID ? [env.OWNER_ID] : [];
const db = await getDb();
const report = await reconcileLedger(mongoSource(db), { maxListed: max, ignoreUserIds: ignore });
console.log(JSON.stringify({ db: env.MONGODB_DB_NAME, ...report }, null, 2));
await (await getClient()).close();
process.exit(0);
