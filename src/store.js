// Everything the engine remembers lives in one object, written to a JSON file.
// On Render, we also sync to GitHub's 'data' branch so channels, subscribers,
// and bot tokens survive every redeploy even without a paid persistent disk.

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH } from "./config.js";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "state.json");

export const state = {
  cfg: structuredClone(DEFAULT_CONFIG),
  subs: [],                 // [{ id, name, username, since, msgs: [messageId] }]
  subOffset: 0,             // Telegram getUpdates offset
  history: [],              // rolling rounds, newest first (up to 500 rounds)
  strategy: {
    level: 1,
    mode: "COLOR",
    consecutiveLosses: 0,
    skipRemaining: 0,
    shadowMode: false,
    shadowPrediction: null,
    targetNumber: null,
    refPeriod: null,
    refNumber: null
  },
  log: [],                  // published signals, newest first (capped at 6)
  stats: { wins: 0, jackpots: 0, losses: 0, l1Wins: 0, l2Wins: 0, l3Wins: 0, winRate: 0, totalTested: 0 },
  run: {
    mode: "LEVEL 1",
    consecutiveLosses: 0,
    prediction: null,
    numbers: [],
    level: 1,
    isSkip: false,
    predictionForPeriod: null
  },
  lastDetail: null,         // what the panel shows on the CALC card
  round: { period: "", startedAt: 0 },
  engine: { enabled: true },  // the master switch the panel drives
  feed: { lastOk: 0, lastError: "", lastStatus: 0, lastRounds: 0, ok: 0, failed: 0, viaProxy: false, host: "" },
  listener: { running: false, status: "not started" },
  bot: { id: null, username: "" },
  startedAt: Date.now(),
  lastPoll: 0,
  lastPollError: "",
  statLines: { polls: 0, rounds: 0, posts: 0 },
  channelForward: {
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
    lastPendingPeriod: null,
    pastLog: []
  },
  forwardChannels: []
};

let remoteSha = null;
let syncingRemote = false;
let lastRemoteSync = 0;

function applySaved(saved) {
  if (!saved || typeof saved !== "object") return;
  if (saved.cfg) {
    state.cfg = { ...structuredClone(DEFAULT_CONFIG), ...state.cfg, ...saved.cfg };
    if (!state.cfg.header || state.cfg.header.includes("𓆩❣️S❣️𓆪") || state.cfg.header.includes("ⲦRȺᎠER")) {
      state.cfg.header = DEFAULT_HEADER;
    }
  }
  if (!state.cfg.botToken && process.env.BOT_TOKEN) state.cfg.botToken = process.env.BOT_TOKEN.trim();
  if (Array.isArray(saved.history) && saved.history.length) {
    const existingPeriods = new Set(state.history.map(h => String(h.period || h.issueNumber)));
    const merged = [...state.history];
    for (const h of saved.history) {
      const p = String(h.period || h.issueNumber);
      if (!existingPeriods.has(p)) {
        merged.push(h);
        existingPeriods.add(p);
      }
    }
    merged.sort((a, b) => {
      const A = BigInt(a.period || a.issueNumber || 0);
      const B = BigInt(b.period || b.issueNumber || 0);
      return A > B ? -1 : A < B ? 1 : 0;
    });
    state.history = merged.slice(0, 500);
  }
  if (saved.strategy && typeof saved.strategy === "object") {
    state.strategy = { ...state.strategy, ...saved.strategy };
  }
  if (Array.isArray(saved.subs) && saved.subs.length) {
    const existingMap = new Map(state.subs.map(s => [s.id, s]));
    for (const s of saved.subs) {
      if (!existingMap.has(s.id)) {
        existingMap.set(s.id, {
          uid: null,
          uidStatus: "NONE",
          uidSubmittedAt: null,
          active: false,
          msgs: [],
          sessionWins: 0,
          sessionNumber: 1,
          dailyWins: 0,
          dailyDate: null,
          cooldownUntil: null,
          lastPendingPeriod: null,
          freeTrialActive: false,
          freeTrialUsed: false,
          freeTrialWins: 0,
          pastLog: [],
          ...s
        });
      } else {
        const cur = existingMap.get(s.id);
        Object.assign(cur, s);
      }
    }
    state.subs = Array.from(existingMap.values());
  }
  if (Number.isFinite(saved.subOffset)) state.subOffset = saved.subOffset;
  if (Array.isArray(saved.log) && saved.log.length) {
    state.log = saved.log.slice(0, 6);
  }
  if (saved.stats) state.stats = { ...state.stats, ...saved.stats };
  if (saved.run) state.run = { ...state.run, ...saved.run };
  if (saved.engine) state.engine = { ...state.engine, ...saved.engine };
  if (saved.channelForward && typeof saved.channelForward === "object") {
    state.channelForward = { ...state.channelForward, ...saved.channelForward };
  }
  if (Array.isArray(saved.forwardChannels)) {
    state.forwardChannels = saved.forwardChannels;
  }
}

export function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const saved = JSON.parse(raw);
    applySaved(saved);
    return true;
  } catch (e) {
    return false;   // first boot, or the file was wiped
  }
}

// Fetches saved state from the GitHub 'data' branch to restore data across redeploys
export async function initRemoteStore() {
  const token = GITHUB_TOKEN();
  const repo = GITHUB_REPO();
  const branch = GITHUB_BRANCH();
  if (!token || !repo) return false;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/state.json?ref=${branch}`, {
      headers: { "Authorization": `Bearer ${token}`, "User-Agent": "Wingo-Engine" },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return false;
    const data = await res.json();
    remoteSha = data.sha;
    const content = Buffer.from(data.content, "base64").toString("utf8");
    const remoteSaved = JSON.parse(content);
    applySaved(remoteSaved);
    // Write locally so next local reads are instant
    saveLocalNow();
    return true;
  } catch (e) {
    return false;
  }
}

export async function syncToRemote(force = false) {
  const token = GITHUB_TOKEN();
  const repo = GITHUB_REPO();
  const branch = GITHUB_BRANCH();
  if (!token || !repo) return false;

  const now = Date.now();
  // Throttle automatic periodic syncs to once every 20 seconds unless forced
  if (!force && now - lastRemoteSync < 20000) return false;
  if (syncingRemote) return false;

  syncingRemote = true;
  try {
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/state.json?ref=${branch}`, {
      headers: { "Authorization": `Bearer ${token}`, "User-Agent": "Wingo-Engine" },
      signal: AbortSignal.timeout(8000)
    });
    if (getRes.ok) {
      const d = await getRes.json();
      remoteSha = d.sha;
    }

    const payload = {
      cfg: state.cfg,
      subs: state.subs,
      subOffset: state.subOffset,
      history: state.history.slice(0, 500),
      strategy: state.strategy,
      log: state.log.slice(0, 6),
      stats: state.stats,
      run: state.run,
      engine: state.engine,
      channelForward: state.channelForward,
      forwardChannels: state.forwardChannels,
      savedAt: Date.now()
    };

    const content = Buffer.from(JSON.stringify(payload, null, 2)).toString("base64");
    const body = {
      message: "Sync persistent state",
      content,
      branch
    };
    if (remoteSha) body.sha = remoteSha;

    const res = await fetch(`https://api.github.com/repos/${repo}/contents/state.json`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "Wingo-Engine",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });

    if (res.ok) {
      const resData = await res.json();
      remoteSha = resData.content?.sha || null;
      lastRemoteSync = Date.now();
      return true;
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    syncingRemote = false;
  }
}

export function saveLocalNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      cfg: state.cfg,
      subs: state.subs,
      subOffset: state.subOffset,
      history: state.history.slice(0, 500),
      strategy: state.strategy,
      log: state.log.slice(0, 6),
      stats: state.stats,
      run: state.run,
      engine: state.engine,
      channelForward: state.channelForward,
      forwardChannels: state.forwardChannels
    };
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error("could not write state file:", e.message);
  }
}

let lastSave = 0;
let saveTimer = null;

export function persist(force = false) {
  const now = Date.now();
  const write = () => {
    lastSave = Date.now();
    saveLocalNow();
    if (force) syncToRemote(true);
    else syncToRemote(false);
  };

  if (force) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    write();
    return;
  }
  if (now - lastSave > 1500) { write(); return; }
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; write(); }, 1500);
}

export function saveNow() {
  persist(true);
}

export function dataFile() {
  return FILE;
}
