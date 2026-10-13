/**
 * The sweeper's own timer, kept apart from the reaper (the user's addition 2).
 *
 * WHY NOT A SIXTH PASS IN `reap()`. The reaper releases abandoned payment
 * reservations and expires approvals: it gives budget back and takes
 * permission away, on a clock. Alerting is useful and optional. Sharing a
 * function would let a slow or broken alert sweep delay or skip that work, so
 * the two run on separate timers and neither can see the other.
 *
 * THE OVERLAP GUARD. A sweep can take longer than its interval (many
 * companies, a slow disk). A tick that arrives while one is still running is
 * SKIPPED, not queued: two sweeps at once would race each other's diffs, and a
 * queue of them would grow without bound.
 *
 * WHAT SEPARATE TIMERS DO NOT CHANGE, stated plainly: the per-company part of a
 * sweep is synchronous, and while it runs nothing else on this event loop runs,
 * the reaper included. So the reaper can be DELAYED by at most one company's
 * synchronous segment (the sweep yields between companies), and it can never
 * be SKIPPED. AL-L1 shows the second; AL-D7 bounds the first.
 */
export interface SweepLoop {
  stop(): void;
  stats(): { runs: number; skipped: number; failures: number; running: boolean };
}

export function startSweepLoop(options: {
  sweep: () => Promise<unknown>;
  intervalMs: number;
  /** Called with nothing that could carry a secret: only that a sweep failed. */
  onFailure: () => void;
  /** Run once immediately as well as on the interval. */
  runNow?: boolean;
}): SweepLoop {
  let running = false;
  let runs = 0;
  let skipped = 0;
  let failures = 0;

  const tick = () => {
    if (running) {
      skipped += 1;
      return;
    }
    running = true;
    runs += 1;
    let attempt: Promise<unknown>;
    try {
      attempt = Promise.resolve(options.sweep());
    } catch (error) {
      attempt = Promise.reject(error);
    }
    // Nothing escapes: a failed sweep is counted and reported, and the next
    // tick runs as normal. No rejection reaches the process.
    attempt
      .catch(() => {
        failures += 1;
        try {
          options.onFailure();
        } catch {
          // A failing reporter must not become a failing loop.
        }
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, options.intervalMs);
  timer.unref();
  if (options.runNow) setImmediate(tick);

  return {
    stop: () => clearInterval(timer),
    stats: () => ({ runs, skipped, failures, running }),
  };
}
