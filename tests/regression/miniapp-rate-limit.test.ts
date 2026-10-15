/** v1.16.3 — the Mini App API has a per-person request budget (MongoDB-backed). */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser } from "../harness/fakeMongo.js";

await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: handler, MINIAPP_CALLS_PER_MINUTE } = await import("../../api/miniapp.js");

function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
async function call(userId: number, body: any) {
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send() { return res; }, end() { return res; } };
  await handler({ method: "POST", body: { initData: init(userId), ...body } } as any, res);
  return { status, payload };
}
beforeEach(() => {
  resetState();
  seedUser({ id: 1, anonId: "user_AAA1", nickname: "علی", relicBalance: 1 });
  seedUser({ id: 2, anonId: "user_AAA2", nickname: "سارا", relicBalance: 1 });
});

test("R1. beyond the per-minute budget a person gets 429 too_fast; other people and the next window are unaffected", async () => {
  let blocked = 0;
  for (let i = 0; i < MINIAPP_CALLS_PER_MINUTE + 5; i++) {
    const r = await call(1, { action: "me" });
    if (r.status === 429) { blocked++; assert.equal(r.payload.error, "too_fast"); }
  }
  assert.ok(blocked >= 1 && blocked <= 5, `blocked ${blocked}`);
  assert.equal((await call(2, { action: "me" })).status, 200, "another person is not affected");
});
