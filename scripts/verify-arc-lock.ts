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
