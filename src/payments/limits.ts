/**
 * Timing bounds for a payment, kept together because they constrain each other.
 *
 * x402 stamps `validBefore = now + maxTimeoutSeconds` onto the authorization
 * BEFORE signing, and the *server* picks `maxTimeoutSeconds`. So the whole of
 * our signing and delivery path has to fit inside a window a stranger chose. If
 * it doesn't, the authorization expires in transit: we signed, the budget is
 * consumed (correctly — it was spendable), and we got nothing.
 *
 * These three therefore have to be read as one budget, not three independent
 * knobs. They live in one file so a change to one is visibly a change to all.
 */

/** A resource server that never responds must not hold a reservation open. */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * How long to wait for the Fireblocks co-signer. Observed latency is ~5s.
 *
 * Deliberately well under `reapStaleReservations`' 2-minute window: if a
 * signature could outlive that, the reaper and a late-returning request would
 * race over the same payment's status.
 */
export const SIGN_TIMEOUT_MS = 60_000;

/**
 * Shortest authorization validity we will accept from a server.
 *
 * Must exceed the worst case we can actually take: signing (SIGN_TIMEOUT_MS)
 * plus the paid delivery fetch (FETCH_TIMEOUT_MS), plus margin for the
 * facilitator's own broadcast. Derived rather than written down, because the
 * failure it prevents is silent — a too-low value here means we accept terms we
 * cannot possibly meet, and burn the cap proving it.
 *
 * x402's own default is 300s, so ordinary servers are unaffected.
 */
export const MIN_TIMEOUT_SECONDS = Math.ceil((SIGN_TIMEOUT_MS + FETCH_TIMEOUT_MS) / 1000) + 45;

/* ---------------------------------------------------------------------------
 * The receiving side. Same budget idea, pointed the other way.
 *
 * Paying, Fuel must fit inside a window a stranger chose, which is what
 * MIN_TIMEOUT_SECONDS defends. Earning, FUEL CHOOSES THE WINDOW and has to be
 * able to live inside its own number — so these derive in the opposite
 * direction: the advertised validity is computed from the work, rather than the
 * work being checked against an advertised validity.
 * ------------------------------------------------------------------------- */

/**
 * How long the gateway waits on a customer's origin before giving up.
 *
 * Short on purpose. A slow origin holds a socket, a rate-limit concurrency
 * slot, and — because the gateway must hold the whole body before it can
 * settle — a buffer. Ten seconds is already generous for an API someone is
 * being paid per call to serve.
 */
export const ORIGIN_TIMEOUT_MS = 10_000;

/**
 * Room for the facilitator's two calls: verify (an eth_call simulation) and
 * settle, which broadcasts and then blocks on a transaction receipt. Base
 * blocks are ~2s; this is deliberately several times that, because being
 * generous here costs an unused margin while being tight costs a burnt
 * authorization.
 */
export const FACILITATOR_BUDGET_MS = 45_000;

/**
 * What the gateway advertises as `maxTimeoutSeconds` in its 402.
 *
 * DERIVED, for exactly the reason MIN_TIMEOUT_SECONDS is. The authorization a
 * payer signs carries `validBefore = now + this`, and Fuel then has to complete
 * verify, the origin fetch, and settle before it lapses. Writing a literal here
 * and separately tuning ORIGIN_TIMEOUT_MS would let the two drift until Fuel
 * advertised a window it could not itself meet — and the failure is the bad
 * kind: the payer's authorization expires mid-flight, so they have signed
 * something that can no longer be settled and the customer serves a request
 * nobody pays for.
 *
 * The +15 covers `verifyEIP3009`'s own 6-second expiry margin (it refuses an
 * authorization inside 6s of lapsing) plus network jitter on both facilitator
 * legs.
 */
export const GATEWAY_MAX_TIMEOUT_SECONDS =
  Math.ceil((ORIGIN_TIMEOUT_MS + FACILITATOR_BUDGET_MS) / 1000) + 15;

/**
 * The most an origin response may weigh.
 *
 * The gateway buffers the whole body before settling, so this is a direct
 * bound on memory an anonymous caller can cause Fuel to allocate — one of the
 * few such bounds that exists. 1 MiB is far above any metered JSON API and far
 * below anything that threatens the process.
 */
export const ORIGIN_MAX_RESPONSE_BYTES = 1024 * 1024;
