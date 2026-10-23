/** v1.24.0 — gift packs (zip / json / tgs) parsing. */
import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8, gzipSync } from "fflate";
import { parsePack } from "../../src/services/nava/giftPack.js";

const lottie = { v: "5.7.0", fr: 30, ip: 0, op: 30, w: 100, h: 100, layers: [] };

test("P1. zip with pack.json: names, prices, emoji, pattern and colours are read; lottie .json becomes a tgs", () => {
  const zip = Buffer.from(zipSync({ "a.json": strToU8(JSON.stringify(lottie)), "pack.json": strToU8(JSON.stringify({ gifts: [{ file: "a.json", name: "قلب", emoji: "❤️", price: 25, pattern: "💖", c1: "#ff0000", c2: "#00ff00" }] })) }));
  const [g] = parsePack(zip, "x.zip");
  assert.equal(g!.name, "قلب"); assert.equal(g!.price, 25); assert.equal(g!.pattern, "💖"); assert.equal(g!.c1, "#ff0000"); assert.equal(g!.format, "tgs");
  assert.deepEqual(JSON.parse(Buffer.from(gunzip(g!.data)).toString()), lottie);
});
function gunzip(b: Buffer) { return Buffer.from(require_gunzip(b)); }
import { gunzipSync as require_gunzip } from "fflate";

test("P2. zip without pack.json: every file is one gift with a default price; bad inputs give readable errors", () => {
  const zip = Buffer.from(zipSync({ "one.json": strToU8(JSON.stringify(lottie)), "two.png": new Uint8Array(50) }));
  assert.equal(parsePack(zip, "p.zip").length, 2);
  assert.throws(() => parsePack(Buffer.from("nope"), "x.txt"), /zip/);
  assert.throws(() => parsePack(Buffer.from("{}"), "x.json"), /Lottie|gifts/);
  assert.throws(() => parsePack(Buffer.from("garbage"), "x.tgs"), /tgs/);
  assert.equal(parsePack(Buffer.from(gzipSync(strToU8("{}"))), "ok.tgs")[0]!.name, "ok");
});

test("P3. json pack with inline lottie", () => {
  const items = parsePack(Buffer.from(JSON.stringify({ gifts: [{ name: "a", lottie }, { name: "b", price: 7, lottie }] })), "p.json");
  assert.equal(items.length, 2); assert.equal(items[1]!.price, 7); assert.equal(items[0]!.price, 10);
});
