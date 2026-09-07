import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PROVINCES } from "./provinces.js";

/**
 * Source of truth for cities: src/data/cities.generated.json, produced by
 * `npx tsx tools/build-cities.ts <cities.json>` from the official
 * https://github.com/sajaddp/list-of-cities-in-Iran dataset (31 provinces,
 * 1657 unique cities after de-duplication). See that script for the
 * conversion/validation logic.
 *
 * Loaded with plain fs.readFileSync + JSON.parse (rather than an ESM JSON
 * import attribute) so this works identically across Node 18/20/22 —
 * import-attribute syntax for JSON only stabilized in newer Node releases
 * and this project's deployment target should not depend on that.
 */
export interface City {
  id: string;
  nameFa: string;
  provinceId: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const generatedCities: City[] = JSON.parse(readFileSync(join(__dirname, "cities.generated.json"), "utf-8"));

export const CITIES: City[] =
  generatedCities.length > 0
    ? generatedCities
    : PROVINCES.map((p) => ({ id: p.centerCityId, nameFa: p.centerCityId, provinceId: p.id }));

export const usingCompleteCityDataset = generatedCities.length > 0;

export function citiesForProvince(provinceId: string): City[] {
  return CITIES.filter((c) => c.provinceId === provinceId);
}

export function isValidCityForProvince(cityId: string, provinceId: string): boolean {
  return CITIES.some((c) => c.id === cityId && c.provinceId === provinceId);
}
