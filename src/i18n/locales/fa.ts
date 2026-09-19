import type { Dictionary } from "../types.js";
import { textEmoji } from "../../config/emojis.js";

// NOTE: The strings below marked LOCKED in types.ts are reproduced EXACTLY
// as provided by the project owner: same wording, punctuation, spacing,
// emojis and line breaks. Do not "clean up" or rewrite them.

export const fa: Dictionary = {
  onboarding: {
    welcome: (firstName: string) =>
      `${textEmoji("WORLD", "🌍")}\n\n` +
      `سلام - ${firstName}- عزیز ✋️\n\n` +
      `به نوا  خوش اومدی ، توی این ربات می تونی افراد #نزدیک ات رو پیدا کنی و باهاشون آشنا شی و یا به یه نفر بصورت #ناشناس وصل شی و باهاش #چت کنی ❗️\n\n` +
      `استفاده از این ربات رایگانه و اطلاعات تلگرام شما مثل اسم، عکس پروفایل یا موقعیت GPS کاملا محرمانه هست😎\n\n` +
      `${textEmoji("WORLD", "🌍")} خب حالا زبان مورد نظرت رو انتخاب کن`,

    genderPrompt: "خب حالا جنسیت خودتو انتخاب کن",
    genderButtonMale: "من پسرم",
    genderButtonFemale: "من دخترم",

    guide1:
      `${textEmoji("P1", "1️⃣")} نوا چیه؟\n` +
      `یه ربات چت #ناشناس که میتونی باهاش با افراد مختلف حرف بزنی و وقت بگذرونی.\n\n` +
      `${textEmoji("P2", "2️⃣")} چجوری #رایگان از ربات استفاده کنم؟\n` +
      `با 《🎲جستجوی شانسی》 بصورت نامحدود و  بدون نیاز به رلیک چت کن !\n\n` +
      `${textEmoji("P3", "3️⃣")} چجوری دوستامو دعوت کنم و #رلیک بدست بیارم؟\n` +
      `کافیه /link رو بزنی و لینک مخصوص خودتو دریافت کنی ، با معرفی هرکدوم از دوستات 30 تا رلیک کوین بگیری 😍\n\n` +
      `${textEmoji("P4", "4️⃣")} اطلاعاتمو چجوری ویرایش کنم؟\n` +
      `همونطور که میدونی تو این ربات یه #پروفایل داری ! برای ویرایش کردن اطلاعاتت گزینه 《👤 پروفایل》  رو از منو انتخاب کن بعد《 📝 ویرایش پروفایل》 رو بزن.\n\n` +
      `${textEmoji("P5", "5️⃣")} سوالامو از کجا بپرسم؟\n` +
      `آیدی تیم پشتیبانی ربات بصورت دکمه شیشه ای زیر پیام پیام هست که هروقت به مشکلی برخوردی یا انتقاد و پیشنهادی داشتی میتونی با ما درمیون بزاری`,

    agePrompt:
      `${textEmoji("AGE", "🎂")} خب حالا سنت رو بهم بگو ؟\n\n` + `• سنت رو از لیست پایین 👇انتخاب کن یا خودت تایپ کن`,

    provincePrompt:
      `${textEmoji("HOME", "🏠")} خب حالا استانت رو انتخاب کن\n\n` + `• استانت رو از لیست پایین 👇انتخاب کن`,

    cityPrompt:
      `${textEmoji("HOME", "🏠")} 🏠 خب حالا شهرتو انتخاب کن\n\n` + `• شهرتو از لیست پایین 👇انتخاب کن`,

    nicknamePrompt:
      `${textEmoji("PERSON", "👤")} خب حالا فقط کافیه یه اسم مستعار برای نمایش در ربات انتخاب کنی تا وارد ربات شیم!\n\n` +
      `• اسمتو بفرست👇`,

    nicknameInvalid: "⚠️ خطا: لطفا برای ثبت اسم در ربات فقط از حروف فارسی استفاده کنید!",

    completionMessage:
      `${textEmoji("GREEN_CHECK", "✅")} اطلاعات شما ثبت شد.\n\n` +
      `به خانواده بزرگ هایپر گپ خوش اومدی بهت توصیه میکنم اول از همه با لمس کردن دکمه راهنما  با ربات آشنا شی`,

    chooseFromMenu: "از منوی پایین انتخاب کن👇",

    guideButton: "راهنما",
  },

  forceJoin: {
    messageIntro: (nickname: string) =>
      `${nickname} عزیز\n` + `برای استفاده از ربات  ابتدا باید در کانال های زیر عضو بشی 👇`,
    messageOutro:
      `⚠️ توجه: درصورتی که در عضویت کانال با خطا مواجه میشوید و یا نمیخواید در کانال های اسپانسری ما عضو شوید دستور ( /Exempt ) را لمس کنید.\n\n` +
      `بعد از عضـــویت « بررسی عضویت و فعال سازی » را لمس کنید تا ربات برای شما فعال شود. 👇`,
    verifyButton: "بررسی عضویت و فعال سازی",
    verifiedMessage:
      `${textEmoji("GREEN_CHECK", "✅")} عضویت شما تایید شد ! شما هم اکنون می توانید از امکانات ویژه ربات استفاده کنید !\n` +
      `یکی از گزینه های زیر را لمس کنید 👇`,
  },

  matching: {
    partnerPrompt:
      `${textEmoji("COURT", "⚖️")} لطفا قبل از شروع چت قوانین ربات « /ghavanin » را مطالعه کنید.\n\n` +
      `به کی وصلت کنم؟   انتخاب کن👇`,
    luckySearch: "جستجوی شانسی",
    maleSearch: "جستجوی پسر",
    femaleSearch: "جستجوی دختر",
    nearbySearch: "جستجوی اطراف",
    sameAgeSearch: "جستجوی هم سنی",
    sameProvinceSearch: "جستجوی هم استانی",

    searchingStatus: (searchTypeLabel: string) =>
      `🔎 درحال جستجوی مخاطب ناشناس شما\n\n` +
      `- ${searchTypeLabel}\n\n` +
      `⏳ حداکثر تا ۴۰ ثانیه صبر کنید.\n\n` +
      `⚙️ جستجوی همسن : 📴 غیر فعال\n` +
      `-فعال سازی : /hamseni_on\n\n` +
      `⚙️ جستجوی هم استانی ها : 📴 غیر فعال\n\n` +
      `- فعال سازی : /hamostani_on`,

    cancelSearchButton: "❌ لغو جستجو",
    searchCancelled: "🚫 جستجو لغو شد.",

    foundPartner: "👀 پیدا کردم وصلتون کردم، به مخاطبت سلام کن",

    trustWarning:
      "🚫 اخطار: به هیچ کاربری در ربات اعتماد نکنید و اطلاعات شخصیتان را در اختیارشان قرار ندهید\n\n" +
      "⚠️ درصورتی که کاربر در اول چت از شما خواست به پی وی شخصی او بروید چت را قطع کرده و او را گزارش کنید!",

    partnerProfileButton: "پروفایل مخاطب",
    safeChatButton: "چت ایمن",
    endChatButton: "پایان چت",

    endChatConfirm: `${textEmoji("BOT", "🤖")} پیام ربات 👇\n\nمطمئنی میخوای چت رو قطع کنی؟`,
    continueChatButton: "ادامه دادن چت",

    chatEndedByPartner: (anonId: string) =>
      `{{NAVA_EMOJI}} چت شما با /${anonId} توسط مخاطب شما قطع شد.\n\n` +
      `برای گزارش عدم رعایت قوانین (/ghavanin) می توانید با لمس 《 🚫 گزارش کاربر 》 در پروفایل، کاربر را گزارش کنید.`,

    chatCashback: "{{RELIC_EMOJI}} تعداد 1 رلیک به دلیل ناموفق بودن چت به حساب شما برگشت!",

    profileViewNotification:
      "پیام ربات 👇\n\n" +
      "مخاطب شما  پروفایلِ {{NAVA_EMOJI}}نوا{{NAVA_EMOJI}}  شما را مشاهده کرد.\n\n" +
      "<blockquote>⚠️ توجه: پروفایل نوا اطلاعاتی است که در بخش پروفایل ربات ثبت کرده اید!</blockquote>",
  },

  mainMenu: {
    connectAnonymous: "به یه ناشناس وصلم کن",
    nearbyPeople: "افراد نزدیک",
    searchUsers: "جستجوی کاربران",
    guide: "راهنما",
    profile: "پروفایل",
    relicCoin: "رلیک کوین",
    feedback: "پیشنهادات و انتقادات",
    myAnonymousLink: "لینک ناشناس من",
    inviteFriends: "دعوت دوستان (رلیک کوین رایگان)",
    contacts: "مخاطبین من",
  },

  languageButtons: {
    fa: "فارسی",
    en: "English",
    ar: "العربية",
  },

  errors: {
    invalidAge: "سن واردشده معتبر نیست. لطفاً عددی بین 9 تا 99 وارد کن.",
    genderAlreadySet: "جنسیت شما قبلاً ثبت شده و قابل تغییر نیست.",
    unknownInput: "متوجه نشدم 🤔\n\nچه کاری برات انجام بدم؟ از منوی پایین انتخاب کن👇",
    generic: "مشکلی پیش اومد، لطفاً دوباره تلاش کن.",
    exemptConfirmation: "باشه، دیگه لازم نیست توی کانال‌های اسپانسری عضو بشی ✅",
    nearbyUnavailable: "موقعیت مکانی شما هنوز ثبت نشده، فعلاً این نوع جستجو در دسترس نیست.",
    alreadyInChat: "شما همین الان توی یه چت فعال هستید.",
    insufficientBalance: "😔 موجودی رلیک شما کافی نیست. برای اتصال به چت ناشناس به ۱ رلیک نیاز داری.",
    searchTimedOut: "⏳ زمان جستجو تموم شد و کسی پیدا نشد. می‌تونی دوباره تلاش کنی.",
    rateLimited: "⚠️ یکم آروم‌تر! لطفاً چند ثانیه صبر کن و دوباره امتحان کن.",
  },

  relic: {
    transferButton: "ارسال رلیک",
    amountPrompt: "چند رلیک می‌خوای بفرستی؟ فقط عدد بفرست.",
    invalidAmount: "عدد واردشده معتبر نیست. یه عدد صحیح و مثبت بفرست.",
    cannotTransferToSelf: "نمی‌تونی به خودت رلیک بفرستی!",
    insufficientForTransfer: "😔 موجودی رلیک شما برای این انتقال کافی نیست.",
    transferConfirmMessage: (amount: number, anonId: string) => `آیا از ارسال ${amount} رلیک به ${anonId} مطمئن هستید؟`,
    confirmButton: "✅ تأیید",
    cancelTransferButton: "❌ لغو",
    transferSuccess: "✅ رلیک با موفقیت ارسال شد.",
    transferCancelled: "انتقال لغو شد.",
    transferReceived: (amount: number, anonId: string) => `🎉 ${amount} رلیک از طرف ${anonId} برات ارسال شد!`,
  },

  photo: {
    rejected:
      "عکس شما به دلیل محتوای جنسی و فلان چیز توسط هوش مصنوعی کنترل و حذف شد\n" +
      "اگر فکر میکنید اشتباهی رخ داده به پشتیبانی پیام دهید",
    submittedForReview: "📸 عکست برای بررسی ارسال شد. بعد از تایید، به‌عنوان عکس پروفایلت فعال می‌شه.",
    approved: "✅ عکس پروفایلت تایید و فعال شد.",
    supportButton: "آیدی پشتیبانی",
  },

  profile: {
    labels: "نام :\nسن :\nجنسیت :\nاستان :\nشهر :",
    bioLabel: `${textEmoji("BIOGRAPHY", "📝")} بیوگرافی :`,
    onlineNowStatus: `هم اکنون آنلاین در حال چت ${textEmoji("CHAT_STATUS", "💬")}`,
    idLabel: `${textEmoji("AT_SIGN", "🆔")} آیدی :`,
    distanceLabel: `${textEmoji("LOCATION", "📍")} فاصله از شهر شما :`,
    partnerLocationMissing: "موقعیت طرف مقابل ثبت نشده",
    viewerLocationMissing: "موقعیت شما ثبت نشده",
    likeButton: (count: number) => `لایک ${count}`,
    chatRequestButton: "درخواست چت",
    directMessageButton: "پیام دایرکت",
    addContactButton: "افزودن به مخاطبین",
    blockButton: "بلاک کردن کاربر",
    reportButton: "گزارش کاربر",
    notifyOnEndButton: "به محض اتمام چت اطلاع بده",
  },
};
