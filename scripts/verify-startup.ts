/**
 * Verifies that Fuel stays up when the payment network is down, and that while
 * it is down every payment that needs it is refused, never approved.
 *
 * THE FAILURE THIS GUARDS AGAINST. Both of Fuel's x402 resource servers used to
 * start their handshake with the facilitator the moment they were created, with
 * nothing listening for it to fail. An unreachable facilitator was an
 * unhandled rejection, and Node ends the process on one: the whole API went
 * down with it. src/payments/facilitator-sync.ts now owns both handshakes.
 *
 * HOW, WITHOUT THE INTERNET. The API runs as a child process -- the real
 * src/server.ts, on a generated test database, with throwaway keys -- under a
 * test-only preload (scripts/lib/offline-network.mjs) that plays the
 * facilitator in whatever mode this file writes to its control file, refuses
 * everything else off this machine, and logs every facilitator call and DNS
 * lookup. A lookup of a seller's hostname is how "the gateway contacted the
 * seller" is seen; GS-6c shows that detector firing in the same process.
 *
 * ORDER MATTERS. Each break test (B1-B16) must fail ITS OWN check first, so
 * the checks run cheapest and most specific first: source checks, then the
 * sync module in-process, then children that only import, then the full API.
 *
 * ONE LIMIT, ACCEPTED AND DOCUMENTED (docs/testing.md): a facilitator failing
 * at SETTLE, after the seller has answered, is not driven end to end. That code
 * is byte-identical to the version before this fix, and verify-earning checks
 * the receipt rules it relies on.
 *
 * Run:  npm run verify-startup     (and as a step of npm test)
 */
import { createTestDatabase } from "./lib/test-db.js";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** Strips comments so a check reads code. A `//` right after `:` (a URL) is kept. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(ready: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await sleep(25);
  }
  return ready();
}

const scratch = createTestDatabase("startup");
process.env.FUEL_DB_PATH = scratch;
// The suite and its API children share one throwaway key, so the endpoints
// seeded here have forward secrets the children can read.
const ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.FUEL_TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
const OPERATOR_KEY = `op-${randomBytes(16).toString("hex")}`;
const AGENT_KEY = `ag-${randomBytes(16).toString("hex")}`;

const work = mkdtempSync(join(tmpdir(), "fuel-startup-"));
const PRELOAD = join("scripts", "lib", "offline-network.mjs");
const children: ChildProcess[] = [];

/** A fresh control directory per child, so no two children's logs mix. */
function networkDir(name: string, mode: string): string {
  const path = mkdtempSync(join(work, `${name}-`));
  writeFileSync(join(path, "mode"), `${mode}\n`);
  return path;
}
const setMode = (dir: string, mode: string) => writeFileSync(join(dir, "mode"), `${mode}\n`);

interface Call { at: number; kind: string; path?: string; host?: string; mode?: string }
function calls(dir: string): Call[] {
  const file = join(dir, "calls.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
}
const supportedCalls = (dir: string) => calls(dir).filter((c) => c.kind === "facilitator" && c.path === "/supported");
const facilitatorCalls = (dir: string, path: "/verify" | "/settle") => calls(dir).filter((c) => c.kind === "facilitator" && c.path === path).length;
const lookupsOf = (dir: string, host: string) => calls(dir).filter((c) => c.kind === "lookup" && c.host === host);

/** Flags every child runs with. GS-12 reads this list: none may soften an unhandled rejection. */
const NODE_FLAGS = ["--import", "tsx", "--import", `./${PRELOAD}`];

function childEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    DOTENV_CONFIG_PATH: "/dev/null",
    FUEL_DB_PATH: scratch,
    FUEL_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    FUEL_API_KEY: OPERATOR_KEY,
    FUEL_AGENT_KEY: AGENT_KEY,
    FUEL_TEST_NETWORK_DIR: dir,
    ...extra,
  };
}

interface Child { proc: ChildProcess; output: () => string; alive: () => boolean; exitCode: () => number | null }
function startChild(args: string[], env: NodeJS.ProcessEnv): Child {
  const proc = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(proc);
  let out = "";
  proc.stdout!.on("data", (c: Buffer) => (out += c.toString()));
  proc.stderr!.on("data", (c: Buffer) => (out += c.toString()));
  let exited = false;
  proc.once("exit", () => (exited = true));
  return { proc, output: () => out, alive: () => !exited, exitCode: () => proc.exitCode };
}
const tail = (c: Child) => `\n--- child output (last lines) ---\n${c.output().trim().split("\n").slice(-12).join("\n")}`;

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

interface Reply { status: number; retryAfter: string | null; required: string | null; allow: string | null; length: string | null; body: string; ms: number }
async function request(method: "GET" | "HEAD", base: string, path: string, headers: Record<string, string>, timeoutMs: number): Promise<Reply> {
  const started = Date.now();
  try {
    const res = await fetch(base + path, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
    return {
      status: res.status,
      retryAfter: res.headers.get("retry-after"),
      required: res.headers.get("payment-required"),
      allow: res.headers.get("allow"),
      length: res.headers.get("content-length"),
      body: await res.text(),
      ms: Date.now() - started,
    };
  } catch {
    return { status: -1, retryAfter: null, required: null, allow: null, length: null, body: "", ms: Date.now() - started };
  }
}
const get = (base: string, path: string, headers: Record<string, string> = {}, timeoutMs = 15_000) => request("GET", base, path, headers, timeoutMs);
const head = (base: string, path: string, headers: Record<string, string> = {}, timeoutMs = 15_000) => request("HEAD", base, path, headers, timeoutMs);

/** What a refused HEAD says, and how long that is: a HEAD reply has no body, only this Content-Length. */
const GET_ONLY_LENGTH = String(JSON.stringify({ error: "GET only" }).length);

async function main(): Promise<void> {
  const { DB_PATH, db } = await import("../src/db/index.js");
  assertEqual(DB_PATH, scratch, "TD-2: this suite opened its test database, not fuel.db");
  const fx = await import("./lib/startup-fixtures.js");
  const { createFacilitatorSync } = await import("../src/payments/facilitator-sync.js");
  const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
  const seeded = await fx.seedGatewayEndpoints();
  const GATEWAY_PATH = `/earn/${seeded.gateway.publicId}`;
  const SELLER_HOST = new URL(fx.QUOTE_SEED.originUrl).hostname;
  const CONTROL_HOST = new URL(fx.CONTROL_SEED.originUrl).hostname;

  // Every table a payment, receipt, approval or posting lives in.
  const MONEY_TABLES = ["payments", "receipts", "approval_requests", "posting_lines", "export_postings", "qbo_postings", "qbo_posting_drafts", "qbo_draft_lines"];
  const moneyHash = (): string => {
    const h = createHash("sha256");
    for (const table of MONEY_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      h.update(table).update(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    }
    return h.digest("hex");
  };
  const receiptsFor = (endpointId: string): number =>
    Number((db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE endpoint_id = ?").get(endpointId) as { n: number | bigint }).n);
  const stillEnabled = (publicId: string): boolean =>
    db.prepare("SELECT 1 FROM earning_endpoints WHERE public_id = ? AND enabled = 1").get(publicId) !== undefined;

  /* ======================================================================== */
  console.log("\n== source: the rail, the preload, and no global error handler");
  {
    // GS-9. The rail is the hardcoded one, and nothing new can change it.
    const pay = readFileSync(join("src", "payments", "pay.ts"), "utf8");
    assert(/^export const FACILITATOR_URL = "https:\/\/x402\.org\/facilitator";$/m.test(pay), "GS-9: FACILITATOR_URL is still a literal in pay.ts");
    assert(/^export const ALLOWED_NETWORK = "eip155:84532";$/m.test(pay), "GS-9: ALLOWED_NETWORK is still a literal in pay.ts");
    const sync = withoutComments(readFileSync(join("src", "payments", "facilitator-sync.ts"), "utf8"));
    assert(!/process\.env/.test(sync) && !/^\s*import\s/m.test(sync), "GS-9: facilitator-sync.ts reads no environment and imports nothing");
    for (const file of [join("src", "gateway", "route.ts"), join("src", "server.ts")]) {
      const src = withoutComments(readFileSync(file, "utf8"));
      assert(
        /new HTTPFacilitatorClient\(\{ url: FACILITATOR_URL \}\)/.test(src) && /\.register\(ALLOWED_NETWORK, new ExactEvmScheme\(\)\)/.test(src),
        `GS-9: ${file} builds its resource server from FACILITATOR_URL and ALLOWED_NETWORK`,
      );
    }
    // The preload decides what "the facilitator" says. Referenced from src/,
    // package.json or an env template it would be a switch in production.
    const srcFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? srcFiles(join(dir, e.name)) : /\.(ts|mts|mjs|js)$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const SRC = srcFiles("src");
    assert(SRC.length > 20, "GS-9: (control) the source walk found files");
    const templates = ["package.json", ".env.example", join("dashboard", ".env.local.example")].filter((f) => existsSync(f));
    const referencing = [...SRC, ...templates].filter((f) => readFileSync(f, "utf8").includes("offline-network"));
    assertEqual(referencing.join(","), "", "GS-9: the test preload is referenced from nowhere in src/, package.json or the env templates");

    // GS-12. No process-wide handler that would turn a crash into silence.
    const GLOBAL = /\bprocess\.(on|once|addListener|prependListener|prependOnceListener)\(\s*["'](unhandledRejection|uncaughtException)["']|setUncaughtExceptionCaptureCallback/;
    const handlers = [...SRC, PRELOAD].filter((f) => GLOBAL.test(withoutComments(readFileSync(f, "utf8"))));
    assertEqual(handlers.join(","), "", "GS-12: nothing in src/ or the preload installs an unhandledRejection or uncaughtException handler");
    assert(
      !NODE_FLAGS.some((f) => f.startsWith("--unhandled-rejections")) && !("NODE_OPTIONS" in childEnv(work)),
      "GS-12: and no child runs with --unhandled-rejections or NODE_OPTIONS",
    );
  }

  /* ======================================================================== */
  console.log("\n== the sync module, in-process");
  {
    const counted = (behaviour: () => Promise<unknown>) => {
      const at: number[] = [];
      return { at, init: () => { at.push(Date.now()); return behaviour(); } };
    };
    const quiet = { log: () => {} };

    // GS-5. A failed attempt is retried on the configured, growing delays.
    {
      const stub = counted(() => Promise.reject(new Error("down")));
      // Each retry must wait AT LEAST its configured delay. Only a lower bound:
      // a busy event loop can make a wait longer, never shorter, so comparing
      // measured gaps with each other would fail on scheduler jitter alone.
      const DELAYS = [60, 180, 540];
      const s = createFacilitatorSync(stub.init, { name: "gs5", retryDelaysMs: DELAYS, ...quiet });
      s.start();
      await waitFor(() => stub.at.length >= 4, 5_000);
      s.stop();
      assert(stub.at.length >= 4, `GS-5: a failing handshake is retried in the background (${stub.at.length} attempts)`);
      const gaps = stub.at.slice(1, 4).map((t, i) => t - stub.at[i]!);
      assert(gaps.every((g, i) => g >= DELAYS[i]! - 5), `GS-5: each retry waits at least its configured, growing delay (${gaps.join(", ")} ms for ${DELAYS.join(", ")})`);
      assertEqual(s.isReady(), false, "GS-5: and is not ready while every attempt fails");
    }

    // GS-8. One attempt at a time, and never again after success.
    {
      const stub = counted(() => sleep(150));
      const s = createFacilitatorSync(stub.init, { name: "gs8", ...quiet });
      s.start();
      const answers = await Promise.all(Array.from({ length: 20 }, () => s.ready()));
      assert(answers.every((a) => a === true), "GS-8: 20 concurrent ready() calls during a slow attempt all wait for it and get true");
      assertEqual(stub.at.length, 1, "GS-8: and caused exactly one handshake");
      await Promise.all(Array.from({ length: 20 }, () => s.ready()));
      await sleep(200);
      assertEqual(stub.at.length, 1, "GS-8: after success, no handshake ever runs again");
      s.stop();
    }

    // GS-8b. A request never starts an attempt: during the wait, ready() is
    // false at once and the next attempt is the timer's.
    {
      const stub = counted(() => Promise.reject(new Error("down")));
      // A ready() that waited for the retry would take ~1 s; "at once" is far below that.
      const s = createFacilitatorSync(stub.init, { name: "gs8b", retryDelaysMs: [1_000], ...quiet });
      s.start();
      await waitFor(() => stub.at.length === 1, 1_000);
      await sleep(20);
      const t0 = Date.now();
      const answers = await Promise.all(Array.from({ length: 20 }, () => s.ready()));
      const took = Date.now() - t0;
      assert(answers.every((a) => a === false) && took < 250, `GS-8b: during the wait to retry, ready() answers false at once (${took} ms)`);
      assertEqual(stub.at.length, 1, "GS-8b: and 20 of them start no attempt before the scheduled retry");
      await waitFor(() => stub.at.length === 2, 3_000);
      assertEqual(stub.at.length, 2, "GS-8b: (control) the scheduled retry still happens");
      s.stop();
    }

    // GS-8c, in-process. An attempt that never answers is never replaced, and
    // ready() gives up on it within its bound.
    {
      const stub = counted(() => new Promise(() => {}));
      const s = createFacilitatorSync(stub.init, { name: "gs8c", readyWaitMs: 100, ...quiet });
      s.start();
      const t0 = Date.now();
      const answer = await Promise.race([s.ready(), sleep(3_000).then(() => "hung" as const)]);
      const took = Date.now() - t0;
      assert(answer === false && took < 1_000, `GS-8c: ready() during a hung attempt answers false within its bound (${answer}, ${took} ms)`);
      await Promise.race([Promise.all([s.ready(), s.ready()]), sleep(3_000)]);
      assertEqual(stub.at.length, 1, "GS-8c: and the hung attempt is never replaced by a new one");
      s.stop();
    }

    // GS-10, in-process. stop() is final; a sync never started refuses and does nothing.
    {
      const stub = counted(() => Promise.reject(new Error("down")));
      const s = createFacilitatorSync(stub.init, { name: "gs10", retryDelaysMs: [50], ...quiet });
      s.start();
      await waitFor(() => stub.at.length === 1, 1_000);
      s.stop();
      await sleep(150);
      s.start();
      const after = await s.ready();
      assertEqual(stub.at.length, 1, "GS-10: after stop(), no attempt runs: not the scheduled retry, not start(), not ready()");
      assertEqual(after, false, "GS-10: and ready() answers false");

      const idle = counted(() => Promise.resolve());
      const lines: string[] = [];
      const never = createFacilitatorSync(idle.init, { name: "gs10-idle", log: (l) => lines.push(l) });
      assertEqual(await never.ready(), false, "GS-10: a sync never started answers false");
      assertEqual(idle.at.length, 0, "GS-10: and ready() does not start it");
      assert(lines.length === 1 && /before this sync was started/.test(lines[0]!), "GS-10: and says so once, as a wiring mistake");
      never.stop();
    }
  }

  /* ======================================================================== */
  console.log("\n== children that only import");
  {
    // GS-2. The gateway's handshake failing is handled: the process lives on.
    const dir = networkDir("gs2", "down");
    const child = startChild(
      [...NODE_FLAGS, "-e", 'const { gatewayFacilitator } = await import("./src/gateway/route.ts"); gatewayFacilitator.start(); setInterval(() => {}, 1000);'],
      childEnv(dir),
    );
    const attempted = await waitFor(() => supportedCalls(dir).length >= 1 || !child.alive(), 20_000);
    await sleep(800);
    assert(attempted && child.alive(), `GS-2: the gateway's handshake failing with the facilitator down does not end the process${tail(child)}`);
    child.proc.kill("SIGKILL");

    // GS-4. Importing the API or the gateway reaches nothing.
    const dir4 = networkDir("gs4", "up");
    const importer = startChild(
      [...NODE_FLAGS, "-e", 'await import("./src/api.ts"); await import("./src/gateway/route.ts"); await new Promise((r) => setTimeout(r, 1500)); process.exit(0);'],
      childEnv(dir4),
    );
    const done = await waitFor(() => !importer.alive(), 30_000);
    assert(done && importer.exitCode() === 0, `GS-4: (control) the importing child finished cleanly${tail(importer)}`);
    assertEqual(supportedCalls(dir4).length, 0, "GS-4: importing src/api.ts and src/gateway/route.ts makes no facilitator request");
  }

  /* ======================================================================== */
  console.log("\n== the API, offline, then back online");
  {
    const dir = networkDir("api", "down");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const api = startChild([...NODE_FLAGS, "src/server.ts"], childEnv(dir, { PORT: String(port), X402_PAY_TO: fx.QUOTE_SEED.payTo }));

    // The first wave: both servers try once.
    await waitFor(() => supportedCalls(dir).length >= 2 || !api.alive(), 30_000);
    const t0 = supportedCalls(dir)[0]?.at ?? Date.now();
    await sleep(800);

    // GS-3. The /paid-hello handshake failing is handled too.
    assert(api.alive(), `GS-3: the API survives both handshakes failing at boot${tail(api)}`);

    // GS-11. Every handshake in src/ goes through facilitator-sync.
    {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
        );
      const SRC_TS = walk("src");
      const inits: string[] = [];
      let fromHttpServerCalls = 0;
      const selfSyncing: string[] = [];
      const syncingOnTheirOwn: string[] = [];
      for (const file of SRC_TS) {
        const src = withoutComments(readFileSync(file, "utf8"));
        for (const m of src.matchAll(/\.initialize\(/g)) {
          const before = src.slice(0, m.index);
          const opened = before.lastIndexOf("createFacilitatorSync(");
          const insideSync = opened !== -1 && !/\{\s*name:/.test(before.slice(opened));
          inits.push(`${file}${insideSync ? "" : " (OUTSIDE a sync)"}`);
        }
        if (/\bpaymentMiddleware(FromConfig)?\(/.test(src)) selfSyncing.push(file);
        // Any call, however it is written: its arguments, up to the matching
        // parenthesis (one level of nesting), must end in `false`.
        for (const m of src.matchAll(/paymentMiddlewareFromHTTPServer\(((?:[^()]|\([^()]*\))*)\)/g)) {
          fromHttpServerCalls += 1;
          if (!/,\s*false\s*$/.test(m[1]!)) syncingOnTheirOwn.push(file);
        }
      }
      assertEqual(selfSyncing.join(","), "", "GS-11: nothing in src/ uses paymentMiddleware or paymentMiddlewareFromConfig, which start their own handshake");
      assert(fromHttpServerCalls >= 1, "GS-11: (control) the check found the paymentMiddlewareFromHTTPServer call to judge");
      assertEqual(syncingOnTheirOwn.join(","), "", "GS-11: every paymentMiddlewareFromHTTPServer call is told not to sync on its own");
      // server.ts gates its paid routes on the /paid-hello sync and no other.
      // Both syncs fail and recover together in every mode this suite can make,
      // so a guard asking the gateway's sync would pass every behavioural check;
      // only this sees it. (Whether the guard refuses at all is GS-7's question.)
      const server = withoutComments(readFileSync(join("src", "server.ts"), "utf8"));
      const consulted = [...new Set([...server.matchAll(/\b(\w+Facilitator)\.(?:isReady|ready)\(/g)].map((m) => m[1]))];
      assertEqual(consulted.join(","), "paidFacilitator", "GS-11: server.ts gates paid routes on the /paid-hello sync alone, never the gateway's");
      // The HEAD refusal comes before the payment middleware in the source. Today the
      // order is not load-bearing: the middleware asks its matcher with the request's
      // own method, which never matches a HEAD. A route-table entry with no verb would
      // match one, and the middleware would then quote and verify it before the
      // refusal ran. (An absent refusal is the runtime checks' to catch, not this one's.)
      const refusalAt = server.indexOf('"GET only"');
      const paymentAt = server.indexOf("paymentMiddlewareFromHTTPServer(paidHttpServer");
      assert(paymentAt !== -1, "GS-16: (control) the source check found the payment middleware's mount");
      assert(refusalAt === -1 || refusalAt < paymentAt, "GS-16: server.ts mounts its HEAD refusal ahead of the payment middleware");
      assertEqual(
        inits.sort().join(" | "),
        [join("src", "gateway", "route.ts"), join("src", "server.ts")].join(" | "),
        "GS-11: .initialize( appears exactly twice in src/, each inside a createFacilitatorSync callback",
      );
    }

    // GS-6c. The seller-contact detector fires in this very process: the
    // startup reaper probes the control endpoint, and its lookup is logged.
    assert(await waitFor(() => lookupsOf(dir, CONTROL_HOST).length > 0, 10_000), "GS-6c: (control) the startup reaper's probe of the control endpoint appears in the DNS log");
    await waitFor(() => !stillEnabled(seeded.control.publicId), 5_000); // its failed probe is recorded; then the books are quiet
    await waitFor(() => supportedCalls(dir).length >= 4, 10_000); // the second wave, so the next is ~4s away
    for (let i = 0; i < 40 && (await get(base, "/health")).status !== 200; i++) await sleep(100);
    const before = { hash: moneyHash(), receipts: receiptsFor(seeded.gateway.id) };
    {
      // (control) The hash notices a change to any one money row: this suite
      // changes one approval's detail, hashes, and puts it back.
      const row = db.prepare("SELECT id, detail FROM approval_requests ORDER BY rowid LIMIT 1").get() as { id: string; detail: string | null };
      db.prepare("UPDATE approval_requests SET detail = ? WHERE id = ?").run(`${row.detail ?? ""} (changed)`, row.id);
      const changed = moneyHash();
      db.prepare("UPDATE approval_requests SET detail = ? WHERE id = ?").run(row.detail, row.id);
      assert(changed !== before.hash && moneyHash() === before.hash, "GS-6: (control) the money-table hash notices a change to a single row");
    }

    // GS-6. While down, the gateway refuses: 503, no receipt, no entry, no seller.
    const unpaid = await get(base, GATEWAY_PATH);
    const withHeader = await get(base, GATEWAY_PATH, { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64") });
    for (const [label, r] of [["an unpaid request", unpaid], ["a request with a payment header", withHeader]] as const) {
      assertEqual(r.status, 503, `GS-6: while the facilitator is down, ${label} to the gateway is refused with 503`);
      assertEqual(r.retryAfter, "30", `GS-6: with Retry-After: 30 (${label})`);
    }
    assertEqual(receiptsFor(seeded.gateway.id), before.receipts, "GS-6: no receipt is created for a refused request");
    assertEqual(moneyHash(), before.hash, "GS-6: no ledger entry: every money table is unchanged");
    assertEqual(lookupsOf(dir, SELLER_HOST).length, 0, "GS-6: no seller contact: the seller's hostname was never looked up");
    assert(stillEnabled(seeded.gateway.publicId), "GS-6: (control) the endpoint is still enabled, so the 503 was the outage's answer");

    // GS-7. /paid-hello, every spelling the router accepts, refuses the same way.
    for (const path of ["/paid-hello", "/paid-hello-large", "/PAID-HELLO", "/paid-hello/"]) {
      for (const headers of [{}, { "payment-signature": Buffer.from("{}").toString("base64") }] as Record<string, string>[]) {
        const r = await get(base, path, headers);
        assertEqual(r.status, 503, `GS-7: ${path} while down answers 503${"payment-signature" in headers ? " (with a payment header)" : ""}`);
        assert(r.retryAfter === "30" && !r.body.includes("You paid"), `GS-7: ${path} carries Retry-After and never serves the handler's body`);
      }
    }
    assertEqual(moneyHash(), before.hash, "GS-7: and every money table is still unchanged");

    // GS-15 / GS-16, while down. A HEAD is refused with 405 before the outage is
    // even consulted: not a 503, and not the 200 /paid-hello gave a HEAD, which
    // ran its handler with no payment at all. Express answers a HEAD with the GET
    // handler, so without this a payer who sent one was either served for free
    // or charged for headers alone.
    const unreadable = { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64") };
    {
      const verifiesBefore = facilitatorCalls(dir, "/verify");
      const settlesBefore = facilitatorCalls(dir, "/settle");
      for (const [label, headers] of [["no payment header", {}], ["a payment header", unreadable]] as const) {
        const r = await head(base, GATEWAY_PATH, headers);
        assertEqual(r.status, 405, `GS-15: while the facilitator is down, HEAD to the gateway (${label}) is refused with 405`);
        assertEqual(r.allow, "GET", `GS-15: with Allow: GET (down, ${label})`);
        assert(r.required === null && r.length === GET_ONLY_LENGTH, `GS-15: quoting nothing and saying only "GET only" (down, ${label}: ${r.length} bytes)`);
      }
      assertEqual(receiptsFor(seeded.gateway.id), before.receipts, "GS-15: no receipt is created for a HEAD while down");
      assertEqual(moneyHash(), before.hash, "GS-15: no ledger entry while down");
      assertEqual(lookupsOf(dir, SELLER_HOST).length, 0, "GS-15: the seller is not contacted by a HEAD while down");
      assertEqual(facilitatorCalls(dir, "/verify") + facilitatorCalls(dir, "/settle") - verifiesBefore - settlesBefore, 0, "GS-15: no HEAD to the gateway reaches the facilitator's verify or settle while down");

      for (const path of ["/paid-hello", "/paid-hello-large", "/PAID-HELLO", "/paid-hello/"]) {
        for (const [label, headers] of [["no payment header", {}], ["a payment header", unreadable]] as const) {
          const r = await head(base, path, headers);
          assertEqual(r.status, 405, `GS-16: while the facilitator is down, HEAD ${path} (${label}) is refused with 405, never run`);
          assertEqual(r.allow, "GET", `GS-16: with Allow: GET (down, ${path}, ${label})`);
          assert(r.required === null && r.length === GET_ONLY_LENGTH, `GS-16: quoting nothing and saying only "GET only" (down, ${path}, ${label}: ${r.length} bytes)`);
        }
      }
      assertEqual(moneyHash(), before.hash, "GS-16: no ledger entry while down");
      assertEqual(facilitatorCalls(dir, "/verify") + facilitatorCalls(dir, "/settle") - verifiesBefore - settlesBefore, 0, "GS-16: no HEAD to /paid-hello reaches the facilitator's verify or settle while down");
    }

    // GS-8b, in the API. Just after a wave, requests start no attempt of their own.
    await waitFor(() => supportedCalls(dir).length >= 6, 10_000); // the third wave; the next is ~8s away
    const atWave = supportedCalls(dir).length;
    await Promise.all([
      ...Array.from({ length: 5 }, () => get(base, GATEWAY_PATH)),
      ...Array.from({ length: 5 }, () => get(base, "/paid-hello")),
    ]);
    assertEqual(supportedCalls(dir).length, atWave, "GS-8b: ten paid requests during the wait to retry start no handshake");

    // GS-1. The API is up, serving, and both servers keep retrying.
    const health = await get(base, "/health");
    assertEqual(health.status, 200, "GS-1: with the facilitator down, the API answers /health");
    await waitFor(() => !api.alive(), Math.max(0, t0 + 10_000 - Date.now()));
    assert(api.alive(), `GS-1: and is still running 10 seconds after its first failed handshake${tail(api)}`);
    const waves = supportedCalls(dir).filter((c) => c.at < t0 + 10_000).length;
    assert(waves >= 6, `GS-1: across three waves of retries by both servers (${waves} handshakes in 10 s)`);

    // Back online, slowly: the next wave's handshake takes 2.5 s to answer.
    setMode(dir, "slow-up");
    const preWave = supportedCalls(dir).length;
    await waitFor(() => supportedCalls(dir).length >= preWave + 1, 20_000);
    const sentAt = Date.now();
    const twenty = await Promise.all(Array.from({ length: 20 }, () => get(base, GATEWAY_PATH)));
    const answeredAt = calls(dir).find((c) => c.kind === "facilitator-answered")?.at ?? Infinity;
    const readyAt = Date.now();

    // GS-8, in the API. Requests made during the handshake wait for it.
    assert(answeredAt - sentAt >= 1_000, `GS-8: (control) the 20 requests went out at least a second before the handshake answered (${answeredAt - sentAt} ms)`);
    assertEqual(twenty.filter((r) => r.status === 402).length, 20, "GS-8: all 20 waited for the open handshake and were quoted");
    assertEqual(supportedCalls(dir).length - preWave, 2, "GS-8: and that wave was exactly one handshake per server");

    // GS-5b / GS-5c. Each server recovered, seen through its own answers.
    const gatewayQuote = await get(base, GATEWAY_PATH);
    assertEqual(gatewayQuote.status, 402, "GS-5b: back online, the gateway quotes its price again");
    const small = await get(base, "/paid-hello");
    const large = await get(base, "/paid-hello-large");
    assert(small.status === 402 && large.status === 402, `GS-5c: and /paid-hello and /paid-hello-large quote theirs (${small.status}, ${large.status})`);

    // GS-13. The quotes are exactly main's.
    const golden = JSON.parse(readFileSync(join("scripts", "fixtures", "x402-quotes-main.json"), "utf8")) as { seed: unknown; quotes: Record<string, unknown> };
    assertEqual(JSON.stringify(golden.seed), JSON.stringify({ ...fx.QUOTE_SEED }), "GS-13: (control) this suite seeds exactly what the recorded quotes were made with");
    for (const [name, reply] of [["gateway", gatewayQuote], ["paid-hello", small], ["paid-hello-large", large]] as const) {
      assertEqual(JSON.stringify(fx.pickQuote(reply.required)), JSON.stringify(golden.quotes[name]), `GS-13: the ${name} quote is identical to main's: amount, recipient, network, asset, time limit`);
    }

    // GS-6, ready but with verify down: a payment that matches the terms is
    // refused after exactly one verify, and nothing is claimed or contacted.
    const required = decodePaymentRequiredHeader(gatewayQuote.required!);
    const accepted = required.accepts[0]!;
    const payment = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: {
          from: `0x${"ab".repeat(20)}`,
          to: accepted.payTo,
          value: accepted.amount,
          validAfter: "0",
          validBefore: String(Math.floor(Date.now() / 1000) + 3600),
          nonce: `0x${"cd".repeat(32)}`,
        },
      },
    } as Parameters<typeof encodePaymentSignatureHeader>[0]);
    const verifiesBefore = calls(dir).filter((c) => c.kind === "facilitator" && c.path === "/verify").length;
    const refused = await get(base, GATEWAY_PATH, { "payment-signature": payment });
    assertEqual(refused.status, 402, "GS-6: ready, but with verify down, a matching payment is refused with 402");
    assertEqual(calls(dir).filter((c) => c.kind === "facilitator" && c.path === "/verify").length - verifiesBefore, 1, "GS-6: after exactly one verify call, so the payment really reached verify");
    assertEqual(receiptsFor(seeded.gateway.id), before.receipts, "GS-6: no receipt is created when verify is down");
    assertEqual(moneyHash(), before.hash, "GS-6: no ledger entry when verify is down");
    assertEqual(lookupsOf(dir, SELLER_HOST).length, 0, "GS-6: no seller contact when verify is down");

    // GS-8. Once ready, never again: 10 seconds of traffic to all three paid
    // routes, and no handshake since the one wave that made them ready -- the
    // requests above (quotes, the verify-down payment) included.
    while (Date.now() < readyAt + 10_000) {
      await Promise.all([get(base, GATEWAY_PATH), get(base, "/paid-hello"), get(base, "/paid-hello-large")]);
      await sleep(1_000);
    }
    assertEqual(supportedCalls(dir).length, preWave + 2, "GS-8: after both servers are ready, no handshake runs again (10 s of traffic to all three routes)");

    // GS-15 / GS-16 / GS-17, ready. After GS-8's quiet window, so none of this can
    // shorten it. The same refusals with the facilitator up, where a HEAD that
    // matches the terms would otherwise be verified, and on the gateway claimed,
    // forwarded to the seller and settled -- a charge for headers alone.
    {
      // (control) The receipt detector fires: a real claim moves the count and the hash.
      const { claimReceipt, resolveReceipt } = await import("../src/db/receipts.js");
      const owner = db.prepare("SELECT agent_id FROM earning_endpoints WHERE id = ?").get(seeded.gateway.id) as { agent_id: string };
      const receiptsThen = receiptsFor(seeded.gateway.id);
      const hashThen = moneyHash();
      const made = claimReceipt({ agentId: owner.agent_id, endpointId: seeded.gateway.id, amountBaseUnits: 50_000n, payerAddress: `0x${"ee".repeat(20)}`, authorizationNonce: `0x${"ee".repeat(32)}` });
      assert(receiptsFor(seeded.gateway.id) === receiptsThen + 1 && moneyHash() !== hashThen, "GS-17: (control) a real receipt claim moves the receipt count and the money hash");
      resolveReceipt(made.id, "abandoned", { detail: "verify-startup control" });
      const base0 = { hash: moneyHash(), receipts: receiptsFor(seeded.gateway.id) };

      // (control) Sent as a GET, the very same payment header reaches /verify once,
      // so a HEAD that reaches it zero times was stopped, not unable to get there.
      const viaGet = facilitatorCalls(dir, "/verify");
      const getReply = await get(base, GATEWAY_PATH, { "payment-signature": payment });
      assertEqual(getReply.status, 402, "GS-17: (control) the payment header, sent as a GET, is refused after verify with 402");
      assertEqual(facilitatorCalls(dir, "/verify") - viaGet, 1, "GS-17: (control) and it reaches /verify exactly once");

      const verifiesBefore = facilitatorCalls(dir, "/verify");
      const settlesBefore = facilitatorCalls(dir, "/settle");
      const heads: [string, Record<string, string>][] = [
        ["no payment header", {}],
        ["a payment header that cannot be read", unreadable],
        ["a payment header matching the terms", { "payment-signature": payment }],
        ["the same, as x-payment", { "x-payment": payment }],
      ];
      for (const [label, headers] of heads) {
        const r = await head(base, GATEWAY_PATH, headers);
        assertEqual(r.status, 405, `GS-15: with the facilitator up, HEAD to the gateway (${label}) is refused with 405`);
        assertEqual(r.allow, "GET", `GS-15: with Allow: GET (up, ${label})`);
        assert(r.required === null && r.length === GET_ONLY_LENGTH, `GS-15: quoting nothing and saying only "GET only" (up, ${label}: ${r.length} bytes)`);
      }
      assertEqual(facilitatorCalls(dir, "/verify") - verifiesBefore, 0, "GS-15: no HEAD to the gateway reaches the facilitator's verify, not even one that matches the terms");
      assertEqual(facilitatorCalls(dir, "/settle") - settlesBefore, 0, "GS-15: or its settle");
      assertEqual(receiptsFor(seeded.gateway.id), base0.receipts, "GS-15: no receipt is created for a HEAD");
      assertEqual(moneyHash(), base0.hash, "GS-15: no ledger entry for a HEAD");
      assertEqual(lookupsOf(dir, SELLER_HOST).length, 0, "GS-15: the seller is not contacted by any HEAD");

      // GS-16's payments are built from each paid route's OWN quote. The gateway's
      // payment (50000 base units, the gateway's recipient) matches none of their
      // terms, so the library would reject it before verify whether or not a HEAD
      // got through, and the verify and settle counters below could never fail.
      const signedFor = (quoteHeader: string): string => {
        const quote = decodePaymentRequiredHeader(quoteHeader);
        const terms = quote.accepts[0]!;
        return encodePaymentSignatureHeader({
          x402Version: 2,
          resource: quote.resource,
          accepted: terms,
          payload: {
            signature: `0x${"11".repeat(65)}`,
            authorization: {
              from: `0x${"ab".repeat(20)}`,
              to: terms.payTo,
              value: terms.amount,
              validAfter: "0",
              validBefore: String(Math.floor(Date.now() / 1000) + 3600),
              nonce: `0x${"cd".repeat(32)}`,
            },
          },
        } as Parameters<typeof encodePaymentSignatureHeader>[0]);
      };
      const paymentFor: Record<string, string> = {
        "/paid-hello": signedFor(small.required!),
        "/paid-hello-large": signedFor(large.required!),
        "/PAID-HELLO": signedFor(small.required!),
        "/paid-hello/": signedFor(small.required!),
      };

      // (control) Sent as a GET, each route's own payment reaches /verify exactly
      // once, so a HEAD that reaches it zero times was stopped, not unable to get there.
      for (const route of ["/paid-hello", "/paid-hello-large"]) {
        const verifiesThen = facilitatorCalls(dir, "/verify");
        const reply = await get(base, route, { "payment-signature": paymentFor[route]! });
        assert(reply.status !== 200, `GS-17: (control) ${route}, given a payment that cannot be verified, is not served (${reply.status})`);
        assertEqual(facilitatorCalls(dir, "/verify") - verifiesThen, 1, `GS-17: (control) a payment built from ${route}'s own quote, sent as a GET, reaches /verify exactly once`);
      }

      const paidVerifies = facilitatorCalls(dir, "/verify");
      for (const path of ["/paid-hello", "/paid-hello-large", "/PAID-HELLO", "/paid-hello/"]) {
        const paidHeads: [string, Record<string, string>][] = [
          ["no payment header", {}],
          ["a payment header matching its own terms", { "payment-signature": paymentFor[path]! }],
          ["the same, as x-payment", { "x-payment": paymentFor[path]! }],
        ];
        for (const [label, headers] of paidHeads) {
          const r = await head(base, path, headers);
          assertEqual(r.status, 405, `GS-16: with the facilitator up, HEAD ${path} (${label}) is refused with 405, never run`);
          assertEqual(r.allow, "GET", `GS-16: with Allow: GET (up, ${path}, ${label})`);
          assert(r.required === null && r.length === GET_ONLY_LENGTH, `GS-16: quoting nothing and saying only "GET only" (up, ${path}, ${label}: ${r.length} bytes)`);
        }
      }
      assertEqual(facilitatorCalls(dir, "/verify") - paidVerifies, 0, "GS-16: no HEAD to /paid-hello reaches the facilitator's verify, not even one that matches its own terms");
      assertEqual(facilitatorCalls(dir, "/settle") - settlesBefore, 0, "GS-16: or its settle");
      assertEqual(moneyHash(), base0.hash, "GS-16: no ledger entry for a HEAD to /paid-hello");
      // A refusal that does not end the request lets the handler run behind it. The
      // status, Allow and length were already sent, so nothing above would notice:
      // Express's own error is the only trace, and it is written to the child's log.
      assert(
        !/ERR_HTTP_HEADERS_SENT|Cannot set headers after they are sent/.test(api.output()),
        `GS-16: after every HEAD above, nothing ran behind a refusal: the API's log holds no "headers already sent" error${tail(api)}`,
      );

      // GS-17. The refusal is for paid routes only, and moved nothing else.
      assertEqual((await head(base, "/health")).status, 200, "GS-17: (control) HEAD /health is still served: the refusal is for paid routes only");
      for (const [name, path] of [["gateway", GATEWAY_PATH], ["paid-hello", "/paid-hello"], ["paid-hello-large", "/paid-hello-large"]] as const) {
        const again = await get(base, path);
        assertEqual(again.status, 402, `GS-17: after every HEAD above, a GET to the ${name} still quotes its price`);
        assertEqual(JSON.stringify(fx.pickQuote(again.required)), JSON.stringify(golden.quotes[name]), `GS-17: and the ${name} quote is still exactly main's`);
      }
    }
    api.proc.kill("SIGTERM");
  }

  /* ======================================================================== */
  console.log("\n== the API with a facilitator that lacks Fuel's rail, then hangs");
  {
    const dir = networkDir("rail", "no-rail");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const api = startChild([...NODE_FLAGS, "src/server.ts"], childEnv(dir, { PORT: String(port), X402_PAY_TO: fx.QUOTE_SEED.payTo }));
    await waitFor(() => supportedCalls(dir).length >= 2 || !api.alive(), 30_000);
    await sleep(300);
    for (let i = 0; i < 40 && (await get(base, "/health")).status !== 200; i++) await sleep(100);

    // GS-5d. A facilitator without exact payments on Base Sepolia is not "ready".
    const noRail = await get(base, GATEWAY_PATH);
    assertEqual(noRail.status, 503, "GS-5d: a facilitator that does not offer Fuel's rail leaves the gateway refusing with 503, not quoting or failing");
    assert(await waitFor(() => supportedCalls(dir).length >= 4, 6_000), "GS-5d: and the handshakes keep being retried");
    assert(
      /\[payments\] gateway: the payment network is unreachable \(the facilitator does not offer exact payments on eip155:84532\)/.test(api.output()),
      `GS-5d: the gateway's own failure is the missing rail, logged as such${tail(api)}`,
    );

    // GS-8c, in the API. A handshake that never answers costs a request at most ~5 s.
    setMode(dir, "hang");
    const hungFrom = supportedCalls(dir).length;
    assert(await waitFor(() => supportedCalls(dir).length >= hungFrom + 2, 10_000), "GS-8c: (control) the next wave's handshakes are open and unanswered");
    const hung = await get(base, GATEWAY_PATH, {}, 15_000);
    assert(hung.status === 503 && hung.ms >= 4_000 && hung.ms <= 8_000, `GS-8c: a request during a hung handshake is refused with 503 after its 5 s bound (${hung.status} in ${hung.ms} ms)`);
    api.proc.kill("SIGTERM");
  }

  /* ======================================================================== */
  console.log("\n== timers");
  {
    // GS-14. A log sink that throws cannot turn a failed handshake back into a
    // crash. Run in a child: in this process a crash would end the suite instead
    // of failing a check.
    const loud = startChild(
      ["--import", "tsx", "-e", 'const { createFacilitatorSync } = await import("./src/payments/facilitator-sync.ts"); const s = createFacilitatorSync(() => Promise.reject(new Error("down")), { name: "loud", retryDelaysMs: [50], log: () => { throw new Error("the log sink broke"); } }); s.start(); await new Promise((r) => setTimeout(r, 400)); console.log(`ready=${await s.ready()}`); s.stop();'],
      { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    );
    const loudEnded = await waitFor(() => !loud.alive(), 10_000);
    assert(loudEnded && loud.exitCode() === 0 && /ready=false/.test(loud.output()), `GS-14: a log sink that throws, on every failed handshake, crashes nothing${tail(loud)}`);

    // GS-10. A pending retry never keeps a process alive.
    const lone = startChild(
      ["--import", "tsx", "-e", 'const { createFacilitatorSync } = await import("./src/payments/facilitator-sync.ts"); createFacilitatorSync(() => Promise.reject(new Error("down")), { name: "lone", log: () => {} }).start();'],
      { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    );
    const ended = await waitFor(() => !lone.alive(), 5_000);
    assert(ended && lone.exitCode() === 0, `GS-10: a process whose only work is a failing sync exits by itself, its retry timer unreferenced${tail(lone)}`);
  }

  for (const c of children) c.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
  console.log(`\nAll ${checks} checks passed.`);
  console.log(`Test database: ${scratch} (fuel.db was never opened)`);
}

main()
  .catch((error) => {
    console.error(`\n${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  });
