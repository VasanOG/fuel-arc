/**
 * Which environment Fuel is actually running against, as a display fact.
 *
 * WHAT THIS IS FOR. The dashboard needs to tell an operator, truthfully,
 * whether they are looking at sandbox activity. It must not assert that from a
 * constant in the browser: the whole argument of the pinned constants is that
 * the environment is a property of the deployed code, and a badge hardcoded in
 * the frontend would assert exactly the thing it is supposed to prove.
 *
 * WHAT IT MUST NOT DO. It reports a verdict, never the evidence. The constants
 * below are origins, network identifiers and provider base paths; none of them
 * leaves this module. It makes no network call, no provider call and no
 * database read — a read-only display endpoint that quietly dialled Fireblocks
 * to answer "are we in sandbox" would be both slow and a new outbound path on a
 * surface that has no business having one.
 *
 * FAIL DIRECTION. A constant holding a value this file does not recognise
 * yields "unknown", never a default of "sandbox". Defaulting to sandbox is the
 * one answer that could tell someone their money is safe when it is not.
 */

import { BASE_PATH } from "../fireblocks/provision.js";
import { GATEWAY_PUBLIC_ORIGIN } from "../gateway/origin.js";
import { ALLOWED_NETWORK, FACILITATOR_URL } from "../payments/pay.js";
import { QBO_API_ORIGIN } from "../quickbooks/config.js";

export type EnvironmentName = "sandbox" | "production" | "unknown";

export interface SurfaceReport {
  key: string;
  label: string;
  environment: EnvironmentName;
}

export interface EnvironmentReport {
  environment: EnvironmentName;
  label: string;
  isProduction: boolean;
  surfaces: SurfaceReport[];
}

/**
 * Known values, exhaustively.
 *
 * A lookup rather than a pattern match: `startsWith("sandbox-")` would call
 * `https://sandbox-quickbooks.api.intuit.com.evil.example` a sandbox, which is
 * the same class of bug the QuickBooks origin guard already had to get right
 * (docs/decisions/0008). Exact equality, or unknown.
 */
const KNOWN: Record<string, EnvironmentName> = {
  // Payments rail
  "eip155:84532": "sandbox", // Base Sepolia
  "eip155:8453": "production", // Base mainnet
  // Settlement
  "https://x402.org/facilitator": "sandbox",
  // Custody
  "https://sandbox-api.fireblocks.io/v1": "sandbox",
  "https://api.fireblocks.io/v1": "production",
  // Accounting
  "https://sandbox-quickbooks.api.intuit.com": "sandbox",
  "https://quickbooks.api.intuit.com": "production",
  /*
   * Receiving — the fifth surface, added in 6B-3.
   *
   * The first four are all capabilities Fuel exercises AS A PAYER. Receiving is
   * the other direction, and it is the only surface where being "in production"
   * means strangers can reach Fuel rather than Fuel reaching someone else.
   *
   * Loopback is a real sandbox answer, not a placeholder: a gateway bound to
   * 127.0.0.1 is serving nobody. There is deliberately NO production entry
   * here yet — when the gateway is genuinely hosted, its real origin is added
   * alongside a reviewed change to GATEWAY_PUBLIC_ORIGIN, and until then an
   * unrecognised origin correctly yields "unknown" rather than inheriting
   * sandbox from its neighbours.
   */
  "http://127.0.0.1": "sandbox",
};

function classify(value: string): EnvironmentName {
  return KNOWN[value] ?? "unknown";
}

const LABELS: Record<EnvironmentName, string> = {
  sandbox: "Sandbox",
  production: "Production",
  unknown: "Unknown",
};

/**
 * Reduces the pinned constants to labels.
 *
 * The aggregate is "sandbox" ONLY when every surface is known to be sandbox.
 * Otherwise it is "production" if any surface is known to be production, and
 * "unknown" otherwise. A known production surface is the loudest true fact
 * available, and an unrecognised one is still not a reason to claim safety.
 */
export function describeEnvironment(): EnvironmentReport {
  const surfaces: SurfaceReport[] = [
    { key: "payments", label: "Payments", environment: classify(ALLOWED_NETWORK) },
    { key: "settlement", label: "Settlement", environment: classify(FACILITATOR_URL) },
    { key: "custody", label: "Custody", environment: classify(String(BASE_PATH)) },
    { key: "accounting", label: "Accounting", environment: classify(QBO_API_ORIGIN) },
    // The inbound direction. X402_PAY_TO is deliberately NOT what this
    // classifies: that is an address, and this table holds origins and network
    // ids. What distinguishes a gateway serving real traffic from one serving
    // nobody is the origin it answers on.
    { key: "receiving", label: "Receiving", environment: classify(GATEWAY_PUBLIC_ORIGIN) },
  ];

  const environment: EnvironmentName = surfaces.every((s) => s.environment === "sandbox")
    ? "sandbox"
    : surfaces.some((s) => s.environment === "production")
      ? "production"
      : "unknown";

  return {
    environment,
    label: LABELS[environment],
    // Advisory, for styling. A surface must never derive the environment from
    // anything other than `environment` itself.
    isProduction: environment === "production",
    surfaces,
  };
}
