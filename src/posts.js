// Builds the text message that goes out for each prediction round:
// a branding header, a PAST RESULTS list, a NEXT PREDICTION block, and a footer link.

import { PAST_RESULT_LINES, DEFAULT_HEADER } from "./config.js";
import { state } from "./store.js";
import { isColourCall } from "./engine.js";

const formatPeriod = (p) => {
  const s = String(p || "");
  const last5 = s.slice(-5).replace(/^0+/, "");
  return last5 || s.slice(-4);
};

export function buildTargetBox(period, prediction, numbers, level, sessionWins) {
  const p = String(prediction || "").toUpperCase();
  const pDisplay = formatPeriod(period);
  const winCount = (typeof sessionWins === "number") ? sessionWins : 0;

  if (p === "SKIP") {
    return [
      `NEXT PREDICT:- ${pDisplay} :- [ ⏳ SKIP ]`,
      "",
      "STATUS - [ PAUSED / WAIT ]",
      "",
      `TOTAL WINN :- {  ${winCount}  }`
    ].join("\n");
  }

  const lines = [
    `NEXT PREDICT:- ${pDisplay} :- [ ${p} ]`,
    "",
    `TOTAL WINN :- {  ${winCount}  }`
  ];
  return lines.join("\n");
}

export function footerLine() {
  return "";
}

const sideWord = prediction => {
  const p = String(prediction || "").toUpperCase();
  if (p.includes("BIG")) return "BIGGG";
  if (p.includes("SMAL")) return "SMALL";
  return p;
};

const statusWord = resultText => {
  const r = String(resultText || "").toUpperCase();
  if (r.includes("WIN")) return "WINNN";
  if (r.includes("LOSE") || r.includes("LOSS")) return "LOSSS";
  return "";
};

export function pastResultLines(userLog = null) {
  // If userLog is provided as an array, use it (starts at 0 and grows up to 5)
  const source = Array.isArray(userLog) ? userLog : state.log.slice(1);
  const lines = [];
  for (const entry of source) {
    if (lines.length >= PAST_RESULT_LINES) break;
    const status = statusWord(entry.resultText || entry.status || "");
    if (!status) continue;
    const pDisplay = formatPeriod(entry.period);
    const rawLabel = String(entry.label || entry.side || "");
    const parts = rawLabel.split(/\s+/);
    const side = sideWord(parts[0] || "");
    const sp = side === "BIGGG" ? "    " : "   ";
    lines.push(`PEREOD :- ${pDisplay} ${side}${sp}${status}`);
  }
  return lines.reverse();
}

// Builds the complete prediction post text (pure text formatted for Telegram HTML)
export function buildPost(period, prediction, numbers, level, sessionWins, userLog = null) {
  const header = (state.cfg.header || DEFAULT_HEADER).trim();
  const allLines = pastResultLines(userLog);
  const box = buildTargetBox(period, prediction, numbers, level, sessionWins);

  const sections = [];
  if (header) sections.push(header);
  if (allLines.length) sections.push(allLines.join("\n"));
  sections.push(box);

  return `<b>${sections.join("\n\n")}</b>`;
}

// Builds the final completed post when 5 winning shots are achieved
export function buildCompletedPost(sessionWins = 5, userLog = null) {
  const header = (state.cfg.header || DEFAULT_HEADER).trim();
  const allLines = pastResultLines(userLog);
  const winCount = (typeof sessionWins === "number") ? sessionWins : 5;

  const box = [
    `NEXT PREDICT:- COMPLETED :- [ 🎯 ${winCount} WINNING ]`,
    "",
    `TOTAL WINN :- {  ${winCount}  }`
  ].join("\n");

  const sections = [];
  if (header) sections.push(header);
  if (allLines.length) sections.push(allLines.join("\n"));
  sections.push(box);

  return `<b>${sections.join("\n\n")}</b>`;
}

export { isColourCall };
