export const PARTNER_TYPE_CALLBACKS = {
  lucky: "match:lucky",
  male: "match:male",
  female: "match:female",
  nearby: "match:nearby",
  sameAge: "match:same_age",
  sameProvince: "match:same_province",
} as const;

/** The live countdown status message shown while a search is queued. The
 *  "seconds elapsed" button itself carries `noop` as callback_data — it is
 *  purely a display, not a real action — which the bot's generic callback
 *  fallback (src/bot.ts) already safely acknowledges with no side effect. */
export const SEARCH_CALLBACKS = {
  cancel: "search:cancel",
  noop: "search:noop",
} as const;

export const CHAT_CALLBACKS = {
  partnerProfile: "chat:profile",
  safeChat: "chat:safe", // UI stub only — behavior specified in a future prompt
  endChat: "chat:end",
  endChatConfirm: "chat:end:confirm",
  endChatCancel: "chat:end:cancel",
  like: "chat:like",
  transfer: "profile:transfer", // + `:${targetId}`
  transferConfirm: "relic:transfer:confirm",
  transferCancel: "relic:transfer:cancel",
  // The following are UI stubs per spec ("future prompt") — rendered but
  // safely acknowledged with no behavior by the generic callback fallback:
  chatRequest: "profile:chat_request",
  directMessage: "profile:direct_message",
  addContact: "profile:add_contact",
  block: "profile:block",
  report: "profile:report",
  notifyOnEnd: "profile:notify_on_end",
} as const;

/** "درخواست وریفای" — shown under "ویرایش پروفایل" on the user's own profile
 *  and inside the edit menu; both open the same verify flow. */
export const VERIFY_REQUEST_CALLBACK = "profile:edit:req_verify";
