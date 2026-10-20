/** v1.20.0 — force-join: one shared membership rule for bot + mini-app; retries; owner alert. (mocked Telegram) */
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "../harness/fakeTelegram.js";

await createHarness({});
const { isJoinedStatus, checkMembership, alertChannelProblem } = await import("../../src/features/forcejoin/membership.js");

test("J1. statuses: member/admin/creator and a MUTED member (restricted, is_member) are joined; left/kicked/non-member restricted are not", () => {
  for (const s of ["member", "administrator", "creator"]) assert.equal(isJoinedStatus({ status: s }), true);
  assert.equal(isJoinedStatus({ status: "restricted", is_member: true }), true);
  assert.equal(isJoinedStatus({ status: "restricted", is_member: false }), false);
  assert.equal(isJoinedStatus({ status: "restricted" }), false);
  for (const s of ["left", "kicked"]) assert.equal(isJoinedStatus({ status: s }), false);
});

test("J2. a rate-limit (429) is retried and then succeeds; a lasting error is reported as 'error', never as joined", async () => {
  let n = 0;
  const flaky = { getChatMember: async () => { if (++n < 2) throw Object.assign(new Error("Too Many Requests"), { error_code: 429, parameters: { retry_after: 0 } }); return { status: "member" } as any; } };
  assert.equal(await checkMembership(flaky, -100, 1), "joined");
  assert.equal(n, 2);
  const broken = { getChatMember: async () => { throw Object.assign(new Error("Bad Request: chat not found"), { error_code: 400, description: "Bad Request: chat not found" }); } };
  assert.equal(await checkMembership(broken, -100, 1), "error");
  const notFound = { getChatMember: async () => { throw Object.assign(new Error("x"), { error_code: 400, description: "Bad Request: user not found" }); } };
  assert.equal(await checkMembership(notFound, -100, 1), "not_joined");
});

test("J3. the owner is told about an unreachable channel — once per hour, not per user", async () => {
  const sent: any[] = [];
  const api = { sendMessage: async (id: number, t: string) => { sent.push([id, t]); return {} as any; } };
  await alertChannelProblem(api as any, "@chan-x", "کانال");
  await alertChannelProblem(api as any, "@chan-x", "کانال");
  await alertChannelProblem(api as any, "@chan-y", "کانال ۲");
  assert.equal(sent.length, 2);
});
