/**
 * The lock and the signer for the Arc founder demo. The constants they act on,
 * and the reasons for them, are in ./arc-chain.ts -- read that first.
 *
 * FIVE LAYERS KEEP EVERY OTHER AGENT OFF ARC:
 *
 *   1. Identity in code. `isArcDemoAgent` matches one agent by id, by its
 *      company's id and by its wallet address, all literals. For any other
 *      agent it returns false after one string comparison, before reading
 *      anything, so their payments take exactly the path they took before.
 *   2. The rail. pay.ts asks `railFor`, which gives Base Sepolia to everyone
 *      else. The demo agent gets Arc only when this process is ARMED (below);
 *      otherwise it is refused, before any request or reservation, and never
 *      falls back to another rail.
 *   3. The key. It lives in one file under ~/.fuel-arc/, readable only by its
 *      owner, named by FUEL_ARC_DEMO_KEY_FILE in the demo instance's
 *      environment and nowhere else. The variable supplies the key, never which
 *      agent may use it. The key is never printed, logged or put in an error.
 *   4. The signers refuse each other's payments. Fireblocks' signer (unchanged)
 *      refuses Arc's chain id; this one refuses anything but the demo payment
 *      described in `arcDemoSigner`.
 *   5. scripts/verify-arc-lock.ts, with break tests for each of the above.
 */
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { hashTypedData, recoverAddress, type TypedDataDefinition } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Agent } from "../db/agents.js";
import { db } from "../db/index.js";
import { spentBaseUnits } from "../db/payments.js";
import {
  ARC_MAINNET,
  ARC_LIFETIME_LIMIT_BASE_UNITS,
  ARC_MAX_PER_PAYMENT_BASE_UNITS,
  ARC_MAX_VALIDITY_SECONDS,
  MAINNET_DEMO,
} from "./arc-chain.js";
import type { PaymentRail } from "./pay.js";
import type { PaymentSigner } from "./signer.js";

/** The only folder a demo key may be read from. */
export const ARC_KEY_DIR = resolve(homedir(), ".fuel-arc");

const sameAddress = (a: unknown, b: string): boolean =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Is this THE demo agent? All three must match: id, company, address.
 *
 * The id is compared first, so for every other agent this is one string
 * comparison and no database read.
 */
export function isArcDemoAgent(agent: Pick<Agent, "id" | "teamId" | "address">): boolean {
  if (agent.id !== MAINNET_DEMO.agentId) return false;
  if (!sameAddress(agent.address, MAINNET_DEMO.address)) return false;
  const team = db.prepare("SELECT company_id FROM teams WHERE id = ?").get(agent.teamId) as
    | { company_id: string }
    | undefined;
  return team?.company_id === MAINNET_DEMO.companyId;
}

/**
 * Reads the demo key, or says why it cannot. Every refusal names the problem
 * and never the key: an error message can end up in a log or a payment row.
 */
function loadDemoAccount(): PrivateKeyAccount {
  const configured = process.env.FUEL_ARC_DEMO_KEY_FILE;
  if (!configured) throw new Error("not armed: FUEL_ARC_DEMO_KEY_FILE is not set");
  const path = resolve(configured);
  if (dirname(path) !== ARC_KEY_DIR) throw new Error(`not armed: the key file must be in ${ARC_KEY_DIR}`);
  let folder;
  try {
    folder = lstatSync(ARC_KEY_DIR);
  } catch {
    throw new Error("not armed: the key folder does not exist");
  }
  if (!folder.isDirectory() || (folder.mode & 0o077) !== 0) throw new Error("not armed: the key folder must be a real folder only its owner can open (0700)");
  if (typeof process.getuid === "function" && folder.uid !== process.getuid()) {
    throw new Error("not armed: the key folder belongs to another user");
  }

  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error("not armed: the key file does not exist");
  }
  // lstat, so a symlink is seen as one and refused rather than followed.
  if (!stat.isFile()) throw new Error("not armed: the key file is not a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("not armed: the key file is readable by other users (want 0600)");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("not armed: the key file belongs to another user");
  }

  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error("not armed: the key file does not hold a private key");
  const account = privateKeyToAccount(raw as `0x${string}`);
  if (!sameAddress(account.address, MAINNET_DEMO.address)) {
    throw new Error(`not armed: the key file is for ${account.address}, not the demo agent's ${MAINNET_DEMO.address}`);
  }
  return account;
}

/**
 * The demo agent's rail, or why it cannot pay. pay.ts calls this only for the
 * demo agent, and refuses the payment outright when it is not ok.
 */
export function arcDemoRail(): { ok: true; rail: PaymentRail } | { ok: false; reason: string } {
  try {
    loadDemoAccount();
  } catch (error) {
    return { ok: false, reason: `This agent cannot pay: ${(error as Error).message}.` };
  }
  return {
    ok: true,
    rail: { scheme: "exact", network: MAINNET_DEMO.chain.network, asset: MAINNET_DEMO.chain.asset },
  };
}

/** EIP-3009's struct, field for field. Anything else is not the payment we sign. */
const TRANSFER_WITH_AUTHORIZATION = [
  ["from", "address"],
  ["to", "address"],
  ["value", "uint256"],
  ["validAfter", "uint256"],
  ["validBefore", "uint256"],
  ["nonce", "bytes32"],
];

function refuse(why: string): never {
  throw new Error(`Refusing to sign on Arc: ${why}`);
}

function toBigInt(value: unknown, field: string): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  } catch {
    // fall through
  }
  return refuse(`${field} is not a whole number`);
}

/**
 * Signs the demo agent's Arc payments, and nothing else.
 *
 * Refuses unless ALL of these hold, every one checked before the key is read:
 *   - a TransferWithAuthorization, with exactly EIP-3009's fields;
 *   - the domain of Arc's USDC on the configured chain (name, version, chain
 *     id, contract), and nothing more;
 *   - from the demo agent's wallet, to the founder's shop and nobody else;
 *   - between 1 and ARC_MAX_PER_PAYMENT_BASE_UNITS ($0.01);
 *   - spendable now, and for no more than ARC_MAX_VALIDITY_SECONDS;
 *   - backing a payment the ledger holds as `signing` for exactly this amount,
 *     so nothing is signed that pay.ts has not reserved;
 *   - leaving the agent's ledger total, this payment included, at or under
 *     ARC_LIFETIME_LIMIT_BASE_UNITS ($5).
 * Then it signs, recovers the signer from the digest, and returns the signature
 * only if it is the demo wallet's.
 *
 * Every refusal is a plain Error thrown before a signature exists, so pay.ts
 * releases the reservation (markFailedBeforeSigning) and records it as failed.
 */
export function arcDemoSigner(options: { nowSeconds?: () => number } = {}): PaymentSigner {
  const now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const chain = MAINNET_DEMO.chain;

  return {
    address: MAINNET_DEMO.address,

    async signTypedData(message) {
      if (message.primaryType !== "TransferWithAuthorization") {
        refuse(`expected TransferWithAuthorization, got ${String(message.primaryType)}`);
      }

      // Exactly one struct, and no caller-supplied EIP712Domain: viem lets a
      // supplied one replace the domain it derives, which could drop the chain
      // id or the contract from what is signed.
      const types = message.types as Record<string, unknown>;
      const structs = Object.keys(types ?? {});
      if (structs.length !== 1 || structs[0] !== "TransferWithAuthorization") {
        refuse(`unexpected types: ${structs.join(", ")}`);
      }
      const fields = (types.TransferWithAuthorization as { name?: unknown; type?: unknown }[] | undefined) ?? [];
      const shape = JSON.stringify(Array.isArray(fields) ? fields.map((f) => [f?.name, f?.type]) : null);
      if (shape !== JSON.stringify(TRANSFER_WITH_AUTHORIZATION)) refuse("the authorization's fields are not EIP-3009's");

      const domain = message.domain as Record<string, unknown>;
      const domainKeys = Object.keys(domain ?? {}).sort().join(",");
      if (domainKeys !== "chainId,name,verifyingContract,version") refuse(`unexpected domain fields: ${domainKeys}`);
      if (domain.name !== chain.domainName || domain.version !== chain.domainVersion) {
        refuse(`unexpected token domain ${String(domain.name)} v${String(domain.version)}`);
      }
      if (toBigInt(domain.chainId, "chainId") !== BigInt(chain.chainId)) {
        refuse(`unexpected chainId ${String(domain.chainId)}`);
      }
      if (!sameAddress(domain.verifyingContract, chain.asset)) {
        refuse(`unexpected verifyingContract ${String(domain.verifyingContract)}`);
      }

      const m = message.message as Record<string, unknown>;
      if (!sameAddress(m.from, MAINNET_DEMO.address)) refuse(`authorization is from ${String(m.from)}`);
      if (!sameAddress(m.to, MAINNET_DEMO.payee)) refuse(`payee ${String(m.to)} is not the founder's shop`);

      const value = toBigInt(m.value, "value");
      if (value < 1n || value > ARC_MAX_PER_PAYMENT_BASE_UNITS) {
        refuse(`value ${value} is outside 1..${ARC_MAX_PER_PAYMENT_BASE_UNITS}`);
      }
      const t = BigInt(now());
      const validAfter = toBigInt(m.validAfter, "validAfter");
      const validBefore = toBigInt(m.validBefore, "validBefore");
      if (validAfter > t) refuse("authorization is not valid yet");
      if (validBefore <= t || validBefore > t + BigInt(ARC_MAX_VALIDITY_SECONDS)) {
        refuse(`authorization must expire within ${ARC_MAX_VALIDITY_SECONDS}s`);
      }

      const reserved = db
        .prepare("SELECT 1 FROM payments WHERE agent_id = ? AND status = 'signing' AND amount_base_units = ?")
        .get(MAINNET_DEMO.agentId, value);
      if (!reserved) refuse("no reservation in the ledger is being signed for this amount");

      // Counts pending, signing, settled and unreconciled, so this payment and
      // every other one in flight are already inside the total.
      const committed = spentBaseUnits(MAINNET_DEMO.agentId);
      if (committed > ARC_LIFETIME_LIMIT_BASE_UNITS) {
        refuse(`the lifetime limit of ${ARC_LIFETIME_LIMIT_BASE_UNITS} base units would be exceeded (${committed} committed)`);
      }

      const account = loadDemoAccount();
      const definition = message as unknown as TypedDataDefinition;
      const signature = await account.signTypedData(definition);
      const recovered = await recoverAddress({ hash: hashTypedData(definition), signature });
      if (!sameAddress(recovered, MAINNET_DEMO.address)) refuse(`signature recovers to ${recovered}`);
      return signature;
    },
  };
}

/**
 * What the dashboard's environment badge says for the demo's own company.
 *
 * src/lib/environment.ts reduces Fuel's pinned constants, every one of which
 * is a sandbox or testnet provider, so for every company it says "Sandbox".
 * For the one company whose one agent pays real USDC on Arc mainnet that
 * would be false, on exactly the screen whose job is to say whether money is
 * real. So the API asks this first: for the demo company on mainnet the
 * verdict is production, loud, and says why; for any other company, null,
 * and the ordinary verdict stands unchanged.
 */
export function arcDemoEnvironmentFor(companyId: string): { environment: "production" | "sandbox"; label: string; isProduction: boolean } | null {
  if (companyId !== MAINNET_DEMO.companyId) return null;
  return MAINNET_DEMO.chain.chainId === ARC_MAINNET.chainId
    ? { environment: "production", label: "Live: real money on Arc", isProduction: true }
    : { environment: "sandbox", label: "Arc testnet (not real money)", isProduction: false };
}

/** The network to name on the demo agent's funding panel; null for every other agent. */
export function arcDemoFundingNetwork(agent: Pick<Agent, "id" | "teamId" | "address">): string | null {
  return isArcDemoAgent(agent) ? MAINNET_DEMO.chain.label : null;
}
