import test from "node:test";
import assert from "node:assert/strict";
process.env.BOT_TOKEN ||= "1:x";
const { eligibleCandidateFilter, sanitizeExclude, MAX_EXCLUDE } = await import("../src/services/miniapp.js");

test("candidate filter only allows registered, unbanned, free users with a photo, never the viewer or blocked", () => {
  const f: any = eligibleCandidateFilter(7, [8, 9], ["user_x"]);
  assert.deepEqual(f._id, { $nin: [7, 8, 9] });
  assert.equal(f.onboardingStep, "COMPLETED");
  assert.deepEqual(f.banned, { $ne: true });
  assert.equal(f.activeChatSessionId, null);
  assert.deepEqual(f.profilePhotoFileId, { $type: "string", $ne: "" });
  assert.deepEqual(f.anonId, { $nin: ["user_x"] });
});
test("exclude list is sanitized and capped", () => {
  assert.deepEqual(sanitizeExclude("nope"), []);
  assert.deepEqual(sanitizeExclude(["a", 5, {}, "b"]), ["a", "b"]);
  assert.equal(sanitizeExclude(Array.from({ length: 1000 }, (_, i) => "u" + i)).length, MAX_EXCLUDE);
  assert.deepEqual(sanitizeExclude(["x".repeat(99)]), []);
});
