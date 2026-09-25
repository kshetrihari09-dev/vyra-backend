/** Minimal structured JSON logger (stdout). PM2 / journald collect it; no dependency needed yet. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level = "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...fields });
    (lvl === "error" || lvl === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
