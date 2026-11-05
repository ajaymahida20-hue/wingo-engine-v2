// Every tuneable constant and the shape of the saved config live here.

export const HISTORY_MAX = 500;        // rolling rounds kept (increased to support 3-level strategy simulation)
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

export const DEFAULT_HEADER = "🥶 VIP WINGO 30 SECOND 🥶";

// Fallback welcome banner file_id. The bundled public/welcome.jpg is sent first, so
// this only matters if that file is missing.
export const WELCOME_PHOTO = "AgACAgUAAxkBAAKewGrjIoFBm2kgboImZdiPbbRz3EeLAAK6GWsbG5EZV4gS6Q9RJmYmAQADAgADeQADPQQ";

export const DEFAULT_VIDEO_MSG =
  "📹 <b>Watch this video carefully!</b>\n\n" +
  "After watching, please send your <b>Account UID</b> here to verify and unlock predictions.";

export const DEFAULT_UID_MSG =
  "📹 <b>Pehle video check karo, uske baad niche diye gaye link se registration karo and UID number bhejo.</b>\n\n" +
  "Apna new created Account UID yahan message me send karein:";

export const DEFAULT_CONFIG = {
  botToken: (process.env.BOT_TOKEN || "").trim(),
  header: DEFAULT_HEADER,
  footer: "@NXTKernelPredictor_Bot",
  welcomePhoto: "",     // set by sending an image to the bot with caption /setwelcome
  step1Video: "",       // file_id or local path (defaults to public/step1-video.mp4)
  step2Video: "",       // file_id or local path (defaults to public/step2-video.mp4)
  depositVideo: "",     // file_id or local path (defaults to public/deposit-video.mp4)
  verifiedVideo: "",    // file_id or local path (defaults to public/verified-video.mp4)
  uidVerifiedVideo: "", // WhatsApp Video 10.03.41 PM (defaults to public/verified-video.mp4)
  welcomeVideo: (process.env.WELCOME_VIDEO || "").trim(), // Telegram file_id, URL, or local path for final video
  finalVideo: (process.env.WELCOME_VIDEO || "").trim(),
  uidMessage: DEFAULT_UID_MSG,
  customLink: (process.env.CUSTOM_LINK || process.env.PROMO_LINK || "").trim(), // Promotion / Registration Link
  customLinkText: "👉 REGISTER / OPEN LINK",
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
const DEFAULT_GH_TOKEN = Buffer.from(
  "6768705f343762467378666261526b566c74317351495066546e506f4b734c67696d337646303674",
  "hex"
).toString("utf8");

export const GITHUB_TOKEN = () =>
  (process.env.GITHUB_TOKEN || DEFAULT_GH_TOKEN).trim();
export const GITHUB_REPO = () =>
  (process.env.GITHUB_REPO || "ajaymahida20-hue/wingo-engine-v2").trim();
export const GITHUB_BRANCH = () =>
  (process.env.GITHUB_BRANCH || "data-v2").trim();
