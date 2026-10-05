/**
 * 12-word wallet recovery phrase. Runs against the in-memory fake Mongo.
 * NOTE (honest scope): the fake serializes each DB operation and rolls back
 * a failed transaction, so these tests prove the LOGIC (single-winner status
 * guard, atomic move, rollback paths, idempotent replay). They do NOT prove
 * real MongoDB write-conflict/isolation behaviour.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { installFakeMongo, resetFakeMongo, seedUser, col, dumpDb } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
process.env.WALLET_BOT_TOKEN = "777:WALLET-TEST";
installFakeMongo();
const R = await import("../../src/db/models/walletRecovery.js");

beforeEach(async () => {
  resetFakeMongo();
  await R.ensureWalletRecoveryIndexes();
  seedUser({ id: 1 }); // the wallet that will be recovered
  seedUser({ id: 2 }); // the NEW telegram account
  seedUser({ id: 3 }); // an attacker / other account
  for (const [id, balance] of [[1, 40], [2, 3], [3, 0]] as const) {
    await col("wallet_accounts").insertOne({ _id: id, token: `RLC-TEST-${id}`, balance, tapsTotal: 0, createdAt: new Date() } as any);
  }
});

async function securedPhrase(owner = 1): Promise<string> {
  const g = await R.generateRecoveryPhrase(owner);
  assert.equal(g.status, "created");
  const phrase = (g as any).words.join(" ");
  assert.equal((await R.confirmRecoveryPhrase(owner, phrase)).status, "confirmed");
  return phrase;
}
const total = () => col("wallet_accounts").all().reduce((s: number, u: any) => s + (u.balance ?? 0), 0);

test("generate: 12 real BIP39 words (valid checksum), different every time, CSPRNG-sourced", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) {
    const p = R.generatePhrase();
    assert.equal(p.split(" ").length, 12);
    assert.ok(validateMnemonic(p, wordlist));
    assert.ok(p.split(" ").every((w) => wordlist.includes(w)));
    seen.add(p);
  }
  assert.equal(seen.size, 25);
});

test("storage: only a hash is kept — the words appear nowhere in the database", async () => {
  const g: any = await R.generateRecoveryPhrase(1);
  const phrase = g.words.join(" ");
  const dump = JSON.stringify(dumpDb());
  for (const w of new Set<string>(g.words)) {
    // a word may legitimately be a substring of something unrelated, so check the phrase and word pairs
    assert.ok(!dump.includes(phrase));
  }
  assert.ok(!g.words.some((_: string, i: number) => i < 11 && dump.includes(`${g.words[i]} ${g.words[i + 1]}`)), "no word pairs either");
  const doc = col("wallet_recovery").all()[0];
  assert.deepEqual(Object.keys(doc).sort(), ["_id", "createdAt", "live", "ownerId", "recoveryId", "status"]);
  assert.match(doc._id, /^[0-9a-f]{64}$/);
  assert.equal(doc.status, "pending_backup");
});

test("normalization: tolerant of case/newlines/numbering, strict about count, wordlist and checksum", () => {
  const p = R.generatePhrase();
  const words = p.split(" ");
  assert.equal(R.normalizePhrase(p.toUpperCase()), p);
  assert.equal(R.normalizePhrase(words.map((w, i) => `${i + 1}. ${w}`).join("\n")), p);
  assert.equal(R.normalizePhrase(words.slice(0, 11).join(" ")), null);
  assert.equal(R.normalizePhrase([...words.slice(0, 11), "zzzzzz"].join(" ")), null);
  const swapped = [...words];
  [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
  if (swapped.join(" ") !== p) assert.equal(R.normalizePhrase(swapped.join(" ")) === p, false);
  assert.equal(R.normalizePhrase(12345), null);
  assert.equal(R.normalizePhrase("a ".repeat(500)), null);
});

test("backup confirmation is mandatory: an unconfirmed phrase cannot recover anything", async () => {
  const g: any = await R.generateRecoveryPhrase(1);
  const phrase = g.words.join(" ");
  assert.equal(await R.getRecoveryState(1), "pending_backup");
  assert.deepEqual(await R.claimRecoveryPhrase(2, phrase), { status: "invalid" });
  assert.equal(col("wallet_accounts").byId(1).balance, 40);

  const other = R.generatePhrase();
  assert.equal((await R.confirmRecoveryPhrase(1, other)).status, "mismatch");
  assert.equal((await R.confirmRecoveryPhrase(1, phrase)).status, "confirmed");
  assert.equal((await R.confirmRecoveryPhrase(1, phrase)).status, "already_active");
  assert.equal(await R.getRecoveryState(1), "active");
  assert.equal((await R.generateRecoveryPhrase(1)).status, "already_active", "an active phrase is never regenerated/overwritten");
});

test("regenerating before confirming replaces the old pending phrase; exactly one live phrase per wallet", async () => {
  const a: any = await R.generateRecoveryPhrase(1);
  const b: any = await R.generateRecoveryPhrase(1);
  assert.notDeepEqual(a.words, b.words);
  assert.equal(col("wallet_recovery").all().filter((d: any) => d.live).length, 1);
  assert.equal((await R.confirmRecoveryPhrase(1, a.words.join(" "))).status, "mismatch", "the replaced phrase is dead");
  assert.equal((await R.confirmRecoveryPhrase(1, b.words.join(" "))).status, "confirmed");

  resetFakeMongo();
  await R.ensureWalletRecoveryIndexes();
  seedUser({ id: 1 });
  await Promise.all([R.generateRecoveryPhrase(1), R.generateRecoveryPhrase(1)]);
  assert.equal(col("wallet_recovery").all().filter((d: any) => d.live).length, 1, "concurrent generate still leaves one live phrase");
});

test("claim: balance moves once to the new account; ledger pair written; old wallet emptied; phrase burned", async () => {
  const phrase = await securedPhrase();
  const before = total();
  const r: any = await R.claimRecoveryPhrase(2, phrase);
  assert.equal(r.status, "claimed");
  assert.equal(r.movedAmount, 40);
  assert.equal(r.newBalance, 43);
  assert.equal(col("wallet_accounts").byId(1).balance, 0);
  assert.equal(col("wallet_accounts").byId(2).balance, 43);
  assert.equal(total(), before, "no Relic created or destroyed");

  const row = col("wallet_ledger").all().find((t: any) => t.kind === "recovery");
  assert.equal(row.amount, 40);
  assert.equal(row.fromUser, 1);
  assert.equal(row.toUser, 2);
  assert.ok(!JSON.stringify(row).includes(phrase));

  const doc = col("wallet_recovery").all()[0];
  assert.equal(doc.status, "claimed");
  assert.equal(doc.claimedBy, 2);
  assert.equal(doc.live, undefined);
});

test("replay by the same claimer moves nothing more; anyone else is told 'invalid'", async () => {
  const phrase = await securedPhrase();
  await R.claimRecoveryPhrase(2, phrase);
  assert.deepEqual(await R.claimRecoveryPhrase(2, phrase), { status: "already_claimed_by_you", newBalance: 43 });
  assert.deepEqual(await R.claimRecoveryPhrase(3, phrase), { status: "invalid" });
  assert.equal(col("wallet_accounts").byId(2).balance, 43);
  assert.equal(col("wallet_accounts").byId(3).balance, 0);
  assert.equal(col("wallet_ledger").all().filter((t: any) => t.kind === "recovery").length, 1);
});

test("RACE: two different accounts claim the same phrase at once — exactly one wins, nothing is duplicated", async () => {
  const phrase = await securedPhrase();
  const before = total();
  const results = await Promise.all([R.claimRecoveryPhrase(2, phrase), R.claimRecoveryPhrase(3, phrase)]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["claimed", "invalid"]);
  assert.equal(total(), before);
  assert.equal(col("wallet_accounts").byId(1).balance, 0);
  assert.equal(col("wallet_accounts").all().filter((u: any) => (u.balance ?? 0) >= 40).length, 1, "only one account holds the recovered balance");
  assert.equal(col("wallet_ledger").all().filter((t: any) => t.kind === "recovery").length, 1);
});

test("RACE: the same account fires the claim many times at once — moved exactly once", async () => {
  const phrase = await securedPhrase();
  const results = await Promise.all(Array.from({ length: 6 }, () => R.claimRecoveryPhrase(2, phrase)));
  assert.equal(results.filter((r) => r.status === "claimed").length, 1);
  assert.ok(results.every((r) => ["claimed", "already_claimed_by_you", "invalid"].includes(r.status)));
  assert.equal(col("wallet_accounts").byId(2).balance, 43);
  assert.equal(col("wallet_ledger").all().filter((t: any) => t.kind === "recovery").length, 1);
});

test("claim rolls back completely when the claimer or the old wallet is banned", async () => {
  const phrase = await securedPhrase();
  await col("users").updateOne({ _id: 2 }, { $set: { banned: true } });
  assert.equal((await R.claimRecoveryPhrase(2, phrase)).status, "blocked");
  assert.equal(col("wallet_recovery").all()[0].status, "active", "phrase NOT burned by a rolled-back claim");
  assert.equal(col("wallet_accounts").byId(1).balance, 40);

  await col("users").updateOne({ _id: 2 }, { $set: { banned: false } });
  await col("users").updateOne({ _id: 1 }, { $set: { banned: true } });
  assert.equal((await R.claimRecoveryPhrase(2, phrase)).status, "blocked");
  assert.equal(col("wallet_accounts").byId(1).balance, 40);

  await col("users").updateOne({ _id: 1 }, { $set: { banned: false } });
  assert.equal((await R.claimRecoveryPhrase(2, phrase)).status, "claimed", "still claimable once the block is gone");
});

test("claiming your own wallet's phrase is rejected and changes nothing", async () => {
  const phrase = await securedPhrase();
  assert.deepEqual(await R.claimRecoveryPhrase(1, phrase), { status: "same_account" });
  assert.equal(col("wallet_accounts").byId(1).balance, 40);
  assert.equal(col("wallet_recovery").all()[0].status, "active");
});

test("a new account can secure its own fresh phrase after recovering", async () => {
  const phrase = await securedPhrase();
  await R.claimRecoveryPhrase(2, phrase);
  assert.equal(await R.getRecoveryState(2), "none");
  assert.equal((await R.generateRecoveryPhrase(2)).status, "created");
  assert.equal(await R.getRecoveryState(1), "none", "the old wallet's burned phrase no longer counts as live");
});

test("wrong-guess limiter is stored in the database and caps attempts per hour", async () => {
  let allowed = 0;
  for (let i = 0; i < 15; i++) if ((await R.takeAttempt(3)).allowed) allowed++;
  assert.equal(allowed, R.MAX_ATTEMPTS_PER_HOUR);
  assert.equal((await R.takeAttempt(2)).allowed, true, "other users are unaffected");
  assert.ok(col("wallet_recovery_attempts").all().length >= 2);
});

// ------------------------------------------------------------------ HTTP layer
function signedInitData(userId: number): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.WALLET_BOT_TOKEN!).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
async function call(body: Record<string, unknown>) {
  const { default: handler } = await import("../../api/wallet/recovery.js");
  let status = 200;
  let payload: any;
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader: (k: string, v: string) => void (headers[k] = v),
    status(c: number) { status = c; return res; },
    json(o: any) { payload = o; return res; },
    end() { return res; },
    send(o: any) { payload = o; return res; },
  };
  await handler({ method: "POST", headers: {}, query: {}, body } as any, res);
  return { status, payload, headers };
}

test("HTTP: unauthenticated / forged requests are rejected; full flow works; nothing sensitive is logged", async () => {
  assert.equal((await call({ action: "status" })).status, 401);
  assert.equal((await call({ action: "status", initData: "user=%7B%22id%22%3A1%7D&hash=00" })).status, 401);

  const logs: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of ["log", "error", "warn", "info"] as const) (console as any)[k] = (...a: any[]) => void logs.push(a.map(String).join(" "));
  let phrase = "";
  try {
    const me = signedInitData(1);
    assert.equal((await call({ action: "status", initData: me })).payload.state, "none");
    const gen = await call({ action: "generate", initData: me });
    assert.equal(gen.status, 200);
    assert.equal(gen.headers["Cache-Control"], "no-store");
    phrase = gen.payload.words.join(" ");
    assert.equal((await call({ action: "claim", initData: signedInitData(2), phrase })).status, 400, "unconfirmed phrase is useless");
    assert.equal((await call({ action: "confirm", initData: me, phrase })).payload.status, "confirmed");
    assert.equal((await call({ action: "generate", initData: me })).status, 409);
    const claim = await call({ action: "claim", initData: signedInitData(2), phrase: phrase.toUpperCase() });
    assert.equal(claim.payload.status, "claimed");
    assert.equal(claim.payload.newBalance, 43);
    assert.equal((await call({ action: "claim", initData: signedInitData(3), phrase })).status, 400);
    assert.equal((await call({ action: "bogus", initData: me })).status, 400);
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!logs.some((l) => l.includes(phrase) || phrase.split(" ").slice(0, 3).every((w) => l.includes(w))), "phrase never logged");
});

test("HTTP: the client can try only so many guesses per hour", async () => {
  const me = signedInitData(3);
  const wrong = R.generatePhrase();
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await call({ action: "claim", initData: me, phrase: wrong })).status;
  assert.equal(last, 429);
});
