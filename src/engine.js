// 3-Level Martingale (Pure Big / Small Strategy)
// Ported from WinGo Pro Terminal (WinGo_Pro_Terminal.html)
//
// Strategy rules:
// - Anchors to the 10th history record from the top.
// - Sequence level: Level 1 to 3.
// - If round WINS: 1 Skip applied, Session Wins +1.
//   If Session Wins reaches 10: 2 Skips applied and Session Wins resets to 0.
// - If round LOSES: Continues to Level 2 or Level 3 with the same targetType.
// - If 3 consecutive losses: Resets to initial state (fresh 10th record anchor).
// - During SKIP: Output is "SKIP" (pause / cooldown).

import { state, persist } from "./store.js";
import { nextPeriod } from "./history.js";

// Winner color helper
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

// Maps result to tag for Telegram post past results
export function outcomeTag(resultText) {
  if (resultText.includes("JACKPOT")) return "[🎰 JACKPOT]";
  if (resultText.includes("WIN")) return "[✅ WIN]";
  if (resultText.includes("LOSE") || resultText.includes("LOSS")) return "[❌ LOSS]";
  if (resultText.includes("SKIP")) return "[⏳ SKIP]";
  return "";
}

// ==========================================
// 🧠 3-LEVEL MARTINGALE (PURE BIG / SMALL STRATEGY)
// Direct port from WinGo Pro Terminal simulateStrategy()
// ==========================================
export function simulateStrategy(historyList = state.history) {
  if (!historyList || historyList.length < 10) {
    return {
      canPredict: false,
      reason: "Need at least 10 history rounds to calculate.",
      simulatedRecords: [],
      stats: { totalTested: 0, totalWins: 0, totalLosses: 0, l1Wins: 0, l2Wins: 0, l3Wins: 0, winRate: 0 },
      nextLivePrediction: null
    };
  }

  // historyList is newest-first. chronoHistory is oldest-first.
  const chronoHistory = [...historyList].reverse();
  let sessionWins = 0;
  let skipRemaining = 0;
  let targetType = null;
  let currentLevel = 1;
  let anchorItem = null;

  const simulatedRecords = [];
  const stats = {
    totalTested: 0,
    totalWins: 0,
    totalLosses: 0,
    l1Wins: 0,
    l2Wins: 0,
    l3Wins: 0,
    winRate: 0
  };

  for (let i = 10; i < chronoHistory.length; i++) {
    const currentRoundItem = chronoHistory[i];
    const actualNum = parseInt(currentRoundItem.number ?? currentRoundItem.Number, 10);
    const actualType = actualNum >= 5 ? "BIG" : "SMALL";
    const currentPeriod = String(currentRoundItem.period ?? currentRoundItem.issueNumber ?? currentRoundItem.Period);

    const ref10Item = chronoHistory[i - 10];
    const ref10Num = parseInt(ref10Item.number ?? ref10Item.Number, 10);
    const ref10Type = ref10Num >= 5 ? "BIG" : "SMALL";

    if (skipRemaining > 0) {
      simulatedRecords.unshift({
        period: currentPeriod,
        actualNumber: actualNum,
        actualType: actualType,
        predictedType: "SKIP",
        level: 0,
        status: "SKIP",
        sessionWins: sessionWins,
        refPeriod: String(ref10Item.period ?? ref10Item.issueNumber ?? ref10Item.Period),
        refType: ref10Type
      });
      skipRemaining--;
    } else {
      if (!targetType) {
        targetType = ref10Type;
        currentLevel = 1;
        anchorItem = ref10Item;
      }

      const predictedType = targetType;
      const levelUsed = currentLevel;
      const isWin = (actualType === predictedType);

      stats.totalTested++;

      if (isWin) {
        sessionWins++;
        stats.totalWins++;
        if (levelUsed === 1) stats.l1Wins++;
        else if (levelUsed === 2) stats.l2Wins++;
        else if (levelUsed === 3) stats.l3Wins++;

        simulatedRecords.unshift({
          period: currentPeriod,
          actualNumber: actualNum,
          actualType: actualType,
          predictedType: predictedType,
          level: levelUsed,
          status: "WIN",
          sessionWins: sessionWins,
          refPeriod: String(anchorItem ? (anchorItem.period ?? anchorItem.issueNumber ?? anchorItem.Period) : (ref10Item.period ?? ref10Item.issueNumber)),
          refType: predictedType
        });

        if (sessionWins >= 10) {
          skipRemaining = 2; // Skip 2 rounds after 10 wins
          sessionWins = 0;
        } else {
          skipRemaining = 1; // Skip 1 round after 1 win
        }

        targetType = null;
        currentLevel = 1;
        anchorItem = null;
      } else {
        stats.totalLosses++;
        simulatedRecords.unshift({
          period: currentPeriod,
          actualNumber: actualNum,
          actualType: actualType,
          predictedType: predictedType,
          level: levelUsed,
          status: "LOSS",
          sessionWins: sessionWins,
          refPeriod: String(anchorItem ? (anchorItem.period ?? anchorItem.issueNumber ?? anchorItem.Period) : (ref10Item.period ?? ref10Item.issueNumber)),
          refType: predictedType
        });

        if (currentLevel < 3) {
          currentLevel++;
        } else {
          // 3 losses back-to-back: reset to initial state
          targetType = null;
          currentLevel = 1;
          anchorItem = null;
        }
      }
    }
  }

  stats.winRate = stats.totalTested > 0 ? Math.round((stats.totalWins / stats.totalTested) * 100) : 0;

  // Current 10th history record from top (0-indexed: index 9)
  const currentRef10 = historyList[9];
  const currentRef10Num = parseInt(currentRef10.number ?? currentRef10.Number, 10);
  const currentRef10Type = currentRef10Num >= 5 ? "BIG" : "SMALL";
  const currentRef10Period = String(currentRef10.period ?? currentRef10.issueNumber ?? currentRef10.Period);

  let nextLivePrediction = {};

  if (skipRemaining > 0) {
    nextLivePrediction = {
      isSkip: true,
      skipCount: skipRemaining,
      reason: skipRemaining === 2 ? "10 Wins Reached! Skipping 2 Rounds." : "Round Won! Skipping 1 Round.",
      sessionWins: sessionWins,
      level: 0,
      predictedType: "SKIP",
      ref10Period: currentRef10Period,
      ref10Type: currentRef10Type
    };
  } else {
    if (!targetType) {
      targetType = currentRef10Type;
      currentLevel = 1;
      anchorItem = currentRef10;
    }

    const anchorPeriod = String(anchorItem ? (anchorItem.period ?? anchorItem.issueNumber ?? anchorItem.Period) : currentRef10Period);

    nextLivePrediction = {
      isSkip: false,
      skipCount: 0,
      sessionWins: sessionWins,
      level: currentLevel,
      predictedType: targetType,
      anchorPeriod: anchorPeriod,
      anchorType: targetType,
      ref10Period: currentRef10Period,
      ref10Type: currentRef10Type
    };
  }

  return {
    canPredict: true,
    simulatedRecords,
    stats,
    nextLivePrediction
  };
}

// Works out the next signal using the 3-Level Martingale strategy
export function computePrediction() {
  const history = state.history;
  if (!history || history.length < 10) return null;

  const sim = simulateStrategy(history);
  if (!sim.canPredict || !sim.nextLivePrediction) return null;

  if (!state.strategy) {
    state.strategy = {
      level: 1,
      targetType: null,
      anchorPeriod: null,
      anchorType: null,
      skipRemaining: 0,
      sessionWins: 0
    };
  }

  // Current 10th history record from top (0-indexed: index 9)
  const currentRef10 = history[9];
  const currentRef10Num = parseInt(currentRef10.number ?? currentRef10.Number, 10);
  const currentRef10Type = currentRef10Num >= 5 ? "BIG" : "SMALL";
  const currentRef10Period = String(currentRef10.period ?? currentRef10.issueNumber ?? currentRef10.Period);

  // If live strategy has not yet initialized its target or skip, take from sim.nextLivePrediction
  if (!state.strategy.targetType && state.strategy.skipRemaining === 0) {
    if (sim.nextLivePrediction.isSkip) {
      state.strategy.skipRemaining = sim.nextLivePrediction.skipCount || 1;
      state.strategy.sessionWins = sim.nextLivePrediction.sessionWins || 0;
      state.strategy.level = 0;
      state.strategy.targetType = null;
    } else {
      state.strategy.level = sim.nextLivePrediction.level || 1;
      state.strategy.targetType = sim.nextLivePrediction.predictedType || currentRef10Type;
      state.strategy.anchorPeriod = sim.nextLivePrediction.anchorPeriod || currentRef10Period;
      state.strategy.anchorType = sim.nextLivePrediction.anchorType || currentRef10Type;
      state.strategy.sessionWins = sim.nextLivePrediction.sessionWins || 0;
    }
  }

  let prediction, level, isSkip;

  if (state.strategy.skipRemaining > 0) {
    prediction = "SKIP";
    level = 0;
    isSkip = true;
  } else {
    if (!state.strategy.targetType) {
      state.strategy.targetType = currentRef10Type;
      state.strategy.anchorPeriod = currentRef10Period;
      state.strategy.anchorType = currentRef10Type;
      state.strategy.level = 1;
    }
    prediction = state.strategy.targetType;
    level = state.strategy.level;
    isSkip = false;
  }

  const detail = {
    mode: isSkip ? "SKIP" : `LEVEL ${level}`,
    prediction,
    numbers: [],
    isSkip,
    level,
    sessionWins: state.strategy.sessionWins || 0,
    skipCount: state.strategy.skipRemaining || 0,
    anchorPeriod: state.strategy.anchorPeriod || currentRef10Period,
    anchorType: state.strategy.anchorType || currentRef10Type,
    consecutiveLosses: isSkip ? 0 : (level - 1),
    stats: sim.stats
  };
  state.lastDetail = detail;

  // Sync state.stats with simulation stats
  state.stats.wins = sim.stats.totalWins;
  state.stats.losses = sim.stats.totalLosses;
  state.stats.l1Wins = sim.stats.l1Wins;
  state.stats.l2Wins = sim.stats.l2Wins;
  state.stats.l3Wins = sim.stats.l3Wins;
  state.stats.winRate = sim.stats.winRate;
  state.stats.totalTested = sim.stats.totalTested;

  return {
    prediction,
    numbers: [],
    level,
    isSkip,
    sessionWins: state.strategy.sessionWins || 0,
    detail
  };
}

const cmpPeriod = (a, b) => {
  const A = BigInt(a), B = BigInt(b);
  return A < B ? -1 : A > B ? 1 : 0;
};

// Settles the signal that was published for the round that has just finished.
export function resolvePending(newest) {
  const run = state.run;
  if (!run.predictionForPeriod) return null;

  const cmp = cmpPeriod(newest.period, run.predictionForPeriod);
  if (cmp < 0) return null; // the predicted round is still running

  const lvlTag = (run.level && run.level > 0) ? ` (L${run.level})` : "";
  const label = run.prediction === "SKIP" ? "SKIP" : `${run.prediction}${lvlTag}`;

  if (cmp > 0) {
    const entry = {
      period: run.predictionForPeriod,
      label,
      actualText: "missed",
      resultText: "⏭️ MISSED",
      resultClass: "value"
    };
    run.predictionForPeriod = null;
    if (state.strategy) {
      state.strategy.targetType = null;
      state.strategy.level = 1;
      state.strategy.skipRemaining = 0;
    }
    persist();
    return entry;
  }

  const predicted = run.prediction;
  const actual = newest.result;
  const actualNumber = newest.number;

  let resultText, resultClass;

  if (!state.strategy) {
    state.strategy = {
      level: 1,
      targetType: null,
      anchorPeriod: null,
      anchorType: null,
      skipRemaining: 0,
      sessionWins: 0
    };
  }

  if (predicted === "SKIP") {
    resultText = "⏳ SKIP";
    resultClass = "small";
    if (state.strategy.skipRemaining > 0) {
      state.strategy.skipRemaining--;
    }
  } else if (predicted === actual) {
    resultText = "✅ WIN";
    resultClass = "big";
    state.strategy.sessionWins = (state.strategy.sessionWins || 0) + 1;
    if (state.strategy.sessionWins >= 10) {
      state.strategy.skipRemaining = 2; // 2 skips after 10 wins
      state.strategy.sessionWins = 0;
    } else {
      state.strategy.skipRemaining = 1; // 1 skip after each win
    }
    state.strategy.level = 1;
    state.strategy.targetType = null;
    state.strategy.anchorPeriod = null;
    state.strategy.anchorType = null;
  } else {
    resultText = "❌ LOSE";
    resultClass = "small";
    if (state.strategy.level < 3) {
      state.strategy.level++;
      // Same targetType maintained for Martingale progression
    } else {
      // 3 consecutive losses: reset to initial state
      state.strategy.level = 1;
      state.strategy.targetType = null;
      state.strategy.anchorPeriod = null;
      state.strategy.anchorType = null;
      state.strategy.skipRemaining = 0;
    }
  }

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
  state.strategy = {
    level: 1,
    targetType: null,
    anchorPeriod: null,
    anchorType: null,
    skipRemaining: 0,
    sessionWins: 0
  };
  state.run = {
    mode: "LEVEL 1",
    consecutiveLosses: 0,
    prediction: null,
    numbers: [],
    level: 1,
    isSkip: false,
    predictionForPeriod: null
  };
  state.lastDetail = null;
}
