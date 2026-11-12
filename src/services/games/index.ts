/**
 * Games module — the single entry point the Mini App API uses for every game. Everything here is DERIVED from the plug-in list in
 * `modules.ts` (see registry.ts / docs/ADD_A_GAME.md): a new game never touches api/miniapp.ts or this file.
 */
import { GAME_MODULES } from "./modules.js";
import { buildRegistry } from "./registry.js";

const REG = buildRegistry(GAME_MODULES);

export const GAME_ACTIONS: readonly string[] = [...REG.actions];
/** staff "act as" mode must never play for somebody else */
export const GAME_ACTING_NEVER: readonly string[] = [...REG.actingNever];
export const GAME_ERRORS: Record<string, number> = REG.errors;
/** what a not-yet-registered person (a "guest") may do */
export const GAME_GUEST_ACTIONS: readonly string[] = [...REG.guestActions];

/** games offered in the inline invite list */
export const INVITE_GAMES = GAME_MODULES.filter((m) => !!m.invite);

export const isGameAction = (a: string): boolean => REG.actions.has(a);

export async function gamePulse(me: any): Promise<unknown> {
  // backgammon keeps the legacy shape `{ items }`; other games add their own keys next to it
  const out: Record<string, unknown> = { items: [] };
  for (const m of GAME_MODULES) {
    if (!m.pulse) continue;
    try { const r: any = await m.pulse(me); if (m.id === "backgammon") Object.assign(out, r); else out[m.id] = r; } catch { /* a broken game never breaks the pulse */ }
  }
  return out;
}

export async function handleGameAction(action: string, me: any, body: Record<string, unknown>, guest = false): Promise<unknown> {
  const def = REG.handlers.get(action);
  if (!def) throw new Error("not_a_game_action");
  return def.handle(me, body, { guest });
}

/** the daily cron: every game's housekeeping (a failing game never stops the others) */
export async function sweepAllGames(): Promise<number> {
  let n = 0;
  for (const m of GAME_MODULES) { try { n += (await m.sweep?.()) ?? 0; } catch (e) { console.error(`[games] sweep failed for ${m.id}:`, e instanceof Error ? e.message : "unknown"); } }
  return n;
}
