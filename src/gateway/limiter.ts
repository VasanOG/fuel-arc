/**
 * Request-volume limits for the public gateway.
 *
 * DISTINCT FROM SPEND VELOCITY. `payments/velocity.ts` bounds money, keyed on
 * an agent id, for a caller Fuel has authenticated. This bounds requests, keyed
 * on a stranger, for the first route in the product with no credential in front
 * of it. Nothing about the outbound machinery transfers.
 *
 * THE COUNTING MECHANISM LIVES IN src/lib/buckets.ts, which Stage 3 extracted so
 * that login and signup could not end up with a second, drifting copy of it.
 * That file carries the reasoning for why it is in memory and why it is bounded.
 * WHAT STAYS HERE IS POLICY: which keyspaces this surface limits, at what
 * numbers, and what a refused caller is told.
 */

import { Buckets, MAX_TRACKED_KEYS } from "../lib/buckets.js";

/** Requests per window, per source address, before any endpoint is resolved. */
const PER_ADDRESS_LIMIT = 60;
/** Requests per window for one endpoint, summed across every caller. */
const PER_ENDPOINT_LIMIT = 120;
const WINDOW_MS = 60_000;

/** Origin fetches in flight for one endpoint. Protects the customer's server. */
const PER_ENDPOINT_CONCURRENCY = 8;

/**
 * Origin fetches in flight across every endpoint.
 *
 * THE ONE THAT PROTECTS FUEL FROM ITS OWN NEW SURFACE. The gateway shares a
 * process, an event loop and a single SQLite connection with `/api` — the
 * authenticated surface that runs cap checks, approvals and agent payments. A
 * flood against the anonymous gateway would otherwise degrade the spend
 * controls every earlier phase exists to provide. Per-endpoint caps cannot
 * bound that, because an attacker registering nothing can still hit N
 * endpoints at once.
 */
const GLOBAL_CONCURRENCY = 32;

const byAddress = new Buckets(PER_ADDRESS_LIMIT, WINDOW_MS);
const byEndpoint = new Buckets(PER_ENDPOINT_LIMIT, WINDOW_MS);

const inFlight = new Map<string, number>();
let globalInFlight = 0;

export interface LimitVerdict {
  ok: boolean;
  /** Set when refused: what to tell the caller, without naming internals. */
  reason?: string;
  retryAfterSeconds?: number;
}

const OK: LimitVerdict = { ok: true };

/**
 * The outermost check, before any database read or network call.
 *
 * ORDER MATTERS AND IS THE WHOLE VALUE. Resolving the endpoint means a query;
 * building payment requirements means reading a price. If either ran first, an
 * unpaid flood would cost a database read per request and the limiter would be
 * pointless. Address first, because it needs nothing but the socket.
 *
 * `trust proxy` is deliberately not set on the app, so this is the socket peer
 * rather than a header a caller can write. Behind a load balancer every request
 * would share one key and this layer would stop being meaningful — that is a
 * deployment question 0011 leaves open, and reading `X-Forwarded-For` without a
 * trusted proxy in front would be worse than not having the layer at all.
 */
export function checkAddress(address: string): LimitVerdict {
  if (byAddress.exceeded(address)) {
    return { ok: false, reason: "too many requests", retryAfterSeconds: 60 };
  }
  return OK;
}

/** Checked only after the public id is known to exist, so unknown paths mint nothing. */
export function checkEndpoint(endpointId: string): LimitVerdict {
  if (byEndpoint.exceeded(endpointId)) {
    return { ok: false, reason: "this endpoint is receiving too many requests", retryAfterSeconds: 60 };
  }
  return OK;
}

/**
 * Reserves a concurrency slot for an origin fetch, or refuses.
 *
 * Returns a release function rather than exposing the counters, so a caller
 * cannot decrement something it never incremented. The caller must release in a
 * `finally` — a leaked slot is permanent, and enough of them wedge the gateway
 * closed for everyone.
 */
export function acquireSlot(endpointId: string): { ok: false; reason: string } | { ok: true; release: () => void } {
  if (globalInFlight >= GLOBAL_CONCURRENCY) {
    return { ok: false, reason: "the gateway is at capacity" };
  }
  const current = inFlight.get(endpointId) ?? 0;
  if (current >= PER_ENDPOINT_CONCURRENCY) {
    return { ok: false, reason: "this endpoint is at capacity" };
  }

  inFlight.set(endpointId, current + 1);
  globalInFlight += 1;

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return; // idempotent: a double release must not free a stranger's slot
      released = true;
      globalInFlight -= 1;
      const n = (inFlight.get(endpointId) ?? 1) - 1;
      if (n <= 0) inFlight.delete(endpointId);
      else inFlight.set(endpointId, n);
    },
  };
}

/** Test seam: reset every counter. */
export function resetLimiter(): void {
  byAddress.clear();
  byEndpoint.clear();
  inFlight.clear();
  globalInFlight = 0;
}

export const LIMITS = {
  PER_ADDRESS_LIMIT,
  PER_ENDPOINT_LIMIT,
  PER_ENDPOINT_CONCURRENCY,
  GLOBAL_CONCURRENCY,
  WINDOW_MS,
  MAX_TRACKED_KEYS,
};
