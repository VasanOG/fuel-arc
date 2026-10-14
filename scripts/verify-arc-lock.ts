/**
 * THE ARC LOCK, UNDER TEST: one agent may pay real money on Arc, nobody else
 * can, and that one agent can only pay the founder's shop, a little at a time.
 *
 *   AL-1  identity: only the exact (agent id, company id, address) in
 *         MAINNET_DEMO is the demo agent; every other agent gets Base Sepolia
 *   AL-2  Arc is named only in src/payments/arc-chain.ts (plus demo/ and
 *         scripts/arc-demo/), never elsewhere in src/ or the dashboard
 *   AL-3  the Arc signer refuses everything but the demo payment, and its
 *         limits hold at their boundaries
 *   AL-4  Fireblocks' signer (unchanged) refuses an Arc authorization
 *   AL-5  payForAgent end to end against the shop, offline: the demo agent
 *         pays, is governed, and is stopped by the lifetime limit; a normal
 *         agent cannot pay Arc at all
 *   AL-6  not armed means refused, before any request or reservation
 *   AL-7  the shop: HEAD refused, a conditional paid request still gets the
 *         full body, its settler writes nothing but transferWithAuthorization
 *   AL-8  the Try-it door (demo/try-it/): a visitor can choose one of three
 *         fixed items and nothing else about what Fuel is asked; the door's
 *         own stops (pause, daily cap, per-visitor limit, low or unknown
 *         balance) close it before anything reaches Fuel; the approver
 *         approves only the demo agent's pending shop-priced requests; the
 *         door holds the agent key only
 *
 * NOTHING HERE TOUCHES A CHAIN OR A REAL KEY. HOME is a temp folder before any
 * Arc code is imported, so ~/.fuel-arc/ is a throwaway folder and the real one
 * is never read; the test key is random. The shop settles through a fake
 * settler. Fireblocks credentials are removed before anything loads.
 *
 * AL-3 and AL-5 need the demo agent to be one whose key this suite holds, so
 * after AL-1 has checked the real literals, the suite points MAINNET_DEMO at a
 * test identity in its own process. Production code never writes to it, and
 * AL-2 checks that.
 *
 * Run:  npx tsx scripts/verify-arc-lock.ts     (and as a step of npm test)
 */
import { createTestDatabase } from "./lib/test-db.js";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import ts from "typescript";
import { hashTypedData, recoverAddress, type TypedDataDefinition } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

let checks = 0;
function assert(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
}
function assertEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) throw new Error(`FAILED: ${description}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
}
async function resolves(work: () => Promise<unknown>, description: string): Promise<void> {
  checks += 1;
  try {
    await work();
  } catch (error) {
    throw new Error(`FAILED: ${description}\n  threw: ${(error as Error).message}`);
  }
}
async function rejects(work: () => Promise<unknown>, pattern: RegExp, description: string): Promise<string> {
  checks += 1;
  try {
    await work();
  } catch (error) {
    const message = (error as Error).message;
    if (!pattern.test(message)) throw new Error(`FAILED: ${description}\n  threw: ${message}`);
    return message;
  }
  throw new Error(`FAILED: ${description}\n  it did not refuse`);
}

/* ---- setup: a throwaway database and a throwaway home ------------------------ */

const scratch = createTestDatabase("arclock");
process.env.FUEL_DB_PATH = scratch;
process.env.FUEL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
for (const name of ["FIREBLOCKS_API_KEY", "FIREBLOCKS_PRIVATE_KEY_PATH", "FIREBLOCKS_SECRET_KEY", "FIREBLOCKS_BASE_PATH", "FUEL_ARC_DEMO_KEY_FILE", "ARC_SHOP_KEY_FILE"]) {
  delete process.env[name];
}
const home = mkdtempSync(join(tmpdir(), "fuel-arclock-home-"));
process.env.HOME = home;
const keyDir = join(home, ".fuel-arc");
mkdirSync(keyDir, { mode: 0o700 });

/* ---- reading source with the parser (as verify-pins does) -------------------- */

const printer = ts.createPrinter({ removeComments: true });
const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const code = (file: string): string => (/\.(m?[jt]sx?)$/.test(file) ? printer.printFile(parse(file)) : readFileSync(file, "utf8"));
const walk = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" || e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : [],
  );

const ARC_CHAIN_FILE = join("src", "payments", "arc-chain.ts");
const ARC_DEMO_FILE = join("src", "payments", "arc-demo.ts");

const nowSeconds = () => Math.floor(Date.now() / 1000);
const TWA_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

async function main(): Promise<void> {
  const { DB_PATH, db } = await import("../src/db/index.js");
  assertEqual(DB_PATH, scratch, "TD-2: this suite opened its test database, not the real one");

  const chainMod = await import("../src/payments/arc-chain.js");
  const demo = await import("../src/payments/arc-demo.js");
  const pay = await import("../src/payments/pay.js");
  const payments = await import("../src/db/payments.js");
  const agents = await import("../src/db/agents.js");
  const { createCompany } = await import("../src/db/companies.js");
  const { createTeam } = await import("../src/db/teams.js");
  const { decideRequest } = await import("../src/db/approvals.js");
  const { fireblocksSigner } = await import("../src/fireblocks/signer.js");
  const { createShopApp, CONDITIONAL_HEADERS } = await import("../demo/arc-shop/shop.js");
  const { guardedFacilitator, restrictedSettlerSigner, refusalFor } = await import("../demo/arc-shop/settler.js");
  const { x402Client, x402HTTPClient } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { encodePaymentRequiredHeader } = await import("@x402/core/http");

  const MAINNET_DEMO = chainMod.MAINNET_DEMO as unknown as {
    chain: typeof chainMod.ARC_TESTNET | typeof chainMod.ARC_MAINNET;
    companyId: string;
    agentId: string;
    address: string;
    payee: string;
  };
  const chain = MAINNET_DEMO.chain;
  assert(demo.ARC_KEY_DIR === keyDir, "AL-6: (control) the Arc key folder this suite sees is its own temp folder, never ~/.fuel-arc");

  /** A company, team and agent with the given ids, written straight into the test database. */
  function makeAgent(opts: { companyId?: string; agentId: string; address: string; cap?: bigint }) {
    const company = createCompany({ name: `arclock ${opts.agentId.slice(0, 8)}`, spendCapBaseUnits: opts.cap ?? 100_000_000n });
    if (opts.companyId) db.prepare("UPDATE companies SET id = ? WHERE id = ?").run(opts.companyId, company.id);
    const team = createTeam({ companyId: opts.companyId ?? company.id, name: "arclock", spendCapBaseUnits: opts.cap ?? 100_000_000n });
    return agents.createAgent({
      id: opts.agentId,
      name: `arclock-${opts.agentId.slice(0, 8)}`,
      teamId: team.id,
      fireblocksVaultId: `no-vault:${opts.agentId}`,
      address: opts.address,
      spendCapBaseUnits: opts.cap ?? 100_000_000n,
    });
  }

  /* ======================================================================== */
  console.log("\n== AL-1: only the agent named in MAINNET_DEMO is the demo agent");
  {
    // The literal, read as a declaration: four string literals and a chain, nothing computed.
    const sf = parse(ARC_CHAIN_FILE);
    let entries: Map<string, ts.Expression> | undefined;
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== "MAINNET_DEMO" || !d.initializer) continue;
        let init: ts.Expression = d.initializer;
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
        if (ts.isObjectLiteralExpression(init)) {
          entries = new Map(init.properties.filter(ts.isPropertyAssignment).map((p) => [p.name.getText(sf), p.initializer]));
        }
      }
    }
    assert(entries !== undefined, "AL-1: MAINNET_DEMO is an object literal in arc-chain.ts");
    assertEqual([...entries!.keys()].sort().join(","), "address,agentId,chain,companyId,payee", "AL-1: MAINNET_DEMO names exactly a chain, a company, an agent, an address and a payee");
    for (const key of ["address", "agentId", "companyId", "payee"]) {
      assert(ts.isStringLiteral(entries!.get(key)!), `AL-1: MAINNET_DEMO.${key} is a string literal, not computed or read from anywhere`);
    }
    const chainText = entries!.get("chain")!.getText(sf).replace(/\s+/g, " ");
    assert(/^ARC_(TESTNET|MAINNET) as ArcChain$/.test(chainText), `AL-1: MAINNET_DEMO.chain is one of the two Arc chains by name (${chainText})`);
    assert(/^[0-9a-f-]{36}$/.test(MAINNET_DEMO.agentId) && /^[0-9a-f-]{36}$/.test(MAINNET_DEMO.companyId), "AL-1: the demo agent and company are named by real ids");
    assert(/^0x[0-9a-fA-F]{40}$/.test(MAINNET_DEMO.address) && /^0x[0-9a-fA-F]{40}$/.test(MAINNET_DEMO.payee), "AL-1: the demo address and payee are addresses");
    assert(MAINNET_DEMO.address.toLowerCase() !== MAINNET_DEMO.payee.toLowerCase(), "AL-1: the agent does not pay itself");

    // Every agent in the generated database is an ordinary agent on Base Sepolia.
    const everyone = db.prepare("SELECT id FROM agents").all() as { id: string }[];
    assert(everyone.length >= 5, `AL-1: (control) the test database has agents to check (${everyone.length})`);
    for (const { id } of everyone) {
      const agent = agents.getAgentUnscoped(id)!;
      assert(!demo.isArcDemoAgent(agent), `AL-1: ${agent.name} is not the demo agent`);
      const railed = pay.railFor(agent);
      assert(railed.ok && railed.rail.network === pay.ALLOWED_NETWORK && railed.rail.asset === pay.ALLOWED_ASSET, `AL-1: ${agent.name} pays on Base Sepolia`);
    }

    // The real triple matches; each one-field difference does not.
    const real = makeAgent({ companyId: MAINNET_DEMO.companyId, agentId: MAINNET_DEMO.agentId, address: MAINNET_DEMO.address });
    assert(demo.isArcDemoAgent(real), "AL-1: (control) the exact agent id, company id and address is the demo agent");
    const sameIdOtherCompany = { ...real, teamId: (db.prepare("SELECT id FROM teams WHERE company_id != ? LIMIT 1").get(MAINNET_DEMO.companyId) as { id: string }).id };
    assert(!demo.isArcDemoAgent(sameIdOtherCompany), "AL-1: the demo agent's id in another company is not the demo agent");
    const otherIdSameCompany = makeAgent({ agentId: crypto.randomUUID(), address: MAINNET_DEMO.address });
    db.prepare("UPDATE agents SET team_id = ? WHERE id = ?").run(real.teamId, otherIdSameCompany.id);
    assert(!demo.isArcDemoAgent(agents.getAgentUnscoped(otherIdSameCompany.id)!), "AL-1: another agent in the demo company, even holding the demo address, is not the demo agent");
    assert(!demo.isArcDemoAgent({ ...real, address: "0x" + "12".repeat(20) }), "AL-1: the demo agent's id with another address is not the demo agent");
    assert(demo.isArcDemoAgent({ ...real, address: MAINNET_DEMO.address.toLowerCase() }), "AL-1: (control) the address match ignores letter case only");
  }

  /* ======================================================================== */
  console.log("\n== AL-2: Arc is named in one file of src/ and nowhere in the product");
  {
    const ARC: [string, RegExp][] = [
      ["an Arc network id", /eip155:\s*5042(?:002)?\b/],
      ["an Arc chain id", /\b5042(?:002)?\b/],
      ["Arc's USDC contract", /0x3600000000000000000000000000000000000000/i],
      ["an Arc RPC or explorer host", /\b(?:rpc|explorer)(?:\.[a-z]+)?\.(?:mainnet\.|testnet\.)?arc\.(?:io|network)\b|arcscan/i],
    ];
    const bad = ["eip155:5042", "eip155: 5042002", "chainId: 5042", "0x3600000000000000000000000000000000000000", "https://rpc.mainnet.arc.io", "https://explorer.testnet.arc.io", "https://testnet.arcscan.app"];
    const good = ["eip155:84532", "50420", "15042", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "https://x402.org/facilitator", "search"];
    assert(bad.every((s) => ARC.some(([, re]) => re.test(s))), "AL-2: (control) every Arc spelling is matched");
    assert(good.every((s) => !ARC.some(([, re]) => re.test(s))), "AL-2: (control) no Base Sepolia or ordinary spelling is matched");
    for (const [what, re] of [ARC[0]!, ARC[2]!, ARC[3]!]) assert(re.test(code(ARC_CHAIN_FILE)), `AL-2: (control) arc-chain.ts holds ${what}`);

    const product = [...walk("src", /\.ts$/), ...walk("dashboard", /\.(tsx?|jsx?)$/).filter((f) => !f.includes(`${join("dashboard", ".next")}`))];
    assert(product.length > 60, `AL-2: (control) the scan reads src/ and the dashboard (${product.length} files)`);
    for (const [what, re] of ARC) {
      const holders = product.filter((f) => f !== ARC_CHAIN_FILE && re.test(code(f)));
      assertEqual(holders.join(", "), "", `AL-2: nothing in src/ or the dashboard but arc-chain.ts names ${what}`);
    }
    // The tests, other than this suite, never name Arc either: a suite that did could only be there by mistake.
    const otherSuites = walk("scripts", /\.ts$/).filter((f) => !f.startsWith(join("scripts", "arc-demo")) && f !== join("scripts", "verify-arc-lock.ts"));
    const suiteHolders = otherSuites.filter((f) => ARC.some(([, re]) => re.test(code(f))));
    assertEqual(suiteHolders.join(", "), "", "AL-2: no other script names Arc");

    // Who may use the demo's names at all, and that nobody writes to MAINNET_DEMO.
    const users = (name: string) => product.filter((f) => new RegExp(`\\b${name}\\b`).test(code(f)));
    assertEqual(users("MAINNET_DEMO").sort().join(", "), [ARC_CHAIN_FILE, ARC_DEMO_FILE].sort().join(", "), "AL-2: only arc-chain.ts and arc-demo.ts read MAINNET_DEMO");
    assertEqual(users("arcDemoSigner").sort().join(", "), [join("src", "api.ts"), ARC_DEMO_FILE].sort().join(", "), "AL-2: only api.ts asks for the Arc signer");
    const apiCode = code(join("src", "api.ts"));
    assertEqual((apiCode.match(/\barcDemoSigner\b/g) ?? []).length, 2, "AL-2: api.ts names the Arc signer twice: its import and one call");
    assert(/if \(isArcDemoAgent\(agent\)\)\s*return arcDemoSigner\(\);/.test(apiCode), "AL-2: and that call is reached only for the demo agent");
    assertEqual(users("arcDemoRail").sort().join(", "), [ARC_DEMO_FILE, join("src", "payments", "pay.ts")].sort().join(", "), "AL-2: only pay.ts asks for the Arc rail");
    const writes = product.filter((f) => /MAINNET_DEMO\s*(?:\.\s*\w+|\[[^\]]+\])\s*=[^=]|Object\.(?:assign|defineProperty)\(\s*MAINNET_DEMO/.test(code(f)));
    assertEqual(writes.join(", "), "", "AL-2: nothing in src/ writes to MAINNET_DEMO");
    assert(!/process\.env/.test(code(ARC_CHAIN_FILE)), "AL-2: arc-chain.ts reads nothing from the environment");
    const envReads = [...code(ARC_DEMO_FILE).matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]);
    assertEqual([...new Set(envReads)].join(","), "FUEL_ARC_DEMO_KEY_FILE", "AL-2: arc-demo.ts reads one variable, the key file's path");
  }

  /* ---- a test identity for the demo agent, from here on ------------------------ */

  const testKey = generatePrivateKey();
  const testAccount = privateKeyToAccount(testKey);
  const payee = privateKeyToAccount(generatePrivateKey()).address;
  const stranger = privateKeyToAccount(generatePrivateKey()).address;
  const testCompanyId = crypto.randomUUID();
  const testAgentId = crypto.randomUUID();
  const demoAgent = makeAgent({ companyId: testCompanyId, agentId: testAgentId, address: testAccount.address });
  Object.assign(chainMod.MAINNET_DEMO as object, { companyId: testCompanyId, agentId: testAgentId, address: testAccount.address, payee });
  const keyFile = join(keyDir, "demo.key");
  writeFileSync(keyFile, `${testKey}\n`, { mode: 0o600 });
  const arm = (file: string | undefined) => (file === undefined ? delete process.env.FUEL_ARC_DEMO_KEY_FILE : (process.env.FUEL_ARC_DEMO_KEY_FILE = file));
  arm(keyFile);
  assert(demo.isArcDemoAgent(demoAgent), "AL-3: (control) the suite's test identity is now the demo agent");

  const reserveSigning = (amount: bigint) => {
    const r = payments.reserveIfUnderCap({ agentId: testAgentId, amountBaseUnits: amount, resourceUrl: "http://127.0.0.1/arclock" });
    if (!r.ok) throw new Error(`could not reserve: ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
    payments.markSigningStarted(r.paymentId);
    return r.paymentId;
  };
  const clearLedger = () => {
    db.prepare("DELETE FROM approval_requests WHERE agent_id = ?").run(testAgentId);
    db.prepare("DELETE FROM payments WHERE agent_id = ?").run(testAgentId);
  };
  const authorization = (over: { domain?: Record<string, unknown>; message?: Record<string, unknown>; types?: Record<string, unknown>; primaryType?: string } = {}) => {
    const t = nowSeconds();
    return {
      domain: { name: chain.domainName, version: chain.domainVersion, chainId: chain.chainId, verifyingContract: chain.asset, ...over.domain },
      types: over.types ?? TWA_TYPES,
      primaryType: over.primaryType ?? "TransferWithAuthorization",
      message: {
        from: testAccount.address,
        to: payee,
        value: 1000n,
        validAfter: BigInt(t - 600),
        validBefore: BigInt(t + 300),
        nonce: `0x${randomBytes(32).toString("hex")}`,
        ...over.message,
      },
    };
  };

  /* ======================================================================== */
  console.log("\n== AL-3: the Arc signer signs the demo payment and nothing else");
  {
    const signer = demo.arcDemoSigner();
    assertEqual(signer.address, testAccount.address, "AL-3: the Arc signer's address is the demo agent's");

    clearLedger();
    reserveSigning(1000n);
    const good = authorization();
    const signature = await signer.signTypedData(good);
    const recovered = await recoverAddress({ hash: hashTypedData(good as unknown as TypedDataDefinition), signature });
    assertEqual(recovered, testAccount.address, "AL-3: (control) a correct demo payment is signed, by the demo key");

    const otherArc = chain.chainId === chainMod.ARC_TESTNET.chainId ? chainMod.ARC_MAINNET.chainId : chainMod.ARC_TESTNET.chainId;
    // A reservation for one base unit over the ceiling, so it is the ceiling and
    // not the missing reservation that has to refuse it.
    reserveSigning(chainMod.ARC_MAX_PER_PAYMENT_BASE_UNITS + 1n);
    // Each case names the reason it must be refused for: a different check
    // refusing it would hide the one under test.
    const cases: [string, ReturnType<typeof authorization>, RegExp][] = [
      ["a Permit instead of a transfer", authorization({ primaryType: "Permit" }), /expected TransferWithAuthorization/],
      ["a second struct in types", authorization({ types: { ...TWA_TYPES, Extra: [{ name: "x", type: "uint256" }] } }), /unexpected types/],
      ["a caller-supplied EIP712Domain that drops the chain and contract", authorization({ types: { ...TWA_TYPES, EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }] } }), /unexpected types/],
      ["a changed field type", authorization({ types: { TransferWithAuthorization: TWA_TYPES.TransferWithAuthorization.map((f) => (f.name === "value" ? { ...f, type: "uint128" } : f)) } }), /fields are not EIP-3009's/],
      ["Base Sepolia's chain id", authorization({ domain: { chainId: 84532 } }), /unexpected chainId 84532/],
      ["the other Arc chain's id", authorization({ domain: { chainId: otherArc } }), /unexpected chainId/],
      ["Base Sepolia's USDC contract", authorization({ domain: { verifyingContract: pay.ALLOWED_ASSET } }), /unexpected verifyingContract/],
      ["another token domain name", authorization({ domain: { name: "USD Coin" } }), /unexpected token domain/],
      ["an extra domain field", authorization({ domain: { salt: `0x${"00".repeat(32)}` } }), /unexpected domain fields/],
      ["another payer", authorization({ message: { from: stranger } }), /authorization is from/],
      ["a payee other than the shop", authorization({ message: { to: stranger } }), /is not the founder's shop/],
      ["a zero value", authorization({ message: { value: 0n } }), /value 0 is outside/],
      ["one base unit over $0.01, even reserved", authorization({ message: { value: chainMod.ARC_MAX_PER_PAYMENT_BASE_UNITS + 1n } }), /value 10001 is outside/],
      ["a window longer than the limit", authorization({ message: { validBefore: BigInt(nowSeconds() + chainMod.ARC_MAX_VALIDITY_SECONDS + 60) } }), /must expire within/],
      ["an expired window", authorization({ message: { validBefore: BigInt(nowSeconds() - 1) } }), /must expire within/],
      ["a window that has not opened", authorization({ message: { validAfter: BigInt(nowSeconds() + 60) } }), /not valid yet/],
      ["an amount with no reservation behind it", authorization({ message: { value: 2000n } }), /no reservation in the ledger/],
    ];
    for (const [what, message, why] of cases) {
      await rejects(() => signer.signTypedData(message), new RegExp(`^Refusing to sign on Arc: .*${why.source}`), `AL-3: refuses ${what}`);
    }

    // Every refusal above happens before the key is read: with no key at all,
    // each case is refused for the same reason, not as "not armed".
    arm(undefined);
    for (const [what, message, why] of cases) {
      await rejects(() => signer.signTypedData(message), new RegExp(`^Refusing to sign on Arc: .*${why.source}`), `AL-3: ${what} is refused before the key is even looked for`);
    }
    await rejects(() => signer.signTypedData(authorization()), /^not armed/, "AL-6: a correct payment with no key is refused as not armed, and nothing is signed");
    arm(keyFile);

    // The lifetime limit at its boundary: committed exactly at the limit signs, one base unit over does not.
    const limit = chainMod.ARC_LIFETIME_LIMIT_BASE_UNITS;
    const settledRow = (amount: bigint) =>
      db.prepare(`INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at, settled_at)
                  VALUES (?, ?, ?, 'http://127.0.0.1/arclock', 'settled', ?, NULL, ?, ?)`)
        .run(crypto.randomUUID(), testAgentId, amount, `0x${randomBytes(32).toString("hex")}`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    clearLedger();
    settledRow(limit - 1000n);
    reserveSigning(1000n);
    assertEqual(payments.spentBaseUnits(testAgentId), limit, "AL-3: (control) the ledger holds exactly the lifetime limit, this payment included");
    await resolves(() => signer.signTypedData(authorization()), "AL-3: at exactly the lifetime limit, the payment is signed");
    settledRow(1n);
    await rejects(() => signer.signTypedData(authorization()), /^Refusing to sign on Arc: the lifetime limit/, "AL-3: one base unit over the lifetime limit is refused");
    clearLedger();

    assertEqual(chainMod.ARC_MAX_PER_PAYMENT_BASE_UNITS, pay.MAX_PER_PAYMENT_BASE_UNITS, "AL-3: the Arc ceiling per payment is Fuel's own $0.01");
    assertEqual(chainMod.ARC_LIFETIME_LIMIT_BASE_UNITS, 5_000_000n, "AL-3: the lifetime limit is $5.00");
    assert(chainMod.ARC_MAX_VALIDITY_SECONDS <= 900, "AL-3: an authorization lives at most 15 minutes");
  }

  /* ======================================================================== */
  console.log("\n== AL-4: Fireblocks' signer refuses an Arc payment");
  {
    const fb = fireblocksSigner({ vaultId: "0", address: testAccount.address });
    await rejects(() => fb.signTypedData(authorization()), /^Refusing to sign: unexpected verifyingContract/, "AL-4: Arc's USDC contract is refused by Fireblocks' signer");
    await rejects(() => fb.signTypedData(authorization({ domain: { verifyingContract: pay.ALLOWED_ASSET } })), /^Refusing to sign: unexpected chainId/, "AL-4: Arc's chain id is refused by Fireblocks' signer");
  }

  /* ---- the shop, offline, with a fake settler ---------------------------------- */

  let settles = 0;
  let verifies = 0;
  const lastPaid: { from?: string; to?: string; value?: string } = {};
  const fakeSettler = {
    getSupported: () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: chain.network }], extensions: [], signers: {} }),
    async verify(payload: { payload: { authorization: { from: string } } }) {
      verifies += 1;
      return { isValid: true, payer: payload.payload.authorization.from };
    },
    async settle(payload: { payload: { authorization: { from: string; to: string; value: string } } }) {
      settles += 1;
      Object.assign(lastPaid, payload.payload.authorization);
      return { success: true, transaction: `0x${randomBytes(32).toString("hex")}`, network: chain.network, payer: payload.payload.authorization.from };
    },
  };
  const { SHOP_PRICES } = await import("../demo/arc-shop/shop.js");
  const shop = createShopApp({
    chain,
    payTo: payee,
    facilitator: guardedFacilitator(fakeSettler as never, { chain, payTo: payee, prices: SHOP_PRICES }, () => {}),
  });
  await shop.initialize();
  let shopHits = 0;
  const shopServer = http.createServer((req, res) => {
    shopHits += 1;
    shop.app(req as never, res as never);
  });
  await new Promise<void>((r) => shopServer.listen(0, "127.0.0.1", () => r()));
  const shopBase = `http://127.0.0.1:${(shopServer.address() as AddressInfo).port}`;

  // Any terms at all, for the cases the shop cannot express.
  let termsHits = 0;
  let terms: Record<string, unknown> = {};
  const termsApp = express();
  termsApp.get("/terms", (_req, res) => {
    termsHits += 1;
    res.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader({ x402Version: 2, resource: { url: "http://127.0.0.1/terms", description: "terms", mimeType: "application/json" }, accepts: [terms] } as never));
    res.status(402).json({});
  });
  const termsServer = termsApp.listen(0, "127.0.0.1");
  await new Promise((r) => termsServer.once("listening", r));
  const termsUrl = `http://127.0.0.1:${(termsServer.address() as AddressInfo).port}/terms`;

  const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM payments WHERE agent_id = ?").get(testAgentId) as { n: number }).n;
  const fresh = () => agents.getAgentUnscoped(testAgentId)!;
  const payAs = (url: string, approvalRequestId?: string) => pay.payForAgent({ agent: fresh(), signer: demo.arcDemoSigner(), url, approvalRequestId });

  try {
    /* ====================================================================== */
    console.log("\n== AL-5: payForAgent on Arc, end to end, offline");
    {
      clearLedger();
      const first = await payAs(`${shopBase}/item/basic`);
      assertEqual(first.outcome, "settled", "AL-5: the demo agent pays the shop's $0.001 item");
      assert(lastPaid.from?.toLowerCase() === testAccount.address.toLowerCase() && lastPaid.to?.toLowerCase() === payee.toLowerCase() && lastPaid.value === "1000", "AL-5: what reached the settler is from the demo wallet, to the shop, for $0.001");
      const row = db.prepare("SELECT status, tx_hash FROM payments WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1").get(testAgentId) as { status: string; tx_hash: string };
      assert(row.status === "settled" && /^0x[0-9a-f]{64}$/.test(row.tx_hash), "AL-5: the ledger records it settled, with the settlement's transaction hash");

      for (let i = 0; i < 4; i++) assertEqual((await payAs(`${shopBase}/item/basic`)).outcome, "settled", `AL-5: ordinary payment ${i + 2} of 5 settles`);

      const held = await payAs(`${shopBase}/item/unusual`);
      assert(held.outcome === "awaiting_approval" && held.scope === "anomaly", "AL-5: $0.005 after five $0.001 payments is held for approval");
      const settledBefore = settles;
      const approved = decideRequest({ id: (held as { approvalRequestId: string }).approvalRequestId, companyId: testCompanyId, decision: "approve", decidedBy: null });
      assertEqual(approved?.status, "approved", "AL-5: the operator key approves it (the demo company has no users)");
      assertEqual(settles, settledBefore, "AL-5: nothing was signed or settled while it was held");
      const redeemed = await payAs(`${shopBase}/item/unusual`, (held as { approvalRequestId: string }).approvalRequestId);
      assertEqual(redeemed.outcome, "settled", "AL-5: the approved payment then settles");
      assertEqual((await payAs(`${shopBase}/item/basic`)).outcome, "settled", "AL-5: one more ordinary payment ($0.011 this minute)");

      const fast = await payAs(`${shopBase}/item/ceiling`);
      assertEqual(fast.outcome, "rate_limited", "AL-5: $0.01 on top of $0.011 this minute hits the $0.02-a-minute rate limit");

      agents.freezeAgent(testAgentId, "arclock");
      const rowsBeforeFreeze = rows();
      const frozen = await payAs(`${shopBase}/item/basic`);
      assertEqual(frozen.outcome, "frozen", "AL-5: a frozen demo agent cannot pay");
      assertEqual(rows(), rowsBeforeFreeze, "AL-5: (as the proof page says) a freeze refusal writes no ledger row");
      agents.unfreezeAgent(testAgentId);

      const spent = payments.spentBaseUnits(testAgentId);
      agents.setSpendCap(testAgentId, spent);
      const capped = await payAs(`${shopBase}/item/basic`);
      assert(capped.outcome === "blocked" && capped.scope === "agent", "AL-5: the agent's own cap refuses the next payment");
      agents.setSpendCap(testAgentId, 100_000_000n);

      // The terms server can offer what the shop never would.
      const base = { scheme: "exact", network: chain.network, asset: chain.asset, payTo: payee, maxTimeoutSeconds: 300, extra: { name: chain.domainName, version: chain.domainVersion } };
      db.prepare("UPDATE payments SET created_at = '2026-01-01T00:00:00.000Z' WHERE agent_id = ?").run(testAgentId); // out of the rate window
      terms = { ...base, amount: "10001" };
      let n = rows();
      const over = await payAs(termsUrl);
      assert(over.outcome === "failed" && /per-payment limit/.test((over as { reason: string }).reason), "AL-5: $0.010001 is refused by Fuel's per-payment limit");
      assertEqual(rows(), n, "AL-5: that refusal comes before any reservation (no ledger row)");

      terms = { ...base, amount: "1000", payTo: stranger };
      n = rows();
      const wrongPayee = await pay.payForAgent({ agent: fresh(), signer: demo.arcDemoSigner(), url: termsUrl });
      assert(wrongPayee.outcome === "failed" && /not the founder's shop/.test((wrongPayee as { reason: string }).reason), "AL-5: terms paying anyone but the shop are refused by the Arc signer");
      const lastRow = db.prepare("SELECT status FROM payments WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1").get(testAgentId) as { status: string };
      assert(rows() === n + 1 && lastRow.status === "failed", "AL-5: and the reservation is released (recorded failed, not spent)");

      terms = { ...base, network: "eip155:8453", amount: "1000" };
      n = rows();
      const otherNetwork = await payAs(termsUrl);
      assert(otherNetwork.outcome === "failed" && /No acceptable terms/.test((otherNetwork as { reason: string }).reason), "AL-5: Arc's token on any other network is refused");
      assertEqual(rows(), n, "AL-5: with no ledger row");

      terms = { ...base, network: pay.ALLOWED_NETWORK, asset: pay.ALLOWED_ASSET, amount: "1000", extra: { name: "USDC", version: "2" } };
      n = rows();
      const sepolia = await payAs(termsUrl);
      assert(sepolia.outcome === "failed" && /No acceptable terms/.test((sepolia as { reason: string }).reason), "AL-5: the demo agent refuses Base Sepolia terms");
      assertEqual(rows(), n, "AL-5: with no ledger row");

      // The lifetime limit, through the whole path: the signer refuses, the budget is released.
      clearLedger();
      db.prepare(`INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at, settled_at)
                  VALUES (?, ?, ?, 'http://127.0.0.1/arclock', 'settled', '0x00', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
        .run(crypto.randomUUID(), testAgentId, chainMod.ARC_LIFETIME_LIMIT_BASE_UNITS - 500n);
      const settlesBefore = settles;
      const lifetime = await payAs(`${shopBase}/item/basic`);
      assert(lifetime.outcome === "failed" && /lifetime limit/.test((lifetime as { reason: string }).reason), "AL-5: a payment past the $5 lifetime limit is refused");
      assertEqual(settles, settlesBefore, "AL-5: nothing reached the settler");
      assertEqual(payments.spentBaseUnits(testAgentId), chainMod.ARC_LIFETIME_LIMIT_BASE_UNITS - 500n, "AL-5: and its reservation was released");
      clearLedger();

      // A normal agent, offered Arc, cannot pay: nothing is signed, reserved or sent.
      const ordinary = agents.getAgentUnscoped((db.prepare("SELECT id FROM agents WHERE frozen_at IS NULL AND id NOT IN (?, ?) ORDER BY name LIMIT 1").get(testAgentId, chainMod.MAINNET_DEMO.agentId) as { id: string }).id)!;
      let signed = 0;
      const refusing = { address: ordinary.address as `0x${string}`, signTypedData: async () => { signed += 1; throw new Error("must not sign"); } };
      const ordinaryRows = () => (db.prepare("SELECT COUNT(*) AS n FROM payments WHERE agent_id = ?").get(ordinary.id) as { n: number }).n;
      const before = ordinaryRows();
      const attempt = await pay.payForAgent({ agent: ordinary, signer: refusing, url: `${shopBase}/item/basic` });
      assert(attempt.outcome === "failed" && /No acceptable terms \(want exact eip155:84532/.test((attempt as { reason: string }).reason), "AL-5: an ordinary agent offered Arc terms is refused: it pays only on Base Sepolia");
      assert(signed === 0 && ordinaryRows() === before, "AL-5: with no signature and no ledger row");
    }

    /* ====================================================================== */
    console.log("\n== AL-6: not armed means refused, before any request");
    {
      const tries: [string, () => void][] = [
        ["no key file configured", () => arm(undefined)],
        ["a key file outside ~/.fuel-arc", () => { const f = join(home, "elsewhere.key"); writeFileSync(f, `${testKey}\n`, { mode: 0o600 }); arm(f); }],
        ["a key file others can read", () => { const f = join(keyDir, "open.key"); writeFileSync(f, `${testKey}\n`, { mode: 0o600 }); chmodSync(f, 0o644); arm(f); }],
        ["a symlink to the key", () => { const f = join(keyDir, "link.key"); rmSync(f, { force: true }); symlinkSync(keyFile, f); arm(f); }],
        ["a key for another wallet", () => { const f = join(keyDir, "other.key"); writeFileSync(f, `${generatePrivateKey()}\n`, { mode: 0o600 }); arm(f); }],
        ["a file that is not a key", () => { const f = join(keyDir, "junk.key"); writeFileSync(f, "not a key\n", { mode: 0o600 }); arm(f); }],
        ["a missing file", () => arm(join(keyDir, "missing.key"))],
        ["a key folder others can open", () => { chmodSync(keyDir, 0o755); arm(keyFile); }],
      ];
      for (const [what, set] of tries) {
        set();
        const hitsBefore = shopHits;
        const n = rows();
        const result = await payAs(`${shopBase}/item/basic`);
        assert(result.outcome === "failed" && /cannot pay: not armed/.test((result as { reason: string }).reason), `AL-6: ${what} -> the demo agent is refused as not armed`);
        assert(shopHits === hitsBefore && rows() === n, `AL-6: ${what} -> no request was sent and nothing was reserved`);
        assert(!(result as { reason: string }).reason.includes(testKey.slice(2, 18)), `AL-6: ${what} -> the refusal does not contain the key`);
      }
      chmodSync(keyDir, 0o700);
      arm(keyFile);
      assertEqual((await payAs(`${shopBase}/item/basic`)).outcome, "settled", "AL-6: (control) armed again, it pays");
      clearLedger();
    }

    /* ====================================================================== */
    console.log("\n== AL-7: the shop and its settler");
    {
      const raw = (path: string, method: string, headers: Record<string, string> = {}) =>
        new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((done, fail) => {
          const req = http.request(`${shopBase}${path}`, { method, headers }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => done({ status: res.statusCode ?? 0, body, headers: res.headers }));
          });
          req.on("error", fail);
          req.end();
        });

      const before = { verifies, settles };
      const head = await raw("/item/basic", "HEAD", { "payment-signature": "x" });
      assert(head.status === 405 && head.headers.allow === "GET", "AL-7: HEAD to a paid item is refused with 405, Allow: GET");
      assert(verifies === before.verifies && settles === before.settles, "AL-7: and nothing was verified or settled");
      assertEqual((await raw("/item/basic", "GET", { "if-none-match": "*" })).status, 402, "AL-7: an unpaid conditional request is still quoted, 402");

      // A paid request carrying If-None-Match: sent with node:http, because fetch adds no-cache and hides the bug.
      const payer = privateKeyToAccount(generatePrivateKey());
      const client = new x402Client();
      registerExactEvmScheme(client, { signer: payer, networks: [chain.network as `${string}:${string}`] });
      const httpClient = new x402HTTPClient(client);
      for (const header of ["if-none-match", "if-modified-since"]) {
        const quote = await fetch(`${shopBase}/item/basic`);
        const required = httpClient.getPaymentRequiredResponse((n) => quote.headers.get(n), await quote.json().catch(() => undefined));
        const payload = await httpClient.createPaymentPayload(required);
        const settledBefore = settles;
        const paid = await raw("/item/basic", "GET", { ...httpClient.encodePaymentSignatureHeader(payload), [header]: header === "if-none-match" ? "*" : new Date(Date.now() + 86_400_000).toUTCString() });
        assert(paid.status === 200 && JSON.parse(paid.body).item === "basic", `AL-7: a paid request with ${header} gets 200 and the full body, not an empty 304`);
        assertEqual(settles, settledBefore + 1, `AL-7: and it was settled exactly once (${header})`);
        assert(paid.headers["cache-control"] === "private, no-store", "AL-7: a paid answer tells caches not to keep it");
      }
      assertEqual(CONDITIONAL_HEADERS.length, 6, "AL-7: the shop strips all six conditional and range headers");

      // The settler writes one thing.
      const calls: string[] = [];
      const stub = {
        address: payee,
        readContract: async () => 0n,
        verifyTypedData: async () => true,
        getCode: async () => undefined,
        waitForTransactionReceipt: async () => ({ status: "success" }),
        writeContract: async (a: { functionName: string }) => { calls.push(a.functionName); return "0x01" as `0x${string}`; },
      };
      const settler = restrictedSettlerSigner(stub as never, chain);
      await settler.writeContract({ address: chain.asset as `0x${string}`, abi: [], functionName: "transferWithAuthorization", args: [] });
      assertEqual(calls.join(","), "transferWithAuthorization", "AL-7: (control) the settler submits transferWithAuthorization on Arc's USDC");
      await rejects(async () => settler.writeContract({ address: chain.asset as `0x${string}`, abi: [], functionName: "approve", args: [] }), /refuses approve/, "AL-7: the settler refuses any other function, even on USDC");
      await rejects(async () => settler.writeContract({ address: stranger, abi: [], functionName: "transferWithAuthorization", args: [] }), /refuses/, "AL-7: the settler refuses any other contract");
      await rejects(async () => settler.sendTransaction({ to: stranger, data: "0x" }), /no raw transactions/, "AL-7: the settler sends no raw transactions");

      const req = { scheme: "exact", network: chain.network, asset: chain.asset, payTo: payee, amount: "1000", maxTimeoutSeconds: 300, extra: {} };
      const okPayload = { x402Version: 2, payload: { signature: "0x01", authorization: { from: stranger, to: payee, value: "1000" } } };
      const shopTerms = { chain, payTo: payee, prices: SHOP_PRICES };
      assertEqual(refusalFor(okPayload as never, req as never, shopTerms), null, "AL-7: (control) the guard accepts the shop's own payment");
      for (const [what, payload, r] of [
        ["a Permit2-shaped payload", { x402Version: 2, payload: { signature: "0x01", permit2Authorization: {} } }, req],
        ["a Permit2 payload hiding beside a valid authorization", { ...okPayload, payload: { ...okPayload.payload, permit2Authorization: {} } }, req],
        ["an authorization paying someone else", { ...okPayload, payload: { ...okPayload.payload, authorization: { ...okPayload.payload.authorization, to: stranger } } }, req],
        ["a price no item has", okPayload, { ...req, amount: "999" }],
        ["another network", okPayload, { ...req, network: pay.ALLOWED_NETWORK }],
      ] as const) {
        assert(refusalFor(payload as never, r as never, shopTerms) !== null, `AL-7: the shop's guard refuses ${what} before the library sees it`);
      }
    }

    /* ====================================================================== */
    console.log("\n== AL-8: the Try-it door and its approver, against a fake Fuel");
    {
      const policy = await import("../demo/try-it/policy.js");
      const { createDoorApp } = await import("../demo/try-it/door.js");
      const { createApproverApp } = await import("../demo/try-it/approver.js");

      // A fake Fuel API that records what it is asked and answers what the test says.
      const asked: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
      let payReply: { status: number; json: Record<string, unknown> } = { status: 200, json: { paid: "0.001", transaction: `0x${"ab".repeat(32)}` } };
      let approvalReply: { status: number; json: Record<string, unknown> } = { status: 200, json: {} };
      const fakeFuel = express();
      fakeFuel.use(express.json());
      fakeFuel.post("/api/agents/:id/pay", (req, res) => {
        asked.push({ path: req.path, auth: req.headers.authorization, body: req.body });
        res.status(payReply.status).json(payReply.json);
      });
      fakeFuel.get("/api/approvals/:id", (req, res) => {
        asked.push({ path: req.path, auth: req.headers.authorization, body: {} });
        res.status(approvalReply.status).json(approvalReply.json);
      });
      let approveStatus = 200;
      fakeFuel.post("/api/approvals/:id/approve", (req, res) => {
        asked.push({ path: req.path, auth: req.headers.authorization, body: {} });
        res.status(approveStatus).json(approveStatus === 200 ? { status: "approved" } : { error: "a person must decide" });
      });
      const fuelServer = fakeFuel.listen(0, "127.0.0.1");
      await new Promise((r) => fuelServer.once("listening", r));
      const fuelUrl = `http://127.0.0.1:${(fuelServer.address() as AddressInfo).port}`;

      const approverServer = createApproverApp({ fuelUrl, operatorKey: "op-test", log: () => {} }).listen(0, "127.0.0.1");
      await new Promise((r) => approverServer.once("listening", r));
      const approverUrl = `http://127.0.0.1:${(approverServer.address() as AddressInfo).port}`;

      const pauseFile = join(home, "tryit.paused");
      const logFile = join(home, "tryit-log.jsonl");
      const shopUrl = "http://127.0.0.1:9/demo-shop";
      const origin = "https://judges.example";
      let balances: ReturnType<typeof policy.doorVerdict> extends never ? never : import("../demo/try-it/policy.js").Balances | null = { agentBaseUnits: 5_000_000n, shopBaseUnits: 2_000_000n, readAt: Date.now() };
      const openDoor = (): import("node:http").Server => {
        const app = createDoorApp({
          fuelUrl, agentKey: "ag-test", shopUrl, approverUrl, allowedOrigin: origin, pauseFile, logFile,
          balances: () => balances,
          clientAddress: (req) => String(req.headers["x-test-client"] ?? "anon"),
          log: () => {},
        });
        return app.listen(0, "127.0.0.1");
      };
      let doorServer = openDoor();
      await new Promise((r) => doorServer.once("listening", r));
      let doorUrl = `http://127.0.0.1:${(doorServer.address() as AddressInfo).port}`;
      const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
        const res = await fetch(`${doorUrl}${path}`, { method, headers: { "content-type": "application/json", "x-test-client": "judge-1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown>, headers: res.headers };
      };

      try {
        const status = await call("GET", "/try/status");
        assert(status.status === 200 && status.json.open === true, "AL-8: (control) the door opens with healthy balances and no pause file");
        assertEqual((status.json.items as unknown[]).length, 3, "AL-8: the door offers exactly three items");

        // Who the visitor controls: the item. Nothing else.
        asked.length = 0;
        const paid = await call("POST", "/try/buy", { item: "basic", url: "http://evil.example/", agentId: "someone-else", approvalRequestId: "x", amount: "999" });
        assertEqual(paid.json.outcome, "paid", "AL-8: buying the basic item reports Fuel's 'paid'");
        assertEqual(asked.length, 1, "AL-8: exactly one request reached Fuel");
        assertEqual(asked[0]!.path, `/api/agents/${chainMod.MAINNET_DEMO.agentId}/pay`, "AL-8: it was a payment by the demo agent, by its literal id, whatever the visitor sent");
        assertEqual(asked[0]!.auth, "Bearer ag-test", "AL-8: with the agent key");
        assertEqual(JSON.stringify(asked[0]!.body), JSON.stringify({ url: `${shopUrl}/item/basic` }), "AL-8: and the body named the shop's own basic item and nothing else: no visitor URL, amount or approval id");
        assertEqual(paid.json.explorerUrl, `${chain.explorerUrl}/tx/0x${"ab".repeat(32)}`, "AL-8: a paid answer links the transaction on the explorer");

        for (const bad of ["constructor", "__proto__", "basic/../ceiling", "/item/basic", "", 1, null, ["basic"]]) {
          asked.length = 0;
          const r = await call("POST", "/try/buy", { item: bad });
          assert(r.status === 400 && asked.length === 0, `AL-8: item ${JSON.stringify(bad)} is refused with 400 and nothing reaches Fuel`);
        }
        for (const [item, path] of [["unusual", "/item/unusual"], ["ceiling", "/item/ceiling"]] as const) {
          asked.length = 0;
          await call("POST", "/try/buy", { item }, { "x-test-client": `judge-${item}` });
          assertEqual((asked[0]!.body as { url: string }).url, `${shopUrl}${path}`, `AL-8: ${item} pays the shop's ${path}`);
        }

        // Fuel's other answers, in the page's words.
        for (const [what, reply, outcome, httpStatus] of [
          ["429", { status: 429, json: { spentInWindow: "0.011", limit: "0.02", windowSeconds: 60, retryAfterSeconds: 42 } }, "refused-rate-limit", 200],
          ["402 cap", { status: 402, json: { error: "cap", scope: "agent", spent: "1", spendCap: "1" } }, "refused-cap", 200],
          ["423", { status: 423, json: {} }, "refused-frozen", 200],
          ["502", { status: 502, json: { error: "Payment could not be completed." } }, "failed", 502],
        ] as const) {
          payReply = reply as typeof payReply;
          const r = await call("POST", "/try/buy", { item: "basic" }, { "x-test-client": `judge-${what}` });
          assert(r.json.outcome === outcome && r.status === httpStatus, `AL-8: Fuel's ${what} is reported as ${outcome}`);
          assertEqual(r.json.transaction, null, `AL-8: and ${what} carries no transaction`);
        }

        // Held, then completed: the approver is asked, and only for an id this door received.
        asked.length = 0;
        payReply = { status: 202, json: { status: "awaiting_approval", message: "held", approvalRequestId: "11111111-1111-4111-8111-111111111111", scope: "anomaly", amount: "0.005" } };
        const heldR = await call("POST", "/try/buy", { item: "unusual" }, { "x-test-client": "judge-h" });
        assert(heldR.json.outcome === "held" && heldR.json.approvalRequestId === "11111111-1111-4111-8111-111111111111", "AL-8: Fuel's 202 is reported as held, with the approval id");

        asked.length = 0;
        const unknown = await call("POST", "/try/complete", { approvalRequestId: "22222222-2222-4222-8222-222222222222" }, { "x-test-client": "judge-h" });
        assert(unknown.status === 404 && asked.length === 0, "AL-8: completing an approval id this door never received is refused; neither the approver nor Fuel is asked");

        approvalReply = { status: 200, json: { agentId: chainMod.MAINNET_DEMO.agentId, amountBaseUnits: "5000", amount: "0.005", status: "pending" } };
        payReply = { status: 200, json: { paid: "0.005", transaction: `0x${"cd".repeat(32)}` } };
        asked.length = 0;
        const done = await call("POST", "/try/complete", { approvalRequestId: "11111111-1111-4111-8111-111111111111" }, { "x-test-client": "judge-h" });
        assertEqual(done.json.outcome, "paid", "AL-8: completing a held payment pays once approved");
        assertEqual(asked.map((a) => a.path).join(" "), `/api/approvals/11111111-1111-4111-8111-111111111111 /api/approvals/11111111-1111-4111-8111-111111111111/approve /api/agents/${chainMod.MAINNET_DEMO.agentId}/pay`, "AL-8: the approver read the request, approved it, and then the door paid with it");
        assertEqual(asked[0]!.auth, "Bearer op-test", "AL-8: the approver used the operator key");
        assertEqual(asked[2]!.auth, "Bearer ag-test", "AL-8: the door used the agent key");
        assertEqual(JSON.stringify(asked[2]!.body), JSON.stringify({ url: `${shopUrl}/item/unusual`, approvalRequestId: "11111111-1111-4111-8111-111111111111" }), "AL-8: the completed payment is for the item that was held");
        const again = await call("POST", "/try/complete", { approvalRequestId: "11111111-1111-4111-8111-111111111111" }, { "x-test-client": "judge-h" });
        assertEqual(again.status, 404, "AL-8: a completed id cannot be completed twice");

        // The approver's own refusals, each before Fuel is asked to approve.
        for (const [what, reply, status] of [
          ["another agent's request", { status: 200, json: { agentId: "not-the-demo-agent", amountBaseUnits: "5000", status: "pending" } }, 409],
          ["a request for an amount no item costs", { status: 200, json: { agentId: chainMod.MAINNET_DEMO.agentId, amountBaseUnits: "999", status: "pending" } }, 409],
          ["a request that is no longer pending", { status: 200, json: { agentId: chainMod.MAINNET_DEMO.agentId, amountBaseUnits: "5000", status: "consumed" } }, 409],
          ["a request Fuel does not know", { status: 404, json: {} }, 409],
        ] as const) {
          payReply = { status: 202, json: { approvalRequestId: "33333333-3333-4333-8333-333333333333", message: "held" } };
          await call("POST", "/try/buy", { item: "unusual" }, { "x-test-client": `judge-${status}-${what.length}` });
          approvalReply = reply as typeof approvalReply;
          asked.length = 0;
          const r = await call("POST", "/try/complete", { approvalRequestId: "33333333-3333-4333-8333-333333333333" }, { "x-test-client": `judge-${status}-${what.length}` });
          assertEqual(r.status, status, `AL-8: the approver refuses ${what}`);
          assert(!asked.some((a) => a.path.endsWith("/approve") || a.path.endsWith("/pay")), `AL-8: ${what} -> nothing was approved and nothing was paid`);
        }
        // Already approved but never redeemed (the payment after approval failed): the approver lets the door go on and pay.
        payReply = { status: 202, json: { approvalRequestId: "55555555-5555-4555-8555-555555555555", message: "held" } };
        await call("POST", "/try/buy", { item: "unusual" }, { "x-test-client": "judge-again" });
        approvalReply = { status: 200, json: { agentId: chainMod.MAINNET_DEMO.agentId, amountBaseUnits: "5000", status: "approved" } };
        payReply = { status: 200, json: { paid: "0.005", transaction: `0x${"77".repeat(32)}` } };
        asked.length = 0;
        const retried = await call("POST", "/try/complete", { approvalRequestId: "55555555-5555-4555-8555-555555555555" }, { "x-test-client": "judge-again" });
        assertEqual(retried.json.outcome, "paid", "AL-8: an approval already granted is not decided again; the door goes on to pay with it");
        assert(!asked.some((a) => a.path.endsWith("/approve")), "AL-8: and nothing was approved twice");
        // Once the demo company has people, Fuel refuses the shared key's decision (403): the door sends the visitor to the dashboard.
        payReply = { status: 202, json: { approvalRequestId: "77777777-7777-4777-8777-777777777777", message: "held" } };
        await call("POST", "/try/buy", { item: "unusual" }, { "x-test-client": "judge-people" });
        approvalReply = { status: 200, json: { agentId: chainMod.MAINNET_DEMO.agentId, amountBaseUnits: "5000", status: "pending" } };
        approveStatus = 403;
        asked.length = 0;
        const needsPerson = await call("POST", "/try/complete", { approvalRequestId: "77777777-7777-4777-8777-777777777777" }, { "x-test-client": "judge-people" });
        assert(needsPerson.status === 409 && needsPerson.json.needsApproval === true, "AL-8: when Fuel refuses the shared key (the company has people), the door says a person approves it in the dashboard");
        assert(!asked.some((a) => a.path.endsWith("/pay")), "AL-8: and nothing was paid");
        approveStatus = 200;
        const direct = await fetch(`${approverUrl}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalRequestId: "not-an-id" }) });
        assertEqual(direct.status, 400, "AL-8: the approver takes an id and nothing else");
        assertEqual((await fetch(`${approverUrl}/agents`, { method: "POST" })).status, 404, "AL-8: the approver has no other route");

        // The door's own stops: pause, balances, daily cap, per-visitor. Each closes before Fuel is asked.
        payReply = { status: 200, json: { paid: "0.001", transaction: `0x${"ab".repeat(32)}` } };
        writeFileSync(pauseFile, "");
        asked.length = 0;
        const paused = await call("POST", "/try/buy", { item: "basic" }, { "x-test-client": "judge-p" });
        assert(paused.status === 503 && paused.json.closedReason === "paused" && asked.length === 0, "AL-8: the pause file closes the door; nothing reaches Fuel");
        assertEqual((await call("GET", "/try/status")).json.closedReason, "paused", "AL-8: and the status says why");
        rmSync(pauseFile);
        assertEqual((await call("GET", "/try/status")).json.open, true, "AL-8: (control) removing the pause file reopens it");

        for (const [what, b, reason] of [
          ["no balance read yet", null, "balance-unknown"],
          ["a balance read older than ten minutes", { agentBaseUnits: 5_000_000n, shopBaseUnits: 2_000_000n, readAt: Date.now() - policy.TRY_BALANCE_MAX_AGE_MS - 1 }, "balance-unknown"],
          ["a shop wallet below $0.50", { agentBaseUnits: 5_000_000n, shopBaseUnits: policy.TRY_MIN_SHOP_BALANCE_BASE_UNITS - 1n, readAt: Date.now() }, "low-balance"],
          ["an agent wallet below $0.05", { agentBaseUnits: policy.TRY_MIN_AGENT_BALANCE_BASE_UNITS - 1n, shopBaseUnits: 2_000_000n, readAt: Date.now() }, "low-balance"],
        ] as const) {
          balances = b;
          asked.length = 0;
          const r = await call("POST", "/try/buy", { item: "basic" }, { "x-test-client": `judge-b-${reason}-${what.length}` });
          assert(r.status === 503 && r.json.closedReason === reason && asked.length === 0, `AL-8: ${what} closes the door (${reason}); nothing reaches Fuel`);
        }
        balances = { agentBaseUnits: 5_000_000n, shopBaseUnits: 2_000_000n, readAt: Date.now() };

        for (let i = 1; i <= policy.TRY_VISITOR_LIMIT; i++) {
          assertEqual((await call("POST", "/try/buy", { item: "basic" }, { "x-test-client": "judge-v" })).status, 200, `AL-8: (control) one visitor's attempt ${i} of ${policy.TRY_VISITOR_LIMIT} is forwarded`);
        }
        asked.length = 0;
        const seventh = await call("POST", "/try/buy", { item: "basic" }, { "x-test-client": "judge-v" });
        assert(seventh.status === 429 && seventh.json.closedReason === "visitor-limit" && asked.length === 0, "AL-8: the next attempt from the same visitor is refused and nothing reaches Fuel");
        assertEqual((await call("POST", "/try/buy", { item: "basic" }, { "x-test-client": "judge-w" })).status, 200, "AL-8: another visitor is unaffected");

        // The daily cap, and that a restart replays the log rather than forgetting it.
        doorServer.close();
        const today = new Date().toISOString();
        const spentSoFar = policy.TRY_DAILY_CAP_BASE_UNITS - 10_000n - (policy.TRY_DAILY_CAP_BASE_UNITS % 10_000n);
        // What the door writes: a "forwarding" line as each attempt is admitted, then its result line. Only forwarding lines count.
        const lines = Array.from({ length: Number(spentSoFar / 10_000n) }, () => JSON.stringify({ at: today, kind: "buy", item: "ceiling", outcome: "forwarding" }));
        lines.push(JSON.stringify({ at: today, kind: "buy", item: "ceiling", amountUsd: "$0.010", outcome: "refused-rate-limit", message: "", transaction: null, explorerUrl: null, approvalRequestId: null }));
        lines.push(JSON.stringify({ at: "2026-01-01T00:00:00.000Z", kind: "buy", item: "ceiling", outcome: "forwarding" }));
        lines.push("not json at all", JSON.stringify({ at: today, kind: "buy", item: "constructor", outcome: "forwarding" }), JSON.stringify({ at: "yesterday?", kind: "buy", item: "basic", outcome: "forwarding" }));
        lines.push(JSON.stringify({ at: today, kind: "buy", item: "unusual", outcome: "forwarding" }));
        lines.push(JSON.stringify({ at: today, kind: "buy", item: "unusual", amountUsd: "$0.005", outcome: "held", message: "", transaction: null, explorerUrl: null, approvalRequestId: "44444444-4444-4444-8444-444444444444" }));
        lines.push(JSON.stringify({ at: today, kind: "buy", item: "unusual", amountUsd: "$0.005", outcome: "held", message: "", transaction: null, explorerUrl: null, approvalRequestId: "66666666-6666-4666-8666-666666666666" }));
        lines.push(JSON.stringify({ at: today, kind: "complete", item: "unusual", amountUsd: "$0.005", outcome: "refused-approval", message: "", transaction: null, explorerUrl: null, approvalRequestId: "66666666-6666-4666-8666-666666666666" }));
        writeFileSync(logFile, `${lines.join("\n")}\n`);
        doorServer = openDoor();
        await new Promise((r) => doorServer.once("listening", r));
        doorUrl = `http://127.0.0.1:${(doorServer.address() as AddressInfo).port}`;
        const afterRestart = await call("GET", "/try/status");
        assertEqual(afterRestart.json.forwardedTodayUsd, `$${(Number(spentSoFar + 5_000n) / 1e6).toFixed(3)}`, "AL-8: after a restart the door has replayed today's forwarded attempts (not yesterday's, not unreadable lines), refusals counted at full price");
        asked.length = 0;
        const retired = await call("POST", "/try/complete", { approvalRequestId: "66666666-6666-4666-8666-666666666666" }, { "x-test-client": "judge-d0" });
        assert(retired.status === 404 && asked.length === 0, "AL-8: an id whose approval was found invalid before the restart stays retired");
        asked.length = 0;
        const fits = await call("POST", "/try/buy", { item: "basic" }, { "x-test-client": "judge-d1" });
        assertEqual(fits.status, 200, "AL-8: (control) an attempt that fits under the daily cap is forwarded");
        asked.length = 0;
        const over = await call("POST", "/try/buy", { item: "ceiling" }, { "x-test-client": "judge-d2" });
        assert(over.status === 503 && over.json.closedReason === "daily-cap" && asked.length === 0, "AL-8: an attempt that would pass the daily cap is refused; nothing reaches Fuel");
        approvalReply = { status: 200, json: { agentId: chainMod.MAINNET_DEMO.agentId, amountBaseUnits: "5000", status: "pending" } };
        payReply = { status: 200, json: { paid: "0.005", transaction: `0x${"ef".repeat(32)}` } };
        asked.length = 0;
        const replayed = await call("POST", "/try/complete", { approvalRequestId: "44444444-4444-4444-8444-444444444444" }, { "x-test-client": "judge-d3" });
        assert(replayed.status === 503 && replayed.json.closedReason === "daily-cap", "AL-8: completing counts against the cap too, and a held id survives a restart (it was found, then refused by the cap)");
        assertEqual(asked.length, 0, "AL-8: so the approver was not asked");

        // Browsers: one origin may call it, no other.
        const allowed = await call("GET", "/try/status", undefined, { origin });
        assertEqual(allowed.headers.get("access-control-allow-origin"), origin, "AL-8: the proof page's origin is allowed");
        assertEqual(allowed.headers.get("access-control-allow-credentials"), null, "AL-8: without credentials");
        asked.length = 0;
        const other = await call("POST", "/try/buy", { item: "basic" }, { origin: "https://other.example", "x-test-client": "judge-o" });
        assert(other.status === 403 && asked.length === 0, "AL-8: any other origin is refused before anything reaches Fuel");
        assertEqual((await fetch(`${doorUrl}/try/buy`, { method: "OPTIONS", headers: { origin } })).status, 204, "AL-8: the preflight for the allowed origin succeeds");
        assertEqual((await fetch(`${doorUrl}/api/agents`)).status, 404, "AL-8: the door has no route but its own three and /health");
      } finally {
        doorServer.close();
        approverServer.close();
        fuelServer.close();
      }

      // What the door's code may hold and say, read from source.
      const doorSrc = code(join("demo", "try-it", "door.ts"));
      const doorServerSrc = code(join("demo", "try-it", "door-server.ts"));
      const approverServerSrc = code(join("demo", "try-it", "approver-server.ts"));
      const tryIt = walk(join("demo", "try-it"), /\.ts$/).map(code).join("\n");
      assert(/url: `\$\{options\.shopUrl\}\$\{TRY_ITEMS\[item\]\.path\}`/.test(doorSrc), "AL-8: the URL Fuel is asked to pay is the shop's origin plus the item's own path, from the table");
      assert(!/req\.body[^\n]*url|url[^\n]*req\.body/.test(doorSrc), "AL-8: no request field reaches a URL");
      assert(/if \(process\.env\.FUEL_API_KEY\) \{[\s\S]*?process\.exit\(1\)/.test(doorServerSrc), "AL-8: the door refuses to start if the operator key is in its environment");
      assert(/\.listen\(port, "127\.0\.0\.1"/.test(approverServerSrc), "AL-8: the approver binds loopback by literal; no setting can widen it");
      for (const name of ["FUEL_ARC_DEMO_KEY_FILE", "ARC_SHOP_KEY_FILE", "privateKeyToAccount", "signTypedData", "writeContract", "sendTransaction"]) {
        assert(!tryIt.includes(name), `AL-8: nothing under demo/try-it/ names ${name}: the door holds no chain key and signs nothing`);
      }
      assertEqual(policy.TRY_DAILY_CAP_BASE_UNITS, 200_000n, "AL-8: the daily cap is $0.20");
      assert(policy.TRY_DAILY_CAP_BASE_UNITS * 25n <= chainMod.ARC_LIFETIME_LIMIT_BASE_UNITS, "AL-8: at the daily cap, the lifetime budget lasts at least 25 days");
      assertEqual(Object.keys(policy.TRY_ITEMS).join(","), "basic,unusual,ceiling", "AL-8: the three items are the shop's three");

      console.log("\n== AL-9: the dashboard tells the truth about the demo company");
      const env = demo.arcDemoEnvironmentFor(chainMod.MAINNET_DEMO.companyId);
      assert(env !== null && env.label.length > 0, "AL-9: the demo company gets its own environment verdict");
      assertEqual(demo.arcDemoEnvironmentFor(crypto.randomUUID()), null, "AL-9: any other company gets none, so its badge is unchanged");
      assertEqual(demo.arcDemoEnvironmentFor(""), null, "AL-9: an empty company id gets none");
      const funding = demo.arcDemoFundingNetwork(demoAgent);
      assertEqual(funding, chainMod.MAINNET_DEMO.chain.label, "AL-9: the demo agent's funding panel names its own network");
      assertEqual(demo.arcDemoFundingNetwork({ ...demoAgent, id: crypto.randomUUID() }), null, "AL-9: any other agent's funding panel is unchanged");
      const apiSrc = code(join("src", "api.ts"));
      assert(/const arc = arcDemoEnvironmentFor\(companyOf\(req\)\);\s*res\.json\(arc \? \{ \.\.\.verdict, \.\.\.arc \} : verdict\);/.test(apiSrc), "AL-9: /environment applies the demo verdict only for the caller's own company");
      for (const [name, item] of Object.entries(policy.TRY_ITEMS)) {
        const price = SHOP_PRICES.find((p) => p.path === item.path);
        assert(price !== undefined && BigInt(price.amount) === item.amountBaseUnits, `AL-8: the door's ${name} is the shop's ${item.path} at the shop's price`);
      }
    }
  } finally {
    shopServer.close();
    termsServer.close();
  }

  console.log(`\nAll ${checks} checks passed.`);
  console.log(`Test database: ${scratch} (the real database and the real ~/.fuel-arc were never opened)`);
}

main()
  .then(() => rmSync(home, { recursive: true, force: true }))
  .catch((error) => {
    rmSync(home, { recursive: true, force: true });
    console.error(`\n${(error as Error).message}`);
    process.exit(1);
  });
