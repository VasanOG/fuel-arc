/**
 * Verifies that every testnet guard Fuel relies on is still in place, and that
 * each one still bites.
 *
 * WHY THIS EXISTS. Fuel moves no real money, and the reason is a handful of
 * pinned constants and refusals: a Fireblocks workspace that is the sandbox, a
 * payment rail that is Base Sepolia, a signer that refuses anything else, a
 * QuickBooks origin that is the sandbox. CLAUDE.md says enabling any of them is
 * a reviewed code change, never a config flag. Until this file, nothing checked
 * that: no suite so much as imported the Fireblocks signer, and "all four
 * refused" in the roadmap was a manual check from Phase 1. A guard that is
 * quietly edited, or deleted in a refactor, would have passed `npm test`.
 *
 * WHY NOW. The hosted beta changes files beside these -- the gateway's public
 * origin, how a caller's address is read, the listening address. Each of those
 * steps has to show it left every guard alone, and "left alone" needs something
 * to be checked against. A step that MEANS to change one (hosting the gateway
 * moves GATEWAY_PUBLIC_ORIGIN and the listening address) edits the matching
 * check, in the same reviewed commit, which is exactly the visibility wanted.
 *
 * WHAT IT CHECKS, by group:
 *   PIN-1  the Fireblocks workspace and assets, that the client really is built
 *          on the sandbox, and that nothing but the two credentials is read
 *          from the environment
 *   PIN-2  the payment rail: network, asset, scheme, facilitator, the ceiling
 *   PIN-3  the signer's guards, BY BEHAVIOUR: each refusal is made to happen,
 *          a correct sandbox authorization is shown to get past all of them,
 *          and the signer is shown to expose nothing wider
 *   PIN-4  the environment report: sandbox on every surface, a table that
 *          calls the mainnet values production, and a loopback listen address
 *   PIN-5  the QuickBooks origin
 *   PIN-6  that no file in src/ outside the environment table names a mainnet
 *          network, asset, host or workspace
 *
 * ORDER. PIN-4 reports on the pins the other groups hold, so it runs AFTER
 * them: flip any one constant and its own group fails first, not the summary.
 * The client check (the last of PIN-1) runs after PIN-3 because it needs
 * stand-in credentials, and PIN-3 must run with none.
 *
 * SOURCE IS READ WITH THE PARSER, NOT A REGULAR EXPRESSION. A first version
 * stripped comments with a regex, and a string such as `accept: "*" + "/*"`
 * in src/gateway/forward.ts started a "comment" that swallowed real code, so
 * everything in it was invisible to the scan. A pinned declaration is now read
 * as a declaration (its initializer, wherever it sits and however it is
 * formatted), and a scan reads the parser's own comment-free output.
 *
 * NOTHING HERE CAN SIGN. The credentials are removed from this process before
 * the signer is called, and checked absent. A guard that was broken would then
 * reach `fireblocks()` and stop on "FIREBLOCKS_API_KEY is not set": it could
 * not contact Fireblocks even in a shell that holds real sandbox keys. The one
 * group that supplies stand-in credentials only constructs the client, which
 * does no I/O, reads its base path and discards both again.
 *
 * Run:  npm run verify-pins     (and as a step of npm test)
 */
import { createTestDatabase } from "./lib/test-db.js";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasePath } from "@fireblocks/ts-sdk";
import { getDefaultAsset } from "@x402/evm";
import ts from "typescript";

let checks = 0;

function assert(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
}

function assertEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) {
    throw new Error(`FAILED: ${description}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

/* ---- reading source with the parser ------------------------------------------ */

const printer = ts.createPrinter({ removeComments: true });
const parse = (file: string, text = readFileSync(file, "utf8")): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
/** The file as the parser prints it with every comment gone: a `"*" + "/*"` string stays a string. */
const code = (file: string): string => printer.printFile(parse(file));
const codeOf = (text: string): string => printer.printFile(parse("snippet.ts", text));

/** What a top-level `const NAME = <this>` is initialised with, as written; undefined if there is none. */
function constInit(file: string, name: string): string | undefined {
  const sf = parse(file);
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer.getText(sf).replace(/\s+/g, " ");
    }
  }
  return undefined;
}

/** The entries of a top-level `const NAME = { ... }`: key -> value text. */
function objectEntries(file: string, name: string): Map<string, string> | undefined {
  const sf = parse(file);
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      if (!(ts.isIdentifier(d.name) && d.name.text === name && d.initializer && ts.isObjectLiteralExpression(d.initializer))) continue;
      const out = new Map<string, string>();
      for (const p of d.initializer.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.name) || ts.isIdentifier(p.name))) out.set(p.name.text, p.initializer.getText(sf));
      }
      return out;
    }
  }
  return undefined;
}

/** How many times an identifier is written in a file: a declaration and each use. */
function identifierCount(file: string, name: string): number {
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) n += 1;
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return n;
}

/** The names a file imports from a module, or "*" for a default or namespace import. */
function namesImportedFrom(file: string, module: string): string[] {
  const out: string[] = [];
  for (const statement of parse(file).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== module) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) out.push("*");
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) out.push("*");
    if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) out.push((e.propertyName ?? e.name).text);
  }
  return out;
}

const walk = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : [],
  );

/* ---- setup ------------------------------------------------------------------- */

const scratch = createTestDatabase("pins");
process.env.FUEL_DB_PATH = scratch;
process.env.FUEL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");

// Everything the Fireblocks SDK or Fuel would read to reach a workspace, out
// BEFORE anything is imported or called, and shown to be gone.
const FIREBLOCKS_ENV = ["FIREBLOCKS_API_KEY", "FIREBLOCKS_PRIVATE_KEY_PATH", "FIREBLOCKS_SECRET_KEY", "FIREBLOCKS_BASE_PATH"];
for (const name of FIREBLOCKS_ENV) delete process.env[name];

/** The Base mainnet USDC contract, written here only so the signer can be shown to refuse it. */
const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const PROVISION = join("src", "fireblocks", "provision.ts");
const SIGNER = join("src", "fireblocks", "signer.ts");
const ENVIRONMENT = join("src", "lib", "environment.ts");

async function main(): Promise<void> {
  const { DB_PATH } = await import("../src/db/index.js");
  assertEqual(DB_PATH, scratch, "TD-2: this suite opened its test database, not the real one");
  for (const name of FIREBLOCKS_ENV) assertEqual(process.env[name], undefined, `PIN-3: (control) ${name} is absent, so nothing below can reach Fireblocks`);

  const provision = await import("../src/fireblocks/provision.js");
  const pay = await import("../src/payments/pay.js");
  const quickbooks = await import("../src/quickbooks/config.js");
  const { GATEWAY_PUBLIC_ORIGIN } = await import("../src/gateway/origin.js");
  const { describeEnvironment } = await import("../src/lib/environment.js");

  const srcFiles = walk("src", /\.(ts|mts|mjs|js)$/);
  assert(srcFiles.length > 40, `PIN-6: (control) the source walk found ${srcFiles.length} files`);
  const fireblocksFiles = walk(join("src", "fireblocks"), /\.ts$/);

  /* ======================================================================== */
  console.log("\n== PIN-1: the Fireblocks workspace and assets");
  {
    assertEqual(provision.BASE_PATH, BasePath.Sandbox, "PIN-1: BASE_PATH is the Fireblocks sandbox");
    assertEqual(provision.BASE_PATH, "https://sandbox-api.fireblocks.io/v1", "PIN-1: and that is the sandbox API's address");
    const production = Object.entries(BasePath).filter(([name]) => name !== "Sandbox");
    assert(production.length >= 2, "PIN-1: (control) the SDK offers production workspaces, so the check knows what one looks like");
    assert(
      production.every(([, address]) => address !== provision.BASE_PATH),
      "PIN-1: BASE_PATH is none of the SDK's production workspaces",
    );
    assertEqual(constInit(PROVISION, "BASE_PATH"), "BasePath.Sandbox", "PIN-1: BASE_PATH is written as the literal BasePath.Sandbox, not computed");

    assertEqual(constInit(PROVISION, "GAS_ASSET_ID"), '"BASECHAIN_ETH_TEST5"', "PIN-1: the gas asset is Base Sepolia's");
    assertEqual(constInit(PROVISION, "USDC_ASSET_ID"), '"USDC_BASECHAIN_ETH_TEST5_29AA"', "PIN-1: the USDC asset is the Base Sepolia one");
    assertEqual(constInit(SIGNER, "SIGNING_ASSET_ID"), '"BASECHAIN_ETH_TEST5"', "PIN-1: the signer signs under Base Sepolia's asset");
    assertEqual(constInit(SIGNER, "EXPECTED_CHAIN_ID"), "84532", "PIN-1: the signer's expected chain id is 84532");
    assertEqual(provision.NETWORK_LABEL, "Base Sepolia", "PIN-1: the funding panel names the network it really signs for");
    assertEqual(provision.ASSET_LABEL, "USDC", "PIN-1: and the asset");

    // Nothing may steer these files from the environment: a workspace, an asset
    // or a chain read from a variable is a config flag. They use `requireEnv`
    // for the two credentials and touch `process.env` nowhere else, so a
    // destructured, aliased or whole-object read has nowhere to hide.
    const touching = fireblocksFiles.filter((f) => /process\.env/.test(code(f)));
    assertEqual(touching.join(", "), "", "PIN-1: the Fireblocks files never touch process.env: credentials come through requireEnv only");
    const named = new Set<string>();
    for (const f of fireblocksFiles) for (const m of code(f).matchAll(/requireEnv\(\s*["']([A-Z0-9_]+)["']\s*\)/g)) named.add(m[1]!);
    assert(named.has("FIREBLOCKS_API_KEY") && named.has("FIREBLOCKS_PRIVATE_KEY_PATH"), "PIN-1: (control) the scan sees the two credentials being read");
    assertEqual([...named].sort().join(","), "FIREBLOCKS_API_KEY,FIREBLOCKS_PRIVATE_KEY_PATH", "PIN-1: the Fireblocks files read nothing else from the environment");

    // The SDK reads FIREBLOCKS_BASE_PATH itself if no base path is given, and
    // Fuel must never be the thing that leaves it out.
    const clients = srcFiles.filter((f) => /\bnew Fireblocks\(/.test(code(f)));
    assertEqual(clients.join(", "), PROVISION, "PIN-1: the one place a Fireblocks client is made is provision.ts");
    assertEqual(srcFiles.flatMap((f) => [...code(f).matchAll(/\bnew Fireblocks\(/g)]).length, 1, "PIN-1: and it is made exactly once");
  }

  /* ======================================================================== */
  console.log("\n== PIN-2: the payment rail");
  {
    assertEqual(pay.ALLOWED_NETWORK, "eip155:84532", "PIN-2: ALLOWED_NETWORK is Base Sepolia");
    assertEqual(pay.ALLOWED_ASSET, "0x036cbd53842c5426634e7929541ec2318f3dcf7e", "PIN-2: ALLOWED_ASSET is Base Sepolia USDC");
    assertEqual(pay.ALLOWED_SCHEME, "exact", "PIN-2: ALLOWED_SCHEME is exact");
    assertEqual(pay.FACILITATOR_URL, "https://x402.org/facilitator", "PIN-2: FACILITATOR_URL is the testnet facilitator");
    assertEqual(pay.MAX_PER_PAYMENT_BASE_UNITS, 10_000n, "PIN-2: no single payment may exceed $0.01");
    assertEqual(
      getDefaultAsset(pay.ALLOWED_NETWORK).address.toLowerCase(),
      pay.ALLOWED_ASSET,
      "PIN-2: the library's own USDC for this network is the pinned one",
    );
    for (const file of [join("src", "payments", "pay.ts"), join("src", "payments", "limits.ts"), join("src", "payments", "velocity.ts")]) {
      assert(!/process\.env/.test(code(file)), `PIN-2: ${file} reads nothing from the environment`);
    }
  }

  /* ======================================================================== */
  // Held before PIN-4 on purpose: PIN-4 summarises it, so a flipped origin must
  // fail here first.
  console.log("\n== PIN-5: the QuickBooks origin");
  {
    assertEqual(quickbooks.QBO_API_ORIGIN, "https://sandbox-quickbooks.api.intuit.com", "PIN-5: QBO_API_ORIGIN is the Intuit sandbox");
    assert(!/process\.env/.test(code(join("src", "quickbooks", "config.ts"))), "PIN-5: and nothing in its config reads the environment");
    assertEqual((() => { try { quickbooks.assertSandboxUrl("https://quickbooks.api.intuit.com/v3/company/1/companyinfo/1"); return "allowed"; } catch { return "refused"; } })(), "refused", "PIN-5: a production QuickBooks address is refused");
    assertEqual((() => { try { quickbooks.assertSandboxUrl("https://sandbox-quickbooks.api.intuit.com/v3/company/1/companyinfo/1"); return "allowed"; } catch { return "refused"; } })(), "allowed", "PIN-5: (control) a sandbox address is allowed");
  }

  /* ======================================================================== */
  console.log("\n== PIN-3: the signer's guards, by behaviour");
  {
    const { fireblocksSigner } = await import("../src/fireblocks/signer.js");
    const { SignatureMayExistError } = await import("../src/payments/signer.js");
    const vault = `0x${"ab".repeat(20)}` as `0x${string}`;
    const signer = fireblocksSigner({ vaultId: "pins-vault", address: vault });

    // The signer is a narrow interface on purpose (src/payments/signer.ts): an
    // extra member, say signTransaction, would sign past all four guards.
    assertEqual(Object.keys(signer).sort().join(","), "address,signTypedData", "PIN-3: the signer exposes exactly an address and signTypedData, nothing wider");
    const creators = srcFiles.filter((f) => /\bcreateTransaction\(/.test(code(f)));
    assertEqual(creators.join(", "), SIGNER, "PIN-3: Fuel creates a Fireblocks transaction in exactly one place, the signer's guarded one");
    assertEqual(srcFiles.flatMap((f) => [...code(f).matchAll(/\bcreateTransaction\(/g)]).length, 1, "PIN-3: and calls it once");

    /** A well-formed Base Sepolia USDC authorization, with any field overridden. */
    const authorization = (over: { primaryType?: string; domain?: Record<string, unknown>; from?: string } = {}) => ({
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: pay.ALLOWED_ASSET, ...over.domain },
      // Both types are declared, and a Permit's message is a well-formed Permit, so
      // that with Fuel's primaryType guard gone the signer's own library accepts it
      // and the request goes on to the credentials. A Permit the library would
      // reject anyway would test the library, not the guard.
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: over.primaryType ?? "TransferWithAuthorization",
      message:
        over.primaryType === "Permit"
          ? // `from` is not part of a Permit, and the signer's own library ignores it; a
            // hostile payload can carry it, and then only the primaryType guard stops it.
            { from: vault, owner: vault, spender: "0x0000000000000000000000000000000000000402", value: 1000n, nonce: 0n, deadline: 4102444800n }
          : {
              from: over.from ?? vault,
              to: "0x0000000000000000000000000000000000000402",
              value: 1000n,
              validAfter: 0n,
              validBefore: 4102444800n,
              nonce: `0x${"cd".repeat(32)}`,
            },
    });
    const attempt = async (message: ReturnType<typeof authorization>): Promise<Error> => {
      try {
        await signer.signTypedData(message);
      } catch (error) {
        return error as Error;
      }
      return new Error("signed");
    };
    const refusedAs = (error: Error, pattern: RegExp) => pattern.test(error.message) && !(error instanceof SignatureMayExistError);

    // Each case passes every guard BEFORE the one under test, so it reaches it.
    // A deleted guard lets the case through to something else, and the message
    // no longer matches.
    const permit = await attempt(authorization({ primaryType: "Permit" }));
    assert(refusedAs(permit, /^Refusing to sign: expected primaryType TransferWithAuthorization, got Permit$/), `PIN-3: a Permit primaryType is refused (${permit.message})`);

    const wrongToken = await attempt(authorization({ domain: { verifyingContract: BASE_MAINNET_USDC } }));
    assert(refusedAs(wrongToken, /^Refusing to sign: unexpected verifyingContract 0x833589/i), `PIN-3: Base mainnet's USDC contract is refused (${wrongToken.message})`);

    const mainnet = await attempt(authorization({ domain: { chainId: 8453 } }));
    assert(refusedAs(mainnet, /^Refusing to sign: unexpected chainId 8453$/), `PIN-3: a chain id of 8453 is refused (${mainnet.message})`);

    const noChain = await attempt(authorization({ domain: { chainId: undefined } }));
    assert(refusedAs(noChain, /^Refusing to sign: unexpected chainId undefined$/), `PIN-3: a missing chain id is refused (${noChain.message})`);

    const stranger = await attempt(authorization({ from: `0x${"11".repeat(20)}` }));
    assert(refusedAs(stranger, /^Refusing to sign: authorization is from 0x1111/), `PIN-3: an authorization from another address is refused (${stranger.message})`);

    // The control that makes the five refusals mean something: a correct
    // authorization gets past all four guards, and stops only at the missing
    // credentials. Without it a signer that refused everything would pass.
    const correct = await attempt(authorization());
    assert(
      refusedAs(correct, /FIREBLOCKS_API_KEY is not set/),
      `PIN-3: (control) a correct Base Sepolia authorization passes every guard and stops only at the missing credentials (${correct.message})`,
    );
    assert(
      ![permit, wrongToken, mainnet, noChain, stranger, correct].some((e) => e instanceof SignatureMayExistError),
      "PIN-3: and none of these is the \"a signature may exist\" error: every one stopped before anything was sent",
    );
  }

  /* ======================================================================== */
  // The last of PIN-1, and the only group that supplies credentials: stand-ins,
  // never real, used to construct the client (which does no I/O), then removed.
  console.log("\n== PIN-1 (continued): the client is built on the sandbox");
  {
    const keyDir = mkdtempSync(join(tmpdir(), "fuel-pins-key-"));
    // Not named like a key: the sandbox this suite also runs under refuses any *.pem, on purpose.
    const keyFile = join(keyDir, "stand-in-secret.txt");
    writeFileSync(keyFile, "stand-in, not a key\n");
    process.env.FIREBLOCKS_API_KEY = "stand-in";
    process.env.FIREBLOCKS_PRIVATE_KEY_PATH = keyFile;
    // The SDK falls back to this variable when it is given no base path. Naming a
    // production workspace here is what a dropped `basePath:` would let through.
    process.env.FIREBLOCKS_BASE_PATH = BasePath.US;
    try {
      const client = provision.fireblocks() as unknown as { config: { basePath: string } };
      assertEqual(client.config.basePath, BasePath.Sandbox, "PIN-1: the Fireblocks client is built on BASE_PATH even when the environment names a production workspace");
    } finally {
      for (const name of FIREBLOCKS_ENV) delete process.env[name];
      rmSync(keyDir, { recursive: true, force: true });
    }
    for (const name of FIREBLOCKS_ENV) assertEqual(process.env[name], undefined, `PIN-1: (control) ${name} is removed again`);
  }

  /* ======================================================================== */
  console.log("\n== PIN-4: the environment report");
  {
    const report = describeEnvironment();
    assertEqual(report.environment, "sandbox", "PIN-4: Fuel reports itself as sandbox");
    assertEqual(report.isProduction, false, "PIN-4: and not production");
    assertEqual(report.surfaces.map((s) => s.key).sort().join(","), "accounting,custody,payments,receiving,settlement", "PIN-4: (control) it reports all five surfaces");
    for (const surface of report.surfaces) {
      assertEqual(surface.environment, "sandbox", `PIN-4: the ${surface.key} surface is sandbox`);
    }
    assertEqual(GATEWAY_PUBLIC_ORIGIN, "http://127.0.0.1", "PIN-4: the gateway's public origin is still loopback");

    // That origin is truthful only while the API listens on loopback: this is the
    // line (src/gateway/origin.ts) that makes "Receiving: sandbox" mean something.
    // Hosting the gateway changes it and the origin together, in one reviewed commit.
    const server = code(join("src", "server.ts"));
    assertEqual([...server.matchAll(/\.listen\(/g)].length, 1, "PIN-4: the API starts listening in exactly one place");
    assert(/app\.listen\(PORT, "127\.0\.0\.1",/.test(server), "PIN-4: and it listens on loopback only");

    // The table is what makes a flipped constant visible: it must call each
    // mainnet value production, and each testnet value sandbox, and nothing else.
    // Anything it does not know is "unknown", never "sandbox".
    const known = objectEntries(ENVIRONMENT, "KNOWN");
    assert(known !== undefined, "PIN-4: (control) the environment table was found");
    const expected = [
      ["eip155:84532", "sandbox"],
      ["https://x402.org/facilitator", "sandbox"],
      ["https://sandbox-api.fireblocks.io/v1", "sandbox"],
      ["https://sandbox-quickbooks.api.intuit.com", "sandbox"],
      ["http://127.0.0.1", "sandbox"],
      ["eip155:8453", "production"],
      ["https://api.fireblocks.io/v1", "production"],
      ["https://quickbooks.api.intuit.com", "production"],
    ] as const;
    for (const [value, name] of expected) {
      assertEqual(known!.get(value), `"${name}"`, `PIN-4: the environment table calls ${value} ${name}`);
    }
    assertEqual(known!.size, expected.length, "PIN-4: and holds nothing else");
    assertEqual(identifierCount(ENVIRONMENT, "KNOWN"), 2, "PIN-4: and is read in one place and written in none");
    assert(/KNOWN\[value\] \?\? "unknown"/.test(code(ENVIRONMENT)), "PIN-4: and anything it does not know is \"unknown\", never \"sandbox\"");
  }

  /* ======================================================================== */
  console.log("\n== PIN-6: no mainnet reference in src/");
  {
    // What a mainnet or production deployment would have to name. The sandbox
    // spellings carry a `sandbox-` or `_TEST` marker and are deliberately not matched.
    const MAINNET: [string, RegExp][] = [
      ["the Base mainnet network id", /eip155:\s*8453\b/],
      ["a wildcard over every eip155 network", /eip155:\s*\*/],
      ["the Base mainnet USDC contract", /0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/i],
      ["a production Fireblocks host", /\/\/(?:eu2?-)?api\.fireblocks\.io/],
      ["a production Fireblocks workspace", /BasePath\.(?:US|EU|EU2)\b/],
      ["a bracketed BasePath lookup", /BasePath\s*\[/],
      ["the Fireblocks base-path variable", /FIREBLOCKS_BASE_PATH/],
      ["a production QuickBooks host", /\/\/quickbooks\.api\.intuit\.com/],
      ["a mainnet Fireblocks asset id", /BASECHAIN_ETH(?!_TEST)/],
    ];
    // (control) Each pattern matches what it should and nothing it should not.
    const bad = [
      "eip155:8453", "eip155: 8453", "eip155:*", BASE_MAINNET_USDC.toLowerCase(), "https://api.fireblocks.io/v1", "https://eu-api.fireblocks.io/v1",
      "BasePath.US", 'BasePath["US"]', "FIREBLOCKS_BASE_PATH", "https://quickbooks.api.intuit.com", "USDC_BASECHAIN_ETH",
    ];
    const good = ["eip155:84532", "https://sandbox-api.fireblocks.io/v1", "BasePath.Sandbox", "https://sandbox-quickbooks.api.intuit.com", "BASECHAIN_ETH_TEST5", "USDC_BASECHAIN_ETH_TEST5_29AA"];
    assert(bad.every((s) => MAINNET.some(([, re]) => re.test(s))), "PIN-6: (control) every mainnet spelling is matched");
    assert(good.every((s) => !MAINNET.some(([, re]) => re.test(s))), "PIN-6: (control) no sandbox spelling is matched");

    // (control) The scan reads code, not text: a string that merely contains the
    // characters /* must not start a comment and hide what follows. A regex
    // stripper did exactly that to src/gateway/forward.ts.
    const tricky = 'const accept = "*/*";\nconst network = "eip155:8453";\n/* an ordinary comment */\n// eip155:8453 in a line comment\n';
    const seen = codeOf(tricky);
    assert(seen.includes("eip155:8453") && seen.split("eip155:8453").length === 2, "PIN-6: (control) a \"*/*\" string does not hide the code after it, and a real comment is still removed");

    // The one place allowed to name them: the table that classifies them.
    const table = code(ENVIRONMENT);
    for (const [what, re] of [MAINNET[0]!, MAINNET[3]!, MAINNET[7]!]) {
      assert(re.test(table), `PIN-6: (control) the environment table is where ${what} is allowed to appear, and it does`);
    }
    for (const [what, re] of MAINNET) {
      const holders = srcFiles.filter((f) => f !== ENVIRONMENT && re.test(code(f)));
      assertEqual(holders.join(", "), "", `PIN-6: no file in src/ outside the environment table names ${what}`);
    }

    // The only chain definition Fuel imports from viem is Base Sepolia's.
    const chainImports = srcFiles.flatMap((f) => namesImportedFrom(f, "viem/chains").map((n) => `${f}: ${n}`));
    assert(chainImports.length >= 1, "PIN-6: (control) the scan finds the one viem/chains import");
    assertEqual(chainImports.filter((s) => !s.endsWith(": baseSepolia")).join(", "), "", "PIN-6: src imports nothing from viem/chains but baseSepolia");
  }

  console.log(`\nAll ${checks} checks passed.`);
  console.log(`Test database: ${scratch} (the real database was never opened)`);
}

main().catch((error) => {
  console.error(`\n${(error as Error).message}`);
  process.exit(1);
});
