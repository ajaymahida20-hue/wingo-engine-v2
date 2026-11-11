// WinGo Top/Bottom Loss-Alternating Prediction Engine
//
// Calculation Rule:
// 1. Initially (or after ANY WIN):
//    Take the TOP (latest) history round (e.g. if predicting 213, take 212).
// 2. If it results in LOSS (1st loss):
//    Take the TOP (latest) history round again (2nd try of top).
// 3. If it results in LOSS (2nd loss):
//    Take the BOTTOM 10th history round from the first page (index 9).
// 4. If it results in LOSS (3rd loss):
//    Take the BOTTOM 10th history round again (2nd try of bottom).
// 5. If it results in LOSS (4th loss):
//    Switch back to TOP (latest) history round.
// Pattern on consecutive losses:
//    2 times TOP -> 2 times BOTTOM -> 2 times TOP -> 2 times BOTTOM...
// AND ON ANY WIN:
//    Instantly reset back to TOP (latest) history round!

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
    const step = simLosses % 4;
    const isTop = (step === 0 || step === 1);

    let refRound;
    if (isTop) {
      refRound = chrono[i - 1]; // Previous round (Top)
    } else {
      const bottomIdx = Math.max(0, i - 10);
      refRound = chrono[bottomIdx]; // 10 rounds back (Bottom)
    }

    if (!refRound) continue;

    const currentPeriod = String(currentRound.period || currentRound.issueNumber || "");
    const actualNum = parseInt(currentRound.number ?? currentRound.Number, 10);
    const actualType = currentRound.result || (actualNum >= 5 ? "BIG" : "SMALL");

    const refNum = parseInt(refRound.number ?? refRound.Number, 10);
    const predictedType = (refRound.result || (refNum >= 5 ? "BIG" : "SMALL")).toUpperCase();

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
        level: step + 1,
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
        level: step + 1,
        status: "LOSS"
      });
    }
  }

  stats.winRate = stats.totalTested > 0 ? Math.round((stats.totalWins / stats.totalTested) * 100) : 0;

  const liveLosses = state.run?.consecutiveLosses || 0;
  const liveStep = liveLosses % 4;
  const liveIsTop = (liveStep === 0 || liveStep === 1);
  const liveRef = liveIsTop ? historyList[0] : historyList[Math.min(historyList.length - 1, 9)];

  let nextLivePrediction = null;
  if (liveRef) {
    const rNum = parseInt(liveRef.number ?? liveRef.Number, 10);
    const pType = (liveRef.result || (rNum >= 5 ? "BIG" : "SMALL")).toUpperCase();
    nextLivePrediction = {
      isSkip: false,
      level: liveStep + 1,
      predictedType: pType,
      mode: liveIsTop ? `TOP (LATEST, Round ${liveStep + 1}/2)` : `BOTTOM (10TH, Round ${liveStep - 1}/2)`,
      refPeriod: String(liveRef.period || liveRef.issueNumber || ""),
      refNumber: rNum
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
  const step = losses % 4;
  const isTop = (step === 0 || step === 1);

  // If top: history[0] (latest history)
  // If bottom: 10th history (history[9], or oldest available if fewer than 10)
  const refIndex = isTop ? 0 : Math.min(state.history.length - 1, 9);
  const refRound = state.history[refIndex];
  if (!refRound) return null;

  const refNum = parseInt(refRound.number ?? refRound.Number, 10);
  const prediction = (refRound.result || (refNum >= 5 ? "BIG" : "SMALL")).toUpperCase();

  const sim = simulateStrategy(state.history);
  if (sim && sim.stats) {
    state.stats.wins = sim.stats.totalWins;
    state.stats.losses = sim.stats.totalLosses;
    state.stats.winRate = sim.stats.winRate;
    state.stats.totalTested = sim.stats.totalTested;
  }

  const modeName = isTop
    ? `TOP LATEST (${step + 1}/2)`
    : `BOTTOM 10TH (${step - 1}/2)`;

  const detail = {
    mode: modeName,
    prediction,
    numbers: [],
    level: step + 1,
    isSkip: false,
    refPeriod: String(refRound.period || refRound.issueNumber || ""),
    refNumber: refNum,
    refType: prediction,
    consecutiveLosses: losses,
    stats: sim ? sim.stats : state.stats
  };
  state.lastDetail = detail;

  return {
    prediction,
    numbers: [],
    level: step + 1,
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
    mode: "TOP LATEST (1/2)",
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
