/**
 * Registers Base Sepolia USDC as an asset in our Fireblocks sandbox workspace.
 *
 * Why this is needed: the sandbox ships with exactly one Base asset
 * (BASECHAIN_ETH_TEST5, native ETH). x402 settles in USDC, so without this the
 * vault holds USDC on-chain but Fireblocks shows no balance for it.
 *
 * This only registers an asset *definition* in a sandbox workspace. It moves
 * no funds and creates no transaction.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BasePath, Fireblocks } from "@fireblocks/ts-sdk";
import { describe, requireEnv } from "../src/lib/env.js";

// Hardcoded sandbox — see CLAUDE.md "Non-negotiable rule".
const BASE_PATH = BasePath.Sandbox;

// Base Testnet Sepolia (chainId 84532) as registered in the Fireblocks sandbox.
// This endpoint wants the legacy string id, not the UUID — passing the UUID
// returns "Blockchain not found".
const BASE_SEPOLIA_BLOCKCHAIN_ID = "BASECHAIN_ETH_TEST5";

// Circle's canonical USDC on Base Sepolia.
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function main() {
  const fireblocks = new Fireblocks({
    apiKey: requireEnv("FIREBLOCKS_API_KEY"),
    secretKey: readFileSync(resolve(requireEnv("FIREBLOCKS_PRIVATE_KEY_PATH")), "utf8"),
    basePath: BASE_PATH,
  });

  const result = await fireblocks.blockchainsAssets.registerNewAsset({
    registerNewAssetRequest: {
      blockchainId: BASE_SEPOLIA_BLOCKCHAIN_ID,
      address: USDC_BASE_SEPOLIA,
      symbol: "USDC",
    },
  });

  console.log(`Registered asset: ${result.data.legacyId}`);
  console.log(JSON.stringify(result.data, null, 2));
}

main().catch((error) => {
  console.error("Failed to register Base Sepolia USDC:", describe(error));
  process.exit(1);
});
