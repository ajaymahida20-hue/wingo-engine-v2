// Builds the text message that goes out for each prediction round:
// a branding header, a PAST RESULTS list, a NEXT PREDICTION block, and a footer link.

import { PAST_RESULT_LINES, DEFAULT_HEADER } from "./config.js";
import { state } from "./store.js";
import { isColourCall } from "./engine.js";

export function buildTargetBox(period, prediction, numbers) {
  const p = String(prediction).toUpperCase();
  const balls = numbers && numbers.length ? numbers.join(" , ") : "—";
  const p4 = String(period || "").slice(-4);

  return [
    "        ⏬ NEXT PREDICTION ⏬",
    `               ${p4} : [ ${p} ]`,
    `               NUMBER - [ ${balls} ]`
  ].join("\n");
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
  if (p === "BIG") return "BIGG";
  if (p === "SMALL") return "SMAL";
  return p;
};

const statusWord = resultText => {
  if (resultText.includes("JACKPOT")) return "JACK 🍾";
  if (resultText.includes("WIN")) return "WINN 🍾";
  if (resultText.includes("LOSE")) return "LOSS 🙈";
  return "";
};

function pastResultLines() {
  const lines = [];
  for (const entry of state.log.slice(1)) {
    if (lines.length >= PAST_RESULT_LINES) break;
    const status = statusWord(entry.resultText || "");
    if (!status) continue;
    const [side, ...rest] = String(entry.label || "").split(" ");
    const number = rest.join(" ").trim();
    const numPart = number ? `${number} ` : "";
    const p4 = String(entry.period || "").slice(-4);
    lines.push(`PEREOD :- ${p4} ${sideWord(side)} ${numPart}${status}`);
  }
  return lines.reverse();
}

// Builds the complete prediction post text (pure text formatted for Telegram HTML)
export function buildPost(period, prediction, numbers) {
  const header = (state.cfg.header || DEFAULT_HEADER).trim();
  const allLines = pastResultLines();
  const box = buildTargetBox(period, prediction, numbers);
  const footer = footerLine();

  const sections = [];
  if (header) sections.push(header);
  if (allLines.length) sections.push(allLines.join("\n"));
  sections.push(box);

  return `<b>${sections.join("\n\n")}</b>${footer}`;
}

export { isColourCall };
