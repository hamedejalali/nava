import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function run(envVars: Record<string, string>, code: string): string {
  const r = spawnSync("npx", ["tsx", "-e", code], {
    env: { ...process.env, BOT_TOKEN: "1:x", WEBHOOK_SECRET: "s", MONGODB_URI: "mongodb://x", ...envVars },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const snippet = `import { textEmoji, buttonIcon } from "./src/config/emojis.ts"; console.log(JSON.stringify([textEmoji("HOME"), buttonIcon("HOME")]));`;

test("premium OFF: plain emoji from .env is used (not the code default)", () => {
  const [text, icon] = JSON.parse(run({ PREMIUM_EMOJI_ENABLED: "false", EMOJI_PREMIUM_HOME: "🏡" }, snippet));
  assert.equal(text, "🏡");
  assert.deepEqual(icon, { fallback: "🏡" });
});
test("premium OFF: a numeric ID in .env never leaks, code default is used", () => {
  const [text, icon] = JSON.parse(run({ PREMIUM_EMOJI_ENABLED: "false", EMOJI_PREMIUM_HOME: "5416041192905265756" }, snippet));
  assert.equal(text, "🏠");
  assert.equal(icon.id, undefined);
});
test("premium OFF: 'ID + emoji' keeps the emoji and ignores the ID", () => {
  const [text] = JSON.parse(run({ PREMIUM_EMOJI_ENABLED: "false", EMOJI_PREMIUM_HOME: "5416041192905265756 🏡" }, snippet));
  assert.equal(text, "🏡");
});
test("premium ON: numeric ID becomes a tg-emoji tag / button icon id", () => {
  const [text, icon] = JSON.parse(run({ PREMIUM_EMOJI_ENABLED: "true", EMOJI_PREMIUM_HOME: "5416041192905265756" }, snippet));
  assert.equal(text, '<tg-emoji emoji-id="5416041192905265756">🏠</tg-emoji>');
  assert.equal(icon.id, "5416041192905265756");
});
test("premium ON: 'ID + emoji' uses that emoji inside the tag", () => {
  const [text] = JSON.parse(run({ PREMIUM_EMOJI_ENABLED: "true", EMOJI_PREMIUM_HOME: "5416041192905265756 🏡" }, snippet));
  assert.equal(text, '<tg-emoji emoji-id="5416041192905265756">🏡</tg-emoji>');
});
test("premium OFF: empty value falls back to code default", () => {
  const [text] = JSON.parse(run({ PREMIUM_EMOJI_ENABLED: "false", EMOJI_PREMIUM_HOME: "" }, snippet));
  assert.equal(text, "🏠");
});
