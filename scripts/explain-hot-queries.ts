/**
 * READ-ONLY. Prints explain("executionStats") summaries for the hot user-list queries so the OWNER can decide with evidence whether an index
 * is needed. Run it only against STAGING (or a read replica) — never write anything, never create indexes.
 *   MONGODB_URI=<staging uri> npm run explain-queries
 * Nothing is changed in the database; no document content is printed (only plan shape and counters).
 *
 * v1.30.3: the verdict is READ from the real winning plan (every stage, any depth): COLLSCAN anywhere = COLLSCAN, a real IXSCAN = IXSCAN,
 * an unexpected shape = UNKNOWN (never a pass). Cases marked MUST_INDEX make the script exit with code 1 when they are not an IXSCAN, so
 * "the index is used" is something the run proves on the cluster you point it at — it is not an expectation printed by the script.
 * The script creates no index: the indexes must already exist on that database (the app creates them at start-up / first Mini App request).
 */
import { MongoClient } from "mongodb";
import { casePasses, planStages, planVerdict } from "./queryPlan.js";

const uri = process.env.MONGODB_URI;
if (!uri) { console.error("MONGODB_URI (staging!) is required"); process.exit(1); }
const dbName = process.env.MONGODB_DB;
const client = new MongoClient(uri, { maxPoolSize: 1, serverSelectionTimeoutMS: 10_000 });
/** queries that must be served by an index; the others are informational (owner decision, see the notes in docs/AUDIT_v1.30.2.md) */
const MUST_INDEX = new Set([
  "hiddenOwnerIds: banned or hidden members",
  "lockedOwnerIds: private pages",
  "explore tile: latest post of one owner",
  "dm overview: last message of a thread",
  "feed: my posts newest first",
]);
const cases: Array<[string, Record<string, unknown>, Record<string, 1 | -1>, number, string?]> = [
  ["search list (all)", { onboardingStep: "COMPLETED", banned: { $ne: true } }, { lastActivityAt: -1 }, 7],
  ["search list (female)", { onboardingStep: "COMPLETED", banned: { $ne: true }, gender: "female" }, { lastActivityAt: -1 }, 7],
  ["search by city", { onboardingStep: "COMPLETED", banned: { $ne: true }, city: "تهران" }, { lastActivityAt: -1 }, 300],
  // v1.29.8 (audit A-06): the queries behind Explore and DM Overview. Ids below are placeholders: the plan shape is what matters.
  ["explore page (newest users, skip)", { onboardingStep: "COMPLETED", banned: { $ne: true } }, { createdAt: -1, _id: 1 }, 25, "users"],
  ["explore tile: latest post of one owner", { ownerId: 1 }, { createdAt: -1 }, 1, "mini_posts"],
  ["dm overview: my mini-app sessions", { origin: "miniapp", $or: [{ userA: 1 }, { userB: 1 }] }, { createdAt: -1 }, 40, "chat_sessions"],
  ["dm overview: last message of a thread", { sessionId: "x", seq: { $gt: 0 } }, { seq: -1 }, 1, "dm_messages"],
  // v1.30.2: must now show IXSCAN (partial indexes banned_users / seed_hidden_users), not COLLSCAN
  ["hiddenOwnerIds: banned or hidden members", { $or: [{ banned: true }, { seedHidden: true }] }, { _id: 1 }, 1000, "users"],
  ["lockedOwnerIds: private pages", { isPrivate: true, _id: { $ne: 1 } }, { _id: 1 }, 0, "users"],
  ["feed: my posts newest first", { ownerId: 1 }, { createdAt: -1 }, 20, "mini_posts"],
];
let failed = 0;
try {
  await client.connect();
  const db = dbName ? client.db(dbName) : client.db();
  for (const [name, filter, sort, limit, coll] of cases) {
    const mustIndex = MUST_INDEX.has(name);
    let cur = db.collection(coll ?? "users").find(filter);
    if (Object.keys(sort).length) cur = cur.sort(sort);
    if (limit > 0) cur = cur.limit(limit);
    const ex: any = await cur.explain("executionStats");
    const s = ex.executionStats ?? {};
    const verdict = planVerdict(ex);
    const ok = casePasses(mustIndex, verdict);
    if (!ok) failed++;
    console.log(`${ok ? (mustIndex ? "PASS" : "info") : "FAIL"}  ${name}: ${verdict}${mustIndex ? " (required)" : ""} stages=${planStages(ex.queryPlanner?.winningPlan).join(">")} returned=${s.nReturned} docsExamined=${s.totalDocsExamined} keysExamined=${s.totalKeysExamined} ms=${s.executionTimeMillis}`);
  }
  console.log("\nRule of thumb: docsExamined >> returned with COLLSCAN/SORT on a big users collection = candidate for an index (owner decision; test on staging first).");
  if (failed) { console.error(`\n${failed} required query(ies) did NOT use an index on this database.`); process.exitCode = 1; }
} finally { await client.close(); }
