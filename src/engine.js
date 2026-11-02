// The prediction engine — four rules, one vote, two target balls.
//
// This is the browser page's rule set moved to the server. The old four-stage
// ladder is gone; the strategy below is the only thing that decides a call now.
//
//  Rule 1 (parity flip):  the gap between the last two draws picks the side. An
//    even gap keeps the newest side, an odd gap flips it.
//  Rule 2 (mean revert):  if the last two draws landed on the same side, keep it;
//    otherwise take the opposite of the newest.
//  Rule 3 (time mix):     the predicted period's last four digits plus the wall
//    clock minute choose a side by parity.
//  Rule 4 (sine wave):    sin(periodSuffix * (newest + 1)) chooses a side.
//
//  The four calls are counted and the majority wins; a 2-2 tie falls to rule 4.
//  Only one ball is shown beside the call: the one on the OPPOSITE side of it, so
//  a SMALL call shows a big ball and a BIG call shows a small one. A result that
//  equals that ball is a JACKPOT.

import { state, persist } from "./store.js";
import { nextPeriod } from "./history.js";

// The feed reports violet balls as combined strings like "green,violet", so match
// on the words. Anything unrecognised falls back to the plain WinGo colour.
export function ballColor(round) {
  const c = String(round?.color || "").toLowerCase();
  if (c.includes("green")) return "green";
  if (c.includes("red")) return "red";
  const n = round ? round.number : 0;
  return n % 2 === 1 ? "green" : "red";
}

export const isViolet = round => !!round && (round.number === 0 || round.number === 5);

// Violet counts as green. Kept because the Telegram module still imports this
// name; the current strategy never calls it.
export function colourFollow(round) {
  if (isViolet(round)) return "green";
  return ballColor(round);
}

// Maps the log wording to the tag used inside a post's PAST RESULTS block.
export function outcomeTag(resultText) {
  if (resultText.includes("JACKPOT")) return "[🎰 JACKPOT]";
  if (resultText.includes("WIN")) return "[✅ WIN]";
  if (resultText.includes("LOSE")) return "[❌ LOSS]";
  return "";
}

export function isColourCall(prediction) {
  return prediction === "GREEN" || prediction === "RED";
}

const sideOf = n => (n >= 5 ? "BIG" : "SMALL");

// The four rules voted into one call, plus the two target balls. Pure logic, so
// the panel or a test can run it on numbers without touching any state.
export function votePrediction(newest, previous, periodSuffix, minute) {
  const gap = Math.abs(newest - previous);

  // rule 1 — parity flip
  const v1 = (gap % 2 === 0)
    ? (newest >= 5 ? "BIG" : "SMALL")
    : (newest >= 5 ? "SMALL" : "BIG");

  // rule 2 — mean reversion
  const lb = sideOf(newest);
  const pb = sideOf(previous);
  const v2 = (lb === pb) ? lb : (lb === "BIG" ? "SMALL" : "BIG");

  // rule 3 — time mix
  const ts = periodSuffix + minute;
  const v3 = (ts % 2 === 0) ? "SMALL" : "BIG";

  // rule 4 — sine wave
  const wv = Math.sin(periodSuffix * (newest + 1));
  const v4 = (wv >= 0) ? "BIG" : "SMALL";

  // majority vote; a 2-2 tie falls to the sine rule
  let bigCount = 0, smallCount = 0;
  for (const v of [v1, v2, v3, v4]) { if (v === "BIG") bigCount++; else smallCount++; }
  const prediction = (bigCount === smallCount) ? v4 : (bigCount > smallCount ? "BIG" : "SMALL");

  // Show only the ball on the opposite side of the call. The same-side ball is
  // dropped, so a SMALL call carries a big ball and a BIG call carries a small one.
  let omni = Math.floor(Math.abs(wv) * 1000) % 10;
  if (prediction === "BIG" && omni < 5) omni += 5;
  if (prediction === "SMALL" && omni >= 5) omni -= 5;
  const numbers = [(omni + 5) % 10];

  return {
    prediction, numbers,
    rules: { v1, v2, v3, v4, bigCount, smallCount, gap, ts, wv }
  };
}

// Works out the next signal. Does not publish anything — the caller decides that.
export function computePrediction() {
  const history = state.history;
  if (history.length < 2) return null;          // needs the last two draws

  const latest = history[0];
  const previous = history[1];
  const period = nextPeriod();
  if (!period) return null;

  const periodSuffix = parseInt(period.slice(-4), 10);
  const { prediction, numbers, rules } =
    votePrediction(latest.number, previous.number, periodSuffix, new Date().getMinutes());

  const detail = {
    mode: "FLOW",
    latestNumber: latest.number,
    latestResult: latest.result,
    topColor: ballColor(latest),
    previousNumber: previous.number,
    periodSuffix,
    prediction,
    numbers,
    consecutiveLosses: state.run.consecutiveLosses,
    rules
  };
  state.lastDetail = detail;
  return { prediction, numbers, detail };
}

const cmpPeriod = (a, b) => {
  const A = BigInt(a), B = BigInt(b);
  return A < B ? -1 : A > B ? 1 : 0;
};

// Settles the signal that was published for the round that has just finished.
// Returns a log entry, or null when this round was not ours to settle.
export function resolvePending(newest) {
  const run = state.run;
  if (!run.predictionForPeriod) return null;

  const cmp = cmpPeriod(newest.period, run.predictionForPeriod);
  if (cmp < 0) return null;                    // the predicted round is still running

  const label = run.prediction + " " + (run.numbers || []).join(",");

  if (cmp > 0) {
    // The round we predicted for never arrived — the process slept, restarted, or the
    // feed jumped past it. Clearing it here matters: a stale period would otherwise
    // block every future signal, which looks exactly like "the engine is not running".
    const entry = {
      period: run.predictionForPeriod, label,
      actualText: "missed", resultText: "⏭️ MISSED", resultClass: "value"
    };
    run.predictionForPeriod = null;
    persist();
    return entry;
  }

  const predicted = run.prediction;            // BIG or SMALL
  const targets = run.numbers || [];
  const actual = newest.result;
  const actualNumber = newest.number;

  let resultText, resultClass;

  if (targets.includes(actualNumber)) {
    // A target ball landed — still a win, counted apart.
    state.stats.jackpots++;
    run.consecutiveLosses = 0;
    resultText = `🎰 JACKPOT ${actualNumber}`;
    resultClass = "big";
  } else if (predicted === actual) {
    state.stats.wins++;
    run.consecutiveLosses = 0;
    resultText = "✅ WIN";
    resultClass = "big";
  } else {
    state.stats.losses++;
    run.consecutiveLosses++;
    resultText = "❌ LOSE";
    resultClass = "small";
  }

  run.mode = "FLOW";                           // the vote has no stages to walk
  run.predictionForPeriod = null;
  persist();

  return {
    period: newest.period,
    label,
    actualText: `${actual} ${actualNumber}`,
    resultText,
    resultClass
  };
}

export function resetStrategy() {
  state.run = {
    mode: "FLOW", consecutiveLosses: 0,
    prediction: null, numbers: [], predictionForPeriod: null
  };
  state.lastDetail = null;
}
