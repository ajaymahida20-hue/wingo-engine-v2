// The control panel: a tiny JSON API plus the static page that drives it.
// Focuses on Engine controls, Feed diagnostics, and Bot Member UID Verification.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HISTORY_MAX, PORT, PANEL_PASSWORD, DEFAULT_PANEL_PASSWORD, FEED_PROXY, MIRROR_HOSTS, GAME } from "./config.js";
import { state, saveNow, dataFile } from "./store.js";
import { roundStatus, nextPeriod, fetchHistory, activeMirror } from "./history.js";
import { resetStrategy } from "./engine.js";
import { logs, info } from "./logger.js";
import * as tg from "./telegram.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function panelPassword() {
  const pw = PANEL_PASSWORD();
  if (pw === DEFAULT_PANEL_PASSWORD) {
    console.warn(
      "\n  ! Panel password is the built-in default. Set PANEL_PASSWORD in the\n" +
      "  ! environment to change it — the panel can read your bot token.\n"
    );
  }
  return pw;
}

function snapshot() {
  tg.checkDailyResets();
  const { period, secondsLeft } = roundStatus();
  return {
    ok: true,
    now: Date.now(),
    uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
    bot: { username: state.bot.username || "" },
    listener: { running: state.listener.running, status: state.listener.status || "not started" },
    engine: state.engine,
    feed: {
      lastPoll: state.lastPoll, lastPollError: state.lastPollError, polls: state.statLines.polls,
      lastOk: state.feed.lastOk, lastError: state.feed.lastError, lastStatus: state.feed.lastStatus,
      lastRounds: state.feed.lastRounds, ok: state.feed.ok, failed: state.feed.failed,
      viaProxy: state.feed.viaProxy, proxyConfigured: !!FEED_PROXY(),
      host: state.feed.host, activeMirror: activeMirror(),
      mirrors: MIRROR_HOSTS.map(h => `draw.${h}.com`), game: GAME
    },
    logs: logs.slice(-140).reverse(),
    round: { period, secondsLeft, nextPeriod: nextPeriod() },
    run: state.run,
    stats: state.stats,
    detail: state.lastDetail,
    history: {
      depth: state.history.length,
      max: HISTORY_MAX,
      newest: state.history[0] || null,
      oldest: state.history[state.history.length - 1] || null,
      file: dataFile()
    },
    cfg: {
      botToken: state.cfg.botToken,
      header: state.cfg.header,
      footer: state.cfg.footer,
      welcomePhoto: state.cfg.welcomePhoto,
      welcomeVideo: state.cfg.welcomeVideo || "",
      step1Video: state.cfg.step1Video || "",
      step2Video: state.cfg.step2Video || "",
      depositVideo: state.cfg.depositVideo || "",
      verifiedVideo: state.cfg.verifiedVideo || "",
      uidVerifiedVideo: state.cfg.uidVerifiedVideo || state.cfg.verifiedVideo || "",
      finalVideo: state.cfg.finalVideo || state.cfg.welcomeVideo || "",
      uidMessage: state.cfg.uidMessage || "",
      customLink: state.cfg.customLink || "",
      customLinkText: state.cfg.customLinkText || "👉 REGISTER / OPEN LINK",
      autoVerifyUid: state.cfg.autoVerifyUid === true
    },
    subscribers: state.subs.map(s => ({
      id: s.id,
      name: s.name,
      username: s.username,
      uid: s.uid || "—",
      uidStatus: s.uidStatus || "NONE",
      uidSubmittedAt: s.uidSubmittedAt || null,
      active: s.active === true,
      freeTrialActive: s.freeTrialActive === true,
      freeTrialUsed: s.freeTrialUsed === true,
      freeTrialWins: s.freeTrialWins || 0,
      tracked: (s.msgs || []).length,
      sessionNumber: s.sessionNumber || 1,
      sessionWins: s.sessionWins || 0,
      dailyWins: s.dailyWins || 0,
      cooldownUntil: s.cooldownUntil || null
    })),
    totals: {
      users: state.subs.length,
      verified: state.subs.filter(s => s.uidStatus === "VERIFIED").length,
      pendingUid: state.subs.filter(s => s.uidStatus === "PENDING_UID").length,
      depositPending: state.subs.filter(s => s.uidStatus === "DEPOSIT_PENDING").length,
      pending: state.subs.filter(s => s.uidStatus === "PENDING").length,
      freeTrial: state.subs.filter(s => s.freeTrialActive && (s.freeTrialWins || 0) < 5).length,
      live: state.subs.filter(s => s.active && (s.uidStatus === "VERIFIED" || (s.freeTrialActive && (s.freeTrialWins || 0) < 5))).length
    },
    channelForward: state.channelForward || {
      target: "",
      chatId: null,
      title: "",
      username: "",
      type: "",
      verified: false,
      active: false,
      sessionWins: 0,
      targetWins: 5,
      status: "IDLE",
      pastLog: []
    },
    forwardChannels: state.forwardChannels || [],
    log: state.log.slice(0, 40)
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 200000) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
};

async function api(req, res, url) {
  const route = url.pathname;
  const body = req.method === "POST" ? await readBody(req) : {};

  // Public Channel Forward endpoints (accessible by group/channel admins directly)
  if (route === "/api/public/channel-verify" && req.method === "POST") {
    const target = body.target || "";
    const r = await tg.verifyChannelAdmin(target);
    return json(res, 200, r);
  }

  if (route === "/api/public/channel-start" && req.method === "POST") {
    const target = body.target || "";
    const r = await tg.startChannelForward(target);
    return json(res, 200, r);
  }

  if (route === "/api/public/channel-status") {
    const target = url.searchParams.get("target") || body.target || "";
    const r = tg.getChannelForwardStatus(target);
    return json(res, 200, r);
  }

  const key = req.headers["x-panel-key"] || "";
  if (key !== panelPassword()) return json(res, 401, { ok: false, error: "unauthorized" });

  if (route === "/api/state" && req.method === "GET") return json(res, 200, snapshot());

  if (route === "/api/config" && req.method === "POST") {
    if ("botToken" in body) state.cfg.botToken = String(body.botToken || "").trim();
    if ("header" in body) state.cfg.header = String(body.header || "");
    if ("footer" in body) state.cfg.footer = String(body.footer || "").trim();
    if ("welcomeVideo" in body) state.cfg.welcomeVideo = String(body.welcomeVideo || "").trim();
    if ("step1Video" in body) state.cfg.step1Video = String(body.step1Video || "").trim();
    if ("step2Video" in body) state.cfg.step2Video = String(body.step2Video || "").trim();
    if ("depositVideo" in body) state.cfg.depositVideo = String(body.depositVideo || "").trim();
    if ("verifiedVideo" in body) state.cfg.verifiedVideo = String(body.verifiedVideo || "").trim();
    if ("uidVerifiedVideo" in body) state.cfg.uidVerifiedVideo = String(body.uidVerifiedVideo || "").trim();
    if ("finalVideo" in body) state.cfg.finalVideo = String(body.finalVideo || "").trim();
    if ("uidMessage" in body) state.cfg.uidMessage = String(body.uidMessage || "");
    if ("customLink" in body) state.cfg.customLink = String(body.customLink || "").trim();
    if ("customLinkText" in body) state.cfg.customLinkText = String(body.customLinkText || "").trim();
    if ("autoVerifyUid" in body) state.cfg.autoVerifyUid = !!body.autoVerifyUid;
    saveNow();
    if (state.cfg.botToken && !state.listener.running) await tg.startListener();
    return json(res, 200, { ok: true });
  }

  if (route === "/api/verify-token" && req.method === "POST") {
    const token = body.botToken ? String(body.botToken).trim() : "";
    const r = await tg.verifyToken(token);
    return json(res, 200, r);
  }

  if (route === "/api/listener" && req.method === "POST") {
    const r = body.action === "stop" ? tg.stopListener() : await tg.startListener();
    return json(res, 200, r);
  }

  if (route === "/api/engine" && req.method === "POST") {
    const on = body.action !== "stop";
    const was = state.engine.enabled;
    state.engine.enabled = on;
    saveNow();
    if (was !== on) info(on ? "prediction engine STARTED" : "prediction engine STOPPED — feed polling paused");
    return json(res, 200, { ok: true, enabled: on });
  }

  if (route === "/api/test-feed" && req.method === "POST") {
    const t0 = Date.now();
    try {
      const parsed = await fetchHistory();
      return json(res, 200, {
        ok: true, ms: Date.now() - t0, rounds: parsed.length,
        newest: parsed[0], oldest: parsed[parsed.length - 1]
      });
    } catch (e) {
      return json(res, 200, { ok: false, ms: Date.now() - t0, error: state.feed.lastError || e.message });
    }
  }

  if (route === "/api/webhook" && req.method === "POST") return json(res, 200, await tg.removeWebhook());
  if (route === "/api/commands" && req.method === "POST") return json(res, 200, await tg.setBotCommands());

  // Channel / Group forward controls
  if (route === "/api/channel/verify" && req.method === "POST") {
    const target = body.target || "";
    const r = await tg.verifyChannelAdmin(target);
    return json(res, 200, r);
  }

  if (route === "/api/channel/toggle" && req.method === "POST") {
    const action = body.action; // "start" | "stop" | "reset"
    if (action === "start") {
      if (!state.channelForward?.verified || !state.channelForward?.chatId) {
        return json(res, 400, { ok: false, error: "Please verify channel admin status first" });
      }
      const r = await tg.startChannelForward(state.channelForward.target || state.channelForward.chatId);
      return json(res, 200, r);
    }
    if (action === "stop") {
      const r = tg.stopChannelForward(state.channelForward.target || state.channelForward.chatId);
      return json(res, 200, r);
    }
    if (action === "reset") {
      state.channelForward.sessionWins = 0;
      state.channelForward.pastLog = [];
      state.channelForward.status = "IDLE";
      state.channelForward.active = false;
      saveNow();
      return json(res, 200, { ok: true, channelForward: state.channelForward });
    }
    return json(res, 400, { ok: false, error: "unknown action" });
  }

  // Subscriber UID verification & management
  if (route === "/api/subscribers" && req.method === "POST") {
    const id = body.id;
    const action = body.action;

    if (action === "verify_id") {
      const r = await tg.sendIdVerifiedDeposit(id);
      return json(res, 200, r);
    }
    if (action === "verify" || action === "full_verify") {
      const r = await tg.setSubscriberUidStatus(id, "VERIFIED");
      return json(res, 200, r);
    }
    if (action === "deposit_pending" || action === "ask_deposit") {
      const r = await tg.sendAskDeposit(id);
      return json(res, 200, r);
    }
    if (action === "reject") {
      const r = await tg.setSubscriberUidStatus(id, "REJECTED");
      return json(res, 200, r);
    }
    if (action === "send_message") {
      const message = String(body.message || "").trim();
      if (!message) return json(res, 400, { ok: false, error: "message cannot be empty" });
      const r = await tg.sendDirect(id, message);
      if (r.ok) {
        info(`Admin sent personal message to user ${id}: ${message.slice(0, 40)}`);
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { ok: false, error: r.description || "Failed to deliver message" });
    }
    if (action === "delete") {
      state.subs = state.subs.filter(s => String(s.id) !== String(id));
      saveNow();
      tg.syncBotProfile();
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { ok: false, error: "unknown action" });
  }

  if (route === "/api/history" && req.method === "GET") {
    return json(res, 200, { ok: true, history: state.history, strategy: state.strategy });
  }

  if (route === "/api/clear-history" && req.method === "POST") {
    state.history = [];
    resetStrategy();
    saveNow();
    return json(res, 200, { ok: true, cleared: true });
  }

  if (route === "/api/reset-stats" && req.method === "POST") {
    state.stats = { wins: 0, jackpots: 0, losses: 0 };
    state.log = [];
    saveNow();
    return json(res, 200, { ok: true });
  }

  if (route === "/api/export" && req.method === "GET") {
    return json(res, 200, { ok: true, config: { ...state.cfg } });
  }

  if (route === "/api/import" && req.method === "POST") {
    const cfg = body.config || {};
    if (typeof cfg.botToken === "string") state.cfg.botToken = cfg.botToken;
    if (typeof cfg.header === "string") state.cfg.header = cfg.header;
    if (typeof cfg.footer === "string") state.cfg.footer = cfg.footer;
    if (typeof cfg.welcomeVideo === "string") state.cfg.welcomeVideo = cfg.welcomeVideo;
    if (typeof cfg.uidMessage === "string") state.cfg.uidMessage = cfg.uidMessage;
    if (typeof cfg.customLink === "string") state.cfg.customLink = cfg.customLink;
    if (typeof cfg.customLinkText === "string") state.cfg.customLinkText = cfg.customLinkText;
    if (typeof cfg.autoVerifyUid === "boolean") state.cfg.autoVerifyUid = cfg.autoVerifyUid;
    saveNow();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { ok: false, error: "unknown route" });
}

function serveStatic(req, res, url) {
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  if (rel === "/forward" || rel === "/forward/") rel = "/forward.html";
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end("forbidden"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }).end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      return serveStatic(req, res, url);
    } catch (e) {
      console.error("panel error:", e.message);
      json(res, 500, { ok: false, error: e.message });
    }
  });
  const port = PORT();
  server.listen(port, () => console.log(`control panel listening on port ${port}`));
  return server;
}
