import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time string comparison (hashes both sides first so length differences do not leak either). */
export function safeEqual(a: string | string[] | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const key = "nava-secure-compare";
  const ha = createHmac("sha256", key).update(a).digest();
  const hb = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(ha, hb);
}
