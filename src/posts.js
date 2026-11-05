// Builds the text message that goes out for each prediction round:
// a branding header, a PAST RESULTS list, a NEXT PREDICTION block, and a footer link.

import { PAST_RESULT_LINES, DEFAULT_HEADER } from "./config.js";
import { state } from "./store.js";
import { isColourCall } from "./engine.js";

export function buildTargetBox(period, prediction, numbers, level, sessionWins) {
  const p = String(prediction || "").toUpperCase();
  const p4 = String(period || "").slice(-4);
  const winCount = (typeof sessionWins === "number") ? sessionWins : 0;
  const headerLine = `🎯 NEXT PREDICTION [ ${winCount} WINNING ] 🎯`;

  if (p === "SKIP") {
    return [
      `        ${headerLine}`,
      "",
      `               ${p4} : [ ⏳ SKIP ]`,
      "               STATUS - [ PAUSED / WAIT ]"
    ].join("\n");
  }

  const lvlPart = (level && level > 0) ? ` [L${level}]` : "";
  let predDisplay = p;
  if (p === "GREEN") predDisplay = "🟢 GREEN";
  else if (p === "RED") predDisplay = "🔴 RED";
  else if (p === "BIG" || p === "SMALL") predDisplay = p;

  const lines = [
    `        ${headerLine}`,
    "",
    `               ${p4} : [ ${predDisplay} ]${lvlPart}`
  ];
  return lines.join("\n");
}

export function footerLine() {
  return "";
}

const sideWord = prediction => {
  const p = String(prediction || "").toUpperCase();
  if (p.startsWith("BIG")) return "BIGG";
  if (p.startsWith("SMAL")) return "SMAL";
  if (p.startsWith("GREE")) return "GREN";
  if (p.startsWith("RED")) return "RED ";
  if (p.startsWith("SKIP")) return "SKIP";
  return p;
};

const statusWord = resultText => {
  if (resultText.includes("JACKPOT")) return "JACK";
  if (resultText.includes("WIN")) return "WINN";
  if (resultText.includes("LOSE") || resultText.includes("LOSS")) return "LOSS";
  if (resultText.includes("SKIP")) return "SKIP";
  return "";
};

function pastResultLines() {
  const lines = [];
  for (const entry of state.log.slice(1)) {
    if (lines.length >= PAST_RESULT_LINES) break;
    const status = statusWord(entry.resultText || "");
    if (!status) continue;
    const p4 = String(entry.period || "").slice(-4);
    const rawLabel = String(entry.label || "");
    const parts = rawLabel.split(/\s+/);
    const side = parts[0] || "";
    const lvlMatch = rawLabel.match(/\(L\d+\)/i);
    const lvlPart = lvlMatch ? `${lvlMatch[0]} ` : "";
    lines.push(`PEREOD :- ${p4} ${sideWord(side)} ${lvlPart}${status}`);
  }
  return lines.reverse();
}

// Builds the complete prediction post text (pure text formatted for Telegram HTML)
export function buildPost(period, prediction, numbers, level, sessionWins) {
  const header = (state.cfg.header || DEFAULT_HEADER).trim();
  const allLines = pastResultLines();
  const box = buildTargetBox(period, prediction, numbers, level, sessionWins);

  const sections = [];
  if (header) sections.push(header);
  if (allLines.length) sections.push(allLines.join("\n"));
  sections.push(box);

  return `<b>${sections.join("\n\n")}</b>`;
}

export { isColourCall };
