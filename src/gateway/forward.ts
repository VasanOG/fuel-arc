/**
 * Calling the customer's origin, and deciding what is allowed to cross in each
 * direction.
 *
 * Both boundaries are allowlists. A denylist here fails open — it protects
 * against the headers someone thought of, and passes everything else — and on
 * the response side that failure has a specific, expensive shape, described at
 * RESPONSE_HEADERS below.
 */
import { ORIGIN_MAX_RESPONSE_BYTES, ORIGIN_TIMEOUT_MS } from "../payments/limits.js";
import { ResponseTooLargeError, safeFetch } from "../lib/safe-fetch.js";
import { forwardSecretFor } from "../db/earning-endpoints.js";
import { signRequest } from "./signing.js";
import type { EarningEndpoint } from "../db/earning-endpoints.js";

/**
 * Response headers that may reach the payer. Everything else is dropped.
 *
 * IT MUST BE AN ALLOWLIST, AND HERE IS THE CONCRETE REASON. `@x402/express`'s
 * middleware reads a `Settlement-Overrides` response header off the handler to
 * decide what to actually charge. Under a denylist, an origin that set that
 * header would be choosing the settlement terms of its own payment. Fuel does
 * not use that middleware — the gateway drives the primitives directly — but
 * the shape of the mistake is general: a denylist must enumerate every
 * dangerous name that exists now and every one added later, and it only has to
 * miss one.
 *
 * `set-cookie` and `www-authenticate` are the other obvious ones: the first
 * would let an origin set state in a payer's client under Fuel's origin, the
 * second would invite credentials to be sent to Fuel that belong to someone
 * else.
 *
 * `content-encoding` is deliberately absent — see the decision below.
 */
const RESPONSE_HEADERS = ["content-type", "etag", "cache-control", "last-modified"];

/**
 * Request headers Fuel sends. The caller's own headers are not among them.
 *
 * NOTHING FROM THE PAYER CROSSES. Relaying caller headers would let an
 * anonymous party set `Host`, `Authorization`, `Cookie` or `X-Forwarded-For` on
 * a request the origin reads as coming from Fuel — which is exactly the trust
 * the signature is meant to establish, handed to the caller instead.
 */
export function buildForwardHeaders(secret: string, path: string): Record<string, string> {
  return {
    accept: "*/*",
    "user-agent": "Fuel-Gateway/1.0",
    // Refuse a compressed response rather than negotiate one. See below.
    "accept-encoding": "identity",
    ...signRequest({ secret, method: "GET", path }),
  };
}

function requestHeaders(endpoint: EarningEndpoint, path: string): Record<string, string> {
  return buildForwardHeaders(forwardSecretFor(endpoint.id), path);
}

/**
 * Keeps only what may cross back to the payer.
 *
 * Pure and exported so the allowlist can be tested for what it DROPS, not just
 * what it keeps — a denylist bug is invisible from the happy path, and the
 * headers that matter most here are the ones that must never appear.
 */
export function pickResponseHeaders(
  read: (name: string) => string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = read(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

export type ForwardResult =
  | { ok: true; status: number; headers: Record<string, string>; body: Uint8Array }
  | {
      ok: false;
      /** Safe to show an anonymous caller. Names nothing about the origin. */
      reason: string;
      /** For the receipt and the log only. May name the origin. */
      detail?: string;
    };

/**
 * Fetches the origin into a buffer.
 *
 * BUFFERED, NOT STREAMED, and that is required rather than convenient: the
 * payer must not receive a single byte until settlement confirms, so the body
 * has to be held somewhere until then. `ORIGIN_MAX_RESPONSE_BYTES` is therefore
 * a direct bound on memory an anonymous caller can make Fuel allocate.
 *
 * THE QUERY STRING IS REBUILT, NOT RELAYED. `URLSearchParams` re-serialises
 * what the caller sent, so what reaches the origin is a string Fuel
 * constructed. No caller-supplied path segment is appended at all — an endpoint
 * maps to exactly one URL, which is what keeps `/earn/<id>/../../admin` from
 * being a request anyone can make.
 */
export async function forwardToOrigin(
  endpoint: EarningEndpoint,
  query: URLSearchParams,
): Promise<ForwardResult> {
  let target: URL;
  try {
    target = new URL(endpoint.originUrl);
  } catch {
    return { ok: false, reason: "this endpoint is misconfigured" };
  }
  target.search = query.toString();

  let response: Awaited<ReturnType<typeof safeFetch>>;
  try {
    response = await safeFetch(
      target.href,
      // allowLoopback: false. This dereferences a customer-supplied URL on
      // behalf of an anonymous payer — the case the policy parameter exists
      // for, and the reason the old blanket exemption had to end.
      { allowLoopback: false, maxBytes: ORIGIN_MAX_RESPONSE_BYTES },
      {
        method: "GET",
        headers: requestHeaders(endpoint, target.pathname),
        signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
      },
    );
  } catch (error) {
    /*
     * WHAT THE CALLER IS TOLD AND WHAT THE OPERATOR IS TOLD ARE DIFFERENT, AND
     * THAT IS THE POINT.
     *
     * The raw error here names the origin: `getaddrinfo ENOTFOUND <hostname>`,
     * `ECONNREFUSED <ip>:<port>`, or safe-fetch's own "Refusing to connect to
     * <hostname>: <address> is not a public address". An earlier version
     * interpolated that straight into the 502 body — which handed the
     * customer's origin hostname and resolved address to any anonymous caller
     * willing to trigger a DNS blip or catch a deploy. The public id is opaque
     * precisely so a payer never learns the origin; leaking it in an error
     * message gives back what the whole design withholds.
     *
     * So `reason` is generic, and `detail` — which reaches the receipt and the
     * log, where an operator can see it — carries the real message.
     */
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof ResponseTooLargeError) {
      return { ok: false, reason: "the origin's response was too large", detail };
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      return { ok: false, reason: "the origin did not respond in time", detail };
    }
    return { ok: false, reason: "the origin could not be reached", detail };
  }

  /*
   * WHICH ORIGIN STATUSES COUNT AS "SERVED", DECIDED RATHER THAN INHERITED.
   *
   * A 404 or a 422 can be a perfectly legitimate paid answer — the payer asked
   * for something that does not exist, and the origin did the work of telling
   * them. Those settle.
   *
   * 401 and 403 are different in kind: they mean the origin rejected FUEL, not
   * the payer. The most likely cause is the anti-bypass check misreading Fuel's
   * own signature — i.e. the customer's infrastructure is wrong. Billing a
   * payer for a customer's misconfiguration is the wrong party bearing it, and
   * without this line the natural failure mode of a half-implemented signature
   * check is a stream of paid-for 401s.
   */
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: "the origin refused this request",
      detail: `origin answered ${response.status} — it may be rejecting Fuel's forward signature`,
    };
  }

  if (response.status >= 500) {
    return { ok: false, reason: "the origin failed to serve this request", detail: `origin answered ${response.status}` };
  }

  /*
   * CONTENT-ENCODING, decided rather than inherited.
   *
   * The byte cap counts bytes off the wire. If a compressed body were relayed,
   * the cap would be measured in compressed bytes while the payer decompressed
   * something far larger — a compression bomb passing a limit that appears to
   * hold. Stripping the header while forwarding compressed bytes is worse
   * still: the payer gets undecodable data.
   *
   * So Fuel asks for `identity` above and refuses anything else here. Declining
   * compression on a metered API response costs bandwidth; accepting it would
   * cost a bound that means what it says.
   */
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    return { ok: false, reason: "the origin sent a compressed response, which this gateway refuses" };
  }

  return {
    ok: true,
    status: response.status,
    headers: pickResponseHeaders((n) => response.headers.get(n)),
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

export const FORWARD_RESPONSE_HEADERS = RESPONSE_HEADERS;
