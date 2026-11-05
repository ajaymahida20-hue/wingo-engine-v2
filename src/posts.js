// Builds the text message that goes out for each prediction round:
// a branding header, a PAST RESULTS list, a NEXT PREDICTION block, and a footer link.

import { PAST_RESULT_LINES, DEFAULT_HEADER } from "./config.js";
import { state } from "./store.js";
import { isColourCall } from "./engine.js";

export function buildTargetBox(period, prediction, numbers, level) {
  const p = String(prediction || "").toUpperCase();
  const p4 = String(period || "").slice(-4);

  if (p === "SKIP") {
    return [
      "        ⏬ NEXT PREDICTION ⏬",
      `               ${p4} : [ ⏳ SKIP ]`,
      "               STATUS - [ PAUSED / WAIT ]"
    ].join("\n");
  }

  const lvlPart = (level && level > 0) ? ` [L${level}]` : "";
  let icon = "";
  if (p === "GREEN" || p === "BIG") icon = "🟢 ";
  else if (p === "RED" || p === "SMALL") icon = "🔴 ";

  const lines = [
    "        ⏬ NEXT PREDICTION ⏬",
    `               ${p4} : [ ${icon}${p} ]${lvlPart}`
  ];
  if (numbers && numbers.length) {
    lines.push(`               NUMBER - [ ${numbers.join(" , ")} ]`);
  }
  return lines.join("\n");
}

export function footerLine() {
  const f = (state.cfg.footer || "@NXTKernelPredictor_Bot").trim();
  if (!f) return "";
  const url = /^https?:\/\//i.test(f) ? f : "https://t.me/" + (f.startsWith("@") ? f.slice(1) : f);
  const handle = f.startsWith("@") ? f : (f.startsWith("http") ? f : "@" + f);
  return `\n\n\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0 ᴼᵖᵉⁿ ᶠᵒʳ ᵖʳⁱᵛᵃᵗᵉ ˢᵉˢⁱᵒⁿ\u00A0\u00A0 <a href="${url}">${handle}</a>\u00A0\u00A0\u00A0\u00A0\u00A0 ↩️`;
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
  if (resultText.includes("JACKPOT")) return "JACK 🍾";
  if (resultText.includes("WIN")) return "WINN 🍾";
  if (resultText.includes("LOSE") || resultText.includes("LOSS")) return "LOSS 🙈";
  if (resultText.includes("SKIP")) return "SKIP ⏳";
  return "";
};

function pastResultLines() {
  const lines = [];
  for (const entry of state.log.slice(1)) {
    if (lines.length >= PAST_RESULT_LINES) break;
    const status = statusWord(entry.resultText || "");
    if (!status) continue;
    const p4 = String(entry.period || "").slice(-4);
    const [side, ...rest] = String(entry.label || "").split(" ");
    const restText = rest.join(" ").trim();
    const extraPart = restText ? `${restText} ` : "";
    lines.push(`PEREOD :- ${p4} ${sideWord(side)} ${extraPart}${status}`);
  }
  return lines.reverse();
}

// Builds the complete prediction post text (pure text formatted for Telegram HTML)
export function buildPost(period, prediction, numbers, level) {
  const header = (state.cfg.header || DEFAULT_HEADER).trim();
  const allLines = pastResultLines();
  const box = buildTargetBox(period, prediction, numbers, level);
  const footer = footerLine();

  const sections = [];
  if (header) sections.push(header);
  if (allLines.length) sections.push(allLines.join("\n"));
  sections.push(box);

  return `<b>${sections.join("\n\n")}</b>${footer}`;
}

export { isColourCall };
