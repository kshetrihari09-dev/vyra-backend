/**
 * Tiny in-process scheduler. One tick per job at a time (a slow run is skipped, never stacked), errors are logged and
 * never crash the process, timers don't keep the process alive. Multiple processes may each run it: the outbox claims rows
 * with SKIP LOCKED and retention is idempotent.
 */
export function createScheduler({ jobs, logger }) {
  const state = new Map(jobs.map((j) => [j.name, { running: false, timer: null }]));
  async function tick(name) {
    const job = jobs.find((j) => j.name === name);
    const s = state.get(name);
    if (!job || s.running) return { skipped: true };
    s.running = true;
    try { return { result: await job.run() }; }
    catch (err) { logger.error("job failed", { job: name, error: String(err?.message ?? err) }); return { error: true }; }
    finally { s.running = false; }
  }
  return {
    tick,
    start() {
      for (const job of jobs) {
        const s = state.get(job.name);
        if (s.timer) continue;
        s.timer = setInterval(() => { tick(job.name); }, job.everyMs);
        s.timer.unref();
        if (job.runOnStart) setTimeout(() => tick(job.name), 5_000).unref();
      }
      logger.info("scheduler started", { jobs: jobs.map((j) => `${j.name}@${j.everyMs}ms`) });
    },
    /** Stops timers and waits (briefly) for a run in progress. */
    async stop(waitMs = 5_000) {
      for (const s of state.values()) { clearInterval(s.timer); s.timer = null; }
      const deadline = Date.now() + waitMs;
      while ([...state.values()].some((s) => s.running) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    },
  };
}
