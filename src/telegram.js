// WinGo Telegram client & subscriber management.
// Handles deposit unlock (video + UID verification), "Check My ID",
// Start/Stop predictions with DM cleanup, and broadcasting.

import { MSG_TRACK_MAX, WELCOME_PHOTO, DEFAULT_VIDEO_MSG, DEFAULT_UID_MSG, DAILY_WIN_LIMIT } from "./config.js";
import { state, persist } from "./store.js";
import { buildPost, buildCompletedPost } from "./posts.js";
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

// High-speed keep-alive connection pool for Telegram Bot API
try {
  const undici = await import("undici");
  if (undici && undici.Agent && undici.setGlobalDispatcher) {
    const agent = new undici.Agent({
      connections: 64,
      pipelining: 1,
      keepAliveTimeout: 60000,
      keepAliveMaxTimeout: 120000,
    });
    undici.setGlobalDispatcher(agent);
  }
} catch {
  // If undici is not directly loaded, global fetch still operates
}

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
  let j = await tg("sendMessage", payload);
  if (!j.ok && typeof j.description === "string" && (j.description.includes("can't parse entities") || j.description.includes("entity"))) {
    delete payload.parse_mode;
    j = await tg("sendMessage", payload);
  }
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
    `<b>WELCOME TO NXT WORLD</b>\n\n` +
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
      `📹 <b>Pehle video check karo, uske baad niche diye gaye link se registration karo and UID number bhejo.</b>\n\n` +
      `🔗 <b>Registration Link:</b>\n` +
      `👉 <a href="${esc(link)}"><b>${esc(link)}</b></a>\n\n` +
      `Apna new created Account UID yahan message me send karein:`
    );
  }

  return custom || DEFAULT_UID_MSG;
}

// ---------------------------------------------------------------- subscriber state management

export function getTodayKey() {
  // IST (UTC + 5:30) date key
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function ensureSubSession(sub) {
  if (!sub) return;
  const today = getTodayKey();
  if (!sub.dailyDate) {
    sub.dailyDate = today;
  } else if (sub.dailyDate !== today) {
    sub.dailyDate = today;
    sub.dailyWins = 0;
    sub.sessionNumber = 1;
    sub.sessionWins = 0;
    sub.cooldownUntil = null;
    sub.waitingForWin = false;
    sub.pastLog = [];
    // Daily requirement: Next day user moves to PENDING (must deposit again for new day)
    if (sub.uidStatus === "VERIFIED") {
      sub.uidStatus = "PENDING";
      sub.active = false;
    }
  }
  if (typeof sub.sessionWins !== "number") sub.sessionWins = 0;
  if (typeof sub.sessionNumber !== "number" || sub.sessionNumber < 1) sub.sessionNumber = 1;
  if (typeof sub.dailyWins !== "number") sub.dailyWins = 0;
  if (typeof sub.waitingForWin !== "boolean") sub.waitingForWin = false;
  if (typeof sub.freeTrialWins !== "number") sub.freeTrialWins = 0;
  if (typeof sub.freeTrialActive !== "boolean") sub.freeTrialActive = false;
  if (typeof sub.freeTrialUsed !== "boolean") sub.freeTrialUsed = false;
  if (!Array.isArray(sub.pastLog)) sub.pastLog = [];
}

export function checkDailyResets() {
  const today = getTodayKey();
  let changed = false;
  for (const sub of state.subs) {
    if (!sub.dailyDate) {
      sub.dailyDate = today;
      changed = true;
    } else if (sub.dailyDate !== today) {
      sub.dailyDate = today;
      sub.dailyWins = 0;
      sub.sessionNumber = 1;
      sub.sessionWins = 0;
      sub.cooldownUntil = null;
      sub.waitingForWin = false;
      sub.pastLog = [];
      if (sub.uidStatus === "VERIFIED") {
        sub.uidStatus = "PENDING";
        sub.active = false;
      }
      changed = true;
    }
  }
  if (changed) {
    persist();
    syncBotProfile();
  }
}

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
      msgs: [],
      sessionWins: 0,
      sessionNumber: 1,
      dailyWins: 0,
      dailyDate: getTodayKey(),
      cooldownUntil: null,
      lastPendingPeriod: null,
      freeTrialActive: false,
      freeTrialUsed: false,
      freeTrialWins: 0,
      pastLog: []
    };
    state.subs.unshift(sub);
  } else {
    sub.name = displayName(from);
    sub.username = from.username || "";
  }
  ensureSubSession(sub);
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
    await sendIdVerifiedDeposit(userId);
    info(`user ${userId} UID ${uid} auto-verified successfully`);
  }
}

export async function sendDepositPrompt(sub) {
  if (!sub) return { ok: false };
  sub.uidStatus = "PENDING";
  sub.active = false;
  persist();

  // Step 1 Deposit Video (verified-video.mp4): ID verified, now complete deposit!
  const depositInstructionCaption =
    `📹 <b>ID Server Verified — Complete Deposit!</b>\n\n` +
    `Aapka Account ID (<code>${esc(sub.uid || "")}</code>) server verified hai.\n` +
    `5 Free Winning Shots poore ho chuke hain! Ab permanent daily live predictions unlock karne ke liye video dekhein aur apna deposit complete karein.\n\n` +
    `Deposit complete karne ke baad neeche diye gaye button par click karein:`;

  await sendStepVideo(sub.id, "deposit_instructions", depositInstructionCaption, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 Maine Deposit Kar Liya", callback_data: `deposited|${sub.id}` }]
      ]
    }
  });

  await syncBotProfile();
  return { ok: true, status: sub.uidStatus };
}

// Verification Step 2: Admin verifies UID from Web Panel
// User moves to "UID_VERIFIED" and receives the "Use for free 5 winning shot" button
export async function sendIdVerifiedDeposit(userId) {
  const sub = state.subs.find(s => String(s.id) === String(userId));
  if (!sub) return { ok: false, error: "user not found" };

  if (sub.freeTrialUsed) {
    return sendDepositPrompt(sub);
  }

  sub.uidStatus = "UID_VERIFIED";
  persist();

  const trialCaption =
    `✅ <b>Account UID Verified!</b>\n\n` +
    `Aapka Account UID (<code>${esc(sub.uid || "")}</code>) server se verify ho chuka hai!\n\n` +
    `Aapko milte hain <b>5 Free Winning Shots</b>.\n` +
    `Neeche diye gaye button par click karke apne free predictions start karein:`;

  await sendDirect(sub.id, trialCaption, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎁 Use for free 5 winning shot", callback_data: `use_free_trial|${sub.id}` }]
      ]
    }
  });

  await syncBotProfile();
  return { ok: true, status: sub.uidStatus };
}

// Admin asks for deposit / deposit reminder (Video 2: deposit-video.mp4):
export async function sendAskDeposit(userId) {
  const sub = state.subs.find(s => String(s.id) === String(userId));
  if (!sub) return { ok: false, error: "user not found" };

  sub.uidStatus = "PENDING";
  sub.active = false;
  persist();

  const depositCaption =
    `⚠️ <b>Deposit Verification Pending / Not Found!</b>\n\n` +
    `Aapka Account UID (<code>${esc(sub.uid || "")}</code>) server verified hai, lekin aapka deposit verify nahi ho paya hai.\n\n` +
    `Kripya is video ko dhyan se dekhein aur apna deposit complete karein.\n\n` +
    `Deposit complete karne ke baad neeche diye gaye button par click karein:`;

  await sendStepVideo(sub.id, "deposit", depositCaption, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 Maine Deposit Kar Liya", callback_data: `deposited|${sub.id}` }]
      ]
    }
  });

  await syncBotProfile();
  return { ok: true, status: sub.uidStatus };
}

export async function verifyChannelAdmin(chatTarget) {
  let target = String(chatTarget || "").trim();
  if (!target) return { ok: false, error: "Please enter a valid channel or group username / link / ID" };

  if (target.startsWith("https://t.me/")) {
    target = "@" + target.replace("https://t.me/", "").replace(/\/$/, "");
  }
  if (!target.startsWith("@") && !target.startsWith("-") && isNaN(Number(target))) {
    target = "@" + target;
  }

  const bot = await ensureBotInfo();
  if (!bot || !bot.id) {
    return { ok: false, error: "Bot token is not configured or bot is offline." };
  }

  const chatRes = await tg("getChat", { chat_id: target });
  if (!chatRes.ok || !chatRes.result) {
    return {
      ok: false,
      error: `चैनल/ग्रुप नहीं मिला (${chatRes.description || "Not Found"}). कृपया सुनिश्चित करें कि बॉट को ग्रुप/चैनल में ऐड किया गया है और यूजरनेम सही है।`
    };
  }

  const chat = chatRes.result;
  const memberRes = await tg("getChatMember", { chat_id: chat.id, user_id: bot.id });
  if (!memberRes.ok || !memberRes.result) {
    return {
      ok: false,
      error: `बॉट का स्टेटस चेक नहीं कर पाए: ${memberRes.description || "Failed to get chat member"}`
    };
  }

  const member = memberRes.result;
  const isAdmin = (member.status === "administrator" || member.status === "creator");

  if (!isAdmin) {
    return {
      ok: false,
      error: `बॉट इस चैनल/ग्रुप में एडमिन नहीं है (वर्तमान स्टेटस: ${member.status})। कृपया @${bot.username || "Bot"} को एडमिन बनाएं और 'Post Messages' परमिशन दें।`
    };
  }

  state.channelForward = {
    ...state.channelForward,
    target,
    chatId: chat.id,
    title: chat.title || target,
    username: chat.username ? `@${chat.username}` : "",
    type: chat.type || "channel",
    verified: true
  };

  if (!Array.isArray(state.forwardChannels)) state.forwardChannels = [];
  let existing = state.forwardChannels.find(c => String(c.chatId) === String(chat.id) || (c.target && c.target.toLowerCase() === target.toLowerCase()));
  if (!existing) {
    existing = {
      chatId: chat.id,
      target,
      title: chat.title || target,
      username: chat.username ? `@${chat.username}` : "",
      type: chat.type || "channel",
      verified: true,
      active: false,
      sessionWins: 0,
      targetWins: 5,
      status: "VERIFIED",
      lastPendingPeriod: null,
      pastLog: [],
      createdAt: Date.now()
    };
    state.forwardChannels.push(existing);
  } else {
    existing.verified = true;
    existing.title = chat.title || target;
    existing.username = chat.username ? `@${chat.username}` : existing.username;
    existing.status = existing.active ? "RUNNING" : "VERIFIED";
  }
  persist();

  return {
    ok: true,
    chat: {
      id: chat.id,
      title: chat.title,
      username: chat.username ? `@${chat.username}` : "",
      type: chat.type,
      status: member.status
    },
    channel: existing
  };
}

export async function startChannelForward(chatTarget) {
  let target = String(chatTarget || "").trim();
  if (target.startsWith("https://t.me/")) {
    target = "@" + target.replace("https://t.me/", "").replace(/\/$/, "");
  }
  if (!target.startsWith("@") && !target.startsWith("-") && isNaN(Number(target))) {
    target = "@" + target;
  }

  let ch = (state.forwardChannels || []).find(c => (c.target && c.target.toLowerCase() === target.toLowerCase()) || String(c.chatId) === target);
  if (!ch || !ch.verified) {
    const vr = await verifyChannelAdmin(target);
    if (!vr.ok) return vr;
    ch = (state.forwardChannels || []).find(c => String(c.chatId) === String(vr.chat.id));
  }

  if (!ch) return { ok: false, error: "Channel verification failed" };

  ch.active = true;
  ch.sessionWins = 0;
  ch.targetWins = 5;
  ch.status = "RUNNING";
  ch.pastLog = [];
  ch.lastPendingPeriod = null;

  state.channelForward = {
    ...state.channelForward,
    ...ch
  };
  persist();

  info(`Channel forwarding STARTED for ${ch.title} (${ch.target})`);
  return { ok: true, channel: ch };
}

export function stopChannelForward(chatTarget) {
  let target = String(chatTarget || "").trim();
  let ch = (state.forwardChannels || []).find(c => (c.target && c.target.toLowerCase() === target.toLowerCase()) || String(c.chatId) === target);
  if (ch) {
    ch.active = false;
    ch.status = "PAUSED";
  }
  if (state.channelForward) {
    state.channelForward.active = false;
    state.channelForward.status = "PAUSED";
  }
  persist();
  return { ok: true, channel: ch || state.channelForward };
}

export function getChannelForwardStatus(chatTarget) {
  let target = String(chatTarget || "").trim();
  if (target.startsWith("https://t.me/")) target = "@" + target.replace("https://t.me/", "").replace(/\/$/, "");
  if (!target.startsWith("@") && !target.startsWith("-") && isNaN(Number(target))) target = "@" + target;

  let ch = (state.forwardChannels || []).find(c => (c.target && c.target.toLowerCase() === target.toLowerCase()) || String(c.chatId) === target);
  if (!ch && state.channelForward && ((state.channelForward.target && state.channelForward.target.toLowerCase() === target.toLowerCase()) || String(state.channelForward.chatId) === target)) {
    ch = state.channelForward;
  }
  return { ok: true, channel: ch || state.channelForward || null };
}

export async function setSubscriberUidStatus(userId, status) {
  const sub = state.subs.find(s => String(s.id) === String(userId));
  if (!sub) return { ok: false, error: "user not found" };

  sub.uidStatus = status;
  if (status !== "VERIFIED") sub.active = false;
  persist();

  if (status === "VERIFIED") {
    sub.dailyDate = getTodayKey();
    sub.sessionWins = 0;
    sub.sessionNumber = 1;
    sub.dailyWins = 0;
    sub.cooldownUntil = null;
    sub.waitingForWin = false;
    sub.freeTrialActive = false;
    sub.freeTrialUsed = true;
    sub.pastLog = [];
    persist();

    // Send congratulations text directly (no black video)
    const finalMsg =
      `🎉 <b>CONGRATULATIONS! YOUR ACCOUNT IS FULLY VERIFIED</b>\n\n` +
      `Aapka Account UID <code>${esc(sub.uid || "")}</code> aur Deposit successfully verify ho chuka hai!\n\n` +
      `Tap <b>${BTN_ON}</b> below to start receiving live predictions.`;

    await sendDirect(sub.id, finalMsg, { reply_markup: MAIN_KEYBOARD });
  } else if (status === "DEPOSIT_PENDING") {
    // Send deposit video (deposit-video.mp4) along with deposit message & button
    const depositCaption =
      `⚠️ <b>Account ID Verified, Deposit Pending!</b>\n\n` +
      `Aapka Account UID (<code>${esc(sub.uid || "")}</code>) verify ho gaya hai, lekin aapne abhi tak <b>Deposit</b> complete nahi kiya hai.\n\n` +
      `Kripya registration link se apna deposit complete karein.\n` +
      `Deposit complete karne ke baad neeche diye gaye <b>💳 Maine Deposit Kar Liya</b> button par click karein:`;

    await sendStepVideo(sub.id, "deposit", depositCaption, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 Maine Deposit Kar Liya", callback_data: `deposited|${sub.id}` }]
        ]
      }
    });
  } else if (status === "REJECTED") {
    if (sub.uid) {
      sub.uidStatus = "PENDING";
      persist();

      const rejectDepositCaption =
        `❌ <b>Deposit Verification Not Approved!</b>\n\n` +
        `Aapka deposit verify nahi ho paya hai.\n` +
        `Kripya is video ko dhyan se dekhein aur apna deposit sahi tarike se complete karein.\n\n` +
        `Deposit complete karne ke baad neeche diye gaye button par click karein:`;

      await sendStepVideo(sub.id, "deposit", rejectDepositCaption, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Maine Deposit Kar Liya", callback_data: `deposited|${sub.id}` }]
          ]
        }
      });
    } else {
      await sendDirect(sub.id,
        `❌ <b>UID Verification Failed</b>\n\n` +
        `Your Account UID could not be verified. Please review the video instructions and submit a valid UID again.`
      );
    }
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
    ensureSubSession(sub);
    if (sub.uidStatus === "VERIFIED") {
      await sendDirect(chatId,
        `👋 <b>Welcome back ${esc(sub.name)}!</b>\n\n` +
        `Your Account UID (<code>${esc(sub.uid || "")}</code>) is <b>VERIFIED</b>.\n\n` +
        `Tap <b>${BTN_ON}</b> below to start receiving live predictions.`,
        { reply_markup: MAIN_KEYBOARD }
      );
      return;
    }

    if (sub.uidStatus === "PENDING") {
      const depositCaption =
        `⚠️ <b>Daily Deposit Required!</b>\n\n` +
        `Aapka Account UID (<code>${esc(sub.uid || "")}</code>) server me registered hai, lekin aapne aaj ka <b>Deposit</b> complete nahi kiya hai.\n\n` +
        `Naye din ke 30 winning shots unlock karne ke liye apna deposit complete karein.\n\n` +
        `Deposit complete karne ke baad neeche diye gaye <b>💳 Maine Deposit Kar Liya</b> button par click karein:`;

      await sendStepVideo(sub.id, "deposit", depositCaption, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Maine Deposit Kar Liya", callback_data: `deposited|${sub.id}` }]
          ]
        }
      });
      return;
    }

    if (sub.uidStatus === "UID_VERIFIED") {
      if (!sub.freeTrialUsed) {
        await sendDirect(chatId,
          `✅ <b>Account UID Verified!</b>\n\n` +
          `UID: <code>${esc(sub.uid || "")}</code>\n\n` +
          `🎁 Apna <b>5 Free Winning Shots</b> trial shuru karne ke liye neeche diye gaye button par click karein:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🎁 Use for free 5 winning shot", callback_data: `use_free_trial|${sub.id}` }]
              ]
            }
          }
        );
      } else {
        await sendDepositPrompt(sub);
      }
      return;
    }

    if (sub.uidStatus === "DEPOSIT_PENDING") {
      await sendDirect(chatId,
        `⏳ <b>Deposit Verification Pending!</b>\n\n` +
        `Aapka deposit claim admin ke paas review me hai.\n` +
        `Admin verify karte hi aapka live prediction access unlock ho jayega!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔍 Check My ID", callback_data: `check_uid|${sub.id}` }]
            ]
          }
        }
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
    ensureSubSession(sub);

    // 1. FIRST PRIORITY: Check if user is currently in cooldown between sessions!
    if (sub.cooldownUntil && Date.now() < sub.cooldownUntil) {
      sub.active = true;
      persist();
      const remainingSec = Math.max(0, Math.ceil((sub.cooldownUntil - Date.now()) / 1000));
      const remMin = Math.floor(remainingSec / 60);
      const remSec = remainingSec % 60;
      const timeStr = remMin > 0 ? `${remMin} minute ${remSec} second` : `${remSec} second`;

      await sendDirect(chatId,
        `⏳ <b>Next Session Ka Waiting Time Chalu Hai!</b>\n\n` +
        `Aapka pichhla session safaltapoorvak poora ho chuka hai.\n` +
        `Agla <b>Session ${sub.sessionNumber || 2}</b> shuru hone me abhi <b>${timeStr}</b> ka samay baaki hai!\n\n` +
        `⚠️ <b>Abhi START ya STOP button par click mat karo!</b> Shaant rahein, jaise hi timer poora hoga, agle 5 winning shots automatically shuru ho jayenge!\n\n` +
        `📊 <b>Aaj ke kul wins:</b> ${sub.dailyWins || 0}/${DAILY_WIN_LIMIT}`,
        { reply_markup: MAIN_KEYBOARD }
      );
      await syncBotProfile();
      return;
    }

    if (sub.uidStatus !== "VERIFIED") {
      if (sub.freeTrialActive && (sub.freeTrialWins || 0) < 5) {
        sub.active = true;
        persist();
        await sendDirect(chatId,
          `🚀 <b>Free Trial Predictions Resumed!</b>\n\n` +
          `🎯 Current progress: ${sub.freeTrialWins || 0}/5 free wins.\n` +
          `Live signals continue in this chat.`,
          { reply_markup: MAIN_KEYBOARD }
        );
        return;
      }

      if (sub.uidStatus === "UID_VERIFIED" && !sub.freeTrialUsed && (sub.freeTrialWins || 0) < 5) {
        await sendDirect(chatId,
          `✅ <b>Account UID Verified!</b>\n\n` +
          `Aapka Account UID (<code>${esc(sub.uid || "")}</code>) server se verify ho chuka hai!\n\n` +
          `🎁 Apna <b>5 Free Winning Shots</b> trial shuru karne ke liye neeche diye gaye button par click karein:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🎁 Use for free 5 winning shot", callback_data: `use_free_trial|${sub.id}` }]
              ]
            }
          }
        );
        return;
      }

      if (sub.uidStatus === "PENDING") {
        await sendDepositPrompt(sub);
        return;
      }

      if (sub.uidStatus === "DEPOSIT_PENDING") {
        await sendDirect(chatId,
          `⏳ <b>Deposit Verification Pending!</b>\n\n` +
          `Aapka deposit claim admin ke paas review me hai. Kripya verification complete hone ka intezar karein.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔍 Check My ID", callback_data: `check_uid|${sub.id}` }]
              ]
            }
          }
        );
        return;
      }

      if (sub.uidStatus === "PENDING_UID") {
        await sendDirect(chatId,
          `⏳ <b>UID Verification Pending!</b>\n\n` +
          `Aapka Account UID (<code>${esc(sub.uid || "")}</code>) admin review me hai.\n` +
          `Admin ke verify karte hi aapko 5 Free Winning Shots ka button mil jayega.`
        );
        return;
      }

      await sendDirect(chatId,
        `⚠️ <b>Access Locked!</b>\n\n` +
        `Aapka Account UID abhi submit ya verify nahi hua hai.\n` +
        `Kripya apna valid Account UID yahan message me send karein.`
      );
      return;
    }

    // 2. Check daily limit (DAILY_WIN_LIMIT winning shots per day)
    if (sub.dailyWins >= DAILY_WIN_LIMIT) {
      await sendDirect(chatId,
        `🛑 <b>Aaj Ka Daily Quota Samapt!</b>\n\n` +
        `Aapne aaj ke sabhi <b>${DAILY_WIN_LIMIT} winning shots</b> poore kar liye hain.\n` +
        `Kripya kal naye sessions ke liye fir se aayein! Dhanyawad.`,
        { reply_markup: MAIN_KEYBOARD }
      );
      return;
    }

    // 3. Start active predictions for this session
    sub.cooldownUntil = null;
    sub.waitingForWin = false;
    sub.active = true;
    sub.pastLog = [];
    persist();
    await sendDirect(chatId,
      `🚀 <b>Predictions Activated!</b>\n\n` +
      `Live round signals will now be delivered directly to this chat.\n\n` +
      `📍 <b>Session:</b> ${sub.sessionNumber}\n` +
      `🎯 <b>Target:</b> 5 winning shots (Current progress: ${sub.sessionWins}/5 wins)\n` +
      `🏆 <b>Aaj ke kul wins:</b> ${sub.dailyWins}/${DAILY_WIN_LIMIT}\n\n` +
      `Tap <b>${BTN_OFF}</b> at any time to pause and clear chat history.`,
      { reply_markup: MAIN_KEYBOARD }
    );
    await syncBotProfile();
    return;
  }

  // Action: STOP PREDICTION
  if (text === BTN_OFF || text.toLowerCase() === "/stop_prediction") {
    sub.active = false;
    sub.waitingForWin = false;
    sub.pastLog = [];
    const deleted = await clearSubscriberChat(sub);
    persist();
    ensureSubSession(sub);
    const progressText = (sub.freeTrialActive || !sub.freeTrialUsed)
      ? `Free Trial: ${sub.freeTrialWins || 0}/5 wins`
      : `Session ${sub.sessionNumber} (${sub.sessionWins}/5 wins) | Aaj ke kul wins: ${sub.dailyWins}/${DAILY_WIN_LIMIT}`;

    await sendDirect(chatId,
      `🛑 <b>Predictions Stopped.</b>\n\n` +
      `Signal delivery has been paused.\n` +
      `📍 Current progress: ${progressText}` +
      (deleted ? `\n🧹 Cleared ${deleted} message(s) from chat.` : "") +
      `\n\nTap <b>${BTN_ON}</b> whenever you want to resume.`,
      { reply_markup: MAIN_KEYBOARD }
    );
    await syncBotProfile();
    return;
  }

  // UID Submission: accept any UID of any length (digits or alphanumeric)
  const isCommand = text.startsWith("/") || text === BTN_ON || text === BTN_OFF;
  const isUidCandidate = !isCommand && /^[0-9a-zA-Z_-]{1,40}$/.test(text);

  if (isUidCandidate) {
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
    sub.uidStatus = "PENDING_UID";
    sub.uidSubmittedAt = Date.now();
    persist();

    // Confirmation message: Admin will verify ID first! (No free trial button yet)
    await sendDirect(chatId,
      `📩 <b>Verification Request Submitted!</b>\n\n` +
      `Your Account UID: <code>${esc(text)}</code>\n` +
      `Status: ⏳ <b>Waiting for Administrator Review</b>\n\n` +
      `Admin aapki ID ko server par verify kar raha hai.\n` +
      `Server se ID verify hone ke baad aapko <b>5 Free Winning Shots</b> claim karne ka button milega. Kripya thoda intezar karein.`
    );
    processServerVerification(sub.id, text);
    return;
  }

  // Any other text
  if (sub.uidStatus !== "VERIFIED") {
    await sendDirect(chatId,
      `ℹ️ Kripya apna valid <b>Account UID</b> yahan message me send karein.`
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

  // User clicked "Use for free 5 winning shot"
  if (data.startsWith("use_free_trial|")) {
    const userId = Number(data.slice("use_free_trial|".length));
    const sub = state.subs.find(s => s.id === userId) || getOrAddUser(from);
    if (!sub) return;

    if (sub.freeTrialUsed || (sub.freeTrialWins || 0) >= 5) {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "⚠️ Aapka 5 Free Winning Shots trial already use ho chuka hai!",
        show_alert: true
      });
      return;
    }

    sub.freeTrialActive = true;
    sub.active = true;
    sub.waitingForWin = false;
    persist();

    await tg("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "🎉 5 Free Winning Shots activated!",
      show_alert: false
    });

    if (chatId) {
      await sendDirect(chatId,
        `🎉 <b>5 Free Winning Shots Activated!</b>\n\n` +
        `Account UID: <code>${esc(sub.uid || "")}</code>\n\n` +
        `Aapko live predictions milna shuru ho gaye hain!\n` +
        `🎯 <b>Target:</b> 5 winning shots (Current progress: ${sub.freeTrialWins || 0}/5 wins)\n\n` +
        `⚠️ 5 winning shots complete hote hi yeh free trial pause ho jayega. Regular daily access ke liye deposit verify karwayein.\n\n` +
        `Tap <b>${BTN_OFF}</b> anytime to pause.`,
        { reply_markup: MAIN_KEYBOARD }
      );
    }
    await syncBotProfile();
    info(`user ${userId} activated 5 free winning shots trial`);
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

    if (sub.uidStatus === "UID_VERIFIED") {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "✅ Status: UID VERIFIED!\nApna 5 Free Winning Shots claim karein.",
        show_alert: true
      });
      if (chatId) {
        if (!sub.freeTrialUsed) {
          await sendDirect(chatId,
            `✅ <b>Account UID Verified!</b>\n\n` +
            `UID: <code>${esc(sub.uid || "")}</code>\n\n` +
            `🎁 Apna <b>5 Free Winning Shots</b> trial shuru karne ke liye neeche diye gaye button par click karein:`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🎁 Use for free 5 winning shot", callback_data: `use_free_trial|${sub.id}` }]
                ]
              }
            }
          );
        } else {
          await sendDepositPrompt(sub);
        }
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
        text: "📹 Status: ID VERIFIED — AWAITING DEPOSIT\nAapka ID verify ho chuka hai. Kripya deposit complete karke 'Maine Deposit Kar Liya' button dabayein.",
        show_alert: true
      });
      return;
    }

    if (sub.uidStatus === "PENDING_UID") {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: "⏳ Status: PENDING UID\nAdmin aapki ID review kar raha hai. ID verify hone ke baad aapko aage ka instruction milega, kripya intezar karein.",
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

export async function broadcast(period, prediction, numbers, level) {
  const now = Date.now();
  // Broadcast to active free trial users OR verified active subscribers
  const eligibleSubs = state.subs.filter(s => {
    if (!s.active) return false;
    // 1. Free Trial User:
    if (s.freeTrialActive && (s.freeTrialWins || 0) < 5) {
      return true;
    }
    // 2. Regular Verified User:
    if (s.uidStatus !== "VERIFIED") return false;
    if (s.waitingForWin) return false;
    ensureSubSession(s);
    if (s.dailyWins >= DAILY_WIN_LIMIT) return false;
    if (s.cooldownUntil && now < s.cooldownUntil) return false;
    return true;
  });

  const activeChannels = [];
  if (Array.isArray(state.forwardChannels)) {
    for (const c of state.forwardChannels) {
      if (c.active && c.chatId && (c.sessionWins || 0) < (c.targetWins || 5)) {
        activeChannels.push(c);
      }
    }
  }
  if (state.channelForward?.active && state.channelForward?.chatId && (state.channelForward.sessionWins || 0) < (state.channelForward.targetWins || 5)) {
    if (!activeChannels.some(c => String(c.chatId) === String(state.channelForward.chatId))) {
      activeChannels.push(state.channelForward);
    }
  }

  const hasChannel = activeChannels.length > 0;

  if (!state.cfg.botToken || (!eligibleSubs.length && !hasChannel)) {
    if (!eligibleSubs.length && !hasChannel) warn(`nothing published for ..${period.slice(-4)} — no eligible active subscriber or channel`);
    return false;
  }

  // Forward prediction to verified Telegram Channels / Groups if active
  for (const ch of activeChannels) {
    if (prediction !== "SKIP") {
      ch.lastPendingPeriod = period;
    }
    const chWins = ch.sessionWins || 0;
    const chLog = Array.isArray(ch.pastLog) ? ch.pastLog : [];
    const chPost = buildPost(period, prediction, numbers, level, chWins, chLog);
    sendDirect(ch.chatId, chPost, {}, true).then(r => {
      if (!r.ok) warn(`channel forward delivery failed for ${ch.title}: ${r.description || "error"}`);
    }).catch(e => warn(`channel forward delivery error for ${ch.title}: ${e.message}`));
  }

  // Mark pending period for eligible subscribers if this is a real prediction round (not SKIP)
  if (prediction !== "SKIP") {
    for (const s of eligibleSubs) {
      s.lastPendingPeriod = period;
    }
  }

  const startMs = Date.now();
  // High concurrency to deliver to all subscribers at the exact same second
  const CONCURRENCY = 25;
  const dead = [];

  // Step 1: Pre-build each subscriber's post in memory so the loop has zero string/logic overhead
  const targets = eligibleSubs.map(s => {
    const winsToShow = s.freeTrialActive ? (s.freeTrialWins || 0) : (s.sessionWins || 0);
    const userLog = Array.isArray(s.pastLog) ? s.pastLog : [];
    const post = buildPost(period, prediction, numbers, level, winsToShow, userLog);
    return { sub: s, post };
  });

  // Step 2: Instant parallel fan-out across persistent keep-alive connections
  await mapConcurrent(targets, CONCURRENCY, async ({ sub, post }) => {
    const r = await sendDirect(sub.id, post, { reply_markup: MAIN_KEYBOARD }, true);
    if (!r.ok && r.blocked) dead.push(sub.id);
  });

  if (dead.length) {
    for (const id of dead) {
      const u = state.subs.find(s => s.id === id);
      if (u) u.active = false;
    }
    info(`switched off ${dead.length} unreachable subscriber(s)`);
  }

  const elapsed = Date.now() - startMs;
  info(`broadcast ..${period.slice(-4)} complete to ${eligibleSubs.length} subscriber(s) in ${elapsed}ms`);

  state.statLines.posts++;
  persist();
  return true;
}

// Settles win counts and session progressions for subscribers who received the prediction
export async function settleSubscriberWins(resolved) {
  if (!resolved || !resolved.period) return;
  const isWin = resolved.resultText && resolved.resultText.includes("WIN");

  for (const sub of state.subs) {
    if (sub.lastPendingPeriod === resolved.period) {
      sub.lastPendingPeriod = null;

      // Track subscriber's session history (newest first, up to 5 rounds)
      if (!Array.isArray(sub.pastLog)) sub.pastLog = [];
      sub.pastLog.unshift({
        period: resolved.period,
        side: resolved.label,
        status: isWin ? "WIN" : "LOSS"
      });
      if (sub.pastLog.length > 5) sub.pastLog.length = 5;

      if (isWin) {
        // 1. Handle Free Trial Users
        if (sub.freeTrialActive && !sub.freeTrialUsed) {
          sub.freeTrialWins = (sub.freeTrialWins || 0) + 1;
          info(`free trial win for user ${sub.id}: ${sub.freeTrialWins}/5`);
          if (sub.freeTrialWins >= 5) {
            sub.freeTrialActive = false;
            sub.freeTrialUsed = true;
            sub.active = false;
            sub.uidStatus = "PENDING";
            persist();

            const finalLog = [...sub.pastLog];
            const userId = sub.id;
            // Send completed 5/5 wins post and follow-up in background (zero block on engine/broadcast)
            (async () => {
              const finalPost = buildCompletedPost(5, finalLog);
              await sendDirect(userId, finalPost, { reply_markup: MAIN_KEYBOARD }).catch(() => {});
              await sleep(1500);

              await sendDirect(userId,
                `🎉 <b>Badhai Ho! Aapke 5 Free Winning Shots Poore Ho Chuke Hain!</b>\n\n` +
                `Aapka 1-time free trial safaltapoorvak complete ho gaya hai (5/5 Wins! 🎯)\n\n` +
                `Permanent aur daily live predictions unlock karne ke liye agla step poora karein:`
              ).catch(() => {});

              await sleep(1000);
              await sendDepositPrompt(sub);
            })().catch(e => warn(`free trial completion delivery error (${userId}): ${e.message}`));
          } else {
            persist();
          }
          continue;
        }

        // 2. Handle Regular Verified Users
        ensureSubSession(sub);
        sub.sessionWins = (sub.sessionWins || 0) + 1;
        sub.dailyWins = (sub.dailyWins || 0) + 1;

        if (sub.dailyWins >= DAILY_WIN_LIMIT) {
          sub.active = false;
          sub.waitingForWin = false;
          sub.cooldownUntil = null;
          const finalLog = [...sub.pastLog];
          sub.pastLog = [];
          persist();

          const userId = sub.id;
          const totalWins = sub.dailyWins;
          (async () => {
            const finalPost = buildCompletedPost(5, finalLog);
            await sendDirect(userId, finalPost, { reply_markup: MAIN_KEYBOARD }).catch(() => {});
            await sleep(1500);

            await sendDirect(userId,
              `🎉 <b>Badhai Ho! Aaj Ka ${DAILY_WIN_LIMIT} Winning Shots Ka Target Poora Hua!</b>\n\n` +
              `Aapne aaj ke sabhi sessions safaltapoorvak poore kar liye hain.\n` +
              `🏆 <b>Aaj ke kul wins:</b> ${totalWins}/${DAILY_WIN_LIMIT}\n\n` +
              `Ab aaj ke liye predictions samapt hoti hain. Kal naye sessions ke saath fir milenge!`,
              { reply_markup: MAIN_KEYBOARD }
            ).catch(() => {});
          })().catch(e => warn(`daily win delivery error (${userId}): ${e.message}`));
        } else if (sub.sessionWins >= 5) {
          const completedSession = sub.sessionNumber || 1;
          sub.sessionNumber = completedSession + 1;
          sub.sessionWins = 0;
          sub.waitingForWin = false;
          const waitMinutes = completedSession * 5;
          sub.cooldownUntil = Date.now() + waitMinutes * 60 * 1000;
          const finalLog = [...sub.pastLog];
          sub.pastLog = []; // Reset history so next session starts from ZERO!
          persist();

          const userId = sub.id;
          const dailyCount = sub.dailyWins;
          (async () => {
            const finalPost = buildCompletedPost(5, finalLog);
            await sendDirect(userId, finalPost, { reply_markup: MAIN_KEYBOARD }).catch(() => {});
            await sleep(1500);

            await sendDirect(userId,
              `⏸️ <b>Session Poora Hua! (5 Winning Shots Prapt)</b>\n\n` +
              `Ab <b>${waitMinutes} minute</b> wait karo. ${waitMinutes} minute ke baad aapka agla <b>Session ${completedSession + 1}</b> shuru hoga.\n\n` +
              `⚠️ <b>Abhi START ya STOP button par click mat karna</b>. Shaant rahein, samay poora hote hi agle 5 shots automatically shuru ho jayenge!\n\n` +
              `📊 <b>Aaj ke kul wins:</b> ${dailyCount}/${DAILY_WIN_LIMIT}`,
              { reply_markup: MAIN_KEYBOARD }
            ).catch(() => {});
          })().catch(e => warn(`session completion delivery error (${userId}): ${e.message}`));
        } else {
          persist();
        }
      } else {
        persist();
      }
    }
  }

  // 1b. Settle Channel/Group Forwarding for all active channels
  const allForwardChannels = [];
  if (Array.isArray(state.forwardChannels)) allForwardChannels.push(...state.forwardChannels);
  if (state.channelForward && !allForwardChannels.some(c => String(c.chatId) === String(state.channelForward.chatId))) {
    allForwardChannels.push(state.channelForward);
  }

  for (const ch of allForwardChannels) {
    if (ch.active && ch.chatId && ch.lastPendingPeriod === resolved.period) {
      ch.lastPendingPeriod = null;
      if (!Array.isArray(ch.pastLog)) ch.pastLog = [];
      ch.pastLog.unshift({
        period: resolved.period,
        side: resolved.label,
        status: isWin ? "WIN" : "LOSS"
      });
      if (ch.pastLog.length > 5) ch.pastLog.length = 5;

      if (isWin) {
        ch.sessionWins = (ch.sessionWins || 0) + 1;
        const wins = ch.sessionWins;
        info(`channel forward win: ${wins}/5 for ${ch.title || ch.chatId}`);

        if (wins >= (ch.targetWins || 5)) {
          ch.active = false;
          ch.status = "COMPLETED";
          ch.completedAt = Date.now();
          const finalChLog = [...ch.pastLog];
          const targetChatId = ch.chatId;
          persist();

          (async () => {
            const finalPost = buildCompletedPost(5, finalChLog);
            await sendDirect(targetChatId, finalPost, {}, true).catch(() => {});
            await sleep(1500);

            const completionMsg =
              "हमारा WINNING पूरा हुआ अब आप नीचे दिए गए बॉट को यूस करके PROSNAL में प्रॉफिट कर अक्ते हो \n\n" +
              "🛑 FIX 4 LEVEL SERVER BOT 🛑\n\n" +
              "🤖:- @NXT_3_LEVEL_SERVER_BOT";

            await sendDirect(targetChatId, completionMsg, {}, true).catch(() => {});
            info(`channel forward 5 wins completion message sent to ${targetChatId}`);
          })().catch(e => warn(`channel forward completion delivery error: ${e.message}`));
        } else {
          persist();
        }
      } else {
        persist();
      }
    }
  }

  // 2. If this round was a WIN on server, safely sync and activate any subscribers waiting for safe entry!
  if (isWin) {
    const waitingSubs = state.subs.filter(s => s.active && s.uidStatus === "VERIFIED" && s.waitingForWin);
    for (const sub of waitingSubs) {
      sub.waitingForWin = false;
      ensureSubSession(sub);
      persist();
      await sendDirect(sub.id,
        `✅ <b>Server Win Confirmed! Session Synced!</b>\n\n` +
        `Aapka prediction session ab server ke saath safely connect ho gaya hai.\n` +
        `Agle round se aapko live signals milna shuru ho jayenge.\n\n` +
        `📍 <b>Session:</b> ${sub.sessionNumber}\n` +
        `🎯 <b>Target:</b> 5 winning shots (Current progress: ${sub.sessionWins || 0}/5 wins)\n` +
        `🏆 <b>Aaj ke kul wins:</b> ${sub.dailyWins || 0}/${DAILY_WIN_LIMIT}\n\n` +
        `Good luck!`,
        { reply_markup: MAIN_KEYBOARD }
      ).catch(() => {});
    }
  }
}

// Checks if any active subscriber's cooldown has finished and notifies them
export async function checkSubscriberCooldowns() {
  const now = Date.now();
  for (const sub of state.subs) {
    if (sub.active && sub.uidStatus === "VERIFIED" && sub.cooldownUntil && now >= sub.cooldownUntil) {
      sub.cooldownUntil = null;
      sub.waitingForWin = false;
      sub.sessionWins = 0;
      sub.pastLog = []; // Reset history so new session starts from ZERO!
      persist();
      await sendDirect(sub.id,
        `🚀 <b>Waiting Time Poora Hua!</b>\n\n` +
        `Aapka <b>Session ${sub.sessionNumber}</b> ab shuru ho raha hai!\n` +
        `🎯 Agle 5 winning shots ke liye taiyar rahein. (Current progress: 0/5 wins | Kul: ${sub.dailyWins}/${DAILY_WIN_LIMIT})`,
        { reply_markup: MAIN_KEYBOARD }
      ).catch(() => {});
    }
  }
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
