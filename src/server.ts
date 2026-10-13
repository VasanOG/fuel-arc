import "dotenv/config";
import express from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  ExpressAdapter,
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { api } from "./api.js";
import { reapStaleApprovals } from "./db/approvals.js";
import { reapStaleReservations } from "./db/payments.js";
import { reapStaleAwaitingReceipts } from "./db/receipts.js";
import { GATEWAY_PREFIX, gatewayFacilitator, gatewayRouter } from "./gateway/route.js";
import { createFacilitatorSync, RETRY_AFTER_SECONDS } from "./payments/facilitator-sync.js";
import { endpointsNeedingRecheck } from "./db/earning-endpoints.js";
import { OWNERSHIP_RECHECK_MS, verifyEndpoint } from "./gateway/probes.js";
import { purgeExpiredOAuthStates } from "./db/qbo.js";
import { quickBooksCallback } from "./quickbooks/callback.js";
import { authenticate, sameOriginForSessions } from "./lib/auth.js";
import { publicAuthRouter, RELAY_CONFIG } from "./auth/routes.js";
import { describeRelay } from "./lib/client-key.js";
import { ALLOWED_NETWORK, FACILITATOR_URL } from "./payments/pay.js";
import { requireEnv } from "./lib/env.js";
import { unhandledErrors } from "./lib/errors.js";
import { baseUnitsToDollars } from "./lib/money.js";
import { MAX_SPEND_PER_WINDOW_BASE_UNITS, VELOCITY_WINDOW_MS } from "./payments/velocity.js";
import { startSweepLoop } from "./alerts/loop.js";
import { alertDispatcher } from "./alerts/runtime.js";
import { sweepAll } from "./alerts/sweeper.js";

// Hardcoded, not read from env — same reasoning as the sandbox base path in
// scripts/create-sandbox-wallet.ts: mainnet must never be one config edit
// away. See CLAUDE.md "Non-negotiable rule".
//
// eip155:84532 is Base Sepolia. The x402.org facilitator is testnet-only; the
// mainnet facilitator is a different host entirely, so this constant alone
// keeps us on testnet.
// One definition of the rail, in src/payments/pay.ts. These used to be
// declared here too, which meant the network Fuel validates against and the
// network it advertises were two strings that had to be kept equal by hand.

const PORT = Number(process.env.PORT ?? 3000);

/**
 * How long a reservation may sit unresolved before we assume the request that
 * made it is never coming back.
 *
 * Comfortably above the 15s fetch timeout in payments/pay.ts, so a merchant
 * that is merely slow is never reaped out from under a live request — that
 * would release budget for a payment still in flight.
 */
const STALE_RESERVATION_MS = 2 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;
/** How often alerting looks for something that needs a person (ADR 0021). */
const ALERT_SWEEP_INTERVAL_MS = 60 * 1000;

function reap(context: string): void {
  try {
    const { released, unreconciled } = reapStaleReservations(STALE_RESERVATION_MS);
    if (released || unreconciled) {
      console.log(
        `[reaper] ${context}: released ${released} pre-signing reservation(s), ` +
          `marked ${unreconciled} unreconciled (signed, outcome unknown)`,
      );
    }
  } catch (error) {
    // A failing reaper must not take the server down with it.
    console.error(`[reaper] ${context} failed:`, (error as Error).message);
  }

  // Separately guarded: expiring approvals can only ever remove permission to
  // spend, so it must not be skipped just because the payment reaper threw.
  try {
    const { expiredApprovals, expiredPending } = reapStaleApprovals();
    if (expiredApprovals || expiredPending) {
      console.log(
        `[reaper] ${context}: expired ${expiredApprovals} unredeemed approval(s), ` +
          `${expiredPending} undecided request(s)`,
      );
    }
  } catch (error) {
    console.error(`[reaper] ${context} approvals failed:`, (error as Error).message);
  }

  // Third guard, same reasoning as the second: clearing abandoned OAuth states
  // can only ever remove a way in, so it must not be skipped because something
  // above it threw. Quiet by design — an unfinished connection attempt is
  // ordinary, not an incident.
  try {
    purgeExpiredOAuthStates();
  } catch (error) {
    console.error(`[reaper] ${context} oauth states failed:`, (error as Error).message);
  }

  // Fourth guard, same reasoning as the second and third. A receipt is claimed
  // BEFORE the origin is called, so a crash in between strands it at
  // `awaiting` — and because the claim is what enforces replay protection, a
  // stranded row permanently burns that payer's authorization nonce. Resolved
  // to `settle_unknown` rather than `abandoned`: the crash could have happened
  // either side of the settle call, so "we do not know" is the honest answer,
  // and it is the one that keeps the amount out of the books.
  try {
    const stranded = reapStaleAwaitingReceipts(STALE_RESERVATION_MS);
    if (stranded) {
      console.log(`[reaper] ${context}: resolved ${stranded} stranded receipt(s) to settle_unknown`);
    }
  } catch (error) {
    console.error(`[reaper] ${context} receipts failed:`, (error as Error).message);
  }

  // Fifth guard: re-prove that each enabled endpoint's origin is still the one
  // its operator proved they controlled.
  //
  // WITHOUT THIS, OWNERSHIP_RECHECK_MS IS A COMMENT RATHER THAN A CONTROL. An
  // endpoint verified once would stay enabled forever, and the window it names
  // — an operator proving ownership, then repointing DNS at a host they do not
  // control while Fuel keeps relaying paid traffic there — would be unbounded.
  // Nobody re-runs the manual check voluntarily, least of all someone abusing
  // it.
  //
  // Async, and deliberately not awaited by the caller: `reap` is called from a
  // timer and at boot, and network probes must not delay either. Failures are
  // contained the same way as the four passes above.
  void (async () => {
    try {
      const due = endpointsNeedingRecheck(OWNERSHIP_RECHECK_MS);
      for (const endpoint of due) {
        const outcome = await verifyEndpoint(endpoint);
        if (outcome.blockedReason) {
          console.warn(
            `[reaper] ${context}: disabled earning endpoint ${endpoint.id} — ${outcome.blockedReason}`,
          );
        }
      }
    } catch (error) {
      console.error(`[reaper] ${context} endpoint re-check failed:`, (error as Error).message);
    }
  })();
}

// Where payments land: our Fireblocks sandbox vault deposit address.
const payTo = requireEnv("X402_PAY_TO");

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
).register(ALLOWED_NETWORK, new ExactEvmScheme());

const PAID_ROUTES = {
  "GET /paid-hello": {
    accepts: {
      scheme: "exact",
      price: "$0.001",
      network: ALLOWED_NETWORK,
      payTo,
    },
    description: "Phase 0 test endpoint — proves the x402 payment loop works",
  },
  // Exists so anomaly detection can be exercised at all. Every payment this
  // system has ever made cost $0.001, which is the exact number the
  // baseline is built from — with a single price there is no such thing as
  // an unusual amount. Still well under MAX_PER_PAYMENT_BASE_UNITS, so this
  // is a behavioural outlier rather than a payment we refuse outright.
  "GET /paid-hello-large": {
    accepts: {
      scheme: "exact",
      price: "$0.005",
      network: ALLOWED_NETWORK,
      payTo,
    },
    description: "Phase 3 test endpoint — 5x the usual price, to trip the anomaly check",
  },
} as const;

/**
 * THE /paid-hello HANDSHAKE IS FUEL'S, NOT THE LIBRARY'S.
 *
 * `paymentMiddleware(routes, server)` -- what this file used before -- is
 * exactly `new x402HTTPResourceServer(server, routes)` handed to
 * `paymentMiddlewareFromHTTPServer` with its startup sync on, and that sync
 * starts the facilitator handshake at construction with no handler attached
 * (@x402/express index.mjs:113). An unreachable facilitator therefore ended
 * this process, exactly as the gateway's own handshake did.
 *
 * So the HTTP server is built here, the middleware is told never to sync
 * (`false`, below), and the handshake runs through a FacilitatorSync like the
 * gateway's: handled, retried in the background, never re-run after success.
 * `paidHttpServer.initialize()` still runs the library's route validation, so
 * a facilitator without this rail is a failed attempt here too. Prices, payTo,
 * and the verify -> handler -> settle order are the library's, unchanged.
 */
const paidHttpServer = new x402HTTPResourceServer(resourceServer, PAID_ROUTES);
const paidFacilitator = createFacilitatorSync(() => paidHttpServer.initialize(), { name: "paid-hello" });

const app = express();
app.use(express.json());

// Fuel's own API. Mounted alongside the test merchant endpoint below so Fuel
// can pay its own paywalled route — which makes the whole loop demonstrable
// in one process. In production these are obviously separate services.
// authenticate resolves WHICH credential is calling (401 if neither); each
// route in api.ts then declares which roles it accepts (403 if wrong).
/**
 * SIGN-IN, MOUNTED AHEAD OF `authenticate` — the second structural exception in
 * this file, alongside the OAuth callback below.
 *
 * A login route that required a credential would be a contradiction. Express
 * matching is positional, so this prefix is tried first and handles the routes
 * it declares (`/login`, and signup once it exists); anything else under
 * `/api/auth` falls through to the authenticated router, which is where `me`
 * and `logout` live — they need a resolved session, so being unauthenticated
 * would make them meaningless.
 *
 * What protects it instead of a credential: a per-email and per-address rate
 * limit checked before any hashing, a password check that costs the same
 * whether or not the account exists, and a refusal that names neither half.
 */
app.use("/api/auth", publicAuthRouter());

app.use("/api", authenticate, sameOriginForSessions, api);

/**
 * A HEAD TO A PAID ROUTE IS REFUSED, AHEAD OF EVERYTHING ELSE ON IT.
 *
 * The route table above says `GET`, and the library compares the verb exactly,
 * so it never asked for payment on a HEAD. Express then answered the HEAD with
 * the GET handler, which ran with no payment at all -- while the facilitator was
 * down as well as up -- and dropped the body. Nothing paid leaves in that body,
 * but a paid handler with a side effect would have run it for free.
 *
 * Listing HEAD in the table, so it is quoted like GET, is the other way to close
 * it, and a worse one: a payer who answered the quote would be charged for
 * headers alone. So the HEAD is refused, and told what to send.
 *
 * Which routes are paid is asked of the library's own matcher, as the guard
 * below does -- but asked as a GET, because a GET is how the table lists them
 * and the matcher cannot say "paid" about a HEAD. Case, trailing slashes and
 * any route added to the table later are therefore covered without a second
 * list. It is mounted ahead of the guard so the answer does not depend on the
 * payment network, and ahead of the payment middleware so nothing is verified.
 */
app.use((req, res, next) => {
  if (req.method.toUpperCase() !== "HEAD") return next();
  const paid = paidHttpServer.requiresPayment({
    adapter: new ExpressAdapter(req),
    path: req.path,
    method: "GET",
  });
  if (!paid) return next();
  res.set("Allow", "GET");
  res.status(405).json({ error: "GET only" });
});

/**
 * Refuses a paid route while its handshake has not succeeded.
 *
 * ITS OWN MIDDLEWARE, AHEAD OF THE PAYMENT ONE, never a wrapper that decides
 * whether to call it: from here a request can only be refused or passed on to
 * the payment middleware, which it can never skip. Which routes are paid is
 * asked of the library's own matcher, so this cannot disagree with the
 * middleware about case, trailing slashes or a route added later.
 *
 * Without this guard the result is still closed -- the unsynced middleware
 * throws on the first paid request and the error handler answers 500 before
 * the handler runs -- but a payer deserves "try again shortly" with a time.
 */
app.use(async (req, res, next) => {
  if (paidFacilitator.isReady()) return next();
  const paid = paidHttpServer.requiresPayment({
    adapter: new ExpressAdapter(req),
    path: req.path,
    method: req.method,
  });
  if (!paid || (await paidFacilitator.ready())) return next();
  res.set("Retry-After", String(RETRY_AFTER_SECONDS));
  res.status(503).json({ error: "this endpoint is temporarily unavailable" });
});

app.use(paymentMiddlewareFromHTTPServer(paidHttpServer, undefined, undefined, false));

app.get("/paid-hello", (_req, res) => {
  res.json({ message: "You paid for this.", paidAt: new Date().toISOString() });
});

app.get("/paid-hello-large", (_req, res) => {
  res.json({ message: "You paid five times as much for this.", paidAt: new Date().toISOString() });
});

/**
 * The QuickBooks OAuth callback — THE ONE UNAUTHENTICATED ROUTE THAT DOES WORK.
 *
 * Mounted here rather than on the /api router because it is reached by a
 * browser redirect from Intuit, which carries no `Authorization` header and so
 * cannot pass `authenticate`. That is not a gap being tolerated; it is what an
 * OAuth callback is. What protects it instead:
 *
 *   - `state` is 32 CSPRNG bytes that Fuel issued, stored durably and bound to
 *     one company, and consumed by a guarded UPDATE so a replay changes no rows
 *     (src/db/qbo.ts). A caller who cannot produce an unused, unexpired state
 *     gets nothing.
 *   - The authorization code is worthless without `client_secret`, which lives
 *     only in this process's environment and is presented at token exchange.
 *   - The redirect URI is registered with Intuit and matched exactly, so a code
 *     cannot be delivered anywhere else.
 *
 * It deliberately renders plain text rather than JSON: a human is looking at
 * this in a browser tab, and it is the last step of a setup flow.
 */
/**
 * Where the OAuth callback sends the operator afterwards.
 *
 * Read from the environment with a loopback default, and validated here rather
 * than trusted: a malformed value would otherwise surface as a broken redirect
 * at the end of a successful connection, which is a confusing place to discover
 * a typo. Only the origin is used — any path or query on the configured value
 * is discarded, so this cannot be pointed at an arbitrary URL.
 */
/**
 * The QuickBooks OAuth callback.
 *
 * Mounted here rather than on the /api router because a browser redirect
 * arriving from Intuit carries no bearer token and so cannot pass
 * `authenticate`. The handler itself lives in src/quickbooks/callback.ts so
 * that it can be driven by a test — this file calls listen() at import time,
 * which put the one unauthenticated route in the system out of reach of every
 * verification suite.
 */
app.get("/integrations/quickbooks/callback", quickBooksCallback);

/**
 * THE PAID GATEWAY — the first route in this product reachable with no
 * credential at all.
 *
 * Mounted after `/api` and therefore outside `authenticate`, which is
 * positional. That is not an oversight: this route is authenticated by
 * PAYMENT, not by a shared secret. A caller proves nothing about who they are
 * and everything about what they have paid.
 *
 * What stands in for a credential, since none is presented: a rate limiter
 * that runs before any database read, an endpoint that cannot be enabled until
 * Fuel has measured its origin refusing unsigned traffic, a replay defence
 * keyed on the payment authorization itself, and a concurrency ceiling that
 * keeps a flood here from degrading the authenticated surface next door.
 * src/gateway/route.ts carries the reasoning for each.
 */
app.use(GATEWAY_PREFIX, gatewayRouter());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// LAST, after every route: an unexpected error is answered with a plain 500
// and logged here, never echoed to the caller with its message and stack.
// See src/lib/errors.ts and ADR 0018.
app.use(unhandledErrors);

// Loopback plus role-bearing secrets on /api (authenticate, above) — two
// layers, neither a substitute for the other. Binding to 127.0.0.1 keeps /api
// off the LAN; the keys still matter for anything else already running on this
// machine. Per-AGENT credentials remain future work: the agent key is shared,
// so it identifies a role, not a particular agent.
// Anything stranded by a previous crash is resolved before we serve a single
// request, so the first cap check of this process sees an accurate total.
reap("startup");
// Both payment handshakes, started here rather than when their modules load,
// so importing a module never reaches the network. Each is retried in the
// background until it succeeds; until then its paid routes answer 503 and
// everything else -- caps, approvals, the dashboard's API -- serves as usual.
gatewayFacilitator.start();
paidFacilitator.start();
// And again periodically, to catch a request that hangs without crashing.
// unref so a pending timer never holds the process open.
setInterval(() => reap("periodic"), REAP_INTERVAL_MS).unref();

/**
 * ALERTING RUNS ON ITS OWN TIMER, NOT INSIDE `reap()` (ADR 0021).
 *
 * The reaper gives budget back and takes permission away on a clock; alerting
 * is useful and optional. On separate timers, a slow, throwing or overlapping
 * sweep cannot skip a reaper pass, and the loop's overlap guard skips a sweep
 * tick rather than ever running two at once. src/alerts/loop.ts says what
 * separate timers do NOT change: a synchronous per-company segment still holds
 * the event loop while it runs.
 *
 * Logs only that a sweep or a company failed, never an error message: nothing
 * about a tenant, and nothing that could carry a webhook URL, reaches the log.
 */
startSweepLoop({
  sweep: () =>
    sweepAll({
      now: () => new Date(),
      dispatcher: alertDispatcher,
      onCompanyError: (companyId) => console.error(`[alerts] sweep failed for company ${companyId}`),
    }),
  intervalMs: ALERT_SWEEP_INTERVAL_MS,
  onFailure: () => console.error("[alerts] a sweep failed; the next one will run as usual"),
  runNow: true,
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Fuel on http://localhost:${PORT}`);
  // Whether sign-in limits trust the dashboard's client address (ADR 0020).
  // Names peers and the ceiling, never the key.
  console.log(`  ${describeRelay(RELAY_CONFIG)}`);
  console.log(`  POST /api/agents            — create an agent (name, teamId, spendCapUsd)  [operator]`);
  console.log(`  GET  /api/agents            — list agents with cap and spend             [operator]`);
  console.log(`  POST /api/agents/:id/pay    — cap-checked payment (url)                    [agent]`);
  console.log(
    `      caps → rate limit (${baseUnitsToDollars(MAX_SPEND_PER_WINDOW_BASE_UNITS)}/${VELOCITY_WINDOW_MS / 1000}s, 429) → anomaly check (202)`,
  );
  console.log(`  PATCH /api/agents/:id       — set one agent's cap                          [operator]`);
  console.log(`  POST /api/agents/:id/freeze|unfreeze — stop or resume an agent (423)       [operator]`);
  console.log(`  GET/PATCH /api/company      — ceiling across every team                  [operator]`);
  console.log(`  GET/POST /api/teams         — teams, each with its own ceiling           [operator]`);
  console.log(`  GET/PATCH /api/teams/:id    — one team, its agents, its cap              [operator]`);
  console.log(`  GET  /api/approvals         — payments held for a human (?status=pending) [operator]`);
  console.log(`  GET  /api/approvals/:id     — one request, so an agent can check its own    [either]`);
  console.log(`  POST /api/approvals/:id/approve|deny — decide one                          [operator]`);
  console.log(`  GET  /api/exports/transactions.csv — accounting export (?from=&to=&include=) [operator]`);
  console.log(`  POST /api/postings/run      — roll sub-cent spend into postable lines     [operator]`);
  console.log(`  GET  /api/postings[/:id]    — posted lines, and what they are made of     [operator]`);
  console.log(`  GET/POST /api/integrations/quickbooks/status|connect — SANDBOX only       [operator]`);
  console.log(`  GET  /integrations/quickbooks/callback — OAuth return (unauthenticated, state-guarded)`);
  console.log(`    /api requires Authorization: Bearer <key>. Two disjoint credentials:`);
  console.log(`      FUEL_API_KEY   = operator — sets caps, approves; CANNOT pay`);
  console.log(`      FUEL_AGENT_KEY = agent    — pays; CANNOT approve or change a cap`);
  console.log(`  GET  /paid-hello            — test merchant, $0.001 → ${payTo}`);
  console.log(`  GET  /paid-hello-large      — test merchant, $0.005 (trips anomaly check)`);
  console.log(`  GET  /health                — free`);
});
