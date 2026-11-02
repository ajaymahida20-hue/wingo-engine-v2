// A rolling in-memory log so the panel can show what the engine is doing — and,
// more importantly, what went wrong. Nothing here is written to disk.

const MAX = 300;

export const logs = [];

export function log(level, msg) {
  const entry = { t: Date.now(), level, msg: String(msg) };
  logs.push(entry);
  if (logs.length > MAX) logs.splice(0, logs.length - MAX);
  const stamp = new Date(entry.t).toISOString().slice(11, 19);
  const line = `[${stamp}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  return entry;
}

export const info  = m => log("info", m);
export const warn  = m => log("warn", m);
export const error = m => log("error", m);
