/* Generates the Mini App badge artwork: public/miniapp/badges/<id>.svg (one file per badge id of src/config/badges.ts "em-*" group).
   Run:  node tools/build-badges.mjs        (re-run after editing any tools/badges-*.mjs) */
import { mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { make } from "./badge-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "miniapp", "badges");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith(".svg")) rmSync(join(out, f));
const parts = ["a", "b", "c"];
const ids = [];
for (const p of parts) {
  let mod;
  try { mod = (await import(`./badges-${p}.mjs`)).default; } catch (e) { if (e.code === "ERR_MODULE_NOT_FOUND") continue; throw e; }
  for (const [id, build] of Object.entries(mod)) {
    writeFileSync(join(out, `${id}.svg`), make(id, build));
    ids.push(id);
  }
}
console.log(`${ids.length} badges →`, ids.join(" "));
