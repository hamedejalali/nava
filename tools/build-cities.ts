/**
 * Converts the official dataset from
 * https://github.com/sajaddp/list-of-cities-in-Iran (dist/json/cities.json)
 * into this project's internal City[] shape (src/data/cities.generated.json).
 *
 * Usage:
 *   npx tsx tools/build-cities.ts /path/to/cities.json
 *
 * The script is defensive about the exact field names (different dataset
 * versions/exports have used slightly different keys), validates every
 * province reference against src/data/provinces.ts (PROVINCES[].sourceId),
 * removes exact duplicate (name + province) entries, and refuses to write
 * output if anything doesn't check out — printing a clear report instead so
 * a human can decide, rather than silently shipping bad data.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PROVINCES } from "../src/data/provinces.js";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npx tsx tools/build-cities.ts <path-to-cities.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(inputPath, "utf-8"));
const rows: unknown[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.data) ? (raw as any).data : [];

if (rows.length === 0) {
  console.error("Input file did not parse to a non-empty array of city records.");
  process.exit(1);
}

const sourceIdToProvince = new Map(PROVINCES.map((p) => [p.sourceId, p]));

type RawRow = Record<string, unknown>;

function pick(row: RawRow, keys: string[]): unknown {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  return undefined;
}

const NAME_KEYS = ["name", "name_fa", "title", "city", "city_fa", "fa_name"];
const PROVINCE_ID_KEYS = ["province_id", "provinceId", "ostan_id", "state_id"];

const seen = new Set<string>();
const output: { id: string; nameFa: string; provinceId: string }[] = [];
const errors: string[] = [];

rows.forEach((r, i) => {
  const row = r as RawRow;
  const name = pick(row, NAME_KEYS);
  const provinceSourceId = pick(row, PROVINCE_ID_KEYS);

  if (typeof name !== "string" || !name.trim()) {
    errors.push(`Row ${i}: missing/invalid city name (raw: ${JSON.stringify(row)})`);
    return;
  }
  if (typeof provinceSourceId !== "number" && typeof provinceSourceId !== "string") {
    errors.push(`Row ${i} (${name}): missing province id`);
    return;
  }

  const province = sourceIdToProvince.get(Number(provinceSourceId));
  if (!province) {
    errors.push(`Row ${i} (${name}): unrecognized province_id "${provinceSourceId}"`);
    return;
  }

  const cleanName = name.trim();
  const dedupeKey = `${province.id}::${cleanName}`;
  if (seen.has(dedupeKey)) return; // silent de-dupe of exact duplicates, per spec
  seen.add(dedupeKey);

  output.push({ id: cleanName, nameFa: cleanName, provinceId: province.id });
});

console.log(`Parsed ${rows.length} input rows -> ${output.length} unique cities.`);
if (errors.length > 0) {
  console.error(`\n${errors.length} row(s) could not be converted:`);
  errors.slice(0, 30).forEach((e) => console.error(" - " + e));
  if (errors.length > 30) console.error(`   ...and ${errors.length - 30} more.`);
  console.error("\nRefusing to write output until these are resolved (or the field-name lists in this script are adjusted to match your file's actual schema).");
  process.exit(1);
}

// Sanity check: every province should have at least one city.
const provincesWithCities = new Set(output.map((c) => c.provinceId));
const missingProvinces = PROVINCES.filter((p) => !provincesWithCities.has(p.id));
if (missingProvinces.length > 0) {
  console.error(`\nWARNING: these provinces ended up with 0 cities: ${missingProvinces.map((p) => p.nameFa).join("، ")}`);
  console.error("Refusing to write output — this almost always means a province_id mapping mismatch.");
  process.exit(1);
}

const outPath = new URL("../src/data/cities.generated.json", import.meta.url);
writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
console.log(`\n✅ Wrote ${output.length} cities to src/data/cities.generated.json`);
