// WinGo Adaptive Loss-Progression Prediction Engine
//
// Calculation Flow:
// 1. Initially (or after ANY WIN):
//    Round 1 (0 Losses): Take the TOP (latest) history round.
// 2. If it results in LOSS (1st loss):
//    Round 2 (1 Loss): Take the TOP (latest) history round again.
// 3. If it results in LOSS (2nd loss):
//    Round 3 (2 Losses): Take the number of the top history round, find its 1st past
//    occurrence in history, and take the result of the round directly above it.
// 4. If it results in LOSS (3rd loss):
//    Round 4 (3 Losses): Take the number of the top history round, find its 2nd past
//    occurrence in history (skipping the 1st match), and take the result of the round directly above it.
// 5. If it results in LOSS (4+ losses):
//    Round 5+ (4+ Losses): Take the TOP (latest) history round repeatedly until WIN.
//
// AND ON ANY WIN:
//    Instantly reset consecutiveLosses = 0 and restart flow from Round 1!

import { state, persist } from "./store.js";
import { nextPeriod } from "./history.js";

// Helper (kept for compatibility)
export const invertPrediction = (p) => {
  const s = String(p || "").toUpperCase();
  if (s === "BIG") return "SMALL";
  if (s === "SMALL") return "BIG";
  return s;
};

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
// 🎯 CORE STRATEGY TARGET SELECTOR
// ==========================================
export function getStrategyTarget(historyList, losses = 0) {
  if (!historyList || historyList.length === 0) return null;

  const topRound = historyList[0];
  const topNum = parseInt(topRound.number ?? topRound.Number, 10);

  // Round 1 (losses === 0) & Round 2 (losses === 1): TOP
  if (losses === 0 || losses === 1) {
    const refNum = parseInt(topRound.number ?? topRound.Number, 10);
    const predictedType = (topRound.result || (refNum >= 5 ? "BIG" : "SMALL")).toUpperCase();
    return {
      refRound: topRound,
      predictedType,
      refNumber: refNum,
      mode: `TOP LATEST (Round ${losses + 1}/2)`,
      level: losses + 1,
      targetNumber: null
    };
  }

  // Round 3 (losses === 2): 1st past match of top number -> round above it
  if (losses === 2) {
    let foundIndex = -1;
    for (let i = 1; i < historyList.length; i++) {
      const n = parseInt(historyList[i].number ?? historyList[i].Number, 10);
      if (n === topNum) {
        foundIndex = i;
        break;
      }
    }

    let refRound = topRound;
    let mode = `PAST LOOKUP (1st Match, Round 3)`;
    if (foundIndex > 0) {
      refRound = historyList[foundIndex - 1]; // Round directly above the match in history
    } else {
      mode = `PAST LOOKUP (Fallback Top, Round 3)`;
    }

    const refNum = parseInt(refRound.number ?? refRound.Number, 10);
    const predictedType = (refRound.result || (refNum >= 5 ? "BIG" : "SMALL")).toUpperCase();
    return {
      refRound,
      predictedType,
      refNumber: refNum,
      mode,
      level: 3,
      targetNumber: topNum,
      matchIndex: foundIndex
    };
  }

  // Round 4 (losses === 3): 2nd past match of top number -> round above it
  if (losses === 3) {
    let matchCount = 0;
    let match1Index = -1;
    let match2Index = -1;
    for (let i = 1; i < historyList.length; i++) {
      const n = parseInt(historyList[i].number ?? historyList[i].Number, 10);
      if (n === topNum) {
        matchCount++;
        if (matchCount === 1) match1Index = i;
        else if (matchCount === 2) {
          match2Index = i;
          break;
        }
      }
    }

    let refRound = topRound;
    let mode = `PAST LOOKUP (2nd Match, Round 4)`;
    if (match2Index > 0) {
      refRound = historyList[match2Index - 1]; // Round directly above 2nd match
    } else if (match1Index > 0) {
      refRound = historyList[match1Index - 1];
      mode = `PAST LOOKUP (1st Match Fallback, Round 4)`;
    } else {
      mode = `PAST LOOKUP (Fallback Top, Round 4)`;
    }

    const refNum = parseInt(refRound.number ?? refRound.Number, 10);
    const predictedType = (refRound.result || (refNum >= 5 ? "BIG" : "SMALL")).toUpperCase();
    return {
      refRound,
      predictedType,
      refNumber: refNum,
      mode,
      level: 4,
      targetNumber: topNum,
      matchIndex: match2Index > 0 ? match2Index : match1Index
    };
  }

  // Round 5+ (losses >= 4): TOP repeatedly until win
  const refNum = parseInt(topRound.number ?? topRound.Number, 10);
  const predictedType = (topRound.result || (refNum >= 5 ? "BIG" : "SMALL")).toUpperCase();
  return {
    refRound: topRound,
    predictedType,
    refNumber: refNum,
    mode: `TOP LATEST (Extended, Round ${losses + 1})`,
    level: losses + 1,
    targetNumber: null
  };
}

// ==========================================
// 🧠 HISTORICAL SIMULATION
// ==========================================
export function simulateStrategy(historyList = state.history) {
  if (!historyList || historyList.length < 2) {
    return {
      canPredict: false,
      reason: `Need history rounds to backtest.`,
      simulatedRecords: [],
      stats: { totalTested: 0, totalWins: 0, totalLosses: 0, winRate: 0 },
      nextLivePrediction: null
    };
  }

  // historyList is newest-first. chrono is oldest-first.
  const chrono = [...historyList].reverse();
  const stats = { totalTested: 0, totalWins: 0, totalLosses: 0, winRate: 0 };
  const simulatedRecords = [];
  let simLosses = 0;

  for (let i = 1; i < chrono.length; i++) {
    const currentRound = chrono[i];
    // subHistory contains past rounds prior to currentRound in newest-first order
    const subHistory = chrono.slice(0, i).reverse();
    const target = getStrategyTarget(subHistory, simLosses);
    if (!target || !target.refRound) continue;

    const currentPeriod = String(currentRound.period || currentRound.issueNumber || "");
    const actualNum = parseInt(currentRound.number ?? currentRound.Number, 10);
    const actualType = (currentRound.result || (actualNum >= 5 ? "BIG" : "SMALL")).toUpperCase();
    const predictedType = target.predictedType;

    const isWin = (actualType === predictedType);
    stats.totalTested++;

    if (isWin) {
      stats.totalWins++;
      simLosses = 0;
      simulatedRecords.unshift({
        period: currentPeriod,
        actualNumber: actualNum,
        actualType,
        predictedType,
        level: target.level,
        status: "WIN"
      });
    } else {
      stats.totalLosses++;
      simLosses++;
      simulatedRecords.unshift({
        period: currentPeriod,
        actualNumber: actualNum,
        actualType,
        predictedType,
        level: target.level,
        status: "LOSS"
      });
    }
  }

  stats.winRate = stats.totalTested > 0 ? Math.round((stats.totalWins / stats.totalTested) * 100) : 0;

  const liveLosses = state.run?.consecutiveLosses || 0;
  const liveTarget = getStrategyTarget(historyList, liveLosses);

  let nextLivePrediction = null;
  if (liveTarget && liveTarget.refRound) {
    nextLivePrediction = {
      isSkip: false,
      level: liveTarget.level,
      predictedType: liveTarget.predictedType,
      mode: liveTarget.mode,
      refPeriod: String(liveTarget.refRound.period || liveTarget.refRound.issueNumber || ""),
      refNumber: liveTarget.refNumber,
      targetNumber: liveTarget.targetNumber
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
  if (!state.history || state.history.length === 0) {
    return null; // wait until completed round exists
  }

  const period = nextPeriod(); // Upcoming period
  const losses = state.run.consecutiveLosses || 0;

  const target = getStrategyTarget(state.history, losses);
  if (!target || !target.refRound) return null;

  const prediction = target.predictedType;

  const sim = simulateStrategy(state.history);
  if (sim && sim.stats) {
    state.stats.wins = sim.stats.totalWins;
    state.stats.losses = sim.stats.totalLosses;
    state.stats.winRate = sim.stats.winRate;
    state.stats.totalTested = sim.stats.totalTested;
  }

  const detail = {
    mode: target.mode,
    prediction,
    numbers: [],
    level: target.level,
    isSkip: false,
    refPeriod: String(target.refRound.period || target.refRound.issueNumber || ""),
    refNumber: target.refNumber,
    refType: prediction,
    consecutiveLosses: losses,
    targetNumber: target.targetNumber,
    stats: sim ? sim.stats : state.stats
  };
  state.lastDetail = detail;

  return {
    prediction,
    numbers: [],
    level: target.level,
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
    run.consecutiveLosses = 0; // On ANY win, reset immediately back to TOP!
  } else {
    state.stats.losses++;
    run.consecutiveLosses = (run.consecutiveLosses || 0) + 1;
  }

  // Clear any skipRemaining so rounds run continuously
  state.strategy.skipRemaining = 0;

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
  state.strategy.skipRemaining = 0;
  state.run = {
    mode: "TOP LATEST (Round 1/2)",
    consecutiveLosses: 0,
    prediction: null,
    numbers: [],
    level: 1,
    isSkip: false,
    predictionForPeriod: null
  };
  state.stats = { wins: 0, jackpots: 0, losses: 0, l1Wins: 0, l2Wins: 0, l3Wins: 0, winRate: 0, totalTested: 0 };
  state.lastDetail = null;
}
