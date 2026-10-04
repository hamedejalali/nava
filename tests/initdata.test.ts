import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyTelegramWebAppInitData } from "../src/utils/telegramWebApp.js";

const TOKEN = "123456:TEST-TOKEN";

function sign(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const now = () => String(Math.floor(Date.now() / 1000));
const user = JSON.stringify({ id: 42, first_name: "A" });

test("valid initData is accepted and yields the signed user id", () => {
  const u = verifyTelegramWebAppInitData(sign({ auth_date: now(), user }), TOKEN, 3600);
  assert.equal(u?.id, 42);
});
test("tampered user id is rejected", () => {
  const good = new URLSearchParams(sign({ auth_date: now(), user }));
  good.set("user", JSON.stringify({ id: 1, first_name: "Evil" }));
  assert.equal(verifyTelegramWebAppInitData(good.toString(), TOKEN, 3600), null);
});
test("signature from another bot token is rejected", () => {
  assert.equal(verifyTelegramWebAppInitData(sign({ auth_date: now(), user }, "999:OTHER"), TOKEN, 3600), null);
});
test("expired initData is rejected", () => {
  const old = String(Math.floor(Date.now() / 1000) - 10_000);
  assert.equal(verifyTelegramWebAppInitData(sign({ auth_date: old, user }), TOKEN, 3600), null);
});
test("missing hash / garbage is rejected", () => {
  assert.equal(verifyTelegramWebAppInitData("user=1", TOKEN), null);
  assert.equal(verifyTelegramWebAppInitData("", TOKEN), null);
});
