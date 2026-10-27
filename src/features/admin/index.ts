import { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { registerAdminPanel } from "./panel.js";
import { registerAdminGuides } from "./guides.js";
import { registerAdminChannels } from "./channels.js";
import { registerAdminRelic } from "./relic.js";
import { registerPostReportsAdmin } from "./postReportsAdmin.js";
import { registerGiftsAdmin } from "./giftsAdmin.js";
import { registerSeedsAdmin } from "./seedsAdmin.js";
import { registerSeedsBatch } from "./seedsBatch.js";
import { registerOfficialAdmin } from "./officialAdmin.js";
import { registerOwnerAdmin } from "./ownerAdmin.js";
import { registerRoutingAdmin } from "./routingAdmin.js";
import { registerEmojiAdmin } from "./emojiAdmin.js";
import { registerShopAdmin } from "./shopAdmin.js";
import { registerVarsAdmin } from "./varsAdmin.js";
import { registerPermissionGate } from "./permGate.js";
import { registerAdminCategories, registerAdminVersionButton } from "./menu.js";

export function registerAdmin(composer: Composer<NavaContext>) {
  registerAdminVersionButton(composer);
  registerPermissionGate(composer);
  registerAdminCategories(composer);
  registerSeedsBatch(composer);
  registerOfficialAdmin(composer);
  registerSeedsAdmin(composer);
  registerOwnerAdmin(composer);
  registerAdminPanel(composer);
  registerGiftsAdmin(composer);
  registerPostReportsAdmin(composer);
  registerAdminGuides(composer);
  registerAdminChannels(composer);
  registerAdminRelic(composer);
  registerShopAdmin(composer);
  registerRoutingAdmin(composer);
  registerEmojiAdmin(composer);
  registerVarsAdmin(composer);
}
