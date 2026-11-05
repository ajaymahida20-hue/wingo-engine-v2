// WinGo Dynamic Pattern Engine (Color & Big/Small Pattern Follower)
//
// New Strategy Rules:
// 1. Level 1: Find previous occurrence of latest number (history[0].number) in past history.
//    Look at the round above it (immediately after it). Predict its COLOR (GREEN or RED).
// 2. If it WINS: Apply 2 Skips (skip 2 rounds).
//    After 2 Skips, repeat Level 1 (search recent history, take COLOR of round above it).
// 3. If Level 1 LOSES:
//    Advance to Level 2. Look at latest number (history[0].number), find its previous occurrence,
//    look at the round above it. Take the OPPOSITE of its Big/Small (if Small -> Big, if Big -> Small).
// 4. If Level 2 / Level 3 LOSES:
//    Continue to Level 3 / Level 4, each time taking the OPPOSITE of Big/Small of the round above the previous occurrence.
// 5. When ANY level WINS:
//    Apply 2 Skips, reset to Level 1, resume prediction with COLOR.
// 6. If 4 consecutive losses occur (Level 4 loses):
//    Enter SHADOW MODE. Publicly broadcast "SKIP" on all rounds, but internally calculate
//    and track virtual predictions until a virtual win occurs. Once a virtual win occurs,
//    exit shadow mode, apply 2 skips, and resume live predictions at Level 1!

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
export const isColourCall = () => state.strategy?.level === 1;
export const colourFollow = round => ballColor(round);

// Maps result to tag for Telegram post past results
export function outcomeTag(resultText) {
  if (resultText.includes("JACKPOT")) return "[🎰 JACKPOT]";
  if (resultText.includes("WIN")) return "[✅ WIN]";
  if (resultText.includes("LOSE") || resultText.includes("LOSS")) return "[❌ LOSS]";
  if (resultText.includes("SKIP")) return "[⏳ SKIP]";
  return "";
}

// Searches past history (historyList[1...]) to find the most recent previous appearance of targetNumber
// Returns the occurrence round and the round above it (historyList[i - 1])
export function findPreviousNumberOccurrence(targetNumber, historyList = state.history) {
  if (!historyList || historyList.length < 2) return null;
  for (let i = 1; i < historyList.length; i++) {
    const item = historyList[i];
    const num = parseInt(item.number ?? item.Number, 10);
    if (num === targetNumber) {
      return {
        occurrenceIndex: i,
        occurrenceRound: item,
        aboveRound: historyList[i - 1]
      };
    }
  }
  return null;
}

function ensureStrategyState() {
  if (!state.strategy || typeof state.strategy !== "object") {
    state.strategy = {
      level: 1,
      mode: "COLOR",
      consecutiveLosses: 0,
      skipRemaining: 0,
      shadowMode: false,
      shadowPrediction: null,
      targetNumber: null,
      refPeriod: null,
      refNumber: null
    };
  }
}

// ==========================================
// 🧠 HISTORICAL SIMULATION (Backtests the new strategy over history)
// ==========================================
export function simulateStrategy(historyList = state.history) {
  if (!historyList || historyList.length < 2) {
    return {
      canPredict: false,
      reason: "Need at least 2 history rounds to calculate.",
      simulatedRecords: [],
      stats: { totalTested: 0, totalWins: 0, totalLosses: 0, l1Wins: 0, l2Wins: 0, l3Wins: 0, l4Wins: 0, winRate: 0 },
      nextLivePrediction: null
    };
  }

  // historyList is newest-first. chronoHistory is oldest-first.
  const chronoHistory = [...historyList].reverse();
  let level = 1;
  let consecutiveLosses = 0;
  let skipRemaining = 0;
  let shadowMode = false;
  let shadowPrediction = null;

  const simulatedRecords = [];
  const stats = {
    totalTested: 0,
    totalWins: 0,
    totalLosses: 0,
    l1Wins: 0,
    l2Wins: 0,
    l3Wins: 0,
    l4Wins: 0,
    skips: 0,
    winRate: 0
  };

  // Backtest from index 2 onwards
  for (let i = 2; i < chronoHistory.length; i++) {
    const currentRound = chronoHistory[i];
    const actualNum = parseInt(currentRound.number ?? currentRound.Number, 10);
    const actualType = actualNum >= 5 ? "BIG" : "SMALL";
    const actualColor = ballColor(currentRound);
    const currentPeriod = String(currentRound.period ?? currentRound.issueNumber ?? currentRound.Period);

    // Look at previous completed round: chronoHistory[i - 1]
    const prevRound = chronoHistory[i - 1];
    const targetNum = parseInt(prevRound.number ?? prevRound.Number, 10);

    // Find previous occurrence of targetNum in chronoHistory[0 ... i - 2]
    let refRound = null;
    for (let k = i - 2; k >= 0; k--) {
      const pastNum = parseInt(chronoHistory[k].number ?? chronoHistory[k].Number, 10);
      if (pastNum === targetNum) {
        refRound = chronoHistory[k + 1]; // Round immediately after that occurrence (above it in list)
        break;
      }
    }

    if (!refRound) {
      // If not found in current history: rule is to show SKIP
      simulatedRecords.unshift({
        period: currentPeriod,
        actualNumber: actualNum,
        actualType: actualType,
        actualColor,
        predictedType: "SKIP",
        level: 0,
        status: "SKIP"
      });
      stats.skips++;
      continue;
    }

    const refColor = ballColor(refRound).toUpperCase();
    const refNum = parseInt(refRound.number ?? refRound.Number, 10);
    const refType = refNum >= 5 ? "BIG" : "SMALL";
    const refOppositeType = refType === "BIG" ? "SMALL" : "BIG";

    if (skipRemaining > 0) {
      simulatedRecords.unshift({
        period: currentPeriod,
        actualNumber: actualNum,
        actualType: actualType,
        actualColor,
        predictedType: "SKIP",
        level: 0,
        status: "SKIP"
      });
      stats.skips++;
      skipRemaining--;
    } else if (shadowMode) {
      // In shadow mode: internally evaluate opposite of Big/Small
      const shadowWon = (shadowPrediction === "BIG" && actualNum >= 5) ||
                        (shadowPrediction === "SMALL" && actualNum < 5);
      simulatedRecords.unshift({
        period: currentPeriod,
        actualNumber: actualNum,
        actualType: actualType,
        actualColor,
        predictedType: "SKIP",
        level: 0,
        status: shadowWon ? "VIRTUAL_WIN" : "SHADOW"
      });
      stats.skips++;
      if (shadowWon) {
        shadowMode = false;
        consecutiveLosses = 0;
        level = 1;
        skipRemaining = 2;
      } else {
        consecutiveLosses++;
        shadowPrediction = refOppositeType;
      }
    } else {
      let predictedType = "";
      let isWin = false;

      if (level === 1) {
        predictedType = refColor; // "GREEN" or "RED"
        isWin = (refColor === "GREEN")
          ? (actualColor === "green" || [1, 3, 5, 7, 9].includes(actualNum))
          : (actualColor === "red" || [0, 2, 4, 6, 8].includes(actualNum));
      } else {
        predictedType = refOppositeType; // "BIG" or "SMALL"
        isWin = (actualType === predictedType);
      }

      stats.totalTested++;

      if (isWin) {
        stats.totalWins++;
        if (level === 1) stats.l1Wins++;
        else if (level === 2) stats.l2Wins++;
        else if (level === 3) stats.l3Wins++;
        else if (level === 4) stats.l4Wins++;

        simulatedRecords.unshift({
          period: currentPeriod,
          actualNumber: actualNum,
          actualType: actualType,
          actualColor,
          predictedType,
          level,
          status: "WIN"
        });

        consecutiveLosses = 0;
        level = 1;
        skipRemaining = 2; // 2 skips after win
        shadowMode = false;
      } else {
        stats.totalLosses++;
        consecutiveLosses++;

        simulatedRecords.unshift({
          period: currentPeriod,
          actualNumber: actualNum,
          actualType: actualType,
          actualColor,
          predictedType,
          level,
          status: "LOSS"
        });

        // Advance level to whatever it reaches (L1 -> L2 -> L3 -> L4 -> L5 ...)
        level = consecutiveLosses + 1;
      }
    }
  }

  stats.winRate = stats.totalTested > 0 ? Math.round((stats.totalWins / stats.totalTested) * 100) : 0;

  // Next live prediction from simulation state
  const topRound = historyList[0];
  const topNum = parseInt(topRound.number ?? topRound.Number, 10);
  const found = findPreviousNumberOccurrence(topNum, historyList);

  let nextLivePrediction = {};

  if (!found) {
    // Number not found in available history -> rule is to show SKIP
    nextLivePrediction = {
      isSkip: true,
      skipCount: 0,
      reason: `Number ${topNum} not found in available history. Paused / waiting.`,
      level: 0,
      predictedType: "SKIP",
      isShadow: false
    };
  } else {
    const refRound = found.aboveRound;
    const refColor = ballColor(refRound).toUpperCase();
    const refNum = parseInt(refRound.number ?? refRound.Number, 10);
    const refType = refNum >= 5 ? "BIG" : "SMALL";
    const refOppositeType = refType === "BIG" ? "SMALL" : "BIG";

    if (skipRemaining > 0) {
      nextLivePrediction = {
        isSkip: true,
        skipCount: skipRemaining,
        reason: `Round Won! Skipping 2 rounds (${skipRemaining} left).`,
        level: 0,
        predictedType: "SKIP",
        isShadow: false
      };
    } else if (shadowMode) {
      nextLivePrediction = {
        isSkip: true,
        skipCount: 0,
        reason: "4 Losses Reached. Pausing (Shadow Mode until virtual win).",
        level: 0,
        predictedType: "SKIP",
        isShadow: true,
        shadowPrediction: refOppositeType
      };
    } else if (level === 1) {
      nextLivePrediction = {
        isSkip: false,
        skipCount: 0,
        level: 1,
        predictedType: refColor,
        isShadow: false,
        mode: "COLOR",
        refPeriod: String(refRound.period || refRound.issueNumber || ""),
        refNumber: refNum,
        refColor
      };
    } else {
      nextLivePrediction = {
        isSkip: false,
        skipCount: 0,
        level,
        predictedType: refOppositeType,
        isShadow: false,
        mode: `LEVEL ${level}`,
        refPeriod: String(refRound.period || refRound.issueNumber || ""),
        refNumber: refNum,
        refType,
        refOppositeType
      };
    }
  }

  return {
    canPredict: true,
    simulatedRecords,
    stats,
    nextLivePrediction
  };
}

// ==========================================
// ⚡ LIVE SIGNAL GENERATOR
// ==========================================
export function computePrediction() {
  const history = state.history;
  if (!history || history.length < 2) return null;

  ensureStrategyState();
  const strat = state.strategy;

  // Run simulation over history for stats, win rate & UI breakdown
  const sim = simulateStrategy(history);

  const topRound = history[0];
  const topNum = parseInt(topRound.number ?? topRound.Number, 10);
  const found = findPreviousNumberOccurrence(topNum, history);

  // 1. If currently in normal SKIP rounds (after win)
  if (strat.skipRemaining > 0) {
    const detail = {
      mode: "SKIP",
      prediction: "SKIP",
      numbers: [],
      isSkip: true,
      level: 0,
      skipCount: strat.skipRemaining,
      consecutiveLosses: strat.consecutiveLosses,
      targetNumber: topNum,
      stats: sim.stats
    };
    state.lastDetail = detail;

    // Sync stats
    state.stats.wins = sim.stats.totalWins;
    state.stats.losses = sim.stats.totalLosses;
    state.stats.l1Wins = sim.stats.l1Wins;
    state.stats.l2Wins = sim.stats.l2Wins;
    state.stats.l3Wins = sim.stats.l3Wins;
    state.stats.winRate = sim.stats.winRate;
    state.stats.totalTested = sim.stats.totalTested;

    return {
      prediction: "SKIP",
      numbers: [],
      level: 0,
      isSkip: true,
      detail
    };
  }

  // 2. If the number is NOT found in current history -> SHOW SKIP as requested!
  if (!found) {
    const detail = {
      mode: "SKIP (NOT_FOUND)",
      prediction: "SKIP",
      numbers: [],
      isSkip: true,
      level: 0,
      reason: `Number ${topNum} not found in available ${history.length} history rounds. Paused / waiting.`,
      targetNumber: topNum,
      consecutiveLosses: strat.consecutiveLosses,
      stats: sim.stats
    };
    state.lastDetail = detail;

    // Sync stats
    state.stats.wins = sim.stats.totalWins;
    state.stats.losses = sim.stats.totalLosses;
    state.stats.l1Wins = sim.stats.l1Wins;
    state.stats.l2Wins = sim.stats.l2Wins;
    state.stats.l3Wins = sim.stats.l3Wins;
    state.stats.winRate = sim.stats.winRate;
    state.stats.totalTested = sim.stats.totalTested;

    return {
      prediction: "SKIP",
      numbers: [],
      level: 0,
      isSkip: true,
      detail
    };
  }

  const refRound = found.aboveRound;
  const refColor = ballColor(refRound).toUpperCase();
  const refNum = parseInt(refRound.number ?? refRound.Number, 10);
  const refType = refNum >= 5 ? "BIG" : "SMALL";
  const refOppositeType = refType === "BIG" ? "SMALL" : "BIG";

  // 2. If in SHADOW mode (4 consecutive losses)
  if (strat.shadowMode) {
    strat.shadowPrediction = refOppositeType;

    const detail = {
      mode: "SKIP (SHADOW)",
      prediction: "SKIP",
      numbers: [],
      isSkip: true,
      level: 0,
      isShadow: true,
      shadowPrediction: refOppositeType,
      consecutiveLosses: strat.consecutiveLosses,
      refPeriod: String(refRound.period || refRound.issueNumber || ""),
      refNumber: refNum,
      targetNumber: topNum,
      stats: sim.stats
    };
    state.lastDetail = detail;

    state.stats.wins = sim.stats.totalWins;
    state.stats.losses = sim.stats.totalLosses;
    state.stats.winRate = sim.stats.winRate;

    return {
      prediction: "SKIP",
      numbers: [],
      level: 0,
      isSkip: true,
      detail
    };
  }

  // 3. Normal Active Prediction
  let prediction, numbers = [], level;

  if (strat.level === 1) {
    // Level 1: Predict the COLOR of refRound
    prediction = refColor; // "GREEN" or "RED"
    numbers = [];
    level = 1;
    strat.mode = "COLOR";
  } else {
    // Level 2, 3, 4, 5...: Predict OPPOSITE of Big/Small of refRound
    prediction = refOppositeType; // "BIG" or "SMALL"
    numbers = [];
    level = strat.level;
    strat.mode = `LEVEL ${level}`;
  }

  strat.currentPrediction = prediction;
  strat.currentLevel = level;

  const detail = {
    mode: strat.mode,
    prediction,
    numbers,
    isSkip: false,
    level,
    consecutiveLosses: strat.consecutiveLosses,
    refPeriod: String(refRound.period || refRound.issueNumber || ""),
    refNumber: refNum,
    refType,
    refColor,
    targetNumber: topNum,
    stats: sim.stats
  };
  state.lastDetail = detail;

  state.stats.wins = sim.stats.totalWins;
  state.stats.losses = sim.stats.totalLosses;
  state.stats.l1Wins = sim.stats.l1Wins;
  state.stats.l2Wins = sim.stats.l2Wins;
  state.stats.l3Wins = sim.stats.l3Wins;
  state.stats.winRate = sim.stats.winRate;
  state.stats.totalTested = sim.stats.totalTested;

  return {
    prediction,
    numbers,
    level,
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

  ensureStrategyState();
  const strat = state.strategy;

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
    persist();
    return entry;
  }

  const predicted = run.prediction;
  const actualNum = newest.number;
  const actualResult = newest.result; // "BIG" or "SMALL"
  const actualColor = ballColor(newest); // "green" or "red"

  let resultText, resultClass;

  if (predicted === "SKIP") {
    // Check if we were in shadow mode
    if (strat.shadowMode && strat.shadowPrediction) {
      const shadowWon = (strat.shadowPrediction === "BIG" && actualNum >= 5) ||
                        (strat.shadowPrediction === "SMALL" && actualNum < 5);
      if (shadowWon) {
        // Virtual win achieved!
        strat.shadowMode = false;
        strat.consecutiveLosses = 0;
        strat.level = 1;
        strat.skipRemaining = 2; // 2 skips after win as per rules
        resultText = "⏳ SKIP (VIRTUAL WIN)";
      } else {
        strat.consecutiveLosses++;
        resultText = "⏳ SKIP";
      }
    } else {
      if (strat.skipRemaining > 0) strat.skipRemaining--;
      resultText = "⏳ SKIP";
    }
    resultClass = "small";
  } else {
    // Active prediction: evaluate win/loss
    let isWin = false;
    if (predicted === "GREEN") {
      isWin = actualColor === "green" || [1, 3, 5, 7, 9].includes(actualNum);
    } else if (predicted === "RED") {
      isWin = actualColor === "red" || [0, 2, 4, 6, 8].includes(actualNum);
    } else if (predicted === "BIG") {
      isWin = actualResult === "BIG" || actualNum >= 5;
    } else if (predicted === "SMALL") {
      isWin = actualResult === "SMALL" || actualNum < 5;
    }

    if (isWin) {
      resultText = "✅ WIN";
      resultClass = "big";
      state.stats.wins++;
      strat.consecutiveLosses = 0;
      strat.level = 1;
      strat.skipRemaining = 2; // 2 skips after win
      strat.shadowMode = false;
    } else {
      resultText = "❌ LOSE";
      resultClass = "small";
      state.stats.losses++;
      strat.consecutiveLosses++;

      // Advance level to whatever it reaches (L1 -> L2 -> L3 -> L4 -> L5 ...)
      strat.level = strat.consecutiveLosses + 1;
      strat.shadowMode = false;
    }
  }

  run.predictionForPeriod = null;
  persist();

  return {
    period: newest.period,
    label,
    actualText: `${actualResult} ${actualNum} (${actualColor})`,
    resultText,
    resultClass
  };
}

export function resetStrategy() {
  state.strategy = {
    level: 1,
    mode: "COLOR",
    consecutiveLosses: 0,
    skipRemaining: 0,
    shadowMode: false,
    shadowPrediction: null,
    targetNumber: null,
    refPeriod: null,
    refNumber: null
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
