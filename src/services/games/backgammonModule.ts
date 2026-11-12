import * as bg from "./backgammonGames.js";
import { prepareGameShare } from "./gameShare.js";
import { getInvite } from "./invites.js";
import { SocialError } from "../nava/common.js";
import type { GameModule } from "./registry.js";

/** Backgammon as a plug-in (legacy `game_*` action names are kept so old clients keep working). */
const backgammon: GameModule = {
  id: "backgammon",
  title: "تخته‌نرد",
  invite: { description: "یه دست تخته‌نرد دوستانه — بدون ژتون", enter: (me, inv, c) => bg.enterInvite(me, inv, c.guest) },
  errors: { game_limit: 409, same_opponent: 409, not_your_turn: 409, illegal_move: 400, stakes_disabled: 400, waiting_host: 409 },
  actions: {
    game_lobby: { guest: true, actingBlocked: false, handle: (me) => bg.lobby(me) },
    // v1.30.0: «@bot» invite — the host opens the table, everybody else sits down at it
    game_invite: { guest: true, handle: async (me, b, c) => {
      const inv = await getInvite(b.token);
      if (!inv || inv.gameKey !== "backgammon") throw new SocialError("not_found");
      return bg.enterInvite(me, inv, c.guest);
    } },
    game_create: { handle: (me, b) => bg.create(me, b.stake) },
    game_join: { guest: true, handle: (me, b, c) => bg.join(me, b.gid, c.guest) },
    game_state: { guest: true, actingBlocked: false, handle: (me, b) => bg.getState(me, b.gid, b.since) },
    game_roll: { guest: true, handle: (me, b) => bg.roll(me, b.gid) },
    game_move: { guest: true, handle: (me, b) => bg.move(me, b.gid, { from: b.from, to: b.to, die: b.die }) },
    game_resign: { guest: true, handle: (me, b) => bg.resign(me, b.gid) },
    game_share: { actingBlocked: false, handle: (me, b) => prepareGameShare(me, b.gid) },
  },
  pulse: (me) => bg.pulse(me),
  sweep: () => bg.sweepStaleGames(),
};
export default backgammon;
