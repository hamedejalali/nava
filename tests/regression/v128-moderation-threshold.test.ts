/** v1.28.0 — moderation threshold validation fails safe (no network: Sightengine fetch is stubbed) */
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";

await createHarness({});
const { parseModerationThreshold } = await import("../../src/config/env.js");
const { checkImage } = await import("../../src/services/sightengine.js");
const { setAppVar } = await import("../../src/services/appVars.js");

test("T1. only decimals in (0, 1] are accepted", () => {
  for (const ok of ["0.5", "1", ".3", "0.01", " 0.7 "]) assert.ok(parseModerationThreshold(ok) !== undefined, ok);
  for (const bad of ["", "NaN", "Infinity", "-Infinity", "-1", "0", "1.01", "5", "1e9", "0x1", "abc", undefined, null, "0.5.1", "--1"]) assert.equal(parseModerationThreshold(bad as any), undefined, String(bad));
});

const seen: Array<{ url: string; body: any }> = [];
async function runWith(stored: string, score: unknown) {
  process.env.SIGHTENGINE_API_USER = "u"; process.env.SIGHTENGINE_API_SECRET = "s";
  resetState();
  await setAppVar("SIGHTENGINE_THRESHOLD", stored);
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), body: init?.body });
    if (String(url).startsWith("https://api.telegram.org/")) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    return { ok: true, json: async () => ({ status: "success", nudity: { sexual_activity: score } }) };
  }) as any;
  try { return await checkImage("https://api.telegram.org/file/botSECRET-TOKEN-X/photos/a.jpg"); } finally { globalThis.fetch = orig; delete process.env.SIGHTENGINE_API_USER; delete process.env.SIGHTENGINE_API_SECRET; }
}

test("T2. a stored threshold of 5 / Infinity / NaN / -1 falls back to 0.5 — it never lets a 0.9 image through", async () => {
  for (const bad of ["5", "Infinity", "NaN", "-1", "1e9"]) {
    const r = await runWith(bad, 0.9);
    assert.equal(r.flagged, true, bad);
  }
  assert.equal((await runWith("0.5", 0.2)).flagged, false);
});

test("T3. a non-numeric score fails closed (flagged, service error)", async () => {
  const r = await runWith("0.5", "high");
  assert.equal(r.flagged, true);
  assert.equal(r.serviceUnavailable, true);
});

test("T4. the Telegram file URL (it contains the bot token) is NEVER sent to Sightengine; the image goes up as an upload", async () => {
  seen.length = 0;
  await runWith("0.5", 0.1);
  const se = seen.filter((c) => c.url.includes("sightengine"));
  assert.equal(se.length, 1);
  assert.ok(!se[0]!.url.includes("SECRET-TOKEN-X") && !se[0]!.url.includes("api.telegram.org"));
  assert.ok(se[0]!.body instanceof FormData);
  assert.ok(![...(se[0]!.body as FormData).values()].some((v) => typeof v === "string" && v.includes("SECRET-TOKEN-X")));
});
