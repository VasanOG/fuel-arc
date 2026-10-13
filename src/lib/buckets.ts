/**
 * A bounded, self-expiring counter map — the shared mechanism behind every
 * request-volume limit in Fuel.
 *
 * EXTRACTED FROM src/gateway/limiter.ts IN STAGE 3, NOT COPIED. The gateway
 * built this to bound anonymous traffic; login and signup need exactly the same
 * thing for exactly the same reasons, and two copies of a limiter drift — one
 * gets an eviction fix the other does not, and the one that missed it is the
 * one holding the front door. The gateway now imports this and keeps its own
 * limits and policy in its own file.
 *
 * BOUNDED IS THE POINT. An unbounded Map keyed on a source address — or on an
 * email address a stranger types — is itself a memory-exhaustion path under a
 * flood: the limiter would grow without limit while doing its job. Insertion
 * order in a JS Map is stable, so the oldest key is the first one iteration
 * yields, which makes eviction a couple of lines rather than a data structure.
 *
 * IN MEMORY, DELIBERATELY, AND THE REASON IS NOT SPEED. A database-backed
 * limiter is a write-amplification denial of service: it lets an unauthenticated
 * caller force a disk write per request, against the single synchronous SQLite
 * connection that also serialises every spend-cap check. The limiter would
 * become the vector it was added to close.
 *
 * What that costs, stated rather than glossed:
 *   - Counts reset when the process restarts.
 *   - State is per process, so a second instance would not share it.
 * Both are acceptable while Fuel runs as one process; neither is hidden.
 */

/** Keys tracked at once, per instance. Beyond this the oldest are evicted. */
export const MAX_TRACKED_KEYS = 10_000;

interface Bucket {
  count: number;
  windowStart: number;
}

export class Buckets {
  private readonly map = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxTrackedKeys: number = MAX_TRACKED_KEYS,
  ) {}

  /** True if this key is over its limit. Counts the request either way. */
  exceeded(key: string, now = Date.now()): boolean {
    const existing = this.map.get(key);
    if (!existing || now - existing.windowStart >= this.windowMs) {
      this.map.delete(key); // re-insert so eviction order tracks recency
      this.map.set(key, { count: 1, windowStart: now });
      this.evict(now);
      return false;
    }
    existing.count += 1;
    return existing.count > this.limit;
  }

  /** How many keys are currently held. Test seam for the memory bound. */
  get size(): number {
    return this.map.size;
  }

  private evict(now: number): void {
    // Drop anything whose window has closed; it can only ever be re-created.
    for (const [key, bucket] of this.map) {
      if (now - bucket.windowStart < this.windowMs) break; // insertion-ordered
      this.map.delete(key);
    }
    // Hard ceiling, in case a flood is fast enough that nothing has expired.
    while (this.map.size > this.maxTrackedKeys) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  /** Test seam. */
  clear(): void {
    this.map.clear();
  }
}
