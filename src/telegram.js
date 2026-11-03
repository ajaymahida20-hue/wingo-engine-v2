// WinGo Telegram client & subscriber management.
// Handles deposit unlock (video + UID verification), "Check My ID",
// Start/Stop predictions with DM cleanup, and broadcasting.

import { MSG_TRACK_MAX, WELCOME_PHOTO, DEFAULT_VIDEO_MSG, DEFAULT_UID_MSG } from "./config.js";
import { state, persist } from "./store.js";
import { buildPost } from "./posts.js";
import { info, warn } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WELCOME_FILE = path.join(here, "..", "public", "welcome.jpg");
const STEP1_VIDEO_FILE = path.join(here, "..", "public", "step1-video.mp4");
const STEP2_VIDEO_FILE = path.join(here, "..", "public", "step2-video.mp4");
const DEPOSIT_VIDEO_FILE = path.join(here, "..", "public", "deposit-video.mp4");
const VERIFIED_VIDEO_FILE = path.join(here, "..", "public", "verified-video.mp4");
const FINAL_VIDEO_FILE = path.join(here, "..", "public", "welcome-video.mp4");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? "").replace(/[&<>"']/g, m =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

// Asynchronous concurrency pool for high-speed broadcast
async function mapConcurrent(items, concurrency, fn) {
  if (!items || !items.length) return [];
  const results = new Array(items.length);
  let index = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { ok: false, error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------- raw telegram client

export async function tg(method, payload, timeoutMs = 8000) {
  const url = `https://api.telegram.org/bot${state.cfg.botToken}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 1);
      await sleep(wait * 1000);
      return tg(method, payload, timeoutMs);
    }
    return await res.json();
  } catch (e) {
    return { ok: false, description: "network error: " + e.message };
  }
}

export async function ensureBotInfo() {
  if (state.bot.id) return state.bot;
  if (!state.cfg.botToken) return state.bot;
  const j = await tg("getMe");
  if (j.ok && j.result) {
    state.bot = { id: j.result.id, username: j.result.username || "" };
    persist();
  }
  return state.bot;
}

// ---------------------------------------------------------------- message tracking & sending

function blockedReason(description) {
  const d = String(description || "").toLowerCase();
  return d.includes("blocked") || d.includes("chat not found") ||
         d.includes("user is deactivated") || d.includes("kicked");
}

function trackSubMessage(chatId, messageId, skipPersist = false) {
  if (!messageId) return;
  const sub = state.subs.find(s => s.id === chatId);
  if (!sub) return;
  if (!Array.isArray(sub.msgs)) sub.msgs = [];
  sub.msgs.push(messageId);
  if (sub.msgs.length > MSG_TRACK_MAX) sub.msgs.splice(0, sub.msgs.length - MSG_TRACK_MAX);
  if (!skipPersist) persist();
}

export async function sendDirect(chatId, text, extra = {}, skipTrackPersist = false) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra };
  const j = await tg("sendMessage", payload);
  if (j.ok) { trackSubMessage(chatId, j.result?.message_id, skipTrackPersist); return { ok: true, result: j.result }; }
  return { ok: false, blocked: blockedReason(j.description), description: j.description };
}

export async function sendPhotoDirect(chatId, photo, caption, extra = {}, skipTrackPersist = false) {
  const payload = { chat_id: chatId, photo, caption, parse_mode: "HTML", ...extra };
  const j = await tg("sendPhoto", payload);
  if (j.ok) {
    trackSubMessage(chatId, j.result?.message_id, skipTrackPersist);
    return { ok: true, result: j.result };
  }
  return { ok: false, blocked: blockedReason(j.description), description: j.description };
}

async function tgUpload(method, fields, fileField, filePath) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  form.append(fileField, new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  try {
    const res = await fetch(`https://api.telegram.org/bot${state.cfg.botToken}/${method}`, {
      method: "POST", body: form, signal: AbortSignal.timeout(30000)
    });
    return await res.json();
  } catch (e) {
    return { ok: false, description: "network error: " + e.message };
  }
}

export async function sendWelcomePhoto(chatId, caption, extra = {}) {
  if (fs.existsSync(WELCOME_FILE)) {
    const j = await tgUpload("sendPhoto", { chat_id: chatId, caption, parse_mode: "HTML", ...extra }, "photo", WELCOME_FILE);
    if (j.ok) { trackSubMessage(chatId, j.result?.message_id); return { ok: true }; }
  }
  const banner = (state.cfg.welcomePhoto || WELCOME_PHOTO || "").trim();
  if (banner) return sendPhotoDirect(chatId, banner, caption, extra);
  return sendDirect(chatId, caption, extra);
}

export async function sendStepVideo(chatId, type, caption = "", extra = {}) {
  let configKey = "step1Video";
  let defaultFile = STEP1_VIDEO_FILE;

  if (type === "step1" || type === 1) {
    configKey = "step1Video";
    defaultFile = STEP1_VIDEO_FILE;
  } else if (type === "step2" || type === 2) {
    configKey = "step2Video";
    defaultFile = STEP2_VIDEO_FILE;
  } else if (type === "deposit") {
    configKey = "depositVideo";
    defaultFile = DEPOSIT_VIDEO_FILE;
  } else if (type === "deposit_instructions" || type === "uid_submitted") {
    configKey = "uidVerifiedVideo";
    defaultFile = VERIFIED_VIDEO_FILE;
  } else if (type === "verified" || type === "final" || type === 3) {
    configKey = "finalVideo";
    defaultFile = FINAL_VIDEO_FILE;
  }

  const videoVal = (state.cfg[configKey] || (type === "final" || type === 3 ? (state.cfg.finalVideo || state.cfg.welcomeVideo) : "") || "").trim();

  // 1. If we already have a cached Telegram file_id or external URL, send it directly
  if (videoVal && !fs.existsSync(videoVal)) {
    const j = await tg("sendVideo", { chat_id: chatId, video: videoVal, caption, parse_mode: "HTML", ...extra });
    if (j.ok) { trackSubMessage(chatId, j.result?.message_id); return { ok: true, result: j.result }; }
  }

  // 2. Check if local file exists
  const targetFile = (videoVal && fs.existsSync(videoVal))
    ? videoVal
    : (fs.existsSync(defaultFile) ? defaultFile : null);

  if (targetFile) {
    const j = await tgUpload("sendVideo", { chat_id: chatId, caption, parse_mode: "HTML", ...extra }, "video", targetFile);
    if (j.ok) {
      trackSubMessage(chatId, j.result?.message_id);
      const fileId = j.result?.video?.file_id;
      if (fileId && !state.cfg[configKey]) {
        state.cfg[configKey] = fileId;
        persist();
      }
      return { ok: true, result: j.result };
    }
  }

  // 3. Fallback to text message if video sending fails
  return sendDirect(chatId, caption, extra);
}

export async function sendWelcomeVideo(chatId, caption = "") {
  return sendStepVideo(chatId, 3, caption);
}

// ---------------------------------------------------------------- chat cleanup

export async function clearSubscriberChat(sub) {
  const ids = Array.isArray(sub?.msgs) ? sub.msgs.slice() : [];
  if (sub) sub.msgs = [];
  if (!ids.length) return 0;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const j = await tg("deleteMessages", { chat_id: sub.id, message_ids: chunk });
    if (j.ok) deleted += chunk.length;
    await sleep(250);
  }
  return deleted;
}

// ---------------------------------------------------------------- keyboards & ui

export const BTN_ON = "🚀 START PREDICTION";
export const BTN_OFF = "🛑 STOP PREDICTION";

export const MAIN_KEYBOARD = {
  keyboard: [
    [BTN_ON, BTN_OFF]
  ],
  resize_keyboard: true,
  is_persistent: true
};

function displayName(from) {
  return [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "User";
}

function welcomeCaption(from) {
  const who = from?.username ? `${displayName(from)} (@${from.username})` : displayName(from);
  return (
    `HELLO USER 👋\n\n` +
    `<b>WELCOME TO 3 LEVEL NXT WORLD</b>\n\n` +
    `Hello <b>${esc(who)}</b>!`
  );
}

function buildUidRequestMessage(cfg) {
  const link = (cfg.customLink || "").trim();
  const custom = (cfg.uidMessage || "").trim();

  if (link) {
    if (custom && custom !== DEFAULT_UID_MSG) {
      if (custom.includes("{link}") || custom.includes("{LINK}")) {
        return custom.replace(/\{link\}/gi, `<a href="${esc(link)}"><b>${esc(link)}</b></a>`);
      }
      return (
        `${custom}\n\n` +
        `🔗 <b>Registration Link:</b>\n` +
        `👉 <a href="${esc(link)}"><b>${esc(link)}</b></a>`
      );
    }
    return (
      `📹 <b>पहले वीडियो चेक करो, उसके बाद Niche diye gaye link se registration karo and uid number भेजो।</b>\n\n` +
      `🔗 <b>Registration Link:</b>\n` +
      `👉 <a href="${esc(link)}"><b>${esc(link)}</b></a>\n\n` +
      `Apna new created Account UID yahan message me send karein:`
    );
  }

  return custom || DEFAULT_UID_MSG;
}

// ---------------------------------------------------------------- subscriber state management

function getOrAddUser(from) {
  if (!from || !Number.isFinite(from.id)) return null;
  let sub = state.subs.find(s => s.id === from.id);
  if (!sub) {
    sub = {
      id: from.id,
      name: displayName(from),
      username: from.username || "",
      since: Date.now(),
      uid: null,
      uidStatus: "NONE", // NONE | PENDING | VERIFIED | REJECTED
      uidSubmittedAt: null,
      active: false,
      msgs: []
    };
    state.subs.unshift(sub);
  } else {
    sub.name = displayName(from);
    sub.username = from.username || "";
  }
  return sub;
}

export async function syncBotProfile() {
  if (!state.cfg.botToken) return { ok: false };
  const total = state.subs.length;
  const verified = state.subs.filter(s => s.uidStatus === "VERIFIED").length;
  const live = state.subs.filter(s => s.active && s.uidStatus === "VERIFIED").length;
  const short = `📊 ${live} active · ${verified} verified · ${total} users`;
  const a = await tg("setMyShortDescription", { short_description: short.slice(0, 120) });
  await tg("setMyDescription", { description: `WinGo Prediction Engine.\n${live} active · ${verified} verified members.` });
  return { ok: !!a.ok };
}

// ---------------------------------------------------------------- server verification structure
// This structure handles the server-side UID check. In the next step, this function can
// call your actual verification API or database.

export async function processServerVerification(userId, uid) {
  const sub = state.subs.find(s => s.id === userId);
  if (!sub) return;

  info(`server verification check for user ${userId}, UID: ${uid}`);

  // Auto-verify only if explicitly enabled in panel (by default it's false for manual admin review)
  if (state.cfg.autoVerifyUid === true) {
    await sleep(1500); // 1.5s server processing simulation
    await setSubscriberUidStatus(userId, "VERIFIED");
    info(`user ${userId} UID ${uid} auto-verified successfully`);
  }
}

// Manual verify/reject/deposit-pending function for Web Control Panel
export async function setSubscriberUidStatus(userId, status) {
  const sub = state.subs.find(s => String(s.id) === String(userId));
  if (!sub) return { ok: false, error: "user not found" };

  sub.uidStatus = status;
  if (status !== "VERIFIED") sub.active = false;
  persist();

  if (status === "VERIFIED") {
    // Send congratulations video (WhatsApp Video 10.03.41 PM / verified-video.mp4)
    const finalCaption =
      `🎉 <b>CONGRATULATIONS! YOUR ACCOUNT IS FULLY VERIFIED</b>\n\n` +
      `Aapka Account UID <code>${esc(sub.uid || "")}</code> aur Deposit successfully verify ho chuka hai!\n\n` +
      `Tap <b>${BTN_ON}</b> below to start receiving live predictions.`;

    await sendStepVideo(sub.id, "verified", finalCaption);
    await sleep(400);

    await sendDirect(sub.id,
      `⚡ <b>Predictions Access Unlocked!</b>\n\n` +
      `Live round signals receive karne ke liye neeche <b>${BTN_ON}</b> dabayein:`,
      { reply_markup: MAIN_KEYBOARD }
    );
  } else if (status === "DEPOSIT_PENDING") {
    // Send deposit video (WhatsApp Video 10.26.35 PM / deposit-video.mp4) along with deposit message & button
    const depositCaption =
      `⚠️ <b>Account ID Verified, Deposit Pending!</b>\n\n` +
      `Aapka Account UID (<code>${esc(sub.uid || "")}</code>) verify ho gaya hai, lekin aapne abhi tak <b>Deposit</b> complete nahi kiya hai.\n\n` +
      `Kripya registration link se apna deposit complete karein.\n` +
      `Deposit complete karne ke baad neeche diye gaye <b>💳 I Have Deposited</b> button par click karein:`;

    await sendStepVideo(sub.id, "deposit", depositCaption, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 Maine Deposit Kar Liya", callback_data: `deposited|${sub.id}` }]
        ]
      }
    });
  } else if (status === "REJECTED") {
    await sendDirect(sub.id,
      `❌ <b>UID Verification Failed</b>\n\n` +
      `Your Account UID could not be verified. Please review the video instructions and submit a valid UID again.`
    );
  }

  await syncBotProfile();
  return { ok: true, status: sub.uidStatus };
}

// ---------------------------------------------------------------- message handler

async function handleMessage(msg) {
  const from = msg.from;
  const chatId = msg.chat?.id;
  const text = (msg.text || "").trim();
  if (!chatId || !from) return;

  const sub = getOrAddUser(from);

  // Command: /start
  if (text.startsWith("/start")) {
    if (sub.uidStatus === "VERIFIED") {
      await sendDirect(chatId,
        `👋 <b>Welcome back ${esc(sub.name)}!</b>\n\n` +
        `Your Account UID (<code>${esc(sub.uid || "")}</code>) is <b>VERIFIED</b>.\n\n` +
        `Tap <b>${BTN_ON}</b> below to start receiving live predictions.`,
        { reply_markup: MAIN_KEYBOARD }
      );
      return;
    }

    // Step 0: Send Welcome banner (photo + greeting only)
    await sendWelcomePhoto(chatId, welcomeCaption(from));
    await sleep(600);

    // Step 1: Send Video 1 with "I Have Watched The Video" button
    await sendStepVideo(
      chatId,
      1,
      `👇 <b>WATCH THIS VIDEO CAREFULLY</b> 👇\n\n` +
      `Is video ko pura dhyan se dekhein aur samajhein. Uske baad neeche diye gaye button par click karein:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ I Have Watched The Video", callback_data: `watched_v1|${chatId}` }]
          ]
        }
      }
    );
    persist();
    return;
  }

  // Operator setting commands for Video & Photo uploads (kept in code for future video enable)
  if (msg.video) {
    const fileId = msg.video.file_id;
    const caption = (msg.caption || "").trim().toLowerCase();
    if (caption === "/setvideo1" || text === "/setvideo1") {
      state.cfg.step1Video = fileId;
      persist();
      await sendDirect(chatId, `✅ <b>Step 1 Video Saved!</b>\n\nFile ID:\n<code>${fileId}</code>`);
      return;
    } else if (caption === "/setvideo2" || text === "/setvideo2") {
      state.cfg.step2Video = fileId;
      persist();
      await sendDirect(chatId, `✅ <b>Step 2 Video Saved!</b>\n\nFile ID:\n<code>${fileId}</code>`);
      return;
    } else if (caption === "/setdepositvideo" || caption === "/setvideodeposit") {
      state.cfg.depositVideo = fileId;
      persist();
      await sendDirect(chatId, `✅ <b>Deposit Pending Video Saved!</b>\n\nFile ID:\n<code>${fileId}</code>`);
      return;
    } else if (caption === "/setverifiedvideo" || caption === "/setvideo" || caption === "/setvideo3" || text === "/setvideo") {
      state.cfg.verifiedVideo = fileId;
      state.cfg.finalVideo = fileId;
      state.cfg.welcomeVideo = fileId;
      persist();
      await sendDirect(chatId, `✅ <b>Verified Congratulations Video Saved!</b>\n\nFile ID:\n<code>${fileId}</code>`);
      return;
    } else {
      await sendDirect(chatId, `📹 <b>Video Received!</b>\n\nTelegram File ID:\n<code>${fileId}</code>\n\n💡 <i>Caption commands: <code>/setvideo1</code>, <code>/setvideo2</code>, <code>/setdepositvideo</code>, <code>/setverifiedvideo</code></i>`);
      return;
    }
  }

  if (msg.photo && ((msg.caption || "").trim() === "/setwelcome" || text === "/setwelcome")) {
    const photos = msg.photo;
    state.cfg.welcomePhoto = photos[photos.length - 1].file_id;
    persist();
    await sendDirect(chatId, "✅ Welcome photo file_id updated.");
    return;
  }

  if (text === "/setvideo" && msg.reply_to_message?.video) {
    state.cfg.welcomeVideo = msg.reply_to_message.video.file_id;
    state.cfg.finalVideo = msg.reply_to_message.video.file_id;
    persist();
    await sendDirect(chatId, "✅ Welcome video file_id updated.");
    return;
  }

  // Action: START PREDICTION
  if (text === BTN_ON || text.toLowerCase() === "/start_prediction") {
    if (sub.uidStatus !== "VERIFIED") {
      await sendDirect(chatId,
        `⚠️ <b>Access Locked!</b>\n\n` +
        `Your Account UID is not verified yet.\n` +
        `Please send your 10-12 digit Account UID here and wait for administrator approval.`
      );
      return;
    }
    sub.active = true;
    persist();
    await sendDirect(chatId,
      `🚀 <b>Predictions Activated!</b>\n\n` +
      `Live round signals will now be delivered directly to this chat.\n\n` +
      `Tap <b>${BTN_OFF}</b> at any time to pause and clear chat history.`,
      { reply_markup: MAIN_KEYBOARD }
    );
    await syncBotProfile();
    return;
  }

  // Action: STOP PREDICTION
  if (text === BTN_OFF || text.toLowerCase() === "/stop_prediction") {
    sub.active = false;
    const deleted = await clearSubscriberChat(sub);
    persist();
    await sendDirect(chatId,
      `🛑 <b>Predictions Stopped.</b>\n\n` +
      `Signal delivery has been paused.` +
      (deleted ? `\n🧹 Cleared ${deleted} message(s) from chat.` : "") +
      `\n\nTap <b>${BTN_ON}</b> whenever you want to resume.`,
      { reply_markup: MAIN_KEYBOARD }
    );
    await syncBotProfile();
    return;
  }

  // Check if text is a numeric Account UID (5 to 12 digits, covering 10-12 digits)
  const isUid = /^\d{5,12}$/.test(text);
  if (isUid) {
    if (sub.uidStatus === "VERIFIED") {
      await sendDirect(chatId,
        `✅ <b>Already Verified!</b>\n\n` +
        `Your Account UID (<code>${esc(sub.uid)}</code>) is already verified.\n` +
        `Tap <b>${BTN_ON}</b> below to receive signals.`,
        { reply_markup: MAIN_KEYBOARD }
      );
      return;
    }

    sub.uid = text;
    sub.uidStatus = "PENDING";
    sub.uidSubmittedAt = Date.now();
    persist();

    // 1. Send confirmation message
    await sendDirect(chatId,
      `📩 <b>Verification Request Submitted!</b>\n\n` +
      `Your Account UID: <code>${esc(text)}</code>\n` +
      `Status: ⏳ <b>Waiting for Administrator Review</b>\n\n` +
      `Admin aapki ID ko verify kar raha hai.`
    );
    await sleep(600);

    // 2. Send Video WhatsApp Video 10.03.41 PM (which explains: ID is verified by server, now deposit!) with "I Have Deposited" button
    const depositInstructionCaption =
      `📹 <b>ID Server Verified — Complete Deposit!</b>\n\n` +
      `Aapka Account ID server se verify ho chuka hai. Live prediction unlock karne ke liye apna deposit complete karein.\n\n` +
      `Deposit complete karne ke baad neeche diye gaye button par click karein:`;

    await sendStepVideo(chatId, "deposit_instructions", depositInstructionCaption, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 Maine Deposit Kar Liya", callback_data: `deposited|${sub.id}` }]
        ]
      }
    });

    // 3. Trigger server verification process (auto-verify if enabled)
    processServerVerification(sub.id, text).catch(err => warn(`verification error: ${err.message}`));
    return;
  }

  // Any other text
  if (sub.uidStatus !== "VERIFIED") {
    await sendDirect(chatId,
      `ℹ️ Please send your <b>10 to 12 digit Account UID</b> here to request verification.`
    );
  }
}

// ---------------------------------------------------------------- callback handler

async function handleCallback(cq) {
  const data = cq.data || "";
  const from = cq.from;
  const chatId = cq.message?.chat?.id;

  // Step 1 -> Step 2 transition: user clicked "I Have Watched The Video"
  if (data.startsWith("watched_v1|")) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Loading next step..." });

    const link = (state.cfg.customLink || "").trim();
    const linkDisplay = link ? link : "https://example.com/register";
    const captionText =
      `👇 <b>REGISTRATION LINK</b> 👇\n\n` +
      `🔗 :- ${link ? `<a href="${esc(link)}"><b>${esc(link)}</b></a>` : `<b>${linkDisplay}</b>`}\n\n\n` +
      `👇 <b>-- UID PAST HERE --</b> 👇`;

    const extra = {};
    if (link) {
      extra.reply_markup = {
        inline_keyboard: [
          [{ text: (state.cfg.customLinkText || "👉 REGISTER / OPEN LINK").trim(), url: link }]
        ]
      };
    }

    await sendStepVideo(chatId, 2, captionText, extra);
    return;
  }

  // User clicked "I Have Deposited"
  if (data.startsWith("deposited|")) {
    const userId = Number(data.slice("deposited|".length));
    const sub = state.subs.find(s => s.id === userId) || getOrAddUser(from);
    if (sub) {
      sub.uidStatus = "DEPOSIT_PENDING";
      persist();
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ Deposit claim submitted! Admin will verify and activate your predictions shortly.",
        show_alert: true
      });
      if (chatId) {
        await sendDirect(chatId,
          `💳 <b>Deposit Confirmation Received!</b>\n\n` +
          `Aapka deposit confirmation admin ko submit ho gaya hai.\n` +
          `Admin verify karte hi aapka live prediction access unlock ho jayega!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔍 Check My ID", callback_data: `check_uid|${sub.id}` }]
              ]
            }
          }
        );
      }
      await syncBotProfile();
      info(`user ${userId} submitted deposit claim (status: DEPOSIT_PENDING)`);
    }
    return;
  }

  if (data.startsWith("check_uid|")) {
    const userId = Number(data.slice("check_uid|".length));
    const sub = state.subs.find(s => s.id === userId) || getOrAddUser(from);

    if (!sub || !sub.uid) {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "⚠️ No UID submitted yet. Please send your UID number.",
        show_alert: true
      });
      return;
    }

    if (sub.uidStatus === "VERIFIED") {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ Status: VERIFIED! Access Unlocked.",
        show_alert: true
      });
      if (chatId) {
        await sendDirect(chatId,
          `✅ <b>UID Status: VERIFIED</b>\n\n` +
          `UID: <code>${esc(sub.uid)}</code>\n` +
          `Status: <b>Active & Approved</b>\n\n` +
          `Tap <b>${BTN_ON}</b> below to start receiving predictions!`,
          { reply_markup: MAIN_KEYBOARD }
        );
      }
      return;
    }

    if (sub.uidStatus === "DEPOSIT_PENDING") {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "⏳ Status: DEPOSIT PENDING\nAapka deposit verification request admin ke paas review me hai. Admin verify kar raha hai, kripya intezar karein...",
        show_alert: true
      });
      return;
    }

    if (sub.uidStatus === "PENDING") {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "⏳ Status: PENDING UID\nAdmin aapki ID check kar raha hai. Kripya video dekh kar deposit complete karein aur 'I Have Deposited' dabayein.",
        show_alert: true
      });
      return;
    }

    if (sub.uidStatus === "REJECTED") {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "❌ Status: REJECTED\nYour UID could not be verified. Please submit a valid UID.",
        show_alert: true
      });
      return;
    }
  }

  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Done." });
}

// ---------------------------------------------------------------- broadcast loop

export async function broadcast(period, prediction, numbers) {
  const fullText = buildPost(period, prediction, numbers);

  // Broadcast ONLY to verified, active subscribers (pure text message, no photo)
  const eligibleSubs = state.subs.filter(s => s.active && s.uidStatus === "VERIFIED");
  if (!state.cfg.botToken || !eligibleSubs.length) {
    if (!eligibleSubs.length) warn(`nothing published for ..${period.slice(-4)} — no active verified subscriber`);
    return false;
  }

  const startMs = Date.now();
  const CONCURRENCY = 12;
  const dead = [];

  await mapConcurrent(eligibleSubs, CONCURRENCY, async (s) => {
    const r = await sendDirect(s.id, fullText, { reply_markup: MAIN_KEYBOARD }, true);
    if (!r.ok && r.blocked) dead.push(s.id);
  });

  if (dead.length) {
    for (const id of dead) {
      const u = state.subs.find(s => s.id === id);
      if (u) u.active = false;
    }
    info(`switched off ${dead.length} unreachable subscriber(s)`);
  }

  const elapsed = Date.now() - startMs;
  info(`broadcast ..${period.slice(-4)} complete to ${eligibleSubs.length} verified subscriber(s) in ${elapsed}ms`);

  state.statLines.posts++;
  persist();
  return true;
}

// ---------------------------------------------------------------- polling listener

export async function startListener() {
  if (state.listener.running) return { ok: true, status: state.listener.status };
  if (!state.cfg.botToken) {
    state.listener.status = "no token";
    return { ok: false, status: state.listener.status };
  }
  await ensureBotInfo();

  const del = await tg("deleteWebhook", { drop_pending_updates: false });
  if (!del.ok) {
    state.listener.status = "webhook blocks polling";
    return { ok: false, status: state.listener.status, error: del.description };
  }

  state.listener.running = true;
  state.listener.fails = 0;
  state.listener.status = "listening";
  pollLoop();
  return { ok: true, status: state.listener.status };
}

export function stopListener() {
  state.listener.running = false;
  state.listener.status = "stopped";
  return { ok: true };
}

async function pollLoop() {
  while (state.listener.running) {
    const j = await tg("getUpdates", {
      offset: state.subOffset,
      timeout: 10,
      allowed_updates: ["message", "callback_query"]
    });
    if (!state.listener.running) return;

    if (!j.ok) {
      state.listener.fails = (state.listener.fails || 0) + 1;
      const desc = String(j.description || "").toLowerCase();
      if (desc.includes("conflict") || desc.includes("terminated by other")) {
        state.listener.running = false;
        state.listener.status = "blocked — another instance polling this token";
        return;
      }
      if (desc.includes("unauthorized") || desc.includes("not found")) {
        state.listener.running = false;
        state.listener.status = "token rejected";
        return;
      }
      state.listener.status = "retrying";
      await sleep(Math.min(15000, 1500 * state.listener.fails));
      continue;
    }

    state.listener.fails = 0;
    state.listener.status = "listening";

    const updates = Array.isArray(j.result) ? j.result : [];
    for (const u of updates) {
      if (u.update_id >= state.subOffset) state.subOffset = u.update_id + 1;
      try {
        if (u.message) await handleMessage(u.message);
        else if (u.callback_query) await handleCallback(u.callback_query);
      } catch (e) {
        warn(`update handler failed: ${e.message}`);
      }
    }
    if (updates.length) persist();
    await sleep(300);
  }
}

export async function removeWebhook() {
  const j = await tg("deleteWebhook", { drop_pending_updates: false });
  return j.ok ? { ok: true } : { ok: false, error: j.description };
}

export async function setBotCommands() {
  const j = await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Start the bot & verification flow" }
    ]
  });
  return j.ok ? { ok: true } : { ok: false, error: j.description };
}

export async function verifyToken(overrideToken = "") {
  const tokenToTest = (overrideToken || state.cfg.botToken || "").trim();
  if (!tokenToTest) return { ok: false, error: "Bot token is empty" };

  try {
    const res = await fetch(`https://api.telegram.org/bot${tokenToTest}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(8000)
    });
    const j = await res.json();
    if (!j.ok) return { ok: false, error: j.description || "Invalid bot token" };

    state.cfg.botToken = tokenToTest;
    state.bot = { id: j.result.id, username: j.result.username || "" };
    persist();

    // Clear any conflicting webhooks and auto-start listener
    await tg("deleteWebhook", { drop_pending_updates: false });
    await setBotCommands();
    if (!state.listener.running) {
      await startListener();
    }
    await syncBotProfile();

    return { ok: true, username: j.result.username, name: j.result.first_name, id: j.result.id };
  } catch (e) {
    return { ok: false, error: "Network error: " + e.message };
  }
}
