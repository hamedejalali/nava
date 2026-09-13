/**
 * Shared shape for every locale dictionary.
 *
 * Two categories of strings exist in this project:
 *
 *  1. OWNER-LOCKED CONTENT: exact user-facing text supplied by the project
 *     owner (marked below with "LOCKED"). These must be reproduced
 *     character-for-character in the language they were given in, and
 *     NEVER auto-translated by the assistant. Until the owner supplies the
 *     EN/AR version of a LOCKED string, its value in those locales is
 *     `undefined` on purpose (see src/i18n/index.ts for how missing values
 *     are handled — they are never silently replaced by another language).
 *
 *  2. FUNCTIONAL TEXT: ordinary system messages (validation errors, etc.)
 *     whose exact wording was not dictated by the owner. These are
 *     provided in all three languages so the bot remains fully usable.
 */
export interface Dictionary {
  onboarding: {
    /** LOCKED (Feature 01). Args: firstName */
    welcome?: (firstName: string) => string;
    /** LOCKED (Feature 02) */
    genderPrompt?: string;
    /** LOCKED (Feature 02) */
    genderButtonMale?: string;
    /** LOCKED (Feature 02) */
    genderButtonFemale?: string;
    /** LOCKED (Feature 03, Guide 1) */
    guide1?: string;
    /** LOCKED (Feature 03) */
    agePrompt?: string;
    /** LOCKED (Feature 04, Step 1) */
    provincePrompt?: string;
    /** LOCKED (Feature 04, Step 2) */
    cityPrompt?: string;
    /** LOCKED (Feature 04, Step 3) */
    nicknamePrompt?: string;
    /** LOCKED (Feature 04, Step 3 validation error) */
    nicknameInvalid?: string;
    /** LOCKED (Feature 04, Step 4) */
    completionMessage?: string;
    /** LOCKED (Feature 04, Step 4) */
    chooseFromMenu?: string;
    /** LOCKED (Feature 04) */
    guideButton?: string;
  };
  forceJoin: {
    /** LOCKED (Feature 05). Args: nickname */
    messageIntro?: (nickname: string) => string;
    /** LOCKED (Feature 05) */
    messageOutro?: string;
    /** LOCKED (Feature 05) */
    verifyButton?: string;
    /** LOCKED (Feature 05) */
    verifiedMessage?: string;
  };
  matching: {
    /** LOCKED (Feature 05) */
    partnerPrompt?: string;
    /** LOCKED (Feature 05) */
    luckySearch?: string;
    /** LOCKED (Feature 05) */
    maleSearch?: string;
    /** LOCKED (Feature 05) */
    femaleSearch?: string;
    /** LOCKED (Feature 05) */
    nearbySearch?: string;
    /** LOCKED (Feature 05) */
    sameAgeSearch?: string;
    /** LOCKED (Feature 05) */
    sameProvinceSearch?: string;
    /** LOCKED (Feature 05). Args: searchTypeLabel (e.g. "🎲جستجوی شانسی") */
    searchingStatus?: (searchTypeLabel: string) => string;
    /** LOCKED — label for the button under the live search countdown. */
    cancelSearchButton?: string;
    /** LOCKED — shown after the user taps "cancel search". */
    searchCancelled?: string;
    /** LOCKED (Feature 05) */
    foundPartner?: string;
    /** LOCKED (Feature 05) */
    trustWarning?: string;
    /** LOCKED (Feature 05) */
    partnerProfileButton?: string;
    /** LOCKED (Feature 05) */
    safeChatButton?: string;
    /** LOCKED (Feature 05) */
    endChatButton?: string;
    /** LOCKED (Feature 05) */
    endChatConfirm?: string;
    /** LOCKED (Feature 05) */
    continueChatButton?: string;
    /** LOCKED (Feature 05). Args: anonId of whoever ended it */
    chatEndedByPartner?: (anonId: string) => string;
    /** LOCKED (Feature 05) */
    chatCashback?: string;
    /** LOCKED (Feature 05) */
    profileViewNotification?: string;
  };
  mainMenu: {
    /** LOCKED */
    connectAnonymous?: string;
    /** LOCKED */
    nearbyPeople?: string;
    /** LOCKED */
    searchUsers?: string;
    /** LOCKED */
    guide?: string;
    /** LOCKED */
    profile?: string;
    /** LOCKED */
    relicCoin?: string;
    /** LOCKED */
    feedback?: string;
    /** LOCKED */
    myAnonymousLink?: string;
    /** LOCKED */
    inviteFriends?: string;
  };
  languageButtons: {
    fa: string;
    en: string;
    ar: string;
  };
  errors: {
    invalidAge: string;
    genderAlreadySet: string;
    /** LOCKED (Feature 04) — replaces the earlier generic placeholder */
    unknownInput?: string;
    generic: string;
    exemptConfirmation: string;
    nearbyUnavailable: string;
    alreadyInChat: string;
    insufficientBalance: string;
    searchTimedOut: string;
    rateLimited: string;
  };
  relic: {
    /** LOCKED (Feature "RELIC TRANSFER"). Button on another user's profile. */
    transferButton?: string;
    amountPrompt: string;
    invalidAmount: string;
    cannotTransferToSelf: string;
    insufficientForTransfer: string;
    /** LOCKED. Args: amount, recipientAnonId */
    transferConfirmMessage?: (amount: number, anonId: string) => string;
    confirmButton: string;
    cancelTransferButton: string;
    transferSuccess: string;
    transferCancelled: string;
    /** Args: amount, senderAnonId */
    transferReceived: (amount: number, anonId: string) => string;
  };
  photo: {
    /** LOCKED (Feature "REJECT PHOTO") */
    rejected?: string;
    submittedForReview: string;
    approved: string;
    supportButton: string;
  };
  profile: {
    /** LOCKED (Feature 05) */
    labels?: string; // "نام :\nسن :\n..." block
    /** LOCKED (Feature 05) */
    bioLabel?: string;
    /** LOCKED (Feature 05) */
    onlineNowStatus?: string;
    /** LOCKED (Feature 05) */
    idLabel?: string;
    /** LOCKED (Feature 05) */
    distanceLabel?: string;
    /** LOCKED (Feature 05) */
    partnerLocationMissing?: string;
    /** LOCKED (Feature 05) */
    viewerLocationMissing?: string;
    /** LOCKED (Feature 05). Args: count */
    likeButton?: (count: number) => string;
    /** LOCKED (Feature 05) */
    chatRequestButton?: string;
    /** LOCKED (Feature 05) */
    directMessageButton?: string;
    /** LOCKED (Feature 05) */
    addContactButton?: string;
    /** LOCKED (Feature 05) */
    blockButton?: string;
    /** LOCKED (Feature 05) */
    reportButton?: string;
    /** LOCKED (Feature 05) */
    notifyOnEndButton?: string;
  };
}
