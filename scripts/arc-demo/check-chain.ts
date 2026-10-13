/**
 * Read-only checks against an Arc chain. Signs nothing, sends nothing.
 *
 *   npx tsx scripts/arc-demo/check-chain.ts <testnet|mainnet> [address ...]
 *
 * Confirms the facts the demo depends on -- the chain id the RPC reports, and
 * the USDC token's name, version, decimals and EIP-712 domain separator (which
 * must equal the one Fuel will sign against) -- then prints the USDC balance of
 * each address given, defaulting to the demo wallets in ~/.fuel-arc/.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, defineChain, hashDomain, http, parseAbi } from "viem";
import { ARC_MAINNET, ARC_TESTNET } from "../../src/payments/arc-chain.js";

const which = process.argv[2];
const chain = which === "mainnet" ? ARC_MAINNET : which === "testnet" ? ARC_TESTNET : null;
if (!chain) {
  console.error("usage: check-chain.ts <testnet|mainnet> [address ...]");
  process.exit(2);
}

const client = createPublicClient({
  chain: defineChain({
    id: chain.chainId,
    name: chain.label,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
  }),
  transport: http(chain.rpcUrl, { timeout: 20_000 }),
});
const abi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function balanceOf(address) view returns (uint256)",
]);
const token = chain.asset as `0x${string}`;
const read = <T>(functionName: string, args: unknown[] = []) =>
  client.readContract({ address: token, abi, functionName: functionName as never, args: args as never }) as Promise<T>;

const reportedChainId = await client.getChainId();
const [name, version, decimals, separator] = await Promise.all([
  read<string>("name"),
  read<string>("version"),
  read<number>("decimals"),
  read<`0x${string}`>("DOMAIN_SEPARATOR").catch(() => null),
]);
const expected = hashDomain({
  domain: { name: chain.domainName, version: chain.domainVersion, chainId: BigInt(chain.chainId), verifyingContract: token },
  types: { EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ] },
});

const ok = (b: boolean) => (b ? "ok" : "MISMATCH");
console.log(`${chain.label} via ${chain.rpcUrl}`);
console.log(`  chain id: ${reportedChainId} (${ok(reportedChainId === chain.chainId)})`);
console.log(`  USDC at ${token}: name "${name}" (${ok(name === chain.domainName)}), version "${version}" (${ok(version === chain.domainVersion)}), decimals ${decimals} (${ok(decimals === 6)})`);
console.log(`  EIP-712 domain separator: ${separator === null ? "not exposed" : ok(separator.toLowerCase() === expected.toLowerCase())}`);

const dir = join(homedir(), ".fuel-arc");
const named = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim() : null);
const wallets: [string, string | null][] =
  process.argv.length > 3
    ? process.argv.slice(3).map((a) => [a, a])
    : which === "mainnet"
      ? [["agent", named("agent.address")], ["shop", named("shop.address")]]
      : [["test-agent", named("test-agent.address")], ["test-shop", named("test-shop.address")]];
for (const [label, address] of wallets) {
  if (!address) continue;
  const balance = await read<bigint>("balanceOf", [address]);
  console.log(`  ${label} ${address}: $${(Number(balance) / 1e6).toFixed(6)}`);
}
