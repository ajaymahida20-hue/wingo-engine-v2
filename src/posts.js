// Builds the message that goes out:
// a branding header, a PAST RESULTS list, a NEXT PREDICTION block, and a footer link.

import { CAPTION_LIMIT, PAST_RESULT_LINES, DEFAULT_HEADER } from "./config.js";
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

// SMALL and BIG each carry their own image; a colour call has no side, so it goes
// out as text only.
export function photoForPrediction(prediction) {
  if (!state.cfg.usePhotos) return "";
  const p = String(prediction).toUpperCase();
  if (p !== "BIG" && p !== "SMALL") return "";
  return ((p === "BIG" ? state.cfg.photoBig : state.cfg.photoSmall) || "").trim();
}

export function footerLine() {
  const f = (state.cfg.footer || "@NXTKernelPredictor_Bot").trim();
  if (!f) return "";
  const url = /^https?:\/\//i.test(f) ? f : "https://t.me/" + (f.startsWith("@") ? f.slice(1) : f);
  const handle = f.startsWith("@") ? f : (f.startsWith("http") ? f : "@" + f);
  return `\n\n\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0 ᴼᵖᵉⁿ ᶠᵒʳ ᵖʳⁱᵛᵃᵗᵉ ˢᵉˢⁱᵒⁿ\u00A0\u00A0 <a href="${url}">${handle}</a>\u00A0\u00A0\u00A0\u00A0\u00A0 ↩️`;
}

// The side word and the status tag the post uses in its PAST RESULTS block.
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
  for (const entry of state.log.slice(1)) {         // index 0 is the round still pending
    if (lines.length >= PAST_RESULT_LINES) break;
    const status = statusWord(entry.resultText || "");
    if (!status) continue;                           // skip pending / missed rounds
    const [side, ...rest] = String(entry.label || "").split(" ");
    const number = rest.join(" ").trim();
    const numPart = number ? `${number} ` : "";
    const p4 = String(entry.period || "").slice(-4);
    lines.push(`PEREOD :- ${p4} ${sideWord(side)} ${numPart}${status}`);
  }
  return lines.reverse();       // oldest first, the way a scroll reads
}

// A photo caption is capped at 1024 characters, so when a limit is given the PAST
// RESULTS block shrinks — newest lines kept, oldest dropped.
export function buildPost(period, prediction, numbers, limit) {
  const header = (state.cfg.header || DEFAULT_HEADER).trim();
  const allLines = pastResultLines();
  const box = buildTargetBox(period, prediction, numbers);
  const footer = footerLine();

  const compose = hist => {
    const sections = [];
    if (header) sections.push(header);
    if (hist.length) sections.push(hist.join("\n"));
    sections.push(box);
    return `<b>${sections.join("\n\n")}</b>${footer}`;
  };

  let hist = allLines;
  let text = compose(hist);
  if (limit) {
    while (hist.length && compose(hist).length > limit) hist = hist.slice(1);
    text = compose(hist);
    if (text.length > limit) text = compose([]);
  }
  return { text, kept: hist.length, full: compose(allLines) };
}

export function buildPostPair(period, prediction, numbers, withPhoto) {
  const post = buildPost(period, prediction, numbers, withPhoto ? CAPTION_LIMIT : 0);
  return { caption: post.text, fullText: withPhoto ? post.full : post.text };
}

export { isColourCall };
