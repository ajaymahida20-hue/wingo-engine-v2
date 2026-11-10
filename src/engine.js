// WinGo 7-Period Lookback Prediction Engine
//
// Calculation Rule:
// For the current prediction period P (e.g. 213), look 7 periods behind: P - 7 (e.g. 206).
// If round (P - 7) was BIG (number 5-9) -> predict BIG.
// If round (P - 7) was SMALL (number 0-4) -> predict SMALL.
// No numbers, no colors, no multi-level jumps/skips, no shadow mode.
// Pure BIG / SMALL prediction.

import { state, persist } from "./store.js";
import { nextPeriod } from "./history.js";

// Winner color helper (kept for compatibility)
export function ballColor(round) {
  const c = String(round?.color || "").toLowerCase();
  if (c.includes("green")) return "green";
  if (c.includes("red")) return "red";
  const n = round ? (round.number ?? 0) : 0;
  return n % 2 === 1 ? "green" : "red";
}

export const isViolet = round => !!round && (round.number === 0 || round.number === 5);
export const isColourCall = () => false;
export const colourFollow = round => ballColor(round);

export function outcomeTag(resultText) {
  if (resultText.includes("JACKPOT")) return "[🎰 JACKPOT]";
  if (resultText.includes("WIN")) return "[✅ WIN]";
  if (resultText.includes("LOSE") || resultText.includes("LOSS")) return "[❌ LOSS]";
  if (resultText.includes("SKIP")) return "[⏳ SKIP]";
  return "";
}

// ==========================================
// 🧠 HISTORICAL SIMULATION (7-Period Lookback)
// ==========================================
export function simulateStrategy(historyList = state.history) {
  if (!historyList || historyList.length < 8) {
    return {
      canPredict: false,
      reason: `Need at least 8 history rounds to backtest (have ${historyList ? historyList.length : 0}).`,
      simulatedRecords: [],
      stats: { totalTested: 0, totalWins: 0, totalLosses: 0, l1Wins: 0, l2Wins: 0, l3Wins: 0, l4Wins: 0, winRate: 0 },
      nextLivePrediction: null
    };
  }

  // historyList is newest-first. chrono is oldest-first.
  const chrono = [...historyList].reverse();
  const stats = { totalTested: 0, totalWins: 0, totalLosses: 0, l1Wins: 0, l2Wins: 0, l3Wins: 0, l4Wins: 0, winRate: 0 };
  const simulatedRecords = [];

  for (let i = 7; i < chrono.length; i++) {
    const currentRound = chrono[i];
    const refRound = chrono[i - 7];

    const currentPeriod = String(currentRound.period || currentRound.issueNumber || "");
    const actualNum = parseInt(currentRound.number ?? currentRound.Number, 10);
    const actualType = currentRound.result || (actualNum >= 5 ? "BIG" : "SMALL");

    const refNum = parseInt(refRound.number ?? refRound.Number, 10);
    const predictedType = refRound.result || (refNum >= 5 ? "BIG" : "SMALL");

    const isWin = (actualType === predictedType);
    stats.totalTested++;

    if (isWin) {
      stats.totalWins++;
      simulatedRecords.unshift({
        period: currentPeriod,
        actualNumber: actualNum,
        actualType,
        predictedType,
        level: 0,
        status: "WIN"
      });
    } else {
      stats.totalLosses++;
      simulatedRecords.unshift({
        period: currentPeriod,
        actualNumber: actualNum,
        actualType,
        predictedType,
        level: 0,
        status: "LOSS"
      });
    }
  }

  stats.winRate = stats.totalTested > 0 ? Math.round((stats.totalWins / stats.totalTested) * 100) : 0;

  // Next live prediction from history:
  // Upcoming period is P. History has [P-1 (idx 0), P-2 (idx 1) ... P-7 (idx 6)]
  const refRoundForLive = historyList[6];
  let nextLivePrediction = null;
  if (refRoundForLive) {
    const refNum = parseInt(refRoundForLive.number ?? refRoundForLive.Number, 10);
    const pred = (refRoundForLive.result || (refNum >= 5 ? "BIG" : "SMALL")).toUpperCase();
    nextLivePrediction = {
      isSkip: false,
      skipCount: 0,
      level: 0,
      predictedType: pred,
      isShadow: false,
      mode: "7-PERIOD LOOKBACK",
      refPeriod: String(refRoundForLive.period || refRoundForLive.issueNumber || ""),
      refNumber: refNum
    };
  }

  return {
    canPredict: !!nextLivePrediction,
    reason: "",
    simulatedRecords: simulatedRecords.slice(0, 30),
    stats,
    nextLivePrediction
  };
}

// ==========================================
// 🔮 COMPUTE NEXT PREDICTION
// ==========================================
export function computePrediction() {
  if (!state.history || state.history.length < 7) {
    return null; // wait until at least 7 completed rounds exist
  }

  const period = nextPeriod(); // Upcoming period P (e.g. 213)
  
  // Find round 7 periods back (P - 7, e.g. 206)
  let refRound = null;
  try {
    const targetPeriod = BigInt(period) - 7n;
    refRound = state.history.find(h => BigInt(h.period || h.issueNumber) === targetPeriod);
  } catch (e) {}

  // Fallback to the 7th item in history (index 6, where index 0 is P-1)
  if (!refRound) {
    refRound = state.history[6];
  }

  if (!refRound) return null;

  const refNum = parseInt(refRound.number ?? refRound.Number, 10);
  const refType = (refRound.result || (refNum >= 5 ? "BIG" : "SMALL")).toUpperCase();

  const prediction = refType; // "BIG" or "SMALL"

  const sim = simulateStrategy(state.history);
  if (sim && sim.stats) {
    state.stats.wins = sim.stats.totalWins;
    state.stats.losses = sim.stats.totalLosses;
    state.stats.winRate = sim.stats.winRate;
    state.stats.totalTested = sim.stats.totalTested;
  }

  const detail = {
    mode: "7-PERIOD LOOKBACK",
    prediction,
    numbers: [],
    level: 0,
    isSkip: false,
    refPeriod: String(refRound.period || refRound.issueNumber || ""),
    refNumber: refNum,
    refType,
    stats: sim ? sim.stats : state.stats
  };
  state.lastDetail = detail;

  return {
    prediction,
    numbers: [],
    level: 0,
    isSkip: false,
    detail
  };
}

const cmpPeriod = (a, b) => {
  const A = BigInt(a), B = BigInt(b);
  return A < B ? -1 : A > B ? 1 : 0;
};

// ==========================================
// 🎯 ROUND SETTLEMENT
// ==========================================
export function resolvePending(newest) {
  const run = state.run;
  if (!run.predictionForPeriod) return null;

  const cmp = cmpPeriod(newest.period, run.predictionForPeriod);
  if (cmp < 0) return null; // the predicted round is still running

  const label = run.prediction;

  if (cmp > 0) {
    const entry = {
      period: run.predictionForPeriod,
      label,
      actualText: "missed",
      resultText: "⏭️ MISSED",
      resultClass: "value"
    };
    run.predictionForPeriod = null;
    persist();
    return entry;
  }

  const predicted = run.prediction;
  const actualNum = parseInt(newest.number ?? newest.Number, 10);
  const actualResult = (newest.result || (actualNum >= 5 ? "BIG" : "SMALL")).toUpperCase();

  const isWin = (predicted === actualResult);
  const resultText = isWin ? "✅ WIN" : "❌ LOSS";
  const resultClass = isWin ? "big" : "small";

  if (isWin) {
    state.stats.wins++;
    run.consecutiveLosses = 0;
  } else {
    state.stats.losses++;
    run.consecutiveLosses = (run.consecutiveLosses || 0) + 1;
  }

  const total = state.stats.wins + state.stats.losses;
  state.stats.winRate = total > 0 ? Math.round((state.stats.wins / total) * 100) : 0;
  state.stats.totalTested = total;

  run.predictionForPeriod = null;
  persist();

  return {
    period: newest.period,
    label,
    actualText: `${actualResult} (${actualNum})`,
    resultText,
    resultClass
  };
}

export function resetStrategy() {
  state.run = {
    mode: "7-PERIOD LOOKBACK",
    consecutiveLosses: 0,
    prediction: null,
    numbers: [],
    level: 0,
    isSkip: false,
    predictionForPeriod: null
  };
  state.stats = { wins: 0, jackpots: 0, losses: 0, l1Wins: 0, l2Wins: 0, l3Wins: 0, winRate: 0, totalTested: 0 };
  state.lastDetail = null;
}
