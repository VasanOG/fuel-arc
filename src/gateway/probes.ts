/**
 * Measuring what Fuel cannot enforce.
 *
 * Fuel has no power over someone else's server. What it can do is supply a
 * mechanism, check whether the origin honours it, and refuse to claim a paywall
 * it has not observed working. That is the whole of what this file does, and
 * the honest framing matters: these are measurements, not controls.
 *
 * TWO INDEPENDENT QUESTIONS, and neither answers the other:
 *
 *   Ownership — "does this operator control the origin?" This is what stops
 *   Fuel being pointed at a third party and used as a paid relay. Fixing the
 *   SSRF guard does NOT address it: a correct SSRF guard still permits every
 *   public address, by design.
 *
 *   Bypass — "does the origin actually refuse traffic that did not come through
 *   Fuel?" This is what makes the paywall real. An origin that answers anyone
 *   who calls it directly has not been fronted; it has merely acquired a second,
 *   paid route while the free one stays open, and the origin URL is not a
 *   secret — it is discoverable through DNS, a log, a referrer, or a guess.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { ORIGIN_TIMEOUT_MS, ORIGIN_MAX_RESPONSE_BYTES } from "../payments/limits.js";
import { safeFetch } from "../lib/safe-fetch.js";
import { signRequest, NONCE_HEADER, SIG_HEADER, TIMESTAMP_HEADER } from "./signing.js";
import {
  forwardSecretFor,
  recordVerification,
  type EarningEndpoint,
} from "../db/earning-endpoints.js";

/** Where an origin must echo the nonce Fuel issued it. */
export const OWNERSHIP_PATH = "/.well-known/fuel-origin-verification";

/**
 * How long an ownership proof stands before it must be re-established.
 *
 * NAMED, BECAUSE "PERIODICALLY" IS NOT A SPECIFICATION. This number is exactly
 * the window in which an operator can prove ownership once and then repoint DNS
 * at a public host they do not control, with Fuel still relaying paid traffic
 * there. Twelve hours is short enough to bound that and long enough not to hammer
 * a customer's origin.
 */
export const OWNERSHIP_RECHECK_MS = 12 * 60 * 60 * 1000;

/**
 * Every probe uses the same policy, and `allowLoopback: false` is the load-
 * bearing half.
 *
 * These dereference an operator-supplied, entirely unvetted URL before any trust
 * exists — the single most hostile fetch in the codebase. The byte cap applies
 * here for the same reason it applies to a forward: a probe response is an
 * origin-controlled body, and nothing about being a probe makes it smaller.
 */
const PROBE_POLICY = { allowLoopback: false, maxBytes: ORIGIN_MAX_RESPONSE_BYTES } as const;

function deadline(): AbortSignal {
  return AbortSignal.timeout(ORIGIN_TIMEOUT_MS);
}

export interface ProbeOutcome {
  ownershipProvedAt: string | null;
  ownershipAddress: string | null;
  probeUnsignedAt: string | null;
  probeBadSigAt: string | null;
  blockedReason: string | null;
}

/**
 * Does the origin echo the nonce Fuel issued?
 *
 * WHAT THIS DOES NOT PROVE, stated plainly: on a host where an attacker can
 * publish a file at an arbitrary path — object storage with public read, a
 * static-site host, a pastebin — this is satisfiable for a domain they do not
 * own. It genuinely stops the naive relay case and is worth having; it is not a
 * general proof of control. And it proves control, not benign use: a registrant
 * who really does control an origin can still make it a forwarding proxy to
 * anywhere. Ownership proof makes relay abuse attributable to an operator
 * credential. It does not prevent it.
 */
async function proveOwnership(
  endpoint: EarningEndpoint,
): Promise<{ ok: true; address: string | null } | { ok: false; reason: string }> {
  const url = new URL(OWNERSHIP_PATH, endpoint.originUrl).href;
  let body: string;
  try {
    const response = await safeFetch(url, PROBE_POLICY, { signal: deadline() });
    if (!response.ok) {
      return { ok: false, reason: `the origin answered ${response.status} at ${OWNERSHIP_PATH}` };
    }
    body = (await response.text()).trim();
  } catch (error) {
    return {
      ok: false,
      reason: `could not reach ${OWNERSHIP_PATH} on the origin: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (body !== endpoint.ownershipNonce) {
    return { ok: false, reason: `${OWNERSHIP_PATH} did not return the expected verification value` };
  }

  // Recorded so a later re-check can notice the origin moved, which is the
  // failure this interval exists to bound.
  let address: string | null = null;
  try {
    address = (await dnsLookup(new URL(endpoint.originUrl).hostname)).address;
  } catch {
    address = null; // best effort; a resolvable origin just proved itself reachable
  }

  return { ok: true, address };
}

/**
 * Does the origin refuse a request that is not properly signed?
 *
 * TWO PROBES, NOT ONE, and the second is the one that catches a real
 * misimplementation. Probing only "no headers at all" passes an origin that
 * checks the signature header is PRESENT without validating it — and the header
 * names are not secret, so any caller could then set them to garbage and walk
 * straight through a check that Fuel had certified as working.
 */
async function probeRefusesUnsigned(
  endpoint: EarningEndpoint,
  variant: "unsigned" | "bad-signature",
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = endpoint.originUrl;
  const path = new URL(url).pathname;

  const headers: Record<string, string> =
    variant === "unsigned"
      ? {}
      : {
          // Correct names, correct shape, wrong secret.
          ...signRequest({ secret: "not-the-forward-secret", method: "GET", path }),
        };

  try {
    const response = await safeFetch(url, PROBE_POLICY, { headers, signal: deadline() });
    if (response.status >= 200 && response.status < 400) {
      return {
        ok: false,
        reason:
          variant === "unsigned"
            ? `the origin served a request carrying no Fuel signature (${response.status}), so the paywall can be bypassed by calling it directly`
            : `the origin served a request whose Fuel signature was invalid (${response.status}); it appears to check that the header is present without verifying it`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `could not complete the bypass probe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Runs every check and records the result.
 *
 * Ownership first, and it short-circuits: until Fuel knows the operator
 * controls this origin, sending it signed traffic — even a probe — is sending
 * traffic to a stranger on an operator's say-so.
 */
export async function verifyEndpoint(endpoint: EarningEndpoint): Promise<ProbeOutcome> {
  const now = () => new Date().toISOString();

  const ownership = await proveOwnership(endpoint);
  if (!ownership.ok) {
    const outcome: ProbeOutcome = {
      ownershipProvedAt: null,
      ownershipAddress: null,
      probeUnsignedAt: null,
      probeBadSigAt: null,
      blockedReason: ownership.reason,
    };
    recordVerification(endpoint.id, outcome);
    return outcome;
  }

  const unsigned = await probeRefusesUnsigned(endpoint, "unsigned");
  const badSig = await probeRefusesUnsigned(endpoint, "bad-signature");

  const outcome: ProbeOutcome = {
    ownershipProvedAt: now(),
    ownershipAddress: ownership.address,
    probeUnsignedAt: unsigned.ok ? now() : null,
    probeBadSigAt: badSig.ok ? now() : null,
    blockedReason: !unsigned.ok ? unsigned.reason : !badSig.ok ? badSig.reason : null,
  };
  recordVerification(endpoint.id, outcome);
  return outcome;
}

/** Silences the unused-import warning for a symbol kept for the reference docs. */
export const PROBE_HEADER_NAMES = [SIG_HEADER, TIMESTAMP_HEADER, NONCE_HEADER];

/** The secret accessor, re-exported so the forwarder has one import site. */
export { forwardSecretFor };
