/**
 * Fireblocks vault provisioning.
 *
 * Lifted from scripts/create-sandbox-wallet.ts, which proved this flow in
 * Phase 0. Each agent gets its own vault account with the gas and USDC assets
 * activated.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BasePath, Fireblocks } from "@fireblocks/ts-sdk";
import { requireEnv } from "../lib/env.js";

// Hardcoded, not read from env: nothing may make mainnet a config toggle away.
// See CLAUDE.md "Non-negotiable rule".
export const BASE_PATH = BasePath.Sandbox;

/** Native Base Sepolia ETH. Held for completeness; x402 payers never spend gas. */
const GAS_ASSET_ID = "BASECHAIN_ETH_TEST5";

/**
 * Base Sepolia USDC — what x402 settles in. Workspace-local id (note the
 * suffix), created by scripts/register-base-usdc.ts. Run that first in a
 * fresh workspace.
 */
const USDC_ASSET_ID = "USDC_BASECHAIN_ETH_TEST5_29AA";

/**
 * What a person is told this network and asset are called, when a funding
 * panel has to say so (ADR 0019). Exported from here, next to the asset ids
 * they describe, so a dashboard label can never drift from what the signer
 * actually refuses everything else for (`EXPECTED_CHAIN_ID` in
 * src/fireblocks/signer.ts) — one is derived reasoning about the other, not
 * two separately maintained facts.
 *
 * Whoever changes BASE_PATH to a production workspace changes these too, in
 * the same reviewed commit; that is the point of naming the network rather
 * than leaving it implicit in an asset id's suffix.
 */
export const NETWORK_LABEL = "Base Sepolia";
export const ASSET_LABEL = "USDC";

let client: Fireblocks | null = null;

export function fireblocks(): Fireblocks {
  if (!client) {
    client = new Fireblocks({
      apiKey: requireEnv("FIREBLOCKS_API_KEY"),
      secretKey: readFileSync(resolve(requireEnv("FIREBLOCKS_PRIVATE_KEY_PATH")), "utf8"),
      basePath: BASE_PATH,
    });
  }
  return client;
}

export interface ProvisionedWallet {
  vaultAccountId: string;
  address: string;
}

/** Fireblocks' "no such vault asset" code — see getVaultUsdcBalance. */
const ASSET_NOT_FOUND_CODE = 1006;

/**
 * Reads a vault's USDC balance, in USDC (which the product treats as dollars
 * 1:1, same as everywhere else — see lib/money.ts).
 *
 * Best-effort: returns null on failure rather than throwing, so a Fireblocks
 * hiccup degrades one dashboard cell instead of the whole agent list. This is
 * a read with no side effects — it cannot move funds or affect a cap
 * decision, so it deliberately sits outside the money-safety-reviewed
 * cap/payment path.
 *
 * Fireblocks 404s (code 1006) an asset that has zero balance and no
 * transaction history yet, even though it was activated during provisioning —
 * verified directly against the sandbox. That specific case is a real "$0",
 * not a failure, so it's reported as such; any other error stays null
 * ("balance unknown"), since claiming zero there could read as "this vault is
 * empty" when it might just be unreachable.
 */
export async function getVaultUsdcBalance(vaultAccountId: string): Promise<string | null> {
  try {
    const asset = await fireblocks().vaults.getVaultAccountAsset({
      vaultAccountId,
      assetId: USDC_ASSET_ID,
    });
    return asset.data.available ?? null;
  } catch (error) {
    const code = (error as { response?: { data?: { code?: number } } })?.response?.data?.code;
    return code === ASSET_NOT_FOUND_CODE ? "0" : null;
  }
}

/**
 * Creates (or reuses) a vault account for an agent and activates its assets.
 *
 * Idempotent by name: Fireblocks rejects duplicate vault account names, and
 * re-running provisioning should not fail.
 */
export async function provisionAgentWallet(vaultName: string): Promise<ProvisionedWallet> {
  const fb = fireblocks();

  const existing = await fb.vaults.getPagedVaultAccounts({ namePrefix: vaultName });
  const found = existing.data.accounts?.find((a) => a.name === vaultName);

  let vaultAccountId: string;
  if (found?.id) {
    vaultAccountId = found.id;
  } else {
    const created = await fb.vaults.createVaultAccount({
      createVaultAccountRequest: { name: vaultName },
    });
    if (!created.data.id) throw new Error("Fireblocks returned a vault account with no id.");
    vaultAccountId = created.data.id;
  }

  const supported = await fb.blockchainsAssets.getSupportedAssets();
  let address = "";

  for (const assetId of [GAS_ASSET_ID, USDC_ASSET_ID]) {
    if (!supported.data.some((a) => a.id === assetId)) {
      throw new Error(`${assetId} is not in this workspace's supported assets.`);
    }
    const activated = await activateAsset(fb, vaultAccountId, assetId);
    // Both assets live at the same EVM address; keep whichever resolves.
    if (activated) address = activated;
  }

  if (!address) throw new Error(`Could not resolve a deposit address for ${vaultName}`);
  return { vaultAccountId, address };
}

/**
 * Activates one asset and returns its deposit address.
 *
 * Idempotent: activating an already-active asset is a 400, so read the
 * existing address instead of failing.
 */
async function activateAsset(
  fb: Fireblocks,
  vaultAccountId: string,
  assetId: string,
): Promise<string | null> {
  const addresses = await fb.vaults
    .getVaultAccountAssetAddressesPaginated({ vaultAccountId, assetId })
    .catch(() => null);
  const existing = addresses?.data.addresses?.[0]?.address;
  if (existing) return existing;

  const created = await fb.vaults.createVaultAccountAsset({ vaultAccountId, assetId });
  return created.data.address ?? null;
}
