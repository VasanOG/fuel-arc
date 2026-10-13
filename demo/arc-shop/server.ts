/**
 * Runs the founder's demo shop with its real settler on Arc.
 *
 *   ARC_SHOP_KEY_FILE=~/.fuel-arc/shop.key PORT=3210 npx tsx demo/arc-shop/server.ts
 *
 * The chain is MAINNET_DEMO.chain (src/payments/arc-chain.ts), the payee is
 * MAINNET_DEMO.payee, and the key file must hold that payee's key: the shop's
 * wallet both receives the payments and pays the gas to settle them.
 *
 * The key is read once from a 0600 file under ~/.fuel-arc/ and never printed.
 */
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET_DEMO } from "../../src/payments/arc-chain.js";
import { guardedFacilitator, restrictedSettlerSigner, type Settles } from "./settler.js";
import { createShopApp, SHOP_PRICES } from "./shop.js";

function fail(why: string): never {
  console.error(`[arc-shop] not starting: ${why}`);
  process.exit(1);
}

const chain = MAINNET_DEMO.chain;
const keyFile = process.env.ARC_SHOP_KEY_FILE ? resolve(process.env.ARC_SHOP_KEY_FILE) : fail("ARC_SHOP_KEY_FILE is not set");
const keyDir = resolve(homedir(), ".fuel-arc");
if (dirname(keyFile) !== keyDir) fail("the key file must be in ~/.fuel-arc/");
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
const statOrFail = (path: string, what: string) => {
  try {
    return lstatSync(path);
  } catch {
    return fail(`the ${what} does not exist`);
  }
};
const folder = statOrFail(keyDir, "key folder");
if (!folder.isDirectory() || (folder.mode & 0o077) !== 0 || (uid !== undefined && folder.uid !== uid)) fail("~/.fuel-arc must be your own folder, 0700");
const stat = statOrFail(keyFile, "key file");
if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) fail("the key file must be your own regular file, readable only by you (0600)");
const raw = readFileSync(keyFile, "utf8").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) fail("the key file does not hold a private key");
const account = privateKeyToAccount(raw as `0x${string}`);
if (account.address.toLowerCase() !== MAINNET_DEMO.payee.toLowerCase()) {
  fail(`the key file is for ${account.address}, but the shop's payee is ${MAINNET_DEMO.payee}`);
}

const viemChain = defineChain({
  id: chain.chainId,
  name: chain.label,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [chain.rpcUrl] } },
  blockExplorers: { default: { name: "Arc explorer", url: chain.explorerUrl } },
});
const transport = http(chain.rpcUrl, { timeout: 20_000 });
const publicClient = createPublicClient({ chain: viemChain, transport });
const walletClient = createWalletClient({ account, chain: viemChain, transport });

const settlerSigner = restrictedSettlerSigner(
  {
    address: account.address,
    readContract: (args) => publicClient.readContract(args as never),
    verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
    getCode: (args) => publicClient.getCode(args),
    waitForTransactionReceipt: async (args) => publicClient.waitForTransactionReceipt({ ...args, timeout: 60_000 }),
    writeContract: (args) => walletClient.writeContract(args as never),
  },
  chain,
);

const facilitator = new x402Facilitator().register(chain.network as `${string}:${string}`, new ExactEvmScheme(settlerSigner));
const { app, initialize } = createShopApp({
  chain,
  payTo: MAINNET_DEMO.payee,
  facilitator: guardedFacilitator(facilitator as unknown as Settles, { chain, payTo: MAINNET_DEMO.payee, prices: SHOP_PRICES }),
});

const chainId = await publicClient.getChainId();
if (chainId !== chain.chainId) fail(`the RPC at ${chain.rpcUrl} is chain ${chainId}, expected ${chain.chainId}`);
await initialize();

const port = Number(process.env.PORT ?? 3210);
const host = process.env.HOST ?? "127.0.0.1";
app.listen(port, host, () => {
  console.log(`[arc-shop] ${chain.label} (chain ${chain.chainId}); payee ${MAINNET_DEMO.payee}; listening on ${host}:${port}`);
});
