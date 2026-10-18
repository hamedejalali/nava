/**
 * Default ("seed") members — see src/db/models/seeds.ts.
 *
 * A seed member is a normal-looking user document whose `_id` lives in a RESERVED numeric range that no real
 * Telegram account can ever have (real ids are < 2^40 today; the seed range starts at 4e15 and stays below
 * Number.MAX_SAFE_INTEGER). Because of that:
 *  - a seed can never collide with a real person;
 *  - any code path that would try to talk to "user 4000000000000001" on Telegram can be recognised and
 *    swallowed in ONE place (src/services/seeds/guard.ts) instead of failing with "chat not found".
 */
export const SEED_ID_BASE = 4_000_000_000_000_000;
export const SEED_ID_MAX = 4_000_000_000_999_999;

export function isSeedId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id >= SEED_ID_BASE && id <= SEED_ID_MAX;
}
