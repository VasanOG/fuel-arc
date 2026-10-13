/**
 * What verify-startup seeds and how it reads a price quote, in one place, so
 * the quotes it compares against (scripts/fixtures/x402-quotes-main.json) were
 * recorded by exactly the same seeding and the same field-picking.
 *
 * Import this only after FUEL_DB_PATH points at a test database: seeding
 * imports the database layer, which opens FUEL_DB_PATH when it loads.
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";

/** The gateway endpoint every gateway check uses, and the quote fixture was recorded with. */
export const QUOTE_SEED = {
  agentName: "research-bot",
  originUrl: "https://seller.fuel-test.example/forecast",
  priceBaseUnits: "50000",
  label: "verify-startup gateway",
  /** What /paid-hello and /paid-hello-large quote as their recipient. */
  payTo: "0x0000000000000000000000000000000000000402",
} as const;

/**
 * A second enabled endpoint whose ownership proof is older than the re-check
 * interval, so the API's startup reaper probes it. The probe resolves this
 * hostname, and that lookup is the positive control for "the seller was not
 * contacted": the detector is shown to fire, in the same API process.
 */
export const CONTROL_SEED = {
  originUrl: "https://control.fuel-test.example/probe",
  priceBaseUnits: "1000",
  label: "verify-startup reaper control",
} as const;

export interface SeededEndpoints {
  gateway: { id: string; publicId: string };
  control: { id: string; publicId: string };
}

/**
 * Registers both endpoints and switches them on, the way an operator's checks
 * would: through recordVerification and setEnabled, never a raw UPDATE.
 */
export async function seedGatewayEndpoints(): Promise<SeededEndpoints> {
  const { db } = await import("../../src/db/index.js");
  const { registerEndpoint, recordVerification, setEnabled } = await import("../../src/db/earning-endpoints.js");
  const agent = db.prepare("SELECT id FROM agents WHERE name = ?").get(QUOTE_SEED.agentName) as { id: string } | undefined;
  if (!agent) throw new Error(`the test database has no agent named ${QUOTE_SEED.agentName}`);

  const enable = (originUrl: string, priceBaseUnits: string, label: string, provedAt: Date) => {
    const { endpoint } = registerEndpoint({ agentId: agent.id, originUrl, priceBaseUnits: BigInt(priceBaseUnits), label });
    const at = provedAt.toISOString();
    recordVerification(endpoint.id, {
      ownershipProvedAt: at,
      ownershipAddress: null,
      probeUnsignedAt: at,
      probeBadSigAt: at,
      blockedReason: null,
    });
    const on = setEnabled(endpoint.id, true);
    return { id: on.id, publicId: on.publicId };
  };

  return {
    // Proved just now: the reaper leaves it alone, so nothing but a payment
    // request could ever make Fuel resolve its hostname.
    gateway: enable(QUOTE_SEED.originUrl, QUOTE_SEED.priceBaseUnits, QUOTE_SEED.label, new Date()),
    // Proved 13 hours ago: past OWNERSHIP_RECHECK_MS, so the reaper probes it at boot.
    control: enable(CONTROL_SEED.originUrl, CONTROL_SEED.priceBaseUnits, CONTROL_SEED.label, new Date(Date.now() - 13 * 3_600_000)),
  };
}

/**
 * The parts of a 402 quote that are payment terms. The resource URL is left
 * out: it carries the endpoint's public id, which is random per database.
 */
export function pickQuote(header: string | null): unknown {
  if (!header) return null;
  const required = decodePaymentRequiredHeader(header);
  return {
    x402Version: required.x402Version,
    accepts: required.accepts.map((a) => ({
      scheme: a.scheme,
      network: a.network,
      amount: a.amount,
      asset: a.asset,
      payTo: a.payTo,
      maxTimeoutSeconds: a.maxTimeoutSeconds,
      extra: a.extra ?? null,
    })),
    description: required.resource?.description ?? null,
    mimeType: required.resource?.mimeType ?? null,
  };
}
