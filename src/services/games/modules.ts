/** THE list of games. Adding a game = import it here and add it to the array (one line). Everything else is derived. */
import type { GameModule } from "./registry.js";
import backgammon from "./backgammonModule.js";

export const GAME_MODULES: readonly GameModule[] = [backgammon];
