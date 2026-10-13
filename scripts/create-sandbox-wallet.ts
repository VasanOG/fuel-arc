import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";
import { BasePath, Fireblocks } from "@fireblocks/ts-sdk";
import { describe, requireEnv } from "../src/lib/env.js";

// Hardcoded, not read from env: nothing in Phase 0 should make mainnet a
// config toggle away. See CLAUDE.md "Non-negotiable rule".
const BASE_PATH = BasePath.Sandbox;

const VAULT_ACCOUNT_NAME = "fuel-test-wallet";

// Base Sepolia. Pinned to one exact id rather than pattern-matched: a search
// like /TEST/i also matches mainnet tokens that merely contain "test" in their
// id (including custom tokens a workspace can add), and would silently
// activate a mainnet asset while reporting success.
// Native Base Sepolia ETH — pays gas.
const GAS_ASSET_ID = "BASECHAIN_ETH_TEST5";

// Base Sepolia USDC — what x402 actually settles in. The sandbox has no Base
// USDC by default; this id is workspace-local (note the random suffix) and was
// created by `npx tsx scripts/register-base-usdc.ts`. Run that first if this
// id is missing.
const USDC_ASSET_ID = "USDC_BASECHAIN_ETH_TEST5_29AA";

async function main() {
  const apiKey = requireEnv("FIREBLOCKS_API_KEY");
  const secretKey = readFileSync(resolve(requireEnv("FIREBLOCKS_PRIVATE_KEY_PATH")), "utf8");

  const fireblocks = new Fireblocks({ apiKey, secretKey, basePath: BASE_PATH });

  console.log(`Connecting to Fireblocks sandbox (${BASE_PATH})`);

  // Fireblocks rejects duplicate vault account names, so reuse ours if a
  // previous run already made it — this script needs to be safe to re-run.
  const existing = await fireblocks.vaults.getPagedVaultAccounts({
    namePrefix: VAULT_ACCOUNT_NAME,
  });
  const found = existing.data.accounts?.find((a) => a.name === VAULT_ACCOUNT_NAME);

  let vaultAccountId: string;
  if (found?.id) {
    vaultAccountId = found.id;
    console.log(`Reusing existing vault account "${VAULT_ACCOUNT_NAME}" (id ${vaultAccountId})`);
  } else {
    const created = await fireblocks.vaults.createVaultAccount({
      createVaultAccountRequest: { name: VAULT_ACCOUNT_NAME },
    });
    if (!created.data.id) throw new Error("Fireblocks returned a vault account with no id.");
    vaultAccountId = created.data.id;
    console.log(`Created vault account "${VAULT_ACCOUNT_NAME}" (id ${vaultAccountId})`);
  }

  const supported = await fireblocks.blockchainsAssets.getSupportedAssets();

  for (const assetId of [GAS_ASSET_ID, USDC_ASSET_ID]) {
    if (!supported.data.some((a) => a.id === assetId)) {
      throw new Error(`${assetId} is not in this workspace's supported assets.`);
    }
    await activateAsset(fireblocks, vaultAccountId, assetId);
  }
}

/**
 * Activates one asset on the vault account and prints its deposit address.
 *
 * Idempotent: activating an already-active asset is a 400, so read the
 * existing address instead of failing.
 */
async function activateAsset(fireblocks: Fireblocks, vaultAccountId: string, assetId: string) {
  const addresses = await fireblocks.vaults
    .getVaultAccountAssetAddressesPaginated({ vaultAccountId, assetId })
    .catch(() => null);
  const existingAddress = addresses?.data.addresses?.[0]?.address;

  if (existingAddress) {
    console.log(`${assetId} already active — ${existingAddress}`);
    return;
  }

  const asset = await fireblocks.vaults.createVaultAccountAsset({ vaultAccountId, assetId });
  console.log(`Activated ${assetId} — ${asset.data.address ?? "(address pending)"}`);
}

main().catch((error) => {
  console.error("Failed to create sandbox wallet:", describe(error));
  process.exit(1);
});
