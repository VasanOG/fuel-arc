/**
 * The gate every agent payment passes through.
 *
 * Ordering here is the whole point of Phase 1: the spend cap is checked and
 * budget is reserved BEFORE anything is signed. An EIP-3009 authorization is
 * spendable the instant it exists, and the facilitator — not Fireblocks —
 * broadcasts it, so Fireblocks' transaction policy engine never sees these
 * payments. This check is the only control that exists.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { recordFrozenAttempt, type Agent } from "../db/agents.js";
import { createApprovalRequest, type ApprovableScope } from "../db/approvals.js";
import {
  markFailedBeforeSigning,
  markSettled,
  markSigningStarted,
  recordAuthorizationWindow,
  markUnreconciled,
  reserveIfUnderCap,
  type CapScope,
} from "../db/payments.js";
import { baseUnitsToDollars } from "../lib/money.js";
import { safeFetch } from "../lib/safe-fetch.js";
import { FETCH_TIMEOUT_MS, MIN_TIMEOUT_SECONDS } from "./limits.js";
import { VELOCITY_WINDOW_MS } from "./velocity.js";
import { SignatureMayExistError, type PaymentSigner } from "./signer.js";
import { arcDemoRail, isArcDemoAgent } from "./arc-demo.js";

// The only network, asset and scheme Fuel will sign for. Hardcoded rather than
// env-driven, like every other network constant here.
export const ALLOWED_NETWORK = "eip155:84532";
/**
 * Moved here from src/server.ts in 5B-2. It is a payment-rail constant and it
 * had no business living in the file that calls listen() — src/lib/environment.ts
 * has to read it to report which rail Fuel is pinned to, and importing
 * server.ts to get a string would start an HTTP server as a side effect.
 */
export const FACILITATOR_URL = "https://x402.org/facilitator";
export const ALLOWED_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".toLowerCase();
export const ALLOWED_SCHEME = "exact";

/**
 * Ceiling on any single payment, independent of the cumulative cap.
 * Without this, one hostile endpoint can drain an agent's whole remaining
 * budget in a single call.
 */
export const MAX_PER_PAYMENT_BASE_UNITS = 10_000n; // $0.01

// Both bounds, and the relationship between them, live in ./limits.ts.

export type PayResult =
  | { outcome: "settled"; txHash: string; amountUsd: string; body: string }
  | { outcome: "blocked"; scope: CapScope; reason: string; spentUsd: string; capUsd: string }
  /** Refused by a ceiling above the agent, and queued for a human to decide. */
  | {
      outcome: "awaiting_approval";
      approvalRequestId: string;
      scope: "team" | "company";
      reason: string;
      amountUsd: string;
      spentUsd: string;
      capUsd: string;
    }
  /**
   * Passed every cap but out of character for this agent, and queued for the
   * same human decision. Carries the baseline instead of a cap: there is no
   * limit to raise here, and without the numbers an operator has nothing to
   * judge and approving becomes a rubber stamp.
   */
  | {
      outcome: "awaiting_approval";
      approvalRequestId: string;
      scope: "anomaly";
      reason: string;
      amountUsd: string;
      baselineUsd: string;
      thresholdUsd: string;
      sampleSize: number;
    }
  /** An operator stopped this agent. Outranks every other refusal. */
  | { outcome: "frozen"; reason: string; frozenAt: string; frozenReason: string | null }
  /** A redemption whose approval was not valid for this payment. */
  | { outcome: "approval_invalid"; reason: string }
  /**
   * Spending too fast. No approval request and no human: the window slides and
   * the agent proceeds, so the only useful thing to return is when to try again.
   */
  | {
      outcome: "rate_limited";
      reason: string;
      spentInWindowUsd: string;
      limitUsd: string;
      windowSeconds: number;
      retryAfterSeconds: number;
    }
  | { outcome: "failed"; reason: string };

/** The scheme, network and asset an agent may sign for: one rail per agent. */
export interface PaymentRail {
  scheme: string;
  network: string;
  asset: string;
}

/** Every agent's rail but one. Built from the pinned constants above, unchanged. */
const BASE_SEPOLIA_RAIL: PaymentRail = {
  scheme: ALLOWED_SCHEME,
  network: ALLOWED_NETWORK,
  asset: ALLOWED_ASSET,
};

/**
 * Which rail this agent pays on.
 *
 * Base Sepolia for every agent except the single Arc founder-demo agent named
 * by literal in ./arc-chain.ts. That agent gets Arc only when this process
 * holds its key, and otherwise is refused -- it never falls back to Base
 * Sepolia, and no other agent can reach Arc. See ./arc-demo.ts.
 */
export function railFor(
  agent: Pick<Agent, "id" | "teamId" | "address">,
): { ok: true; rail: PaymentRail } | { ok: false; reason: string } {
  return isArcDemoAgent(agent) ? arcDemoRail() : { ok: true, rail: BASE_SEPOLIA_RAIL };
}

function acceptable(
  r: { scheme?: string; network?: string; asset?: string },
  rail: PaymentRail,
): boolean {
  return (
    r.scheme === rail.scheme &&
    r.network === rail.network &&
    r.asset?.toLowerCase() === rail.asset.toLowerCase()
  );
}

export async function payForAgent(params: {
  agent: Agent;
  signer: PaymentSigner;
  url: string;
  /** Redeems a previously approved request; see reserveIfUnderCap. */
  approvalRequestId?: string;
}): Promise<PayResult> {
  const { agent, signer, url, approvalRequestId } = params;

  // 0. Frozen agents go no further — before the outbound fetch, not just before
  //    the reservation.
  //
  //    The authoritative check is inside reserveIfUnderCap's transaction; this
  //    one is containment. Without it a frozen agent still makes a request to a
  //    caller-supplied URL on every attempt, and "stopped" ought to mean it is
  //    not reaching the network at all, not merely that it cannot pay. The
  //    agent record is read at the start of the request, so this is a slightly
  //    stale view — which is fine, because anything it lets through still meets
  //    the transactional check.
  if (agent.frozenAt !== null) {
    // Counted, not logged as a row. This is where nearly every post-freeze
    // attempt lands, so without it an agent hammering its stop order would be
    // entirely invisible — see recordFrozenAttempt.
    recordFrozenAttempt(agent.id);
    return {
      outcome: "frozen",
      reason: "This agent has been stopped by an operator.",
      frozenAt: agent.frozenAt,
      frozenReason: agent.frozenReason,
    };
  }

  // 0b. Which rail this agent may pay on. Decided before any request leaves,
  //     so an agent that cannot pay never reaches the network or the budget.
  const railed = railFor(agent);
  if (!railed.ok) {
    return { outcome: "failed", reason: railed.reason };
  }
  const { rail } = railed;

  // 1. Ask for the resource unpaid, to learn the terms. safeFetch refuses
  //    private network space here and on every redirect it follows — the URL
  //    is caller-supplied, so this is the SSRF boundary. Nothing is reserved
  //    or signed yet, so a refusal is just a plain failure.
  // allowLoopback is true at both safeFetch call sites in this file, and this
  // is the only file where it may be: paying Fuel's own /paid-hello on
  // localhost is what the exemption exists for. The gateway passes false.
  let unpaid: Awaited<ReturnType<typeof safeFetch>>;
  try {
    unpaid = await safeFetch(url, { allowLoopback: true }, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (unpaid.status !== 402) {
    return { outcome: "failed", reason: `Expected 402 from ${url}, got ${unpaid.status}` };
  }

  // Build a throwaway client just to decode the 402 — it has no signer, so
  // nothing here can produce a signature.
  const decoder = new x402HTTPClient(new x402Client());
  const paymentRequired = decoder.getPaymentRequiredResponse(
    (name) => unpaid.headers.get(name),
    await unpaid.clone().json().catch(() => undefined),
  );

  // 2. Pick the terms we would accept. Must match on SCHEME as well as network
  //    and asset: x402's own selector discards requirements whose scheme is not
  //    registered, so filtering without it can pick a different entry than the
  //    one that actually gets signed.
  const terms = paymentRequired.accepts.find((r) => acceptable(r, rail));
  if (!terms) {
    const offered = paymentRequired.accepts
      .map((r) => `${r.scheme}/${r.amount} on ${r.network}`)
      .join("; ");
    return {
      outcome: "failed",
      reason: `No acceptable terms (want ${rail.scheme} ${rail.network}/USDC; offered: ${offered || "nothing"})`,
    };
  }

  const amount = BigInt(terms.amount);
  if (amount <= 0n) {
    return { outcome: "failed", reason: `Refusing a non-positive amount: ${terms.amount}` };
  }
  if (amount > MAX_PER_PAYMENT_BASE_UNITS) {
    return {
      outcome: "failed",
      reason: `Single payment of ${baseUnitsToDollars(amount)} exceeds the per-payment limit of ${baseUnitsToDollars(MAX_PER_PAYMENT_BASE_UNITS)}`,
    };
  }

  const timeoutSeconds = Number(
    (terms as { maxTimeoutSeconds?: number | string }).maxTimeoutSeconds ?? 0,
  );
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < MIN_TIMEOUT_SECONDS) {
    return {
      outcome: "failed",
      reason: `Refusing terms valid for only ${timeoutSeconds}s; vault signing needs at least ${MIN_TIMEOUT_SECONDS}s.`,
    };
  }

  // 3. Cap check + budget reservation, atomically, BEFORE signing.
  const reservation = reserveIfUnderCap({
    agentId: agent.id,
    amountBaseUnits: amount,
    resourceUrl: url,
    approvalRequestId,
  });

  if (!reservation.ok) {
    // Frozen between the check above and now. Rare, but this is the
    // authoritative answer — the one read under the write lock.
    if (reservation.refusal === "frozen") {
      return {
        outcome: "frozen",
        reason: "This agent has been stopped by an operator.",
        frozenAt: reservation.frozenAt,
        frozenReason: reservation.frozenReason,
      };
    }

    // The approval itself was no good. There is no cap to raise here — the
    // agent needs a new approval — so this is deliberately not a cap refusal.
    if (reservation.refusal === "approval") {
      return { outcome: "approval_invalid", reason: reservation.reason };
    }

    // Too fast. Nothing to queue and nobody to ask — this one fixes itself.
    if (reservation.refusal === "velocity") {
      const { spentInWindow, limit } = reservation.verdict;
      return {
        outcome: "rate_limited",
        reason:
          `This agent is spending too quickly. It has spent ` +
          `${baseUnitsToDollars(spentInWindow)} of ${baseUnitsToDollars(limit)} allowed in the ` +
          `last ${VELOCITY_WINDOW_MS / 1000} seconds.`,
        spentInWindowUsd: baseUnitsToDollars(spentInWindow),
        limitUsd: baseUnitsToDollars(limit),
        windowSeconds: VELOCITY_WINDOW_MS / 1000,
        retryAfterSeconds: reservation.retryAfterSeconds,
      };
    }

    // Out of character, but affordable. Queue it exactly as a ceiling block is
    // queued — one operator queue, one decision mechanism — but say plainly
    // that the numbers are behavioural, not budgetary.
    if (reservation.refusal === "anomaly") {
      const { baseline, threshold, sampleSize } = reservation.verdict;
      const baselineUsd = baseUnitsToDollars(baseline);
      const thresholdUsd = baseUnitsToDollars(threshold);
      const amountUsd = baseUnitsToDollars(amount);
      const request = createApprovalRequest({
        agentId: agent.id,
        amountBaseUnits: amount,
        resourceUrl: url,
        blockedScope: "anomaly",
        detail:
          `${amountUsd} is unusual for this agent: above the ${thresholdUsd} threshold, ` +
          `against a median of ${baselineUsd} over its last ${sampleSize} payments`,
      });
      return {
        outcome: "awaiting_approval",
        approvalRequestId: request.id,
        scope: "anomaly",
        reason:
          `This payment is much larger than this agent's recent payments. ` +
          `It is awaiting approval.`,
        amountUsd,
        baselineUsd,
        thresholdUsd,
        sampleSize,
      };
    }

    // One message per scope, because the fix for each is different: raise the
    // agent's cap, the team's, or the company's.
    const reasons: Record<CapScope, string> = {
      agent: "This payment would exceed the agent's spend cap.",
      team: "This payment would exceed the team's spend cap.",
      company: "This payment would exceed the company's spend cap.",
    };
    const spentUsd = baseUnitsToDollars(reservation.spent);
    const capUsd = baseUnitsToDollars(reservation.cap);

    // A ceiling ABOVE the agent refused it, and nothing was being redeemed:
    // that is the case a human can reasonably be asked about, so queue it
    // instead of refusing outright. The agent's own cap is never queued — a
    // payment that does not fit the budget its own operator set for it is not
    // an exception worth asking about.
    //
    // Created outside the reservation transaction on purpose: it holds no
    // budget and signs nothing, so it is not money-critical, and the write
    // lock stays held only across the checks that actually need it.
    if (reservation.scope !== "agent" && approvalRequestId === undefined) {
      const request = createApprovalRequest({
        agentId: agent.id,
        amountBaseUnits: amount,
        resourceUrl: url,
        blockedScope: reservation.scope,
      });
      return {
        outcome: "awaiting_approval",
        approvalRequestId: request.id,
        scope: reservation.scope,
        reason: `${reasons[reservation.scope]} It is awaiting approval.`,
        amountUsd: baseUnitsToDollars(amount),
        spentUsd,
        capUsd,
      };
    }

    return {
      outcome: "blocked",
      scope: reservation.scope,
      reason: reasons[reservation.scope],
      spentUsd,
      capUsd,
    };
  }

  // 4. Only now build a signing client — and bind its policy to the exact
  //    amount we reserved. This is what makes "amount checked" and "amount
  //    signed" the same number: the client cannot select any requirement
  //    other than one matching the reservation.
  const client = new x402Client();
  client.registerPolicy((_version, requirements) =>
    requirements.filter((r) => acceptable(r, rail) && BigInt(r.amount) === amount),
  );
  registerExactEvmScheme(client, { signer, networks: [rail.network as `${string}:${string}`] });
  const http = new x402HTTPClient(client);

  let signed = false;
  try {
    // Persist "we are about to sign" BEFORE signing. `signed` below is a local
    // variable and dies with the process; this row does not. It is the only
    // way crash recovery can tell "no authorization can exist" from "one might
    // already be spendable" — see reapStaleReservations.
    markSigningStarted(reservation.paymentId);

    const payload = await http.createPaymentPayload(paymentRequired);
    signed = true;

    /*
     * Record when this authorization stops being spendable, read from the
     * payload that was actually signed.
     *
     * Same instinct as the `authorization.value` check immediately below: what
     * matters is what was signed, not what was requested. This is the evidence
     * `reconcileUnreconciledPayment` needs to refuse releasing budget while the
     * authorization is still live — without it, the only thing standing between
     * a mistaken operator and a silent overspend is their own certainty.
     *
     * Best effort and deliberately not fatal: a payload shape that does not
     * carry `validBefore` leaves the column NULL, which the reconciler reports
     * as "expiry not recorded" rather than treating as expired. Refusing to pay
     * over a missing audit field would be the wrong trade.
     */
    const signedValidBefore = (payload.payload as { authorization?: { validBefore?: string } })
      ?.authorization?.validBefore;
    if (signedValidBefore !== undefined) {
      const parsed = Number(signedValidBefore);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        recordAuthorizationWindow(reservation.paymentId, parsed);
      }
    }

    // Belt and braces: assert on what was actually signed, not on what we
    // asked for. authorization.value is the number the facilitator will move.
    const authorized = (payload.payload as { authorization?: { value?: string } })?.authorization
      ?.value;
    if (authorized !== undefined && BigInt(authorized) !== amount) {
      markUnreconciled(reservation.paymentId, `signed ${authorized}, reserved ${amount}`);
      return {
        outcome: "failed",
        reason: "Refusing to send: the signed amount does not match the reserved amount.",
      };
    }
    if (!acceptable(payload.accepted, rail) || BigInt(payload.accepted.amount) !== amount) {
      markUnreconciled(reservation.paymentId, "selected requirement diverged from reservation");
      return {
        outcome: "failed",
        reason: "Refusing to send: the selected terms diverged from the reserved terms.",
      };
    }

    const paid = await safeFetch(url, { allowLoopback: true }, {
      headers: { Accept: "application/json", ...http.encodePaymentSignatureHeader(payload) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await paid.text();

    if (!paid.ok) {
      // Signed already — the server may have settled before erroring, so the
      // budget stays consumed rather than being handed back.
      const reason = describeRejection(paid.headers.get("PAYMENT-REQUIRED"), paid.status);
      markUnreconciled(reservation.paymentId, reason);
      return { outcome: "failed", reason };
    }

    const settlementHeader = paid.headers.get("PAYMENT-RESPONSE");
    const settlement = settlementHeader ? decodePaymentResponseHeader(settlementHeader) : null;
    const txHash = settlement?.transaction ?? "";

    if (!txHash) {
      markUnreconciled(reservation.paymentId, "unlocked without a settlement tx hash");
      return { outcome: "failed", reason: "Resource unlocked but settlement was not evidenced." };
    }

    markSettled(reservation.paymentId, txHash);
    return { outcome: "settled", txHash, amountUsd: baseUnitsToDollars(amount), body };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Whether the budget is released depends entirely on whether a spendable
    // authorization exists yet. With a remote signer, "we don't know" is a
    // real third case — a timed-out Fireblocks request may still complete —
    // and it has to be treated as spent, not released.
    if (signed || error instanceof SignatureMayExistError) {
      markUnreconciled(reservation.paymentId, reason);
    } else {
      markFailedBeforeSigning(reservation.paymentId, reason);
    }
    return { outcome: "failed", reason };
  }
}

/** The rejection reason lives in the header, not the (empty) body. */
function describeRejection(header: string | null, status: number): string {
  if (!header) return `HTTP ${status} with no PAYMENT-REQUIRED header`;
  const decoded = Buffer.from(header, "base64").toString();
  try {
    return String(JSON.parse(decoded).error ?? `HTTP ${status}`);
  } catch {
    return `HTTP ${status} (unparseable header: ${decoded.slice(0, 100)})`;
  }
}
