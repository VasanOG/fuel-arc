/**
 * Asking the chain whether a payment authorization was actually used.
 *
 * WHY THIS EXISTS. `settle_unknown` is the inbound analogue of `unreconciled`:
 * the facilitator's settle call threw, and a network failure is
 * indistinguishable from a settlement that landed. ADR 0011 says such a receipt
 * is "reconcilable later against the chain" and then stops — no reconciler was
 * ever built, `resolveReceipt` is guarded to `awaiting`, and
 * `reapStaleAwaitingReceipts` manufactures more of them every 60 seconds. This
 * module is the missing half: the authority a reconciler asks.
 *
 * WHY `authorizationState` AND NOT A BALANCE OR A LOG SCAN. EIP-3009 gives
 * every authorization a nonce, and the token contract records whether that
 * nonce has been consumed. `authorizationState(authorizer, nonce)` is therefore
 * a direct, total answer to the only question that matters — *did this specific
 * authorization move money* — and it stays answerable at any distance in time,
 * the same property that makes a deterministic QuickBooks `DocNumber` the right
 * key for `reconcilePending`.
 *
 * The alternatives were considered and rejected. A balance read cannot
 * attribute a change to one authorization. Scanning `Transfer` logs for a
 * matching amount in a time window is a heuristic that mis-attributes the
 * moment an agent makes two identical payments — and a reconciler that can
 * silently book the wrong one is worse than no reconciler, because this whole
 * status vocabulary exists to stop "we do not know" collapsing into a guess.
 *
 * THIS MODULE NEVER DECIDES ANYTHING. It reports what the chain says and
 * throws if it cannot reach it. Deciding what a `true` or a `false` means for a
 * row is the caller's, and a caller that cannot get an answer must leave the
 * row exactly as it found it.
 */
import { createPublicClient, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { getDefaultAsset } from "@x402/evm";
import { ALLOWED_NETWORK } from "../payments/pay.js";

/**
 * The token whose authorization state is authoritative here.
 *
 * Resolved from `ALLOWED_NETWORK` through the library's own asset map, exactly
 * as `src/gateway/route.ts` resolves the price asset — so the contract this
 * reads and the contract a payer signed against cannot drift apart. Pinned to
 * the sandbox rail like every other constant in this project; there is no env
 * var that points it at mainnet.
 */
const ASSET = getDefaultAsset(ALLOWED_NETWORK);

/**
 * Base Sepolia, stated once.
 *
 * `ALLOWED_NETWORK` is the CAIP-2 id (`eip155:84532`) and viem wants a chain
 * object, so the two are asserted equal at module load rather than trusted to
 * stay aligned by eye. A mismatch here would read authorization state from the
 * wrong chain and report `false` for every real settlement — which would look
 * like "the money never arrived" and would be acted on.
 */
if (ALLOWED_NETWORK !== `eip155:${baseSepolia.id}`) {
  throw new Error(
    `settlement-evidence is pinned to eip155:${baseSepolia.id} but ALLOWED_NETWORK is ${ALLOWED_NETWORK}`,
  );
}

const AUTHORIZATION_STATE_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Shapes checked before they reach a contract call, so a malformed row fails here. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;

export class UnreadableAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableAuthorizationError";
  }
}

/**
 * Has this payer's authorization been consumed on-chain?
 *
 * `true` means the transfer happened and the money moved. `false` means it did
 * not — and, because a consumed nonce can never be un-consumed, `false` is
 * durable in a way most negative answers are not.
 *
 * Throws rather than returning a default when the chain cannot be reached. A
 * reconciler that read an RPC timeout as "no money moved" would resolve a real
 * settlement to `served_unsettled` and take the amount out of a customer's
 * books — the exact failure the fail-closed direction in `db/receipts.ts`
 * exists to prevent.
 */
export async function authorizationUsed(params: {
  payerAddress: string;
  authorizationNonce: string;
}): Promise<boolean> {
  const { payerAddress, authorizationNonce } = params;

  if (!ADDRESS.test(payerAddress)) {
    throw new UnreadableAuthorizationError("the stored payer address is not a usable address");
  }
  if (!NONCE.test(authorizationNonce)) {
    throw new UnreadableAuthorizationError("the stored authorization nonce is not a usable nonce");
  }

  const client = createPublicClient({ chain: baseSepolia, transport: http() });

  try {
    return (await client.readContract({
      address: ASSET.address as Address,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: "authorizationState",
      args: [payerAddress as Address, authorizationNonce as Hex],
    })) as boolean;
  } catch (error) {
    // Deliberately not surfacing the raw error to a caller that may render it:
    // an RPC error can carry a provider URL and, on some providers, a key.
    console.error("[settlement-evidence] could not read authorization state:", error);
    throw new UnreadableAuthorizationError(
      "the settlement network could not be reached, so the outcome is still unknown",
    );
  }
}
