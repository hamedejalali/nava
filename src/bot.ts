import { Bot, Composer, GrammyError, HttpError } from "grammy";
import type { NavaContext } from "./bot-context.js";
import { env } from "./config/env.js";
import { getOrCreateUser } from "./db/models/user.js";
import { dictionary, requireLocked } from "./i18n/index.js";
import { registerOnboarding } from "./features/onboarding/index.js";
import { registerAdmin } from "./features/admin/index.js";
import { registerForceJoin } from "./features/forcejoin/handlers.js";
import { registerMatchingEntry } from "./features/matching/entry.js";
import { registerSearch } from "./features/matching/search.js";
import { registerChatRelay, registerChatControls } from "./features/matching/chat.js";
import { registerProfile, ensureProfileViewIndexes } from "./features/matching/profile.js";
import { registerProfileEdit } from "./features/matching/profileEdit.js";
import { registerReportFlow } from "./features/matching/reportFlow.js";
import { registerContacts } from "./features/matching/contacts.js";
import { registerProfileLookup } from "./features/matching/profileLookup.js";
import { registerVerifyFlow } from "./features/matching/verifyFlow.js";
import { registerRelicTransfer } from "./features/matching/transfer.js";
import { registerRelicScreen, registerStarsCheckout } from "./features/payments/index.js";
import { ensureUserIndexes } from "./db/models/user.js";
import { ensureMatchQueueIndexes } from "./db/models/matchQueue.js";
import { ensureChatSessionIndexes } from "./db/models/chatSession.js";
import { registerRulesCommand } from "./features/support/index.js";
import { checkRateLimit, ensureRateLimitIndexes } from "./utils/rateLimit.js";
import { registerPhotoUpload, registerImageModerationDecisions } from "./features/photo/moderation.js";
import { registerFileIdHelper } from "./features/admin/fileIdHelper.js";
import { registerChatImageModeration } from "./features/matching/chatImage.js";
import { ensureImageModerationIndexes } from "./db/models/imageModeration.js";
import { registerAdminUsers } from "./features/admin/users.js";
import { registerAdminLevels } from "./features/admin/levels.js";
import { registerAdminModerators } from "./features/admin/moderators.js";
import { registerAdminResetUser } from "./features/admin/resetUser.js";
import { registerPricingAdmin } from "./features/admin/pricingAdmin.js";
import { registerAdminStats } from "./features/admin/stats.js";
import { registerAdminActivityLog } from "./features/admin/activityLog.js";
import { registerAdminSettings } from "./features/admin/settingsAdmin.js";
import { registerAdminReports } from "./features/admin/reportsAdmin.js";
import { registerAdminBroadcast } from "./features/admin/broadcast.js";
import { registerOwnerAdminPanelClose } from "./features/admin/ownerBypass.js";
import { getAllAdminIds } from "./features/admin/constants.js";
import { registerMainMenuRouter } from "./features/menu/mainMenuRouter.js";

export function createBot(): Bot<NavaContext> {
  const bot = new Bot<NavaContext>(env.BOT_TOKEN);

  // Fire-and-forget index setup — runs once per cold start (createBot is
  // only called once per warm container). createIndexes is idempotent, so
  // this is always safe even across many concurrent cold starts.
  void Promise.all([
    ensureUserIndexes(),
    ensureMatchQueueIndexes(),
    ensureChatSessionIndexes(),
    ensureProfileViewIndexes(),
    ensureRateLimitIndexes(),
    ensureImageModerationIndexes(),
  ]).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[bot] Index setup failed (will retry on next cold start):", err);
  });

  // ---- Context enrichment ----
  // Loads/creates the user's DB record before any feature handler runs, and
  // exposes it (plus the resolved language) on ctx. Idempotent upsert, safe
  // under concurrent/duplicate webhook deliveries (see db/models/user.ts).
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      const user = await getOrCreateUser({
        telegramId: ctx.from.id,
        firstName: ctx.from.first_name,
        username: ctx.from.username,
      });
      ctx.dbUser = user;
      ctx.userLang = user.languageCode ?? "fa";

      if (user.__isNew) {
        const from = ctx.from;
        const usernamePart = from.username ? `@${from.username}` : "-";
        const notifyText =
          `👤 کاربر جدید به ربات پیوست\n\n` +
          `نام: ${from.first_name}${from.last_name ? " " + from.last_name : ""}\n` +
          `یوزرنیم: ${usernamePart}\n` +
          `آیدی عددی: ${from.id}\n` +
          `آیدی ناشناس: <code>${user.anonId}</code>`;

        void getAllAdminIds().then((adminIds) => {
          for (const adminId of adminIds) {
            void ctx.api.sendMessage(adminId, notifyText, { parse_mode: "HTML" }).catch(() => {
              // Admin may have blocked the bot or never started a DM with
              // it — never let a notification failure affect the actual
              // user's request.
            });
          }
        });
      }
    } else {
      ctx.userLang = "fa";
    }
    await next();
  });

  // ---- Ban enforcement ----
  // A banned user gets only the ban notice — nothing else in the bot
  // (including admin/owner accounts, though banning those isn't a normal
  // scenario, is deliberately not special-cased here for simplicity).
  bot.use(async (ctx, next) => {
    if (ctx.dbUser?.banned) {
      await ctx.reply(`🚫 دسترسی شما به ربات مسدود شده است.${ctx.dbUser.banReason ? `\n\nدلیل: ${ctx.dbUser.banReason}` : ""}`).catch(() => {});
      return;
    }
    await next();
  });

  // ---- Rate limiting / anti-spam ----
  // Persistent (MongoDB), not process-memory — required for correctness
  // across concurrent serverless instances. Separate buckets for text
  // messages vs callback queries since they have very different normal
  // usage rates (rapid button taps are normal; rapid full messages less so).
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();

    const bucket = ctx.callbackQuery ? "callback" : ctx.message ? "text" : null;
    if (!bucket) return next();

    const limit = bucket === "callback" ? 25 : 15;
    const { allowed, justExceeded } = await checkRateLimit(ctx.from.id, bucket, limit, 10_000);

    if (allowed) return next();

    if (justExceeded) {
      const t = dictionary(ctx.userLang);
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: t.errors.rateLimited, show_alert: true }).catch(() => {});
      } else {
        await ctx.reply(t.errors.rateLimited).catch(() => {});
      }
    } else if (ctx.callbackQuery) {
      // Still acknowledge every callback so Telegram's loading spinner
      // never gets stuck, even when we're silently dropping it.
      await ctx.answerCallbackQuery().catch(() => {});
    }
    // Drop the update — do not call next().
  });

  const features = new Composer<NavaContext>();
  registerAdmin(features);
  registerOwnerAdminPanelClose(features);
  registerAdminUsers(features);
  registerAdminLevels(features);
  registerAdminModerators(features);
  registerAdminResetUser(features);
  registerPricingAdmin(features);
  registerAdminStats(features);
  registerAdminActivityLog(features);
  registerAdminSettings(features);
  registerAdminReports(features);
  registerAdminBroadcast(features);
  registerRelicTransfer(features); // before chat relay: an amount reply must never be relayed as a chat message
  registerChatRelay(features); // before onboarding: in-chat messages must never be misread as onboarding input
  registerOnboarding(features);
  registerForceJoin(features);
  registerRulesCommand(features);
  registerImageModerationDecisions(features);
  registerChatImageModeration(features); // before profile-photo upload: chat images must never be mistaken for profile uploads
  registerFileIdHelper(features); // must run before registerPhotoUpload — see its doc comment
  registerPhotoUpload(features);
  registerMatchingEntry(features);
  registerSearch(features);
  registerChatControls(features);
  registerProfile(features);
  registerProfileEdit(features);
  registerReportFlow(features);
  registerContacts(features);
  registerProfileLookup(features);
  registerVerifyFlow(features);
  registerRelicScreen(features);
  registerStarsCheckout(features);
  registerMainMenuRouter(features); // last: only acts on exact main-menu label text, next()s everything else
  bot.use(features);

  // ---- Fallback handlers (Feature: UNKNOWN INPUT) ----
  // Must be registered last so every recognized command/callback above
  // takes priority. Never lets an update pass through silently unhandled.
  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.on("message:text", async (ctx) => {
    const t = dictionary(ctx.userLang);
    const text = requireLocked(ctx.userLang, "errors.unknownInput", t.errors.unknownInput);
    await ctx.reply(text);
  });

  // ---- Global error handling ----
  bot.catch((err) => {
    const ctx = err.ctx;
    const ex = err.error;
    // eslint-disable-next-line no-console
    console.error(`[bot] Unhandled error while processing update ${ctx.update.update_id}:`, ex);

    if (ex instanceof GrammyError) {
      console.error("[bot] Telegram API error:", ex.description);
    } else if (ex instanceof HttpError) {
      console.error("[bot] Network/HTTP error contacting Telegram:", ex);
    }

    // Best-effort user-facing notice; never throw from inside the error
    // handler itself (would crash the serverless invocation).
    void ctx.reply(dictionary(ctx.userLang ?? "fa").errors.generic).catch(() => {});
  });

  return bot;
}
