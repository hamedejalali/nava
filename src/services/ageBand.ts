/**
 * v1.28 — AGE SEPARATION (safety).
 * Self-reported age is NOT proof of adulthood, so the rule is deliberately simple and enforced on the backend everywhere a stranger can be
 * reached: people under 18 and people 18+ are never matched / requested / messaged / gifted across the line, and a person whose age is
 * missing or invalid cannot be classified, so they cannot start any stranger contact at all.
 * Official (legal) accounts — the support/announcement identity — are the only exemption.
 */
import { env } from "../config/env.js";

export const ADULT_AGE = 18;
export const MIN_VALID_AGE = 9;
export const MAX_VALID_AGE = 99;
export type AgeBand = "minor" | "adult";

export function ageBandOf(age: unknown): AgeBand | null {
  if (typeof age !== "number" || !Number.isInteger(age) || age < MIN_VALID_AGE || age > MAX_VALID_AGE) return null;
  return age < ADULT_AGE ? "minor" : "adult";
}

/** Mongo filter on a numeric field for "the same band as `age`" (null = cannot classify → matches nobody). */
export function ageBandFilter(age: unknown, field = "age"): Record<string, unknown> {
  const b = ageBandOf(age);
  if (!b) return { [field]: { $in: [] } };
  return b === "minor" ? { [field]: { $gte: MIN_VALID_AGE, $lt: ADULT_AGE } } : { [field]: { $gte: ADULT_AGE, $lte: MAX_VALID_AGE } };
}

type Who = { _id?: number; age?: unknown; official?: boolean; isAdmin?: boolean } | null | undefined;

const staff = (u: NonNullable<Who>): boolean => !!u.isAdmin || (u._id !== undefined && (u._id === env.OWNER_ID || env.ADMIN_IDS.includes(u._id)));

/** May these two people be put in touch (match, request, DM, gift)? */
export function canContact(a: Who, b: Who): boolean {
  if (!a || !b) return false;
  if (a.official || b.official) return true;
  if (staff(a) || staff(b)) return true; // owner / admins (moderation, support) are not part of the age pools
  const x = ageBandOf(a.age), y = ageBandOf(b.age);
  return x !== null && x === y;
}

export const AGE_BLOCK_TEXT = "این ارتباط به‌خاطر محدودیت‌های سنی (زیر ۱۸ / بالای ۱۸ سال) ممکن نیست.";
