/**
 * Game plug-in contract (v1.28.1). A new game is ONE folder `src/services/games/<id>/` that default-exports a `GameModule`,
 * plus ONE line in `modules.ts`. The social API, the guest rules, the cron sweep and the Jeton flow are all derived from this list —
 * nothing else in the project changes. See docs/ADD_A_GAME.md.
 */
export interface GameActionDef {
  /** runs one action; throw `SocialError(code)` for expected errors (code → HTTP status via `errors`) */
  handle(me: any, body: Record<string, unknown>, ctx: { guest: boolean }): Promise<unknown>;
  /** a not-yet-registered person ("guest") may call it (default false) */
  guest?: boolean;
  /** staff "act as another account" mode may NOT call it (default true = blocked: nobody plays for somebody else) */
  actingBlocked?: boolean;
}

/** A game that can be offered through the inline «@bot» list (v1.30.0). `enter` seats the person at that invite's table. */
export interface GameInvite {
  /** one line under the title in the inline list */
  description: string;
  /** host: creates / re-opens the table; any other player: sits down. Throw SocialError("waiting_host") when the host has not entered yet. */
  enter(me: any, invite: { _id: string; hostId: number; gameKey: string; gid?: string | null }, ctx: { guest: boolean }): Promise<unknown>;
}

export interface GameModule {
  /** short lowercase id, e.g. "chess". Every action name MUST start with `${id}_` (backgammon keeps its legacy `game_` names) */
  id: string;
  title: string;
  /** present = this game appears in the inline invite list */
  invite?: GameInvite;
  /** whitelisted API actions of this game */
  actions: Record<string, GameActionDef>;
  /** error code → HTTP status for the codes this game throws */
  errors?: Record<string, number>;
  /** the live-games list for the pulse (red dot when it is my turn) */
  pulse?(me: any): Promise<unknown>;
  /** the daily cron: finish stale games, refund held Jeton, purge old finished games. Returns how many were touched */
  sweep?(): Promise<number>;
}

export interface RegistryView {
  actions: ReadonlySet<string>;
  guestActions: ReadonlySet<string>;
  actingNever: ReadonlySet<string>;
  errors: Record<string, number>;
  handlers: Map<string, GameActionDef>;
}

/** Validates the modules (unique ids / action names, naming rule) and builds the lookup tables. Throws at start-up, never at play time. */
export function buildRegistry(mods: readonly GameModule[], legacyPrefixes: readonly string[] = ["game_"]): RegistryView {
  const handlers = new Map<string, GameActionDef>();
  const guest = new Set<string>(), acting = new Set<string>();
  const errors: Record<string, number> = {};
  const ids = new Set<string>();
  for (const m of mods) {
    if (!/^[a-z][a-z0-9]{1,15}$/.test(m.id)) throw new Error(`game id "${m.id}" is invalid`);
    if (ids.has(m.id)) throw new Error(`duplicate game id "${m.id}"`);
    ids.add(m.id);
    for (const [name, def] of Object.entries(m.actions)) {
      const okName = name.startsWith(`${m.id}_`) || legacyPrefixes.some((p) => name.startsWith(p));
      if (!okName) throw new Error(`action "${name}" of game "${m.id}" must start with "${m.id}_"`);
      if (handlers.has(name)) throw new Error(`duplicate action "${name}"`);
      handlers.set(name, def);
      if (def.guest) guest.add(name);
      if (def.actingBlocked !== false) acting.add(name);
    }
    // v1.29.8 (audit F-19): two modules may not silently overwrite each other's error codes (the later one used to win)
    for (const [k, v] of Object.entries(m.errors ?? {})) {
      if (Object.prototype.hasOwnProperty.call(errors, k)) throw new Error(`duplicate error code "${k}" (game "${m.id}")`);
      errors[k] = v;
    }
  }
  return { actions: new Set(handlers.keys()), guestActions: guest, actingNever: acting, errors, handlers };
}
