// Boot: restore state, start the control panel, and run the round loop that
// polls the feed, settles the finished round and publishes the next signal.

import { POLL_MS } from "./config.js";
import { state, load, persist, dataFile, initRemoteStore, syncToRemote } from "./store.js";
import { fetchHistory, mergeHistory, noteRound, nextPeriod } from "./history.js";
import { computePrediction, resolvePending, isColourCall } from "./engine.js";
import { broadcast, startListener, syncBotProfile, settleSubscriberWins, checkSubscriberCooldowns, checkDailyResets } from "./telegram.js";
import { startServer } from "./server.js";
import { info, warn, error, log } from "./logger.js";

const LOG_MAX = 6; // 1 pending prediction + 5 completed past results
let busy = false;

const labelFor = (prediction) => {
  return prediction;
};

const trimLog = () => { if (state.log.length > LOG_MAX) state.log.length = LOG_MAX; };

async function tick() {
  if (!state.engine.enabled) return;
  if (busy) return;                       // never let two polls overlap
  busy = true;
  try {
    const parsed = await fetchHistory();
    mergeHistory(parsed);
    state.statLines.polls++;
    if (state.statLines.polls % 150 === 0) syncBotProfile();
    state.lastPoll = Date.now();
    state.lastPollError = "";
    noteRound(parsed[0].period);

    // 1. settle the round that has just finished, if it was ours
    const resolved = resolvePending(state.history[0]);
    if (resolved) {
      const row = state.log.find(e => e.period === resolved.period && e.resultText === "PENDING");
      if (row) { row.actual = resolved.actualText; row.resultText = resolved.resultText; }
      else { state.log.unshift({ period: resolved.period, label: resolved.label, actual: resolved.actualText, resultText: resolved.resultText }); trimLog(); }
      const s = state.stats;
      info(`${resolved.period.slice(-4)} | ${resolved.label.padEnd(14)} | ${resolved.actualText.padEnd(8)} | ${resolved.resultText}   (W${s.wins} L${s.losses} Rate:${s.winRate || 0}%)`);

      // Settle wins and session progression for subscribers who received this prediction
      await settleSubscriberWins(resolved);
    }

    // Check if any subscriber's cooldown has finished
    await checkSubscriberCooldowns();

    // Check if new day has arrived to reset daily wins & move verified users to deposit pending
    checkDailyResets();

    // 2. publish the next signal, once per round
    const calc = computePrediction();
    if (!calc) {
      if (state.statLines.polls % 15 === 1) warn(`waiting for history — only ${state.history.length} round(s) saved so far (need at least 7)`);
    } else if (state.run.predictionForPeriod === null) {
      const period = nextPeriod();
      state.run.prediction = calc.prediction;
      state.run.numbers = calc.numbers || [];
      state.run.level = calc.level;
      state.run.isSkip = calc.isSkip;
      state.run.mode = calc.detail.mode;
      state.run.consecutiveLosses = calc.detail.consecutiveLosses;
      state.run.predictionForPeriod = period;
      const lbl = labelFor(calc.prediction);
      state.log.unshift({ period, label: lbl, actual: "?", resultText: "PENDING" });
      trimLog();
      persist(true);
      info(`published ..${period.slice(-4)} → ${lbl} (${calc.detail.mode})`);
      await broadcast(period, calc.prediction, calc.numbers, calc.level);
    } else {
      persist();
    }
  } catch (e) {
    state.lastPollError = e.message;
    if (state.feed.failed <= 3 || state.feed.failed % 30 === 0) {
      error(`feed failed (#${state.feed.failed}): ${state.feed.lastError || e.message}`);
    }
  } finally {
    busy = false;
  }
}

async function main() {
  const restored = load();
  const remoteRestored = await initRemoteStore();
  if (remoteRestored) {
    info("state synchronized from remote cloud storage (branch: data)");
  } else if (restored) {
    info(`state restored from ${dataFile()}`);
  } else {
    info(`starting fresh — no state file at ${dataFile()}`);
  }
  info(
    `mode ${state.run.mode} · saved history ${state.history.length} round(s) · ` +
    `${state.subs.length} subscriber(s) · engine ${state.engine.enabled ? "ON" : "OFF"}`
  );

  startServer();

  // The subscriber bot polls only while this process lives, so start it whenever a
  // token is already saved.
  if (state.cfg.botToken) setTimeout(startListener, 800);
  // Keep the bot profile's counts fresh (also refreshed whenever they change).
  setTimeout(syncBotProfile, 2500);

  // Gracefully save state before container redeploys/shuts down
  const onExit = async (sig) => {
    info(`received ${sig} — syncing state before shutdown`);
    await syncToRemote(true);
    process.exit(0);
  };
  process.on("SIGTERM", () => onExit("SIGTERM"));
  process.on("SIGINT", () => onExit("SIGINT"));

  await tick();
  setInterval(tick, POLL_MS);
}

main();
