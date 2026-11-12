/** v1.30.2 — fixes from the v1.30.1 audit. MOCK TESTS (fake MongoDB): index definitions are checked, not their real query plans. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "../harness/fakeTelegram.js";
import { col } from "../harness/fakeMongo.js";

await createHarness();
const { ensureUserIndexes } = await import("../../src/db/models/user.js");

test("X1. `users` has partial indexes for banned / seedHidden (the hiddenOwnerIds() hot-path query no longer scans the collection)", async () => {
  await ensureUserIndexes();
  await ensureUserIndexes(); // idempotent
  const idx = (col("users") as any).indexes as Array<{ name: string; key: any; partialFilterExpression?: any }>;
  const b = idx.find((i) => i.name === "banned_users");
  const s = idx.find((i) => i.name === "seed_hidden_users");
  assert.ok(b && s, "both indexes exist");
  assert.deepEqual(b!.partialFilterExpression, { banned: true });
  assert.deepEqual(s!.partialFilterExpression, { seedHidden: true });
  assert.equal(idx.filter((i) => i.name === "banned_users").length, 1, "created once");
});
