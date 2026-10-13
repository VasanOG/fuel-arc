import type { TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * What Fuel needs from a signer to make an x402 payment — and nothing more.
 *
 * This mirrors the REQUIRED half of x402's ClientEvmSigner and deliberately
 * omits its two optional members, `readContract` and `signTransaction`.
 *
 * That omission is a safety control, not an oversight. The x402 EVM client
 * branches on a SERVER-supplied `extra.assetTransferMethod` field, and one
 * branch signs an unbounded Permit2 approval (maxUint256) on a server-supplied
 * chain and hands it back for broadcast. That path is only reachable if the
 * signer can read contracts. A signer shaped like this cannot be walked down
 * it at all.
 *
 * Widening this interface for convenience reopens that hole. Don't.
 */
export interface PaymentSigner {
  readonly address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/**
 * Thrown by a signer when a signature MAY exist but could not be confirmed and
 * returned — e.g. a remote signer that timed out and might still complete.
 *
 * This is a third case beyond success and failure, and it exists for budget
 * accounting: an EIP-3009 authorization is spendable the instant it exists, so
 * "we don't know" has to be treated as spent (fail closed), never released.
 * `payForAgent` keys off this. A local signer never throws it — it is
 * synchronous and either signs or doesn't.
 */
export class SignatureMayExistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureMayExistError";
  }
}

/**
 * Signs with a local private key.
 *
 * TESTNET ONLY. This is the Phase 1 stand-in while we wait on a SIGNER-role
 * Fireblocks API key. Real custody belongs in Fireblocks — see
 * docs/decisions/0001-custody-provider.md. `FireblocksSigner` will implement
 * this same interface, and swapping it in should touch nothing else.
 */
export function localSigner(privateKey: string): PaymentSigner {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return {
    address: account.address,
    // x402 describes the payload with looser types than viem accepts. The
    // shape is the EIP-712 definition viem wants; the cast is only bridging
    // Record<string, unknown> to viem's stricter generic.
    signTypedData: (message) => account.signTypedData(message as TypedDataDefinition),
  };
}
