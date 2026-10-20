/** v1.21.0 — monitor account switcher: staff only, Nava first, then default members. (mocked) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser } from "../harness/fakeMongo.js";

await createHarness({});
const { default: handler } = await import("../../api/monitor.js");
function init(id: number) {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
async function call(id: number, body: any) {
  let status = 200, payload: any; const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; } };
  await handler({ method: "POST", body: { initData: init(id), ...body } } as any, res);
  return { status, payload };
}
beforeEach(() => {
  resetState();
  seedUser({ id: OWNER_ID, anonId: "user_NAVA", nickname: "Nava", onboardingStep: "COMPLETED", profilePhotoFileId: "F0" } as any);
  seedUser({ id: 4_000_000_000_000_001, anonId: "seed_a", nickname: "مریم", isSeed: true, onboardingStep: "COMPLETED", profilePhotoFileId: "F1" } as any);
  seedUser({ id: 4_000_000_000_000_002, anonId: "seed_b", nickname: "سارا", isSeed: true, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: 5, anonId: "user_X", nickname: "عادی", onboardingStep: "COMPLETED" } as any);
});

test("MS1. staff gets Nava first, then every default member, with signed avatar urls; ordinary users are refused", async () => {
  const r = await call(OWNER_ID, { action: "accounts" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.payload.items.map((x: any) => x.id), ["user_NAVA", "seed_a", "seed_b"]);
  assert.equal(r.payload.items[0].main, true);
  assert.ok(r.payload.items[0].av.startsWith("/api/miniapp?u="));
  assert.equal(r.payload.items[2].av, null);
  assert.equal((await call(5, { action: "accounts" })).status, 403);
});
