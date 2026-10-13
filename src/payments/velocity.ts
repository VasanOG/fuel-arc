/**
 * How fast may an agent spend?
 *
 * Caps bound the total; anomaly.ts bounds how far one payment may stray from an
 * agent's own habits. Neither bounds the RATE, and that is the gap this closes:
 * a hundred perfectly ordinary payments drain a cap exactly as well as one large
 * one, no single payment looks unusual, and splitting one large payment into
 * several ordinary ones evades the amount detector entirely.
 *
 * A fixed policy, deliberately NOT a learned baseline — which is the honest
 * reading of the data rather than a shortcut. Observed inter-payment gaps for
 * the busiest agent span 1s to two days, five orders of magnitude, and every one
 * of them is an artifact of manual testing rather than agent behaviour. A
 * "baseline" fitted to that would be a statistic about a test session wearing
 * the costume of a control. When real traffic exists, revisit this; until then a
 * plain limit is both more useful and more truthful.
 *
 * Unlike a cap or an anomaly, exceeding this is SELF-HEALING: the window slides
 * and the agent proceeds, with no human involved. That is why it refuses
 * outright rather than raising an approval request — asking an operator to rule
 * on something that resolves itself in sixty seconds would devalue the queue
 * that actually stops overspend.
 */

/** The sliding window over which spend is summed. */
export const VELOCITY_WINDOW_MS = 60_000;

/**
 * The most an agent may spend within one window.
 *
 * $0.02. Roughly 3x the busiest minute ever recorded in this system (6 payments
 * totalling $0.006), so it throttles a runaway loop without touching observed
 * behaviour. Calibrated against test traffic and nothing else — it is one
 * constant, easy to change, and should be revisited the moment real agents
 * generate real traffic. See docs/roadmap.md.
 */
export const MAX_SPEND_PER_WINDOW_BASE_UNITS = 20_000n;

export interface VelocityVerdict {
  exceeded: boolean;
  /** Spend already inside the window, excluding the candidate payment. */
  spentInWindow: bigint;
  limit: bigint;
}

/**
 * The rule itself, kept pure — no database, no clock, no money.
 *
 * The candidate amount is included in the comparison exactly as the cap checks
 * include it (`spent + amount > cap`): the question is what this payment would
 * bring the window to, not what it already holds. Spending to precisely the
 * limit is allowed, same `>` boundary the caps use.
 *
 * Note there is no minimum-history condition here, and so no cold-start hole to
 * fail open through: a fixed limit needs no history, which means a brand-new
 * agent is rate-limited from its very first payment — the one case anomaly.ts
 * deliberately cannot cover.
 */
export function assessVelocity(params: {
  amountBaseUnits: bigint;
  spentInWindow: bigint;
}): VelocityVerdict {
  const { amountBaseUnits, spentInWindow } = params;
  return {
    exceeded: spentInWindow + amountBaseUnits > MAX_SPEND_PER_WINDOW_BASE_UNITS,
    spentInWindow,
    limit: MAX_SPEND_PER_WINDOW_BASE_UNITS,
  };
}

/**
 * How long until the window first frees up, in whole seconds.
 *
 * A HINT, not a promise. It reports when the oldest payment in the window ages
 * out — the earliest moment any budget is released — which is not necessarily
 * enough for the refused payment to fit. Callers should treat it as "no point
 * retrying before this", not "this will succeed then".
 *
 * Floors at 1: a `Retry-After: 0` invites an instant retry that refuses again.
 */
export function retryAfterSeconds(oldestInWindowIso: string | null, now: number): number {
  if (oldestInWindowIso === null) return Math.ceil(VELOCITY_WINDOW_MS / 1000);
  const freesAt = new Date(oldestInWindowIso).getTime() + VELOCITY_WINDOW_MS;
  return Math.max(1, Math.ceil((freesAt - now) / 1000));
}
