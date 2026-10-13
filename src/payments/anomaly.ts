/**
 * Is this payment out of character for this agent?
 *
 * The first behavioural control in Fuel. Caps answer "has this agent spent too
 * much in total"; this answers "is this agent suddenly behaving differently",
 * which a cap cannot see until the money is already gone.
 *
 * Deliberately a ratio against a robust centre rather than a variance model.
 * Real reason, not taste: every payment this system has ever made is the same
 * amount, so the observed variance is exactly zero. A z-score or MAD detector
 * divides by that spread, and the first differently-sized payment scores as
 * infinitely anomalous — the detector would fire on the first legitimate price
 * change and never usefully again.
 *
 * What this does NOT cover, so it is not mistaken for more than it is: an agent
 * that keeps every payment normal-sized and simply makes far more of them. The
 * per-payment ceiling (MAX_PER_PAYMENT_BASE_UNITS in pay.ts) bounds what a
 * single spike can cost; nothing here bounds the rate. See docs/roadmap.md.
 */

/** How many recent payments form the baseline. */
export const BASELINE_WINDOW = 20;

/**
 * Below this many payments an agent has no baseline and is never flagged.
 *
 * Fails OPEN on purpose. Failing closed would queue every new agent's first
 * payments for approval, which teaches operators to click through the queue —
 * and that queue is the Slice 2 control that actually stops overspend. An agent
 * with no history is still bounded by its own cap, its team's, its company's,
 * and the per-payment ceiling.
 */
export const MIN_BASELINE_SAMPLE = 5;

/** How far above the baseline counts as out of character. */
export const ANOMALY_MULTIPLE = 3n;

/**
 * No payment below this is ever flagged, however large the multiple.
 *
 * A ratio alone is not an anomaly. Four times a trivial amount is still
 * trivial, and an agent whose typical payment is $0.0001 would otherwise be
 * flagged at $0.0005 — noise. A queue full of noise is a queue nobody reads,
 * which costs more than the false negatives this floor allows.
 *
 * $0.002. Non-binding at today's typical $0.001 payment (3x that is $0.003, so
 * the multiple is what bites); it only matters for micro-baseline agents.
 */
export const ANOMALY_FLOOR_BASE_UNITS = 2_000n;

export interface AnomalyVerdict {
  anomalous: boolean;
  /** Median of the sample. 0n when there was not enough history to have one. */
  baseline: bigint;
  /** What the amount had to exceed to be flagged. 0n when no baseline. */
  threshold: bigint;
  sampleSize: number;
}

/**
 * Median in integer base units — never a float, per src/lib/money.ts.
 *
 * Even-length samples average the two middle values with truncating division.
 * Losing at most one base unit ($0.000001) to truncation is irrelevant to a
 * threshold comparison, and it keeps the whole path in bigint.
 */
export function median(amounts: bigint[]): bigint {
  if (amounts.length === 0) return 0n;
  const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

/**
 * The rule itself, kept pure — no database, no clock, no money.
 *
 * `sample` is the agent's recent payment amounts; order does not matter, the
 * median sorts them. The caller decides which payments belong in it.
 */
export function assessAmount(params: { amountBaseUnits: bigint; sample: bigint[] }): AnomalyVerdict {
  const { amountBaseUnits, sample } = params;

  if (sample.length < MIN_BASELINE_SAMPLE) {
    return { anomalous: false, baseline: 0n, threshold: 0n, sampleSize: sample.length };
  }

  const baseline = median(sample);
  const byMultiple = baseline * ANOMALY_MULTIPLE;
  const threshold = byMultiple > ANOMALY_FLOOR_BASE_UNITS ? byMultiple : ANOMALY_FLOOR_BASE_UNITS;

  // Strictly greater: a payment exactly at the threshold is within tolerance.
  return { anomalous: amountBaseUnits > threshold, baseline, threshold, sampleSize: sample.length };
}
