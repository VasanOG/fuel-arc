/**
 * Where the gateway lives, as two constants and nothing else.
 *
 * A LEAF MODULE ON PURPOSE. It imports nothing, so anything that needs to know
 * the gateway's path or origin can say so without dragging in the router — and
 * therefore the x402 resource server, the receipts table, the limiter and the
 * whole database layer behind them.
 *
 * That is not hypothetical tidiness. `src/lib/environment.ts` classifies these
 * constants to report which environment Fuel is running against, and it is
 * explicitly a module that does no provider work; having it import the live
 * gateway router to read one string would be the same mistake this project
 * already fixed once, when `FACILITATOR_URL` was moved out of `src/server.ts`
 * because "importing server.ts to get a string would start an HTTP server as a
 * side effect."
 *
 * `src/gateway/route.ts` re-exports both, so callers that legitimately want the
 * router already have them and nothing had to move at the call sites.
 */

/** The path the gateway serves under. Public; carries no credential. */
export const GATEWAY_PREFIX = "/earn";

/**
 * The origin this gateway is actually reachable at.
 *
 * PINNED, NOT READ FROM CONFIGURATION, and that is the whole point. The other
 * four environment surfaces classify a network id or a provider origin baked
 * into the deployed code, because the argument for all of them is that the
 * environment is a property of what was shipped — a value read from an env var
 * would let a deployment claim sandbox while serving the public internet, which
 * is the one wrong answer that matters.
 *
 * Loopback today, and truthfully so: `src/server.ts` binds 127.0.0.1, so
 * nothing reaches the gateway from outside without a tunnel someone starts
 * deliberately (see `scripts/walk-revenue.ts`, where exactly that was done for
 * a few minutes and then stopped). When Fuel genuinely hosts the gateway, this
 * constant changes in a reviewed code change and `src/lib/environment.ts` gains
 * the matching KNOWN entry — the same bar mainnet has to clear, for the same
 * reason: it is the moment real traffic and real exposure begin.
 */
export const GATEWAY_PUBLIC_ORIGIN = "http://127.0.0.1";
