/**
 * The shop's own settler: it submits the payer's signed transfer to Arc itself.
 *
 * No hosted x402 facilitator settles on Arc mainnet that Fuel has vetted, so
 * the shop runs the x402 library's own facilitator code in-process
 * (`@x402/evm/exact/facilitator`, already installed) with the shop's wallet.
 * That wallet pays the gas, in USDC: about $0.0017 a payment, measured on
 * Arc mainnet itself ($0.0022 on the testnet rehearsal was the earlier
 * estimate, before any mainnet payment existed to measure against).
 *
 * The library's facilitator can do more than this shop needs -- Permit2
 * settlement, deploying smart wallets, arbitrary transactions -- and every one
 * of those would spend the shop wallet's gas on a payer's say-so. So both of
 * its doors are narrowed here:
 *
 *   - `restrictedSettlerSigner` can write exactly one thing: USDC's
 *     transferWithAuthorization, on the configured chain. Every other write and
 *     every raw transaction throws before anything is sent.
 *   - `guardedFacilitator` refuses, before the library sees it, any payment that
 *     is not an EIP-3009 authorization for exactly one of the shop's prices, on
 *     its chain and token, to its wallet.
 */
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import type { FacilitatorEvmSigner } from "@x402/evm";
import type { ArcChain } from "../../src/payments/arc-chain.js";

/** The library's facilitator, as far as the shop uses it. */
export interface Settles {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  getSupported(): ReturnType<FacilitatorClient["getSupported"]> extends Promise<infer S> ? S : never;
}

/** What the restricted signer needs from viem: a reader and a writer for one account. */
export interface ChainClients {
  address: `0x${string}`;
  readContract: FacilitatorEvmSigner["readContract"];
  verifyTypedData: FacilitatorEvmSigner["verifyTypedData"];
  writeContract: FacilitatorEvmSigner["writeContract"];
  waitForTransactionReceipt: FacilitatorEvmSigner["waitForTransactionReceipt"];
  getCode: FacilitatorEvmSigner["getCode"];
}

export function restrictedSettlerSigner(clients: ChainClients, chain: ArcChain): FacilitatorEvmSigner {
  return {
    getAddresses: () => [clients.address],
    readContract: (args) => clients.readContract(args),
    verifyTypedData: (args) => clients.verifyTypedData(args),
    getCode: (args) => clients.getCode(args),
    waitForTransactionReceipt: (args) => clients.waitForTransactionReceipt(args),
    writeContract: (args) => {
      if (args.address.toLowerCase() !== chain.asset.toLowerCase() || args.functionName !== "transferWithAuthorization") {
        throw new Error(`the shop's settler refuses ${args.functionName} on ${args.address}`);
      }
      return clients.writeContract(args);
    },
    sendTransaction: () => {
      throw new Error("the shop's settler sends no raw transactions");
    },
  };
}

export interface ShopPrice {
  path: string;
  amount: string;
}

/** Why a payment is not one the shop takes, or null if it is. */
export function refusalFor(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  shop: { chain: ArcChain; payTo: string; prices: readonly ShopPrice[] },
): string | null {
  if (requirements.scheme !== "exact") return "only the exact scheme";
  if (requirements.network !== shop.chain.network) return `wrong network ${requirements.network}`;
  if (requirements.asset.toLowerCase() !== shop.chain.asset.toLowerCase()) return "wrong token";
  if (requirements.payTo.toLowerCase() !== shop.payTo.toLowerCase()) return "wrong payee";
  if (!shop.prices.some((p) => p.amount === requirements.amount)) return `no item costs ${requirements.amount}`;
  const inner = (payload as { payload?: Record<string, unknown> & { authorization?: unknown; signature?: unknown } }).payload;
  if (!inner || typeof inner.signature !== "string" || typeof inner.authorization !== "object" || inner.authorization === null) {
    return "only a signed EIP-3009 authorization";
  }
  // The library routes on this key, so a payload carrying it would take the
  // Permit2 path even beside a valid-looking EIP-3009 authorization.
  if ("permit2Authorization" in inner) return "only a signed EIP-3009 authorization, nothing Permit2";
  const auth = inner.authorization as { to?: unknown; value?: unknown };
  if (typeof auth.to !== "string" || auth.to.toLowerCase() !== shop.payTo.toLowerCase()) return "authorization pays someone else";
  if (String(auth.value) !== requirements.amount) return "authorization is for a different amount";
  return null;
}

export function guardedFacilitator(
  inner: Settles,
  shop: { chain: ArcChain; payTo: string; prices: readonly ShopPrice[] },
  log: (line: string) => void = (line) => console.log(line),
): FacilitatorClient {
  return {
    async getSupported() {
      return inner.getSupported();
    },
    async verify(payload, requirements) {
      const why = refusalFor(payload, requirements, shop);
      if (why) return { isValid: false, invalidReason: "invalid_payload", invalidMessage: `shop: ${why}` } as VerifyResponse;
      return inner.verify(payload, requirements);
    },
    async settle(payload, requirements) {
      const why = refusalFor(payload, requirements, shop);
      if (why) return { success: false, errorReason: "invalid_payload", errorMessage: `shop: ${why}`, transaction: "", network: requirements.network } as SettleResponse;
      const result = await inner.settle(payload, requirements);
      log(`[arc-shop] settle ${result.success ? "ok" : "FAILED"} ${requirements.amount} base units, tx ${result.transaction || "-"}${result.errorReason ? ` (${result.errorReason})` : ""}`);
      return result;
    },
  };
}
