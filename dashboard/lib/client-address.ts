// NO "@/" IMPORTS AND NO "server-only", for the reason middleware.ts records:
// scripts/verify-api.ts imports this module and asks it real questions. Only
// Next resolves "@/", and "server-only" throws outside a Next server build.
import { createHash, timingSafeEqual } from "node:crypto";

/** Must match lib/edge.mjs. verify-api asserts that the two agree. */
export const CLIENT_ADDRESS_HEADER = "x-fuel-client-address";
export const EDGE_PROOF_HEADER = "x-fuel-edge-proof";
export const MIN_EDGE_PROOF_LENGTH = 32;

/**
 * The browser's address, as recorded by this dashboard's own edge, or null.
 *
 * WHY A PROOF AND NOT JUST THE HEADER. Behind server.mjs the edge deletes and
 * rewrites `x-fuel-client-address` on every request, so the header alone would
 * be honest. But the dashboard can still be started without the edge, with
 * `next start` or `next dev`, and then nothing strips the header: a browser
 * could send its own, and this file would hand a value it chose to Fuel as
 * genuine. The proof is a random value the edge makes per process and stamps
 * on every request. Without the edge there is no proof, so there is no
 * address, and the relays refuse rather than forward something spoofable.
 *
 * THE ORDER IS THE POINT (security review, F5). The proof is required to be a
 * real secret BEFORE anything is compared. Otherwise an unset proof and a
 * missing header could match each other, and an empty proof could match an
 * empty header a browser sent. Both are exactly the `next start` case this
 * exists to close.
 *
 * Compared as SHA-256 digests in constant time, as `roleFor` does in
 * src/lib/auth.ts: equal-length inputs for `timingSafeEqual`, and no early exit
 * that would tell a guesser how much of the value was right.
 *
 * It does not validate the address's shape. That is the API's job, done once,
 * in src/lib/client-key.ts. A second, different validator here could only
 * disagree with it.
 */
export function verifiedClientAddress(
  headers: Pick<Headers, "get">,
  proof: string | undefined,
): string | null {
  if (typeof proof !== "string" || proof.length < MIN_EDGE_PROOF_LENGTH) return null;
  const presented = headers.get(EDGE_PROOF_HEADER);
  if (presented === null) return null;
  if (!timingSafeEqual(sha256(presented), sha256(proof))) return null;
  const address = headers.get(CLIENT_ADDRESS_HEADER);
  return address === null || address === "" ? null : address;
}

/**
 * Fuel's relay refusals: the dashboard's relay was not believed (ADR 0020).
 *
 * A COPY of RELAY_CODES in src/auth/codes.ts, not an import of it. The
 * dashboard never compiles code from outside its own directory, and
 * verify-api asserts the two lists are identical, so they cannot drift apart
 * silently.
 */
export const RELAY_REFUSAL_CODES = ["relay_rejected", "malformed_client_address"] as const;

/** True when Fuel refused the relay itself, not the person signing in. */
export function isRelayRefusal(code: string | null): boolean {
  return code !== null && (RELAY_REFUSAL_CODES as readonly string[]).includes(code);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
