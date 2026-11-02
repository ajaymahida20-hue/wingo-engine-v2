// Talks to the lottery feed and keeps the rolling round history.
//
// The feed only hands back the newest 10 rounds per call, so every round we see
// is merged into a rolling store (newest first, one entry per period).

import { HISTORY_MAX, ROUND_SECONDS, MIRROR_HOSTS, feedUrlFor, FEED_PROXY, FEED_URL } from "./config.js";
import { state, persist } from "./store.js";
import { info, warn } from "./logger.js";

const pad = (n, len = 2) => String(n).padStart(len, "0");

let activeHost = null;

export const activeMirror = () => activeHost;

// FEED_URL replaces the whole source; FEED_PROXY puts a relay in front of whichever
// host is being tried, so the request leaves from the relay's IP instead.
export function feedTarget(host) {
  const url = `${FEED_URL() || feedUrlFor(host)}?ts=${Date.now()}`;
  const proxy = FEED_PROXY();
  if (!proxy) return { url, viaProxy: false };
  return { url: proxy + encodeURIComponent(url), viaProxy: true };
}

function parseRounds(list) {
  return list.map(item => {
    const num = parseInt(item.Number ?? item.number, 10);
    return {
      period: String(item.Period ?? item.period ?? item.issueNumber),
      number: num,
      result: num >= 5 ? "BIG" : "SMALL",
      color: String(item.Color ?? item.color ?? "").toLowerCase()
    };
  });
}

// Walks the mirrors until one answers. The host that worked is remembered and tried
// first next time, so the loop normally costs a single request.
export async function fetchHistory() {
  const order = activeHost
    ? [activeHost, ...MIRROR_HOSTS.filter(h => h !== activeHost)]
    : MIRROR_HOSTS;

  let lastErr = null;

  for (const host of order) {
    const { url, viaProxy } = feedTarget(host);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      state.feed.lastStatus = res.status;
      state.feed.viaProxy = viaProxy;
      state.feed.host = host;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list = json?.data?.list || json?.data || [];
      if (!Array.isArray(list) || !list.length) throw new Error("feed returned no rounds");

      const parsed = parseRounds(list);
      if (activeHost !== host) {
        info(`feed source is now draw.${host}.com${viaProxy ? " (through the relay)" : ""}`);
        activeHost = host;
      }
      state.feed.ok++;
      state.feed.lastOk = Date.now();
      state.feed.lastError = "";
      state.feed.lastRounds = parsed.length;
      return parsed;
    } catch (e) {
      lastErr = e;
      if (activeHost === host) {
        warn(`draw.${host}.com stopped answering (${e.message}) — trying another mirror`);
        activeHost = null;
      }
    }
  }

  state.feed.failed++;
  state.feed.viaProxy = !!FEED_PROXY();
  state.feed.lastError = /aborted|timeout/i.test(lastErr?.message || "")
    ? "timed out after 15s — every mirror was unreachable"
    : `${lastErr?.message || "no mirror answered"} — tried ${order.map(h => `draw.${h}.com`).join(", ")}`;
  throw lastErr || new Error("no mirror returned data");
}

export function mergeHistory(parsed) {
  const byPeriod = new Map();
  for (const r of state.history) byPeriod.set(r.period, r);
  for (const r of parsed) byPeriod.set(r.period, r);          // fresh data wins
  const list = [...byPeriod.values()].sort((a, b) => {
    if (a.period.length !== b.period.length) return b.period.length - a.period.length;
    return a.period < b.period ? 1 : a.period > b.period ? -1 : 0;
  });
  state.history = list.slice(0, HISTORY_MAX);
  persist();
}

// The countdown is measured from the moment we first saw the current period
// rather than from the clock, so it cannot drift with the server's timezone.
export function noteRound(period) {
  if (state.round.period !== period) {
    state.round = { period, startedAt: Date.now() };
  }
}

export function roundStatus() {
  const secondsLeft = state.round.startedAt
    ? Math.max(0, ROUND_SECONDS - Math.floor((Date.now() - state.round.startedAt) / 1000))
    : null;
  return { period: state.round.period, secondsLeft };
}

export function nextPeriod() {
  const newest = state.history[0];
  return newest ? (BigInt(newest.period) + 1n).toString() : null;
}
