import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { isAdmin, isOwner } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { canAdmin, labelPermissions, PERMS, type PermKey } from "./permissions.js";
import { getAdminFlow, setAdminFlow } from "./flowState.js";

const MAP = labelPermissions(ADMIN_MENU_LABELS as unknown as Record<string, string>);

/** "owner" = only the owner; a PermKey = that switch; anything admin-prefixed that is not listed needs at least «is an admin». */
type Need = PermKey | "owner";

/**
 * v1.28 — EVERY sensitive admin operation is authorised on the backend at the moment it is used, not when its button was drawn:
 *  1. keyboard labels   (message:text) — as before;
 *  2. inline callbacks  (callback_query:data) — by prefix, so an OLD button still sitting in a chat is re-checked against the CURRENT rights;
 *  3. multi-step flows  (any message while an admin flow is pending) — revoked right ⇒ the flow is dropped, nothing is executed.
 * The effective permission is computed from the user document loaded for THIS update, so a removed admin / switched-off right is effective at once.
 */
export const CALLBACK_PERMS: Array<[prefix: string, need: Need]> = [
  ["admin:broadcast", "broadcast"],
  ["admin:verified", "verify"], ["admin:verify", "verify"],
  ["admin:bdg", "badges"],
  ["admin:userlist", "users"], ["admin:user:ban", "ban"], ["admin:user:unban", "ban"], ["admin:user:toggleverify", "verify"], ["admin:user", "users"],
  ["admin:report", "reports"], ["pr:", "reports"],
  ["admin:editreq", "users"], ["modimg:", "users"],
  // v1.29.2: chat-photo moderation buttons (they were not listed, so the gate never ran for them)
  ["photomod:delete", "users"], ["photomod:ban", "ban"],
  ["admin:relic:mass", "owner"], ["admin:relic", "jeton"], ["admin:level", "jeton"],
  ["admin:pricing", "pricing"], ["adm:shop", "pricing"],
  ["admin:rg", "reactionGate"],
  ["admin:guides", "guides"], ["admin:support_id", "guides"], ["admin:channels", "guides"], ["adm:route", "guides"], ["adm:emo", "guides"],
  ["admin:settings", "settings"], ["adm:vars", "settings"],
  ["admin:seed", "seeds"],
  ["admin:ng", "nava"], ["admin:gf", "nava"],
  ["admin:resetuser", "resetUser"],
  ["admin:own", "owner"], ["admin:short", "owner"], ["admin:wallet", "owner"], ["adm:perm", "owner"], ["adm:mod", "owner"],
];

export const FLOW_PERMS: Record<string, Need> = {
  ban: "ban", unban: "ban", broadcast: "broadcast", import_users: "data", level: "jeton", jetonmass: "owner", moderators: "owner", pricing: "pricing",
  reset_user: "resetUser", user_lookup: "users", verify: "verify", emoji: "guides", reactiongate: "reactionGate", navagifts: "nava",
  maint_allow: "settings", navagram: "nava", official_add: "owner", shop: "pricing", route: "guides", seed_batch: "seeds",
  seed_add: "seeds", seed_edit: "seeds", badges: "badges", appvar: "settings", owner_profile: "owner", short_names: "owner",
};

export function callbackNeed(data: string): Need | "admin" | null {
  for (const [p, n] of CALLBACK_PERMS) if (data.startsWith(p)) return n;
  if (data.startsWith("admin:") || data.startsWith("adm:")) return "admin";
  return null;
}

export function mayDo(ctx: NavaContext, need: Need | "admin"): boolean {
  if (!isAdmin(ctx)) return false;
  if (need === "admin") return true;
  if (need === "owner") return isOwner(ctx);
  return canAdmin(ctx, need);
}

const deny = (need: Need | "admin") => (need === "owner" ? "⛔ این بخش فقط برای مالکه." : need === "admin" ? "⛔ دسترسی نداری." : `⛔ دسترسی «${PERMS[need]}» برای تو فعال نیست.`);

export function registerPermissionGate(composer: Composer<NavaContext>) {
  // 1) keyboard labels
  composer.on("message:text", async (ctx, next) => {
    const perm = MAP[ctx.message.text.trim()];
    if (!perm || !isAdmin(ctx) || isOwner(ctx)) return next();
    if (canAdmin(ctx, perm)) return next();
    await ctx.reply(`⛔ دسترسی «${PERMS[perm]}» برای تو فعال نیست. از مالک بخواه فعالش کنه.`);
  });

  // 2) inline buttons (also OLD ones; also ones pressed under a post in the management channel)
  composer.on("callback_query:data", async (ctx, next) => {
    const need = callbackNeed(ctx.callbackQuery.data);
    if (!need) return next();
    if (mayDo(ctx, need)) return next();
    await ctx.answerCallbackQuery({ text: deny(need), show_alert: true }).catch(() => {});
  });

  // 3) a multi-step flow that is already running: re-check before the next answer is used
  composer.on("message", async (ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== "private") return next();
    const flow = await getAdminFlow(ctx.from.id);
    if (!flow) return next();
    const need = FLOW_PERMS[flow.flow] ?? "admin";
    if (mayDo(ctx, need)) return next();
    await setAdminFlow(ctx.from.id, null);
    await ctx.reply(`${deny(need)}\nمرحله‌ی در حال انجام لغو شد.`).catch(() => {});
  });
}
