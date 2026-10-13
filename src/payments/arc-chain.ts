/**
 * THE ARC FOUNDER DEMO: every Arc constant Fuel has, and the one agent allowed
 * to use them. Arc mainnet moves REAL money. Read this before changing it.
 *
 * WHAT THIS IS. One agent, the founder's own, pays real USDC on Arc through
 * Fuel's real controls (caps, approvals, rate limit, freeze, ledger). Its money
 * goes to a shop the founder also operates, so it moves between the founder's
 * own wallets. Every other agent and every other company stays on Base Sepolia,
 * with every testnet guard in pay.ts, signer.ts and provision.ts unchanged.
 *
 * WHY A SEPARATE FILE. Constants only: no database, no environment, no I/O. The
 * shop (demo/arc-shop/) imports it and must not open Fuel's database by doing
 * so. The lock and the signer that act on these live in ./arc-demo.ts.
 *
 * WHERE ARC MAY BE NAMED. Here, in ./arc-demo.ts, in demo/arc-shop/ and in
 * scripts/arc-demo/ -- and nowhere else in src/. scripts/verify-arc-lock.ts
 * fails the build otherwise.
 *
 * Sources (read 12 Oct 2026): docs.arc.io/arc/references/connect-to-arc and
 * contract-addresses; x402-foundation/x402 PR #3590 (USDC EIP-712 domain).
 */

/** What every Arc chain shares. The ERC-20 face of native USDC is a predeploy. */
const ARC_USDC = {
  /** The 6-decimal ERC-20 interface. Native USDC (gas) is the same balance at 18 decimals. */
  asset: "0x3600000000000000000000000000000000000000",
  /** The EIP-712 domain the token verifies transferWithAuthorization against. */
  domainName: "USDC",
  domainVersion: "2",
} as const;

export const ARC_MAINNET = {
  label: "Arc mainnet",
  chainId: 5042,
  network: "eip155:5042",
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorerUrl: "https://explorer.arc.io",
  ...ARC_USDC,
} as const;

export const ARC_TESTNET = {
  label: "Arc testnet",
  chainId: 5042002,
  network: "eip155:5042002",
  rpcUrl: "https://rpc.testnet.arc.io",
  explorerUrl: "https://explorer.testnet.arc.io",
  ...ARC_USDC,
} as const;

export type ArcChain = typeof ARC_MAINNET | typeof ARC_TESTNET;

/**
 * THE ONE AGENT THAT PAYS ON ARC, BY LITERAL.
 *
 * All four identifiers must match before Fuel will treat an agent as this one:
 * its id, its company's id, its wallet address, and (for the signer) the payee.
 * Nothing in the database, the environment or a request can add an agent to
 * this list; changing it is a code change, reviewed like any other.
 *
 * `chain` is ARC_TESTNET for the rehearsal and becomes ARC_MAINNET in one
 * reviewed commit before the first live payment, with the mainnet demo
 * database's ids and the mainnet wallets.
 */
export const MAINNET_DEMO = {
  chain: ARC_MAINNET as ArcChain,
  companyId: "befc0fb7-b2af-4dd4-82e9-83ef5733025d",
  agentId: "959f3d7c-0b7b-4040-b708-566d64c8922f",
  /** The agent's own wallet: `~/.fuel-arc/agent.address`. */
  address: "0xa963C45e1fc634036EE53FA8DAF712B83F05bC4f",
  /** The founder's shop wallet (`~/.fuel-arc/shop.address`): the only payee the Arc signer will sign for. */
  payee: "0x3ddC6a2d414e658EdC3462fF97F963C81Fca64e7",
} as const;

/** The most one Arc payment may be: $0.01. The same ceiling pay.ts applies to every agent. */
export const ARC_MAX_PER_PAYMENT_BASE_UNITS = 10_000n;

/**
 * The most the demo agent may EVER commit on Arc: $5.00. The founder funds
 * the wallet with $5.50, so the ledger limit binds first and the wallet's own
 * balance bounds it on chain too. Checked by the Arc signer against the ledger
 * before every signature.
 */
export const ARC_LIFETIME_LIMIT_BASE_UNITS = 5_000_000n;

/** How far ahead an authorization may stay spendable. The shop asks for 300 s. */
export const ARC_MAX_VALIDITY_SECONDS = 900;
