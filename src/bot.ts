import { Bot, Composer, GrammyError, HttpError } from "grammy";
import type { NavaContext } from "./bot-context.js";
import { env } from "./config/env.js";
import { healOwnerIdentity } from "./services/nava/common.js";
import { getOrCreateUser, getUser } from "./db/models/user.js";
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
import { inMiniappChat, MINIAPP_CHAT_HINT, registerMiniappChatGuard } from "./features/matching/relayShared.js";
import { hasPendingPhotoFlow } from "./features/common/userFlows.js";
import { registerXpDeposit } from "./features/wallet/xpDeposit.js";
import { registerRelicScreen, registerStarsCheckout } from "./features/payments/index.js";
import { ensureUserIndexes } from "./db/models/user.js";
import { ensureMatchQueueIndexes } from "./db/models/matchQueue.js";
import { ensureChatSessionIndexes } from "./db/models/chatSession.js";
import { ensureBlocksIndexes } from "./db/models/blocks.js";
import { registerRulesCommand } from "./features/support/index.js";
import { checkRateLimit, ensureRateLimitIndexes } from "./utils/rateLimit.js";
import { registerPhotoUpload, registerImageModerationDecisions } from "./features/photo/moderation.js";
import { registerFileIdHelper } from "./features/admin/fileIdHelper.js";
import { registerChatPhotoModeration } from "./features/photo/chatPhotoModeration.js";
import { ensureImageModerationIndexes } from "./db/models/imageModeration.js";
import { ensurePhotoModerationLogIndexes } from "./db/models/photoModerationLog.js";
import { registerChatMediaRelay } from "./features/matching/mediaRelay.js";
import { registerChatReactions } from "./features/matching/reactions.js";
import { ensureChatRelayMapIndexes } from "./db/models/chatRelayMap.js";
import { registerUserBackup } from "./features/admin/userBackup.js";
import { registerAdminUsers } from "./features/admin/users.js";
import { registerAdminLevels } from "./features/admin/levels.js";
import { registerAdminModerators } from "./features/admin/moderators.js";
import { registerAdminResetUser } from "./features/admin/resetUser.js";
import { registerAdminWallet } from "./features/admin/walletAdmin.js";
import { registerAdminBadges } from "./features/admin/badgesAdmin.js";
import { registerPricingAdmin } from "./features/admin/pricingAdmin.js";
import { registerAdminStats } from "./features/admin/stats.js";
import { registerAdminActivityLog } from "./features/admin/activityLog.js";
import { registerAdminSettings } from "./features/admin/settingsAdmin.js";
import { registerNavagramAdmin } from "./features/admin/navagramAdmin.js";
import { registerAdminReports } from "./features/admin/reportsAdmin.js";
import { registerAdminBroadcast } from "./features/admin/broadcast.js";
import { registerOwnerAdminPanelClose } from "./features/admin/ownerBypass.js";
import { getAllAdminIds } from "./features/admin/constants.js";
import { registerMainMenuRouter } from "./features/menu/mainMenuRouter.js";
import { escapeHtml } from "./utils/html.js";
import { telegramSafetyTransformer } from "./ui/telegramSafety.js";
import { telegramRetryTransformer } from "./ui/telegramRetry.js";
import { registerAnonMessages } from "./features/anonMessages/index.js";
import { registerAdminReactionGate } from "./features/admin/reactionGateAdmin.js";
import { registerReactionGate } from "./features/reactionGate/gate.js";
import { registerFeedbackFlow } from "./features/menu/feedbackFlow.js";
import { registerFlowInterrupt, registerFlowCancel } from "./features/common/userFlows.js";
import { registerAdminVerifiedUsers } from "./features/admin/verifiedUsers.js";
import { registerChatRequest } from "./features/matching/chatRequest.js";
import { registerGiftReply } from "./features/matching/giftReply.js";
import { getDb } from "./db/connect.js";
import { registerGiftEvents } from "./features/gifts/events.js";
import { ensureGiftEventIndexes } from "./services/nava/giftEvents.js";
import { ensureChatRequestIndexes } from "./db/models/chatRequest.js";
import { registerProfileReveal } from "./features/matching/profileReveal.js";
import { ensureProfileRevealIndexes } from "./db/models/profileReveal.js";
import { ensureStarsOrderIndexes } from "./db/models/starsOrder.js";
import { ensureSearchNoticeIndexes } from "./db/models/searchNotice.js";
import { ensureRelicLedgerIndexes } from "./db/models/relic.js";
import { banNoticeMarkup, banNoticeText } from "./features/support/banNotice.js";
import { ensureUpdateInboxIndexes } from "./db/models/updateInbox.js";
import { ensureMatchDeliveryIndexes } from "./db/models/matchDelivery.js";
import { settleDueSeedChat } from "./features/matching/seedMatch.js";
import { ensureSeedIndexes } from "./db/models/seeds.js";
import { seedGuardTransformer } from "./services/seeds/guard.js";
import { getMaintenanceState, maintenanceAllows, maintenanceText } from "./services/maintenance.js";

export function createBot(): Bot<NavaContext> {
  const bot = new Bot<NavaContext>(env.BOT_TOKEN);

  // Every outgoing request passes through the emoji/HTML safety net — see
  // src/ui/telegramSafety.ts for what it guarantees.
  bot.api.config.use(telegramSafetyTransformer);
  // Default (seed) members are not Telegram accounts: nothing addressed to them may ever leave the process
  // (see src/services/seeds/guard.ts).
  bot.api.config.use(seedGuardTransformer);
  bot.api.config.use(telegramRetryTransformer);

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
    ensureProfileRevealIndexes(),
    ensureBlocksIndexes(),
    ensurePhotoModerationLogIndexes(),
    ensureChatRelayMapIndexes(),
    ensureChatRequestIndexes(),
    ensureStarsOrderIndexes(),
    ensureMatchDeliveryIndexes(),
    ensureUpdateInboxIndexes(),
    ensureRelicLedgerIndexes(),
    ensureSearchNoticeIndexes(),
    ensureSeedIndexes(),
    getDb().then((db) => ensureGiftEventIndexes(db)),
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
      // the owner's page is the official «Nava» account: the real registered name is never shown anywhere
      if (env.OWNER_ID !== undefined && ctx.from.id === env.OWNER_ID) await healOwnerIdentity(user, ctx.from.first_name).catch(() => {});
      ctx.dbUser = user;
      ctx.userLang = user.languageCode ?? "fa";

      if (user.__isNew) {
        const from = ctx.from;
        const usernamePart = from.username ? `@${from.username}` : "-";
        const notifyText =
          `👤 کاربر جدید به ربات پیوست\n\n` +
          `نام: ${escapeHtml(from.first_name)}${from.last_name ? " " + escapeHtml(from.last_name) : ""}\n` +
          `یوزرنیم: ${escapeHtml(usernamePart)}\n` +
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
        }).catch(() => {
          // getAllAdminIds() failing (DB hiccup) must never become an unhandled rejection: on Node that can
          // take the whole serverless instance down in the middle of the new user's own request.
        });
      }
    } else {
      ctx.userLang = "fa";
    }
    await next();
  });

  // ---- Bot switched OFF (maintenance) ----
  // While the master switch is off only the owner/admins and the numeric ids on the admin-panel allow-list can
  // use the bot; everybody else gets the text from "ویرایش متن‌ها" and nothing else happens. A payment that has
  // ALREADY gone through (successful_payment) and Telegram's pre-checkout query are never blocked.
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return next();
    if (!ctx.message && !ctx.callbackQuery) return next();
    if (ctx.message?.successful_payment) return next();
    const state = await getMaintenanceState();
    if (!state.on || maintenanceAllows(state, ctx.from.id, ctx.dbUser)) return next();
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    await ctx.api.sendMessage(ctx.from.id, await maintenanceText()).catch(() => {});
  });

  // ---- Default-member chat whose time is up ----
  // The invocation that connected a default member normally ends the chat itself; if it was cut off, the
  // person's very next update finishes it here (and every webhook request sweeps the rest), so nobody can be
  // left in a chat with a silent member. See src/features/matching/seedMatch.ts.
  bot.use(async (ctx, next) => {
    const sid = ctx.dbUser?.activeChatSessionId;
    if (sid && ctx.from) {
      try {
        if (await settleDueSeedChat(ctx.api, sid)) ctx.dbUser = (await getUser(ctx.from.id)) ?? ctx.dbUser;
      } catch {
        /* never block the person's own update */
      }
    }
    await next();
  });

  // ---- Ban enforcement ----
  // A banned user gets only the ban notice — nothing else in the bot
  // (including admin/owner accounts, though banning those isn't a normal
  // scenario, is deliberately not special-cased here for simplicity).
  bot.use(async (ctx, next) => {
    if (ctx.dbUser?.banned) {
      // Shown on the person's first (and every later) tap: notice + a link button that opens a chat with support.
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      // to the person's own chat (a button tapped under a CHANNEL post must not make the bot talk in the channel)
      await ctx.api.sendMessage(ctx.from!.id, banNoticeText(ctx.dbUser.banReason), { parse_mode: "HTML", reply_markup: await banNoticeMarkup() }).catch(() => {});
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
  registerFlowInterrupt(features); // a menu tap / command always ends a pending "waiting for text" step
  registerFlowCancel(features); // the red "❌ لغو" glass button used by every such step
  registerAdmin(features);
  registerAdminReactionGate(features);
  registerReactionGate(features);
  registerOwnerAdminPanelClose(features);
  registerAdminUsers(features);
  registerAdminLevels(features);
  registerAdminModerators(features);
  registerAdminResetUser(features);
  registerAdminWallet(features);
  registerAdminBadges(features);
  registerPricingAdmin(features);
  registerAdminStats(features);
  registerAdminActivityLog(features);
  registerAdminSettings(features);
  registerNavagramAdmin(features);
  registerAdminReports(features);
  registerAdminBroadcast(features);
  registerAdminVerifiedUsers(features);
  registerProfileReveal(features);
  registerGiftEvents(features); // auction / giveaway buttons under the channel posts
  registerGiftReply(features); // "پیام به فرستنده" under gift notifications
  registerChatRequest(features); // accept/decline buttons of chat requests sent from the Nava Mini App
  registerXpDeposit(features); // «واریز XP از ولت»: amount → wallet token → Nava asks the Wallet → credit on COMPLETED
  registerRelicTransfer(features); // before chat relay: an amount reply must never be relayed as a chat message
  registerChatControls(features); // before chat relay: the reply-keyboard control labels must never be relayed as a chat message
  registerMiniappChatGuard(features, hasPendingPhotoFlow); // a photo/sticker sent to the bot during an in-app chat points back to the app
  registerChatPhotoModeration(features); // before profile-photo upload: chat photos must never be mistaken for profile uploads; always delivers instantly + logs to moderation channel
  registerChatMediaRelay(features); // stickers/gifs/voice/video/video-notes/audio inside an active chat
  registerChatReactions(features); // mirrors real message_reaction updates onto the original sender's copy
  registerChatRelay(features); // before onboarding: in-chat messages must never be misread as onboarding input
  registerAnonMessages(features); // before onboarding (its /start payload) and before the photo uploader
  registerFeedbackFlow(features);
  registerOnboarding(features);
  registerForceJoin(features);
  registerRulesCommand(features);
  registerImageModerationDecisions(features);
  registerFileIdHelper(features); // must run before registerPhotoUpload — see its doc comment
  registerPhotoUpload(features);
  registerUserBackup(features);
  registerMatchingEntry(features);
  registerSearch(features);
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
    if (await inMiniappChat(ctx)) return void (await ctx.reply(MINIAPP_CHAT_HINT).catch(() => {}));
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
