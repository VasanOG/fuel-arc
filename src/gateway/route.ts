/**
 * The paid gateway. Fuel's first route reachable from the public internet with
 * no operator and no agent credential in front of it.
 *
 * WHY THIS DOES NOT USE `paymentMiddleware`, given the library ships one.
 *
 * The middleware puts every lifecycle event behind a hook, and `@x402/core`
 * wraps every hook invocation in a try/catch that only `console.warn`s
 * (server/index.mjs:970-980). A receipt write that threw inside `onAfterSettle`
 * — a transient SQLite busy, a bug, a full disk — would be swallowed:
 * settlement still succeeds, the payer still gets their response, the money
 * still moves, and the row stays `awaiting` with nothing raised. Fuel's ledger
 * is only worth something because Fuel witnessed what it reports (0011), and a
 * silently-dropped write is exactly that claim failing.
 *
 * `processHTTPRequest`/`verifyPayment`/`settlePayment` are public API — the
 * middleware is a consumer of them, not a gatekeeper. Driving them here puts
 * every transition in ordinary control flow where a throw propagates, and
 * incidentally removes three other hazards: the middleware's response buffering
 * does not cover `res.setHeader`, so handler headers leak onto its error
 * responses; its `await endPromise` hangs forever if a handler never ends; and
 * its route table is fixed at construction, which runtime-registered endpoints
 * with per-row prices have no clean way into.
 *
 * ORDERING: verify -> claim -> fetch origin -> settle -> deliver.
 *
 * The payer receives nothing until settlement confirms, and if the origin fails
 * Fuel does not settle at all — so the case with no remedy under x402, money
 * taken for something never delivered, cannot arise. The cost is the mirror
 * exposure: an origin can do work for a payment that later fails to settle.
 * That is bounded by the limiter and by the replay defence, and it is the
 * cheaper of the two.
 */
import { Router, type Request, type Response } from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import * as http from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getDefaultAsset } from "@x402/evm";
import { ALLOWED_NETWORK, FACILITATOR_URL } from "../payments/pay.js";
import { GATEWAY_MAX_TIMEOUT_SECONDS } from "../payments/limits.js";
import { createFacilitatorSync, RETRY_AFTER_SECONDS } from "../payments/facilitator-sync.js";
import { getAgentOwningEndpoint } from "../db/agents.js";
import { getEnabledEndpointByPublicId, type EarningEndpoint } from "../db/earning-endpoints.js";
import {
  DuplicateAuthorizationError,
  claimReceipt,
  resolveReceipt,
} from "../db/receipts.js";
import { acquireSlot, checkAddress, checkEndpoint } from "./limiter.js";
import { forwardToOrigin } from "./forward.js";

/**
 * Both live in ./origin.ts, which imports nothing.
 *
 * Re-exported here so every existing caller keeps working, but the definitions
 * are in a leaf module so `src/lib/environment.ts` can classify the origin
 * without importing this router and, through it, the x402 resource server and
 * the whole database layer.
 */
export { GATEWAY_PREFIX, GATEWAY_PUBLIC_ORIGIN } from "./origin.js";
// Re-exporting does not create a local binding, and this file uses the prefix
// when it builds the resource url below.
import { GATEWAY_PREFIX } from "./origin.js";

/**
 * Its own resource server, on the same pinned rail as the payer.
 *
 * `ALLOWED_NETWORK` and `FACILITATOR_URL` come from payments/pay.ts rather than
 * being restated, for the reason server.ts already gives: the network Fuel
 * validates against and the network it advertises must not be able to diverge.
 */
const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
).register(ALLOWED_NETWORK, new ExactEvmScheme());

/**
 * `resourceServer` cannot answer "what does this scheme/network need?" until
 * it has fetched the facilitator's supported kinds — `buildPaymentRequirements`
 * throws unconditionally otherwise ("Make sure to call initialize()").
 *
 * THE HANDSHAKE IS OWNED BY ../payments/facilitator-sync.ts, and that file says
 * why. In short: it used to start here, at import, with nothing listening for
 * it to fail, so an unreachable facilitator ended the whole API process within
 * a second of boot -- the comment that stood here claimed the opposite. Now
 * nothing starts on import; server.ts calls `gatewayFacilitator.start()` at
 * boot, a failure is retried in the background, and until it succeeds the
 * handler refuses with 503 before anything else happens.
 *
 * READY MEANS FUEL'S RAIL, NOT ANY RAIL. `initialize()` succeeds if the
 * facilitator lists any payment kind at all. A facilitator answering without
 * exact payments on ALLOWED_NETWORK would leave this server "ready" and unable
 * to quote, for good, because a ready sync never re-initializes. So that case
 * is a failed attempt, and it is retried like any other.
 */
export const gatewayFacilitator = createFacilitatorSync(
  async () => {
    await resourceServer.initialize();
    if (!resourceServer.getSupportedKind(2, ALLOWED_NETWORK, "exact")) {
      throw new Error(`the facilitator does not offer exact payments on ${ALLOWED_NETWORK}`);
    }
  },
  { name: "gateway" },
);

/** The shape a payer's signed payload has, for the two fields used as the replay key. */
interface ExactEvmPayload {
  payload?: { authorization?: { from?: string; nonce?: string } };
}

/**
 * Rebuilds the caller's query string as something Fuel constructed.
 *
 * Express's `qs` parser turns `?a=1&a=2` into an array and `?a[b]=1` into a
 * nested object, so casting `req.query` to `Record<string, string>` is a lie at
 * runtime: an array would stringify comma-joined and an object as
 * "[object Object]". Repeated keys are ordinary in real APIs, so they are
 * preserved properly here; anything structured is dropped rather than mangled,
 * because passing "[object Object]" to a customer's origin is worse than
 * passing nothing.
 */
function queryFor(req: Request): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") out.append(key, value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string") out.append(key, v);
    }
  }
  return out;
}

function refuse(res: Response, status: number, message: string, retryAfter?: number): void {
  if (retryAfter !== undefined) res.set("Retry-After", String(retryAfter));
  res.status(status).json({ error: message });
}

/**
 * The exact USDC contract for this network, not a dollar string re-parsed by
 * the library. `endpoint.priceBaseUnits` is an exact bigint of 6-decimal token
 * units — the same representation `dollarsToBaseUnits`/`baseUnitsToDollars`
 * exist to keep every other price in this codebase in, precisely so it never
 * has to round-trip through a float. `parsePrice`'s `Money` branch (a `"$0.05"`
 * string, as `/paid-hello` in server.ts uses) does that parsing for you and
 * would work — but it also means the six-decimal integer this endpoint was
 * registered with gets reconstructed from a formatted string on every single
 * request instead of being sent as the exact number it already is. This is the
 * `AssetAmount` branch instead, which requires `asset` to be non-empty (an
 * earlier version passed `""` here, which is what threw "Asset address must be
 * specified" the first time this path was ever exercised against a real
 * facilitator — nothing had before, so nothing had caught it).
 *
 * `name`/`version` are read here too, and passed through as `extra` below, for
 * the same reason: the `Money` branch's `defaultMoneyConversion` fills these
 * from this exact struct automatically (they are the EIP-712 domain a payer's
 * CLIENT needs to construct the typed-data signature — `@x402/evm`'s client
 * throws "EIP-712 domain parameters (name, version) are required" without
 * them), but the `AssetAmount` branch only carries through whatever `extra` it
 * is given. The first real client to sign against this endpoint is what
 * caught the omission; nothing offline could have, because verifying a
 * signature never requires reconstructing the domain that produced it.
 */
const USDC_ASSET = getDefaultAsset(ALLOWED_NETWORK);

async function requirementsFor(endpoint: EarningEndpoint, payTo: string) {
  return resourceServer.buildPaymentRequirementsFromOptions(
    [
      {
        scheme: "exact",
        network: ALLOWED_NETWORK,
        payTo,
        price: {
          asset: USDC_ASSET.address,
          amount: endpoint.priceBaseUnits.toString(),
          extra: { name: USDC_ASSET.name, version: USDC_ASSET.version },
        },
        // Derived from the work Fuel has to do inside the window, not written
        // down separately — see limits.ts.
        maxTimeoutSeconds: GATEWAY_MAX_TIMEOUT_SECONDS,
      },
    ],
    undefined,
  );
}

export function gatewayRouter(): Router {
  const router = Router();

  /*
   * A HEAD IS REFUSED, FIRST, BEFORE ANYTHING ELSE LOOKS AT IT.
   *
   * Express answers a HEAD with the GET handler below and then drops the body.
   * Nothing in that handler asks which method it was given, so a HEAD that
   * carried a payment matching the terms was verified, claimed, forwarded to the
   * seller and settled: the payer was charged in full and received headers
   * alone. A HEAD that carried none was quoted a price it could never get
   * anything for.
   *
   * Quoting HEAD like GET would not help: the charge is the problem, not the
   * quote. Settling it differently would mean changing the handler, and the
   * handler below is the code that decides what money moves -- so this does not
   * touch it. It refuses HEAD ahead of it instead, and says what to send.
   *
   * It is a `use`, not a `head`: Express hands a HEAD to the first route whose
   * GET matches, so a `router.head` registered after `router.get` would never
   * run. And it sits ahead of the limiter, the endpoint lookup and the
   * facilitator wait, so it costs nothing, answers every id alike and answers the
   * same with the payment network down. Nothing is claimed, quoted, verified, forwarded or settled.
   */
  router.use((req: Request, res: Response, next) => {
    if (req.method.toUpperCase() !== "HEAD") return next();
    res.set("Allow", "GET");
    return refuse(res, 405, "GET only");
  });

  router.get("/:publicId", async (req: Request, res: Response) => {
    // 1. Cheapest possible check, before any database read. An unpaid flood
    //    must not cost a query per request.
    const address = req.socket.remoteAddress ?? "unknown";
    const byAddress = checkAddress(address);
    if (!byAddress.ok) {
      return refuse(res, 429, byAddress.reason!, byAddress.retryAfterSeconds);
    }

    // 2. Unknown and disabled are the same answer, from one query. Reporting
    //    them differently would let anyone enumerate which endpoints exist.
    const publicId = req.params.publicId;
    if (typeof publicId !== "string") return refuse(res, 404, "not found");
    const endpoint = getEnabledEndpointByPublicId(publicId);
    if (!endpoint) return refuse(res, 404, "not found");

    const byEndpoint = checkEndpoint(endpoint.id);
    if (!byEndpoint.ok) {
      return refuse(res, 429, byEndpoint.reason!, byEndpoint.retryAfterSeconds);
    }

    const agent = getAgentOwningEndpoint(endpoint.id);
    if (!agent) return refuse(res, 404, "not found");

    // Refused while the facilitator has not been reached: nothing below this
    // line -- no quote, verify, claim, origin call or settlement -- can happen
    // without it. Waits only for an attempt already under way, never starts
    // one; see gatewayFacilitator above.
    if (!(await gatewayFacilitator.ready())) {
      return refuse(res, 503, "this endpoint is temporarily unavailable", RETRY_AFTER_SECONDS);
    }

    let requirements;
    try {
      requirements = await requirementsFor(endpoint, agent.address);
    } catch (error) {
      console.error("[gateway] could not build payment requirements:", error);
      return refuse(res, 500, "this endpoint is temporarily unavailable");
    }

    // 3. No payment offered: quote the price. Cheap, and reaches no facilitator.
    const header = req.header("payment-signature") ?? req.header("x-payment");
    if (!header) {
      const required = await resourceServer.createPaymentRequiredResponse(requirements, {
        url: `${GATEWAY_PREFIX}/${endpoint.publicId}`,
        description: "Paid API access, fronted by Fuel",
      });
      res.set("PAYMENT-REQUIRED", http.encodePaymentRequiredHeader(required));
      return refuse(res, 402, "payment required");
    }

    let payload;
    try {
      payload = http.decodePaymentSignatureHeader(header);
    } catch {
      return refuse(res, 400, "the payment header could not be read");
    }

    const matched = resourceServer.findMatchingRequirements(requirements, payload);
    if (!matched) return refuse(res, 402, "the payment offered does not match this endpoint's terms");

    // 4. Verify BEFORE claiming the nonce. Claiming first would let anyone burn
    //    a victim's authorization slot by posting an unsigned payload naming
    //    their address.
    let verified;
    try {
      verified = await resourceServer.verifyPayment(payload, matched);
    } catch (error) {
      console.error("[gateway] verify failed:", error);
      return refuse(res, 402, "the payment could not be verified");
    }
    if (!verified.isValid) {
      return refuse(res, 402, `the payment was not accepted: ${verified.invalidReason ?? "unknown"}`);
    }

    const authorization = (payload as ExactEvmPayload).payload?.authorization;
    const claimedPayer = authorization?.from;
    const nonce = authorization?.nonce;

    /*
     * THE VERIFIED PAYER WINS, AND A DISAGREEMENT IS A REFUSAL.
     *
     * `verified.payer` is what the facilitator recovered from the signature.
     * `authorization.from` is a field in a document the caller handed us. The
     * signature covers `from`, so the two should never differ — but "should
     * never" is not a reason to prefer the unverified one, and this value is
     * half of the replay key. If a payload could name a `from` the signature
     * did not cover, an attacker would get a fresh dedup slot per spelling and
     * the replay defence would be decorative.
     *
     * Refusing on mismatch rather than silently taking the verified one: the
     * two disagreeing means something is wrong that this code does not
     * understand, and forwarding under that condition is the wrong instinct.
     */
    const payer = verified.payer ?? claimedPayer;
    if (
      verified.payer &&
      claimedPayer &&
      verified.payer.toLowerCase() !== claimedPayer.toLowerCase()
    ) {
      return refuse(res, 402, "the payment's payer did not match its signature");
    }
    if (!payer || !nonce) {
      // Without both, the replay defence cannot be applied — so refuse rather
      // than forward something that could be replayed without limit.
      return refuse(res, 402, "the payment did not carry an identifiable authorization");
    }

    // 5. THE REPLAY DEFENCE, and the serialisation point.
    //
    //    NOTHING MAY BE AWAITED BETWEEN THE VERIFY ABOVE AND THIS CALL. The
    //    insert is synchronous, which is the only reason two concurrent
    //    replays cannot both pass it — see the note on claimReceipt. An await
    //    added here would reopen amplification silently, with every existing
    //    test still green.
    let receipt;
    try {
      receipt = claimReceipt({
        agentId: endpoint.agentId,
        endpointId: endpoint.id,
        amountBaseUnits: BigInt(matched.amount),
        payerAddress: payer,
        authorizationNonce: nonce,
      });
    } catch (error) {
      if (error instanceof DuplicateAuthorizationError) {
        return refuse(res, 409, error.message);
      }
      throw error;
    }

    // 6. Bound the work in flight before touching someone else's server.
    const slot = acquireSlot(endpoint.id);
    if (!slot.ok) {
      resolveReceipt(receipt.id, "abandoned", { detail: slot.reason });
      return refuse(res, 503, slot.reason, 5);
    }

    try {
      const forwarded = await forwardToOrigin(endpoint, queryFor(req));

      // 7. The origin failed. NO SETTLEMENT IS ATTEMPTED, so the payer is not
      //    charged for something they never received. This is the ordinary
      //    failure and it costs nobody anything.
      if (!forwarded.ok) {
        // `detail` may name the origin, so it goes to the receipt and the log.
        // `reason` is what an anonymous caller is allowed to hear.
        resolveReceipt(receipt.id, "abandoned", {
          detail: forwarded.detail ?? forwarded.reason,
        });
        return refuse(res, 502, forwarded.reason);
      }

      // 8. Only now does money move.
      let settlement;
      try {
        settlement = await resourceServer.settlePayment(payload, matched);
      } catch (error) {
        // The facilitator raises a plain Error on a network failure, which is
        // indistinguishable from a settlement that landed. "We do not know" is
        // its own state — it must never collapse into "it failed".
        const detail = error instanceof Error ? error.message : String(error);
        resolveReceipt(receipt.id, "settle_unknown", { detail });
        console.error(`[gateway] settle outcome unknown for receipt ${receipt.id}:`, detail);
        return refuse(res, 402, "payment settlement could not be confirmed");
      }

      if (!settlement.success) {
        // The origin's work is spent and no money arrived. The exposure state.
        resolveReceipt(receipt.id, "served_unsettled", {
          txHash: settlement.transaction || null,
          detail: settlement.errorReason ?? "settlement failed",
        });
        return refuse(res, 402, "payment settlement failed");
      }

      resolveReceipt(receipt.id, "settled", { txHash: settlement.transaction });

      // 9. Settled. Only here does anything the origin produced reach the payer,
      //    and only the headers on the allowlist travel with it.
      for (const [name, value] of Object.entries(forwarded.headers)) res.set(name, value);
      res.set("PAYMENT-RESPONSE", http.encodePaymentResponseHeader(settlement));
      return res.status(forwarded.status).send(Buffer.from(forwarded.body));
    } finally {
      // A leaked slot is permanent, and enough of them wedge the endpoint shut
      // for everyone. Released on every path, including a throw.
      slot.release();
    }
  });

  return router;
}
