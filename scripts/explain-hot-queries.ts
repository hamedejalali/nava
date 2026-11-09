/**
 * READ-ONLY. Prints explain("executionStats") summaries for the hot user-list queries so the OWNER can decide with evidence whether an index
 * is needed. Run it only against STAGING (or a read replica) — never write anything, never create indexes.
 *   MONGODB_URI=<staging uri> npm run explain-queries
 * Nothing is changed in the database; no document content is printed (only plan shape and counters).
 */
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) { console.error("MONGODB_URI (staging!) is required"); process.exit(1); }
const dbName = process.env.MONGODB_DB;
const client = new MongoClient(uri, { maxPoolSize: 1, serverSelectionTimeoutMS: 10_000 });
const cases: Array<[string, Record<string, unknown>, Record<string, 1 | -1>, number]> = [
  ["search list (all)", { onboardingStep: "COMPLETED", banned: { $ne: true } }, { lastActivityAt: -1 }, 7],
  ["search list (female)", { onboardingStep: "COMPLETED", banned: { $ne: true }, gender: "female" }, { lastActivityAt: -1 }, 7],
  ["search by city", { onboardingStep: "COMPLETED", banned: { $ne: true }, city: "تهران" }, { lastActivityAt: -1 }, 300],
];
try {
  await client.connect();
  const db = dbName ? client.db(dbName) : client.db();
  for (const [name, filter, sort, limit] of cases) {
    const ex: any = await db.collection("users").find(filter).sort(sort).limit(limit).explain("executionStats");
    const s = ex.executionStats ?? {};
    const plan = JSON.stringify(ex.queryPlanner?.winningPlan ?? {}).match(/"(COLLSCAN|IXSCAN|SORT)"/g)?.join(",") ?? "?";
    console.log(`${name}: stages=${plan} returned=${s.nReturned} docsExamined=${s.totalDocsExamined} keysExamined=${s.totalKeysExamined} ms=${s.executionTimeMillis}`);
  }
  console.log("\nRule of thumb: docsExamined >> returned with COLLSCAN/SORT on a big users collection = candidate for an index (owner decision; test on staging first).");
} finally { await client.close(); }
