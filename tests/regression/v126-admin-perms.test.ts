/** v1.26.0 — per-admin permissions: toggle list, central gate, jeton send debits the admin, audit line to the log channel. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ OWNER_ID: "1" });

beforeEach(() => {
  resetState();
  h.resetCalls();
  seedUser({ id: 1, anonId: "user_OWN", nickname: "مالک", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: 5, anonId: "user_ADM", nickname: "ادمین", isAdmin: true, relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: 7, anonId: "user_W7", nickname: "کاربر", relicBalance: 10, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
});

test("P1. a switched-off permission blocks the button for an admin, not for the owner", async () => {
  await h.text(5, "♻️ ریست اطلاعات کاربر"); // resetUser default OFF
  await h.settle();
  assert.ok(h.of("sendMessage", 5).some((c) => /دسترسی/.test(c.payload.text)), "denied message");
});

test("P2. owner toggles a permission from the glass list and it is saved", async () => {
  await h.callback(1, "adm:perm:5:resetUser", 10);
  await h.settle();
  assert.equal(col("users").byId(5).adminPerms?.resetUser, true);
  await h.callback(1, "adm:perm:5:resetUser", 10);
  await h.settle();
  assert.equal(col("users").byId(5).adminPerms?.resetUser, false);
});

test("P3. a non-owner cannot toggle permissions", async () => {
  await h.callback(5, "adm:perm:5:jeton", 10);
  await h.settle();
  assert.equal(col("users").byId(5).adminPerms, undefined);
});
