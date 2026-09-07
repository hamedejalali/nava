import type { Dictionary } from "../types.js";

// LOCKED strings are intentionally left `undefined`: the project owner has
// not supplied the English wording yet. The i18n layer (src/i18n/index.ts)
// will NEVER substitute the Persian text here -- it treats this as a
// detectable missing-translation condition instead.
export const en: Dictionary = {
  onboarding: {
    welcome: undefined,
    genderPrompt: undefined,
    genderButtonMale: undefined,
    genderButtonFemale: undefined,
    guide1: undefined,
    agePrompt: undefined,
    provincePrompt: undefined,
    cityPrompt: undefined,
    nicknamePrompt: undefined,
    nicknameInvalid: undefined,
    completionMessage: undefined,
    chooseFromMenu: undefined,
    guideButton: undefined,
  },

  forceJoin: {
    messageIntro: undefined,
    messageOutro: undefined,
    verifyButton: undefined,
    verifiedMessage: undefined,
  },

  matching: {
    partnerPrompt: undefined,
    luckySearch: undefined,
    maleSearch: undefined,
    femaleSearch: undefined,
    nearbySearch: undefined,
    sameAgeSearch: undefined,
    sameProvinceSearch: undefined,
    searchingStatus: undefined,
    foundPartner: undefined,
    trustWarning: undefined,
    partnerProfileButton: undefined,
    safeChatButton: undefined,
    endChatButton: undefined,
    endChatConfirm: undefined,
    continueChatButton: undefined,
    chatEndedByPartner: undefined,
    chatCashback: undefined,
    profileViewNotification: undefined,
  },

  mainMenu: {
    connectAnonymous: undefined,
    nearbyPeople: undefined,
    searchUsers: undefined,
    guide: undefined,
    profile: undefined,
    relicCoin: undefined,
    feedback: undefined,
    myAnonymousLink: undefined,
    inviteFriends: undefined,
  },

  languageButtons: {
    fa: "فارسی",
    en: "English",
    ar: "العربية",
  },

  errors: {
    invalidAge: "That age is not valid. Please enter a number between 9 and 99.",
    genderAlreadySet: "Your gender has already been set and cannot be changed.",
    unknownInput: undefined,
    generic: "Something went wrong. Please try again.",
    exemptConfirmation: "OK, you no longer need to join the sponsor channels ✅",
    nearbyUnavailable: "Your location isn't saved yet, so this search type isn't available.",
    alreadyInChat: "You're already in an active chat.",
    insufficientBalance: "😔 You don't have enough Relic. Connecting to an anonymous chat costs 1 Relic.",
    searchTimedOut: "⏳ Search timed out with no match. You can try again.",
    rateLimited: "⚠️ Slow down a bit! Please wait a few seconds and try again.",
  },

  relic: {
    transferButton: undefined,
    amountPrompt: "How many Relic would you like to send? Reply with a number.",
    invalidAmount: "That's not a valid amount. Send a positive whole number.",
    cannotTransferToSelf: "You can't send Relic to yourself!",
    insufficientForTransfer: "😔 You don't have enough Relic for this transfer.",
    transferConfirmMessage: undefined,
    confirmButton: "✅ Confirm",
    cancelTransferButton: "❌ Cancel",
    transferSuccess: "✅ Relic sent successfully.",
    transferCancelled: "Transfer cancelled.",
    transferReceived: (amount: number, anonId: string) => `🎉 ${amount} Relic was sent to you by ${anonId}!`,
  },

  photo: {
    rejected: undefined,
    submittedForReview: "📸 Your photo was submitted for review. Once approved, it becomes your active profile photo.",
    approved: "✅ Your profile photo has been approved and is now active.",
    supportButton: "Support",
  },

  profile: {
    labels: undefined,
    bioLabel: undefined,
    onlineNowStatus: undefined,
    idLabel: undefined,
    distanceLabel: undefined,
    partnerLocationMissing: undefined,
    viewerLocationMissing: undefined,
    likeButton: undefined,
    chatRequestButton: undefined,
    directMessageButton: undefined,
    addContactButton: undefined,
    blockButton: undefined,
    reportButton: undefined,
    notifyOnEndButton: undefined,
  },
};
