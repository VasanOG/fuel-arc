/**
 * Pays the Phase 0 test endpoint over x402, using a throwaway testnet wallet.
 *
 * This proves the x402 loop end to end (402 -> sign -> verify -> settle -> 200)
 * independently of Fireblocks. Roadmap item 4 swaps this local signer for the
 * Fireblocks vault, which needs a SIGNER-role API key and typed-message
 * signing enabled.
 */
import "dotenv/config";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { describe, requireEnv } from "../src/lib/env.js";

const ENDPOINT = process.env.X402_ENDPOINT ?? "http://localhost:3000/paid-hello";

// The only network this payer will ever sign for. Base Sepolia.
const ALLOWED_NETWORK = "eip155:84532";

// Hard ceiling per payment, in USDC base units (6 decimals) — 10000 = $0.01.
// In x402 the *server* dictates the price, so the payer is the only party with
// an interest in bounding it. Without this, a 402 response is an instruction to
// sign for any amount on any chain.
const MAX_AMOUNT_BASE_UNITS = 10_000n;

async function main() {
  const account = privateKeyToAccount(requireEnv("TEST_PAYER_PRIVATE_KEY") as `0x${string}`);
  console.log(`Paying as ${account.address}`);

  const client = new x402Client();

  // Registered BEFORE the scheme, and as a policy rather than just `networks`:
  // registerExactEvmScheme unconditionally registers v1 schemes for every EVM
  // chain it knows about (mainnet included), and `networks` does not suppress
  // that. Policies are applied to both v1 and v2 selection, so this is the only
  // filter that actually closes the mainnet path.
  client.registerPolicy((_version, requirements) =>
    requirements.filter(
      (r) => r.network === ALLOWED_NETWORK && BigInt(r.amount) <= MAX_AMOUNT_BASE_UNITS,
    ),
  );

  registerExactEvmScheme(client, { signer: account, networks: [ALLOWED_NETWORK] });
  const http = new x402HTTPClient(client);

  // 1. Ask for the resource with no payment — expect a 402 carrying the terms.
  const unpaid = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
  if (unpaid.status !== 402) {
    throw new Error(`Expected 402 on first request, got ${unpaid.status}`);
  }

  const paymentRequired = http.getPaymentRequiredResponse(
    (name) => unpaid.headers.get(name),
    await unpaid.clone().json().catch(() => undefined),
  );
  // Belt and braces alongside the policy: state the terms we will actually
  // accept, and refuse loudly rather than silently signing something else.
  const terms = paymentRequired.accepts.find(
    (r) => r.network === ALLOWED_NETWORK && BigInt(r.amount) <= MAX_AMOUNT_BASE_UNITS,
  );
  if (!terms) {
    const offered = paymentRequired.accepts
      .map((r) => `${r.amount} on ${r.network}`)
      .join("; ");
    throw new Error(
      `No acceptable terms. Wanted <=${MAX_AMOUNT_BASE_UNITS} on ${ALLOWED_NETWORK}; offered: ${offered}`,
    );
  }
  console.log(`Paying ${terms.amount} of ${terms.asset} on ${terms.network}`);

  // 2. Sign an EIP-3009 authorization for exactly those terms. This is an
  //    off-chain signature — no gas, nothing on-chain yet.
  const payload = await http.createPaymentPayload(paymentRequired);

  // 3. Retry with the signed payment. The server hands it to the facilitator,
  //    which submits transferWithAuthorization and settles on-chain.
  const paid = await fetch(ENDPOINT, {
    headers: { Accept: "application/json", ...http.encodePaymentSignatureHeader(payload) },
  });

  console.log(`HTTP ${paid.status}`);
  console.log(await paid.text());

  const settlement = paid.headers.get("PAYMENT-RESPONSE");
  if (settlement) {
    console.log("Settlement:", JSON.stringify(decodePaymentResponseHeader(settlement)));
  }

  if (!paid.ok) {
    // A second 402 means the facilitator rejected the payment. The reason is
    // in the PAYMENT-REQUIRED header, not the (empty) body.
    const retryHeader = paid.headers.get("PAYMENT-REQUIRED");
    let reason = "(no PAYMENT-REQUIRED header)";
    if (retryHeader) {
      const decoded = Buffer.from(retryHeader, "base64").toString();
      try {
        // Remote input: a parse failure here must not mask the rejection.
        reason = String(JSON.parse(decoded).error ?? "(no error field)");
      } catch {
        reason = `(unparseable header: ${decoded.slice(0, 100)})`;
      }
    }
    throw new Error(`Payment rejected (HTTP ${paid.status}): ${reason}`);
  }
}

main().catch((error) => {
  console.error("Failed to pay test endpoint:", describe(error));
  process.exit(1);
});
