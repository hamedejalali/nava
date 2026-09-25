import { getDb } from "../connect.js";
import { env } from "../../config/env.js";

export interface RelicPackage {
  price: number; // Stars amount OR Toman amount, depending on `kind`
  relic: number;
}

export type PricingKind = "stars" | "gateway";

interface PricingDoc {
  _id: PricingKind;
  packages: RelicPackage[];
  updatedAt: Date;
  updatedBy?: number;
}

async function collection() {
  const db = await getDb();
  return db.collection<PricingDoc>("relic_pricing");
}

function defaultStarsPackages(): RelicPackage[] {
  return env.starsPackages.map((p) => ({ price: p.stars, relic: p.relic }));
}

/** Placeholder gateway packages shown until you set real ones from the admin
 *  panel (💳 تنظیم قیمت رلیک ← قیمت‌های درگاه). price = Toman. */
export const DEFAULT_GATEWAY_PACKAGES: RelicPackage[] = [
  { price: 50_000, relic: 10 },
  { price: 100_000, relic: 25 },
  { price: 180_000, relic: 50 },
  { price: 320_000, relic: 100 },
  { price: 700_000, relic: 250 },
];

export async function getPackages(kind: PricingKind): Promise<RelicPackage[]> {
  const col = await collection();
  const doc = await col.findOne({ _id: kind });
  if (doc) return doc.packages;
  return kind === "stars" ? defaultStarsPackages() : DEFAULT_GATEWAY_PACKAGES;
}

export function parsePackagesJson(raw: string): RelicPackage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('فرمت JSON نامعتبره. مثال درست: [{"price":50,"relic":10},{"price":100,"relic":25}]');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("باید یه آرایه‌ی غیرخالی باشه.");
  }
  const packages: RelicPackage[] = [];
  for (const item of parsed) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as any).price !== "number" ||
      typeof (item as any).relic !== "number" ||
      (item as any).price <= 0 ||
      (item as any).relic <= 0
    ) {
      throw new Error('هر آیتم باید {"price": عدد مثبت, "relic": عدد مثبت} باشه.');
    }
    packages.push({ price: (item as any).price, relic: (item as any).relic });
  }
  return packages;
}

export async function setPackages(kind: PricingKind, packages: RelicPackage[], adminId: number): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { _id: kind },
    { $set: { packages, updatedAt: new Date(), updatedBy: adminId } },
    { upsert: true }
  );
}
