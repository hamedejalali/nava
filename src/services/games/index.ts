/**
 * Games module — the single entry point the Mini App API uses for every game.
 * api/miniapp.ts only asks this file "is this a game action?" and hands it over, so adding a new game
 * (chess, ludo, …) never touches the social API again. Chips are «ژتون» (same ledger as everywhere else).
 */
import * as bg from "./backgammonGames.js";

/** actions that belong to games (whitelisted by api/miniapp.ts) */
export const GAME_ACTIONS: readonly string[] = ["game_lobby", "game_create", "game_join", "game_state", "game_roll", "game_move", "game_resign"];
/** staff "act as" mode must never play for somebody else */
export const GAME_ACTING_NEVER: readonly string[] = ["game_create", "game_join", "game_roll", "game_move", "game_resign"];
/** game error code -> HTTP status */
export const GAME_ERRORS: Record<string, number> = { game_limit: 409, same_opponent: 409, not_your_turn: 409, illegal_move: 400 };

export const isGameAction = (a: string): boolean => GAME_ACTIONS.includes(a);

export function gamePulse(me: any) {
  return bg.pulse(me).catch(() => ({ items: [] }));
}

export async function handleGameAction(action: string, me: any, body: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "game_lobby": return bg.lobby(me);
    case "game_create": return bg.create(me, body.stake);
    case "game_join": return bg.join(me, body.gid);
    case "game_state": return bg.getState(me, body.gid, body.since);
    case "game_roll": return bg.roll(me, body.gid);
    case "game_move": return bg.move(me, body.gid, { from: body.from, to: body.to, die: body.die });
    case "game_resign": return bg.resign(me, body.gid);
    default: throw new Error("not_a_game_action");
  }
}
