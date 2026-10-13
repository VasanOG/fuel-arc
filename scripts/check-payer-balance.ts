/**
 * Reports the test payer wallet's balances on Base Sepolia, so we can confirm
 * funding directly instead of inferring it from a payment failure.
 *
 * Read-only: this makes eth_call / eth_getBalance queries and nothing else.
 */
import "dotenv/config";
import { createPublicClient, formatUnits, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { describe, requireEnv } from "../src/lib/env.js";

// Base Sepolia only — hardcoded, consistent with the rest of Phase 0.
// See CLAUDE.md "Non-negotiable rule".
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const erc20BalanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

async function main() {
  const account = privateKeyToAccount(requireEnv("TEST_PAYER_PRIVATE_KEY") as `0x${string}`);
  const client = createPublicClient({ chain: baseSepolia, transport: http() });

  const [usdc, eth] = await Promise.all([
    client.readContract({
      address: USDC_BASE_SEPOLIA,
      abi: erc20BalanceOfAbi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    client.getBalance({ address: account.address }),
  ]);

  console.log(`Payer: ${account.address}`);
  console.log(`  USDC: ${formatUnits(usdc, 6)}`);
  console.log(`  ETH:  ${formatUnits(eth, 18)}`);
  console.log();

  if (usdc === 0n) {
    console.log("No USDC. Claim some at https://faucet.circle.com —");
    console.log("select Base Sepolia in the network dropdown, and paste the address above.");
  } else {
    console.log("Funded. `npm run pay-test-endpoint` should settle.");
  }

  // Stated explicitly because a zero ETH balance looks like a problem and isn't.
  console.log();
  console.log("A 0 ETH balance is expected: x402 payments are signed off-chain,");
  console.log("and the facilitator pays the gas to broadcast them.");
}

main().catch((error) => {
  console.error("Failed to read balances:", describe(error));
  process.exit(1);
});
