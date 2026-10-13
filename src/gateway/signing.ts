/**
 * How an origin tells a Fuel-forwarded request from a direct one.
 *
 * WHY A SIGNATURE AND NOT A SHARED-SECRET HEADER. A static header is a bearer
 * token that replays forever: it appears in the origin's access log, in any
 * proxy between them, in an error report, and anyone who ever sees one can
 * forge Fuel's traffic indefinitely. A signature over a timestamp and a nonce
 * expires on its own and cannot be reused.
 *
 * WHAT IT DOES AND DOES NOT PROVE. It proves a request came from something
 * holding this endpoint's forward secret — which is Fuel. It does NOT prove the
 * origin actually checks it; that is what the probes in probes.ts measure, and
 * the reason they exist at all is that Fuel cannot enforce anything on someone
 * else's server.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIG_HEADER = "x-fuel-signature";
export const TIMESTAMP_HEADER = "x-fuel-timestamp";
export const NONCE_HEADER = "x-fuel-nonce";

/**
 * How far out of step an origin's clock may be before it should refuse.
 *
 * Advisory — Fuel cannot make an origin enforce it — but it is documented so a
 * customer implementing the check has a number rather than a guess, and so the
 * window a captured signature stays valid for is a stated five minutes rather
 * than whatever each origin happens to pick.
 */
export const MAX_SKEW_SECONDS = 300;

export interface SignedHeaders {
  [SIG_HEADER]: string;
  [TIMESTAMP_HEADER]: string;
  [NONCE_HEADER]: string;
}

/**
 * The bytes covered by the signature.
 *
 * Method and path are in it so a signature captured from one request cannot be
 * replayed against a different one on the same origin. Timestamp and nonce are
 * in it so it cannot be replayed against the SAME request later. Newline-joined
 * with the fields fixed in number and order, so no field can be shifted into
 * another's position by choosing a value containing the separator.
 */
function canonical(method: string, path: string, timestamp: string, nonce: string): string {
  return [method.toUpperCase(), path, timestamp, nonce].join("\n");
}

export function signRequest(params: {
  secret: string;
  method: string;
  path: string;
  timestamp?: string;
  nonce?: string;
}): SignedHeaders {
  const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000).toString();
  // Per REQUEST. Not to be confused with earning_endpoints.ownership_nonce,
  // which is issued once per registration and proves a different thing.
  const nonce = params.nonce ?? randomBytes(16).toString("base64url");
  const signature = createHmac("sha256", params.secret)
    .update(canonical(params.method, params.path, timestamp, nonce))
    .digest("base64url");

  return {
    [SIG_HEADER]: `v1=${signature}`,
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
  };
}

/**
 * Verifies a signature the way an origin should.
 *
 * Not used by the gateway — Fuel signs, it does not verify — but shipped here
 * so the reference implementation a customer copies is the same code Fuel's own
 * tests exercise, rather than prose in a document that can drift from it.
 */
export function verifySignature(params: {
  secret: string;
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  nowSeconds?: number;
}): boolean {
  const presented = params.headers[SIG_HEADER];
  const timestamp = params.headers[TIMESTAMP_HEADER];
  const nonce = params.headers[NONCE_HEADER];
  if (!presented || !timestamp || !nonce) return false;

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const at = Number(timestamp);
  if (!Number.isFinite(at) || Math.abs(now - at) > MAX_SKEW_SECONDS) return false;

  const expected = `v1=${createHmac("sha256", params.secret)
    .update(canonical(params.method, params.path, timestamp, nonce))
    .digest("base64url")}`;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Length-check first: timingSafeEqual throws on a mismatch, and a length
  // difference is not secret anyway.
  return a.length === b.length && timingSafeEqual(a, b);
}
