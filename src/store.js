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
  history: [],              // rolling rounds, newest first (kept in-memory, max 10)
  log: [],                  // published signals, newest first (capped at 6)
  stats: { wins: 0, jackpots: 0, losses: 0 },
  run: {                    // the four-stage ladder
    mode: "FLOW",           // FLOW | COLOR | COLOR_FLOW
    consecutiveLosses: 0,
    prediction: null,
    numbers: [],
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
  statLines: { polls: 0, rounds: 0, posts: 0 }
};

let remoteSha = null;
let syncingRemote = false;
let lastRemoteSync = 0;

function applySaved(saved) {
  if (!saved || typeof saved !== "object") return;
  if (saved.cfg) state.cfg = { ...structuredClone(DEFAULT_CONFIG), ...state.cfg, ...saved.cfg };
  if (!state.cfg.botToken && process.env.BOT_TOKEN) state.cfg.botToken = process.env.BOT_TOKEN.trim();
  if (Array.isArray(saved.subs) && saved.subs.length) {
    state.subs = saved.subs.map(s => ({
      uid: null,
      uidStatus: "NONE",
      uidSubmittedAt: null,
      active: false,
      msgs: [],
      ...s
    }));
  }
  if (Number.isFinite(saved.subOffset)) state.subOffset = saved.subOffset;
  if (Array.isArray(saved.log) && saved.log.length) {
    state.log = saved.log.slice(0, 6);
  }
  if (saved.stats) state.stats = { ...state.stats, ...saved.stats };
  if (saved.run) state.run = { ...state.run, ...saved.run };
  if (saved.engine) state.engine = { ...state.engine, ...saved.engine };
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
  // Throttle automatic periodic syncs to once every 3 minutes unless forced
  if (!force && now - lastRemoteSync < 180000) return false;
  if (syncingRemote) return false;

  syncingRemote = true;
  try {
    if (!remoteSha) {
      const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/state.json?ref=${branch}`, {
        headers: { "Authorization": `Bearer ${token}`, "User-Agent": "Wingo-Engine" },
        signal: AbortSignal.timeout(8000)
      });
      if (getRes.ok) {
        const d = await getRes.json();
        remoteSha = d.sha;
      }
    }

    const payload = {
      cfg: state.cfg,
      subs: state.subs,
      subOffset: state.subOffset,
      log: state.log.slice(0, 6),
      stats: state.stats,
      run: state.run,
      engine: state.engine,
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

function saveLocalNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      cfg: state.cfg,
      subs: state.subs,
      subOffset: state.subOffset,
      log: state.log.slice(0, 6),
      stats: state.stats,
      run: state.run,
      engine: state.engine
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
