/**
 * Runs the Try-it door with the agent key from its environment, reading both
 * demo wallets' USDC balances from Arc every minute (read-only RPC calls; this
 * process holds no chain key and signs nothing).
 *
 *   FUEL_AGENT_KEY=... PORT=3220 npx tsx demo/try-it/door-server.ts
 *
 * Settings, all optional but the key:
 *   HOST                       bind address; 127.0.0.1 unless told otherwise
 *   FUEL_API_URL               http://127.0.0.1:3200
 *   TRYIT_SHOP_URL             http://127.0.0.1:3210
 *   TRYIT_APPROVER_URL         http://127.0.0.1:3230
 *   TRYIT_ALLOWED_ORIGIN       https://vasanog.github.io
 *   TRYIT_PAUSE_FILE           ~/.fuel-arc/tryit.paused
 *   TRYIT_LOG_FILE             ~/.fuel-arc/tryit-log.jsonl
 *   TRYIT_TRUST_FLY_CLIENT_IP  "1" when the Fly proxy is the only way in:
 *                              the per-visitor limit then keys on Fly-Client-IP
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, defineChain, erc20Abi, http } from "viem";
import { MAINNET_DEMO } from "../../src/payments/arc-chain.js";
import { createDoorApp } from "./door.js";
import type { Balances } from "./policy.js";

const agentKey = process.env.FUEL_AGENT_KEY;
if (!agentKey) {
  console.error("[try-it] not starting: FUEL_AGENT_KEY is not set");
  process.exit(1);
}
if (process.env.FUEL_API_KEY) {
  console.error("[try-it] not starting: FUEL_API_KEY is set in this process; the door must hold only the agent key");
  process.exit(1);
}
const dir = join(homedir(), ".fuel-arc");
const chain = MAINNET_DEMO.chain;
const client = createPublicClient({
  chain: defineChain({ id: chain.chainId, name: chain.label, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [chain.rpcUrl] } } }),
  transport: http(chain.rpcUrl, { timeout: 15_000 }),
});

let balances: Balances | null = null;
async function readBalances(): Promise<void> {
  try {
    const [agent, shop] = await Promise.all(
      [MAINNET_DEMO.address, MAINNET_DEMO.payee].map((who) => client.readContract({ address: chain.asset, abi: erc20Abi, functionName: "balanceOf", args: [who] })),
    );
    balances = { agentBaseUnits: agent!, shopBaseUnits: shop!, readAt: Date.now() };
  } catch (error) {
    console.error(`[try-it] balance read failed: ${(error as Error).message}`);
  }
}
await readBalances();
setInterval(readBalances, 60_000).unref();

const trustFly = process.env.TRYIT_TRUST_FLY_CLIENT_IP === "1";
const app = createDoorApp({
  fuelUrl: process.env.FUEL_API_URL ?? "http://127.0.0.1:3200",
  agentKey,
  shopUrl: process.env.TRYIT_SHOP_URL ?? "http://127.0.0.1:3210",
  approverUrl: process.env.TRYIT_APPROVER_URL ?? "http://127.0.0.1:3230",
  allowedOrigin: process.env.TRYIT_ALLOWED_ORIGIN ?? "https://vasanog.github.io",
  pauseFile: process.env.TRYIT_PAUSE_FILE ?? join(dir, "tryit.paused"),
  logFile: process.env.TRYIT_LOG_FILE ?? join(dir, "tryit-log.jsonl"),
  balances: () => balances,
  clientAddress: (req) => {
    const fly = req.headers["fly-client-ip"];
    const address = trustFly && typeof fly === "string" && fly ? fly : (req.socket.remoteAddress ?? "unknown");
    // One IPv6 subscriber holds a whole /64, so the limit keys on that prefix,
    // or a visitor could take a fresh address for every attempt.
    return address.includes(":") ? address.split(":").slice(0, 4).join(":") + "::/64" : address;
  },
});

const port = Number(process.env.PORT ?? 3220);
const host = process.env.HOST ?? "127.0.0.1";
app.listen(port, host, () => {
  console.log(`[try-it] ${chain.label}; agent ${MAINNET_DEMO.address} pays the shop ${MAINNET_DEMO.payee}; listening on ${host}:${port}`);
});
