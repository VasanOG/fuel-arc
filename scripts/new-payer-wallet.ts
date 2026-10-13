/**
 * Generates a throwaway TESTNET-ONLY wallet used to pay the Phase 0 test
 * endpoint, so we can prove the x402 loop works before wiring up Fireblocks
 * signing.
 *
 * This key is generated locally and never leaves the machine. It exists only
 * to hold faucet USDC on Base Sepolia. Never fund it with real money — for
 * anything beyond this test, custody belongs in Fireblocks
 * (docs/decisions/0001-custody-provider.md).
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

// The key is printed once so it can be pasted into .env (gitignored). It is
// deliberately not written to any file automatically.
console.log(`Address:     ${account.address}`);
console.log(`Private key: ${privateKey}`);
console.log();
console.log("Add the private key to .env as TEST_PAYER_PRIVATE_KEY, then claim");
console.log("USDC at https://faucet.circle.com — select Base Sepolia in the");
console.log("network dropdown.");
console.log();
console.log("USDC is all it needs. Do NOT go hunting for testnet ETH: x402");
console.log("payments are signed off-chain, and the facilitator pays the gas");
console.log("to broadcast them. This wallet will sit at 0 ETH forever.");
console.log();
console.log("!! TESTNET ONLY. Never send real money to this address, and never");
console.log("!! use this script to make a key intended for mainnet. It was just");
console.log("!! printed to your terminal, so assume scrollback and session logs");
console.log("!! have it. Real custody belongs in Fireblocks.");
