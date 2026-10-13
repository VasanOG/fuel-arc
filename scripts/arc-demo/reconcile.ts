/**
 * Checks Fuel's ledger against the chain, read-only. Signs nothing, sends nothing.
 *
 *   npx tsx scripts/arc-demo/reconcile.ts [starting agent balance in USDC, default 20 for the rehearsal]
 *
 * For every payment the ledger records as paid: the transaction succeeded, and
 * it carries a USDC Transfer from the demo agent to the shop of exactly the
 * recorded amount (matched on the 6-decimal ERC-20 event; Arc also emits an
 * 18-decimal native mirror of every transfer, which is ignored here). Then the
 * agent's balance drop equals the ledger's paid total, and the network fees the
 * shop paid are reported.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { ARC_TESTNET, MAINNET_DEMO } from "../../src/payments/arc-chain.js";

const chain = MAINNET_DEMO.chain;
const rehearsal = chain.chainId === ARC_TESTNET.chainId;
const startUsd = process.argv[2] ?? (rehearsal ? "20" : undefined);
if (startUsd === undefined) {
  console.error("usage: reconcile.ts <the agent's starting balance in USDC>");
  process.exit(2);
}
const start = BigInt(Math.round(Number(startUsd) * 1e6));

const db = new DatabaseSync(join(homedir(), ".fuel-arc", rehearsal ? "rehearsal.db" : "fuel-arc.db"), { readOnly: true });
const rows = db
  .prepare("SELECT status, amount_base_units AS amount, tx_hash FROM payments WHERE agent_id = ? ORDER BY created_at")
  .all(MAINNET_DEMO.agentId) as unknown as { status: string; amount: number; tx_hash: string | null }[];

const client = createPublicClient({
  chain: defineChain({ id: chain.chainId, name: chain.label, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [chain.rpcUrl] } } }),
  transport: http(chain.rpcUrl, { timeout: 20_000 }),
});
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

const counts: Record<string, number> = {};
for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log(`${chain.label}: ledger rows by status ${JSON.stringify(counts)}`);

let ok = 0;
let matched = 0;
let fees = 0n;
let paid = 0n;
const problems: string[] = [];
for (const r of rows.filter((x) => x.status === "settled")) {
  paid += BigInt(r.amount);
  if (!r.tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(r.tx_hash)) {
    problems.push(`a paid row has no transaction hash`);
    continue;
  }
  const receipt = await client.getTransactionReceipt({ hash: r.tx_hash as `0x${string}` });
  if (receipt.status === "success") ok += 1;
  else problems.push(`${r.tx_hash} did not succeed`);
  fees += receipt.gasUsed * receipt.effectiveGasPrice;
  const hit = receipt.logs.some(
    (l) =>
      l.address.toLowerCase() === chain.asset.toLowerCase() &&
      l.topics[0] === TRANSFER &&
      l.topics[1]?.toLowerCase() === topicAddr(MAINNET_DEMO.address) &&
      l.topics[2]?.toLowerCase() === topicAddr(MAINNET_DEMO.payee) &&
      BigInt(l.data) === BigInt(r.amount),
  );
  if (hit) matched += 1;
  else problems.push(`${r.tx_hash} has no agent-to-shop transfer of exactly ${r.amount}`);
}
const settledCount = rows.filter((x) => x.status === "settled").length;
const balanceOf = (a: string) =>
  client.readContract({ address: chain.asset as `0x${string}`, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [a as `0x${string}`] });
const agentNow = await balanceOf(MAINNET_DEMO.address);
const shopNow = await balanceOf(MAINNET_DEMO.payee);

const usd = (u: bigint) => `$${(Number(u) / 1e6).toFixed(6)}`;
console.log(`paid rows: ${settledCount}, ledger total ${usd(paid)}`);
console.log(`receipts that succeeded: ${ok}/${settledCount}; with an agent-to-shop transfer of exactly the recorded amount: ${matched}/${settledCount}`);
console.log(`agent balance now ${usd(agentNow)}; drop from ${usd(start)} is ${usd(start - agentNow)}: ${start - agentNow === paid ? "EQUALS the ledger's paid total" : "DOES NOT equal the ledger's paid total"}`);
console.log(`shop balance now ${usd(shopNow)}; network fees the shop paid: $${(Number(fees) / 1e18).toFixed(6)} (about $${(Number(fees) / 1e18 / Math.max(settledCount, 1)).toFixed(6)} a payment)`);
if (problems.length) console.log(`PROBLEMS:\n  ${problems.join("\n  ")}`);
process.exit(problems.length || start - agentNow !== paid ? 1 : 0);
