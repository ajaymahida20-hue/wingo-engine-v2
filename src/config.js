// Every tuneable constant and the shape of the saved config live here.

export const HISTORY_MAX = 10;        // rolling rounds kept (trimmed to match feed)
export const COLOR_STAGE_AFTER = 4;   // losses in a row before the call switches to colour
export const MSG_TRACK_MAX = 1000;    // newest DM message ids remembered per subscriber
export const CAPTION_LIMIT = 1024;    // Telegram's photo-caption ceiling
export const PAST_RESULT_LINES = 5;   // how many past results a post carries at most

export const ROUND_SECONDS_BY_GAME = {
  WinGo_30S: 30, WinGo_1M: 60, WinGo_3M: 180, WinGo_5M: 300
};
export const GAME = (process.env.WINGO_GAME || "WinGo_30S").trim();
export const ROUND_SECONDS = ROUND_SECONDS_BY_GAME[GAME] || 30;
export const POLL_MS = Number(process.env.POLL_MS || 2000);

// The feed is served from several mirror hosts. The first one is behind Cloudflare
// Bot Management and answers 403 to many data-centre IPs — Render's among them —
// while the others hand back the same rounds and allow them. The engine walks this
// list until one answers, so a blocked host never stops the bot.
export const MIRROR_HOSTS = process.env.WINGO_HOST
  ? [process.env.WINGO_HOST.trim()]
  : ["ar-lottery02", "ar-lottery03", "ar-lottery04", "ar-lottery05", "ar-lottery01"];

export const feedUrlFor = host => `https://draw.${host}.com/WinGo/${GAME}/GetHistoryIssuePage.json`;

// Optional escape hatches: FEED_URL points at a whole different source, FEED_PROXY at
// a relay (ending in "?url=") so the request leaves from the relay's IP instead.
export const FEED_URL = () => (process.env.FEED_URL || "").trim();
export const FEED_PROXY = () => (process.env.FEED_PROXY || "").trim();

// Target balls come from the predicted side PLUS the colour of the newest round.
// WinGo colours: 1,3,5,7,9 are green and 0,2,4,6,8 are red.
export const NUMBER_TABLE = {
  SMALL: { green: [1, 3], red: [2, 4] },
  BIG:   { green: [7, 9], red: [6, 8] }
};

export const DEFAULT_HEADER =
  "𓆩❣️S❣️𓆪   🅥༄ᏉᏉ Ꭵ Ꭾ ☠︎☬༒\n\n" +
  "vᵎp °᭄ ➳❦Ꭿl๏ήє ہ٨ـہہ٨ـ♡ ⲦRȺᎠER࿐\n" +
  "                  ✵∘∘cOmєвcคк∘∘✵";

// Fallback welcome banner file_id. The bundled public/welcome.jpg is sent first, so
// this only matters if that file is missing.
export const WELCOME_PHOTO = "AgACAgUAAxkBAAKewGrjIoFBm2kgboImZdiPbbRz3EeLAAK6GWsbG5EZV4gS6Q9RJmYmAQADAgADeQADPQQ";

export const DEFAULT_VIDEO_MSG =
  "📹 <b>Watch this video carefully!</b>\n\n" +
  "After watching, please send your <b>Deposit / Account UID</b> (10-12 digits) here to verify and unlock predictions.";

export const DEFAULT_UID_MSG =
  "📹 <b>पहले वीडियो चेक करो, उसके बाद अपना Account UID भेजो।</b>\n\n" +
  "Apna 10-12 digit ka Account UID yahan message me send karein:";

export const DEFAULT_CONFIG = {
  botToken: (process.env.BOT_TOKEN || "").trim(),
  header: DEFAULT_HEADER,
  footer: "@NXTKernelPredictor_Bot",
  welcomePhoto: "",     // set by sending an image to the bot with caption /setwelcome
  welcomeVideo: (process.env.WELCOME_VIDEO || "").trim(),     // Telegram file_id, URL, or local path
  welcomeAudio: (process.env.WELCOME_AUDIO || "").trim(),     // Telegram file_id, URL, or local path
  videoMessage: DEFAULT_VIDEO_MSG,
  uidMessage: DEFAULT_UID_MSG,
  customLink: (process.env.CUSTOM_LINK || "").trim(),         // URL attached to the second message
  customLinkText: "🔗 OPEN LINK",
  autoVerifyUid: false  // Manual admin verification (user submits, admin verifies)
};

// Fallback panel password. Override it any time by setting PANEL_PASSWORD in the
// environment — worth doing, because this short one lives in the repository and the
// panel can read your bot token.
export const DEFAULT_PANEL_PASSWORD = "012m24";

export const PANEL_PASSWORD = () =>
  (process.env.PANEL_PASSWORD || DEFAULT_PANEL_PASSWORD).trim();
export const PORT = () => Number(process.env.PORT || 3001);

// Remote cloud persistence via GitHub (branch: data-v2).
// Keeps channels, subscribers, and bot configs safe across Render redeploys.
export const GITHUB_TOKEN = () =>
  (process.env.GITHUB_TOKEN || "").trim();
export const GITHUB_REPO = () =>
  (process.env.GITHUB_REPO || "ajaymahida20-hue/wingo-engine-v2").trim();
export const GITHUB_BRANCH = () =>
  (process.env.GITHUB_BRANCH || "data-v2").trim();
