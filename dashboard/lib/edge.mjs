/**
 * The dashboard's edge: what a request says about where it came from, decided
 * HERE, before Next sees it (ADR 0020).
 *
 * WHY THIS EXISTS. The Fuel API now keys sign-in and signup limits on the
 * browser's address, which only the dashboard can report, and the dashboard
 * cannot learn it from Next. Next 15 never shows a route handler the socket,
 * and it fills `x-forwarded-for` with `??=`
 * (node_modules/next/dist/server/base-server.js), so a value the BROWSER sent
 * is kept. A route handler reading that header reads whatever an attacker
 * wrote. The only thing that knows the real peer is the TCP socket, so the
 * header has to be written from it before Next runs.
 *
 * WHY A PLAIN .mjs MODULE. server.mjs runs under plain Node, without Next's
 * compiler, so it cannot import TypeScript. Keeping this logic out of
 * server.mjs also lets scripts/verify-api.ts import it and test it directly,
 * without starting a server.
 */

/** Hardcoded on purpose. `next start` honours a HOSTNAME variable, and this
 * does not, so nothing in the environment can widen the bind. */
export const EDGE_HOST = "127.0.0.1";
export const EDGE_PORT = 3100;

/** Header names, lowercase as Node presents them. */
export const CLIENT_ADDRESS_HEADER = "x-fuel-client-address";
export const EDGE_PROOF_HEADER = "x-fuel-edge-proof";

/** Where the per-process proof lives for route handlers to compare against. */
export const EDGE_PROOF_ENV = "FUEL_EDGE_PROOF";

/**
 * Every header that claims something about the request's origin. All of them
 * are DELETED before anything is stamped, so a client-written value can never
 * survive by being in a header this file forgot to overwrite.
 *
 * `forwarded` and `x-real-ip` are read by nothing in the dashboard today. They
 * are removed anyway, so that nothing added later which follows those
 * conventions can be handed a value the browser wrote.
 */
const ORIGIN_HEADERS = [
  CLIENT_ADDRESS_HEADER,
  EDGE_PROOF_HEADER,
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "x-real-ip",
];

/**
 * Rewrites a request's origin headers in place, from the socket and nothing
 * else.
 *
 * - The client address is the TCP peer, which a browser cannot write. If the
 *   socket has already gone (`remoteAddress` undefined), no address is stamped
 *   at all. The relay then refuses, which is better than stamping the string
 *   "undefined". A zone index (`fe80::1%en0`) names this host's interface, not
 *   the caller, so it is dropped. The API refuses `%` outright.
 * - `x-forwarded-host` is set to the request's own `Host`. That is what Next
 *   would fill in with no proxy in front, and it keeps a browser that reached us
 *   as `localhost:3100` working: Next's own middleware redirect moves browsers
 *   there (see middleware.ts). What it removes is a client making the two
 *   DIFFER, which is what anything comparing an Origin against
 *   `x-forwarded-host` would trust.
 * - `x-forwarded-proto` and `x-forwarded-port` describe this edge, which serves
 *   plain HTTP on one fixed port.
 * - The proof says "the edge wrote these". See lib/client-address.ts.
 *
 * Mutating `headers` is what Next reads: it builds a route handler's `Headers`
 * from `req.headers`, not from `rawHeaders`. The live spoof test in ADR 0020
 * proves that against the real server rather than assuming it.
 */
export function stampEdgeHeaders(headers, remoteAddress, proof) {
  for (const name of ORIGIN_HEADERS) delete headers[name];

  const address = typeof remoteAddress === "string" ? remoteAddress.split("%")[0] : "";
  if (address !== "") {
    headers["x-forwarded-for"] = address;
    headers[CLIENT_ADDRESS_HEADER] = address;
  }
  if (typeof headers.host === "string" && headers.host !== "") {
    headers["x-forwarded-host"] = headers.host;
  }
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-port"] = String(EDGE_PORT);
  headers[EDGE_PROOF_HEADER] = proof;
  return headers;
}
