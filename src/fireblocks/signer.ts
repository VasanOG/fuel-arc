/**
 * Signs x402 payments with an agent's own Fireblocks vault.
 *
 * This is the real custody path: the vault is the payer, not the shared
 * throwaway dev key. It implements `PaymentSigner` and nothing wider — see the
 * comment on that interface for why `readContract`/`signTransaction` must stay
 * off it.
 *
 * ## What actually permits this to sign
 *
 * The API key is a NON_SIGNING_ADMIN. That role can *initiate* transactions;
 * the MPC key shares live in the workspace's "Fireblocks Communal Test
 * Co-signer" (type SANDBOX), which auto-approves. "Non-signing" describes the
 * user holding no key share of its own, not that what it initiates can't be
 * signed. **This arrangement is a sandbox property.** A production workspace
 * has no communal co-signer; it needs a Signer-role key and your own API
 * Co-Signer, and the policy engine would actually gate it there.
 *
 * ## Fireblocks does not validate the EIP-712 payload
 *
 * Two things bite here, both verified against the live sandbox:
 *
 * 1. Fireblocks requires `EIP712Domain` in `types`. x402 omits it, because
 *    viem derives it. Given a payload without it, Fireblocks does NOT error —
 *    it computes a *different* domain separator and returns a well-formed
 *    signature over the wrong digest, which recovers to an unrelated address.
 *    So we inject it.
 * 2. The message carries BigInt values (`value`, `validAfter`, `validBefore`),
 *    and JSON.stringify throws on BigInt. So we stringify them.
 *
 * Because a wrong digest is silent, `signTypedData` recomputes the digest with
 * viem and recovers the address locally before returning. If that check ever
 * fails, the signature is discarded rather than sent.
 */
import {
  hashTypedData,
  isAddressEqual,
  recoverAddress,
  type TypedDataDefinition,
} from "viem";
import { SIGN_TIMEOUT_MS } from "../payments/limits.js";
import { ALLOWED_ASSET } from "../payments/pay.js";
import { SignatureMayExistError, type PaymentSigner } from "../payments/signer.js";
import { fireblocks } from "./provision.js";

/** Native gas asset of the chain we sign for. Fireblocks keys the vault by it. */
const SIGNING_ASSET_ID = "BASECHAIN_ETH_TEST5";

/** Base Sepolia. Must agree with ALLOWED_NETWORK ("eip155:84532") in pay.ts. */
const EXPECTED_CHAIN_ID = 84532;

const POLL_INTERVAL_MS = 1_500;

const TERMINAL = ["COMPLETED", "FAILED", "REJECTED", "BLOCKED", "CANCELLED"];

/** secp256k1 n/2. Signatures above this are the malleable form OZ ECDSA rejects. */
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Canonical EIP-712 domain field order and types. */
const DOMAIN_FIELDS: Array<[string, string]> = [
  ["name", "string"],
  ["version", "string"],
  ["chainId", "uint256"],
  ["verifyingContract", "address"],
  ["salt", "bytes32"],
];

/**
 * Builds the `EIP712Domain` entry from the domain fields actually present.
 * Order matters — the domain separator is a hash over exactly this list.
 */
function domainType(domain: Record<string, unknown>) {
  return DOMAIN_FIELDS.filter(([name]) => domain[name] !== undefined).map(([name, type]) => ({
    name,
    type,
  }));
}

/** BigInt -> decimal string, recursively. JSON.stringify throws on BigInt. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]),
    );
  }
  return value;
}

export interface FireblocksSignerOptions {
  /** Fireblocks vault account id — `Agent.fireblocksVaultId`. */
  vaultId: string;
  /** That vault's address on Base Sepolia — `Agent.address`. */
  address: `0x${string}`;
}

export function fireblocksSigner(options: FireblocksSignerOptions): PaymentSigner {
  const { vaultId, address } = options;

  return {
    address,

    async signTypedData(message) {
      const domain = message.domain as Record<string, unknown>;

      // Refuse anything that isn't the payment we expect. Fireblocks will sign
      // whatever it is handed, and this key can address every agent's vault, so
      // the narrow interface is not on its own a sufficient control.
      if (message.primaryType !== "TransferWithAuthorization") {
        throw new Error(
          `Refusing to sign: expected primaryType TransferWithAuthorization, got ${message.primaryType}`,
        );
      }
      const verifying = domain.verifyingContract;
      if (typeof verifying !== "string" || verifying.toLowerCase() !== ALLOWED_ASSET) {
        throw new Error(`Refusing to sign: unexpected verifyingContract ${String(verifying)}`);
      }
      if (Number(domain.chainId) !== EXPECTED_CHAIN_ID) {
        throw new Error(`Refusing to sign: unexpected chainId ${String(domain.chainId)}`);
      }
      const from = (message.message as Record<string, unknown>).from;
      if (typeof from !== "string" || !isAddressEqual(from as `0x${string}`, address)) {
        throw new Error(`Refusing to sign: authorization is from ${String(from)}, not ${address}`);
      }

      // The digest viem — and therefore the USDC contract — will compute.
      const expectedDigest = hashTypedData(message as unknown as TypedDataDefinition);

      const content = jsonSafe({
        domain,
        // Injected LAST so a caller-supplied EIP712Domain cannot displace the
        // canonical one — that would change the digest we are about to commit
        // budget against.
        types: { ...(message.types as object), EIP712Domain: domainType(domain) },
        primaryType: message.primaryType,
        message: message.message,
      });

      // Derived from the digest, so a retry of the *same* authorization dedupes
      // instead of minting a second spendable signature. Distinct payments have
      // distinct nonces and so never collide.
      const externalTxId = `fuel-${expectedDigest.slice(2)}`;

      const fb = fireblocks();

      // Everything above this line is local and provably signature-free, so a
      // refusal there is safe to release budget. Everything below may have put
      // a spendable authorization into existence.
      //
      // `submitted` flips BEFORE the call, not after: a client-side timeout or
      // socket error does not tell us the request failed to reach Fireblocks,
      // and the communal co-signer auto-approves whatever arrives. Any error
      // escaping from here on is reclassified as SignatureMayExistError so the
      // caller holds the budget instead of releasing it.
      let submitted = false;
      try {
        let txId: string;
        try {
          submitted = true;
          const created = await fb.transactions.createTransaction({
            transactionRequest: {
              operation: "TYPED_MESSAGE" as never,
              assetId: SIGNING_ASSET_ID,
              source: { type: "VAULT_ACCOUNT" as never, id: vaultId },
              externalTxId,
              extraParameters: { rawMessageData: { messages: [{ type: "EIP712", content }] } },
            },
          });
          if (!created.data.id) throw new Error("Fireblocks returned no transaction id");
          txId = created.data.id;
        } catch (error) {
          // A duplicate externalTxId means this exact authorization was already
          // submitted. Adopt the existing one rather than signing twice.
          const existing = await fb.transactions
            .getTransactionByExternalId({ externalTxId })
            .catch(() => null);
          if (!existing?.data.id) throw error;
          txId = existing.data.id;
        }

        const signature = await awaitSignature(txId, externalTxId);
        const { fullSig, v } = signature;
        if (typeof fullSig !== "string" || !/^[0-9a-fA-F]{128}$/.test(fullSig)) {
          throw new Error(`Fireblocks returned a malformed signature for tx ${txId}`);
        }
        if (typeof v !== "number") {
          throw new Error(`Fireblocks returned no recovery id for tx ${txId}`);
        }

        // USDC's EIP-3009 goes through OpenZeppelin ECDSA, which rejects the
        // malleable high-s form. Fireblocks canonicalizes, but catching it here
        // costs nothing and turns an on-chain revert (budget already consumed)
        // into a refusal we can see.
        if (BigInt(`0x${fullSig.slice(64)}`) > SECP256K1_HALF_N) {
          throw new Error(`Fireblocks returned a high-s signature for tx ${txId}`);
        }

        const full = `0x${fullSig}${normalizeV(v)}` as `0x${string}`;

        // The check that makes a silently-wrong digest impossible to ship.
        const recovered = await recoverAddress({ hash: expectedDigest, signature: full });
        if (!isAddressEqual(recovered, address)) {
          throw new Error(
            `signature recovers to ${recovered}, expected ${address} (Fireblocks tx ${txId})`,
          );
        }

        return full;
      } catch (error) {
        if (submitted && !(error instanceof SignatureMayExistError)) {
          throw new SignatureMayExistError(
            `Signing was submitted to Fireblocks and may have produced a spendable ` +
              `authorization; treating budget as spent. Cause: ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
        }
        throw error;
      }
    },
  };
}

/** Fireblocks returns v as a 0/1 recovery id; ecrecover wants 27/28. */
function normalizeV(v: number): string {
  return (v < 27 ? v + 27 : v).toString(16).padStart(2, "0");
}

/** Shape is unvalidated by the SDK types, so treat every field as maybe-absent. */
interface FireblocksSignature {
  fullSig?: string;
  v?: number;
}

async function awaitSignature(txId: string, externalTxId: string): Promise<FireblocksSignature> {
  const fb = fireblocks();
  const deadline = Date.now() + SIGN_TIMEOUT_MS;
  let lastPollError = "";

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    // A transient read failure mid-poll says nothing about the signature; keep
    // polling until the deadline rather than abandoning a live signing request.
    let tx: {
      status?: string;
      subStatus?: string;
      signedMessages?: Array<{ signature?: FireblocksSignature }>;
    };
    try {
      tx = (await fb.transactions.getTransaction({ txId })).data as typeof tx;
    } catch (error) {
      lastPollError = error instanceof Error ? error.message : String(error);
      continue;
    }

    if (!TERMINAL.includes(tx.status ?? "")) continue;

    const signature = tx.signedMessages?.[0]?.signature;
    if (tx.status === "COMPLETED" && signature?.fullSig) return signature;

    // Terminal but unusable. FAILED/REJECTED/BLOCKED before signing is the
    // normal case, but we cannot prove from here that no key share ever
    // touched it, so treat it as maybe-signed and let the caller fail closed.
    throw new SignatureMayExistError(
      `Fireblocks transaction ${txId} ended ${tx.status}${tx.subStatus ? ` (${tx.subStatus})` : ""} without a usable signature`,
    );
  }

  throw new SignatureMayExistError(
    `Fireblocks did not return a signature for ${externalTxId} within ${SIGN_TIMEOUT_MS}ms ` +
      `(tx ${txId}); it may still complete${lastPollError ? `. Last poll error: ${lastPollError}` : ""}`,
  );
}
