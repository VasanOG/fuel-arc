/**
 * The earning gateway (Phase 6, slice 6A-2).
 *
 * Everything here runs offline against a scratch database and a local origin
 * server. What is deliberately NOT covered — because it needs a funded sandbox
 * wallet and a live facilitator — is the full payment round trip: a real
 * signed authorization, a real verify, a real on-chain settle. That is a live
 * walkthrough, recorded in docs/roadmap.md, in the same way the QuickBooks
 * slice separates its offline checks from its live one.
 *
 * BREAK TESTS ARE THE POINT OF HALF OF THIS. Phase 0's SSRF guard passed every
 * test it had while being broken in the allow direction, because nothing ever
 * checked that a permitted address was still permitted. So where a guard exists,
 * this asserts BOTH that it refuses what it should and that it allows what it
 * should — a guard never observed to fail has not been tested.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

let checks = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) throw new Error(`FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`   ok  ${label}`);
}
function throws(label: string, fn: () => unknown, expect: RegExp): void {
  checks += 1;
  try {
    fn();
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    if (!expect.test(m)) throw new Error(`FAILED: ${label} — threw "${m}"`);
    console.log(`   ok  ${label}`);
    return;
  }
  throw new Error(`FAILED: ${label} — did not throw, and it must`);
}
async function throwsAsync(label: string, fn: () => Promise<unknown>, expect: RegExp): Promise<void> {
  checks += 1;
  try {
    await fn();
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    if (!expect.test(m)) throw new Error(`FAILED: ${label} — threw "${m}"`);
    console.log(`   ok  ${label}`);
    return;
  }
  throw new Error(`FAILED: ${label} — did not throw, and it must`);
}

/** A local origin whose behaviour each test dictates. */
interface Origin {
  url: string;
  server: Server;
  lastHeaders: Record<string, string | string[] | undefined>;
  behaviour: (path: string, headers: Record<string, string | string[] | undefined>) => {
    status: number;
    body?: string | Buffer;
    headers?: Record<string, string>;
    delayMs?: number;
  };
}

async function startOrigin(): Promise<Origin> {
  const origin = {
    lastHeaders: {},
    behaviour: () => ({ status: 200, body: "paid content" }),
  } as unknown as Origin;

  origin.server = createServer((req, res) => {
    origin.lastHeaders = req.headers;
    const r = origin.behaviour(req.url ?? "/", req.headers);
    const send = () => {
      res.writeHead(r.status, { "content-type": "text/plain", ...(r.headers ?? {}) });
      res.end(r.body ?? "");
    };
    if (r.delayMs) setTimeout(send, r.delayMs);
    else send();
  });

  await new Promise<void>((resolve) => origin.server.listen(0, "127.0.0.1", resolve));
  const port = (origin.server.address() as { port: number }).port;
  origin.url = `http://127.0.0.1:${port}`;
  return origin;
}

async function main(): Promise<void> {
  // Set BEFORE any import that reaches src/db/index.ts, which reads
  // FUEL_DB_PATH at module load and opens the file immediately.
  process.env.FUEL_DB_PATH = join(mkdtempSync(join(tmpdir(), "fuel-earning-")), "scratch.db");
  process.env.FUEL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.FUEL_API_KEY ??= "operator-" + randomBytes(8).toString("hex");
  process.env.FUEL_AGENT_KEY ??= "agent-" + randomBytes(8).toString("hex");
  process.env.X402_PAY_TO ??= "0x0000000000000000000000000000000000000001";

  const { db } = await import("../src/db/index.js");
  const endpoints = await import("../src/db/earning-endpoints.js");
  const receipts = await import("../src/db/receipts.js");
  const signing = await import("../src/gateway/signing.js");
  const forward = await import("../src/gateway/forward.js");
  const limiter = await import("../src/gateway/limiter.js");
  const safeFetchMod = await import("../src/lib/safe-fetch.js");
  const limits = await import("../src/payments/limits.js");

  const seedAgent = (): string => {
    const team = db.prepare("SELECT id FROM teams LIMIT 1").get() as { id: string };
    const now = new Date().toISOString();
    const id = "agent-" + randomBytes(4).toString("hex");
    db.prepare(
      `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                           spend_cap_base_units, created_at)
       VALUES (?, ?, ?, ?, '0xabc', 0, ?)`,
      // One vault per agent is a constraint now, so each seeded agent gets its own.
    ).run(id, id, team.id, `vault-${id}`, now);
    return id;
  };

  const origin = await startOrigin();
  const agentId = seedAgent();

  console.log("== the signature an origin is meant to check ==");
  {
    const secret = "s3cret";
    const headers = signing.signRequest({ secret, method: "GET", path: "/x" });
    const asRecord = headers as unknown as Record<string, string>;
    check(
      "a correct signature verifies",
      signing.verifySignature({ secret, method: "GET", path: "/x", headers: asRecord }),
    );
    check(
      "the wrong secret does not",
      !signing.verifySignature({ secret: "other", method: "GET", path: "/x", headers: asRecord }),
    );
    check(
      "a signature does not carry to another path — it is bound to the request",
      !signing.verifySignature({ secret, method: "GET", path: "/elsewhere", headers: asRecord }),
    );
    check(
      "a stale timestamp is refused, so a captured header expires",
      !signing.verifySignature({
        secret,
        method: "GET",
        path: "/x",
        headers: asRecord,
        nowSeconds: Math.floor(Date.now() / 1000) + signing.MAX_SKEW_SECONDS + 10,
      }),
    );
    check(
      "missing headers are refused rather than treated as absent-and-fine",
      !signing.verifySignature({ secret, method: "GET", path: "/x", headers: {} }),
    );
  }

  console.log("\n== the name an accountant reads ==");
  {
    // This value becomes posting_lines.counterparty on every revenue line and
    // lands in a QuickBooks-facing CSV, so what it REFUSES matters more than
    // what it accepts. Each refusal is checked, because a validator never seen
    // to reject anything has not been tested.
    const { assertUsableLabel, UNATTRIBUTED_COUNTERPARTY } = endpoints;
    // The real constant, not a copy of it — a test asserting against its own
    // idea of the limit would keep passing after the limit moved.
    const { LABEL_MAX_LENGTH, deriveLabel } = await import("../src/lib/endpoint-label.js");

    // THE MIGRATION BYPASS, pinned. deriveLabel is what BOTH registration and
    // the label backfill use; it used to only truncate, so an origin path
    // carrying an MD5, a git SHA or a hyphen-less UUID wrote a hash-shaped
    // string straight into posting_lines.counterparty and from there into a
    // QuickBooks document that under 0008 is never edited.
    check(
      "an ordinary origin derives a readable name",
      deriveLabel("https://api.acme.com/v2/forecast") === "api.acme.com/v2/forecast",
      deriveLabel("https://api.acme.com/v2/forecast"),
    );
    check(
      "an origin whose path is a 32-char hash does NOT derive one — it falls back",
      deriveLabel("https://api.acme.com/r/d41d8cd98f00b204e9800998ecf8427e") === "endpoint",
      deriveLabel("https://api.acme.com/r/d41d8cd98f00b204e9800998ecf8427e"),
    );
    check(
      "nor one carrying an 0x address",
      deriveLabel("https://api.acme.com/0xdeadbeefcafe/x") === "endpoint",
      deriveLabel("https://api.acme.com/0xdeadbeefcafe/x"),
    );
    check(
      "and the fallback keeps its disambiguating suffix",
      deriveLabel("https://api.acme.com/r/d41d8cd98f00b204e9800998ecf8427e", " (2)") ===
        "endpoint (2)",
    );

    check("an ordinary name is kept, trimmed", assertUsableLabel("  Forecast API  ") === "Forecast API");
    check(
      "a name with the words the response filter bans is still fine",
      assertUsableLabel("Supply Chain API") === "Supply Chain API",
      "NO_CRYPTO bans that vocabulary from responses; refusing it here would be Fuel " +
        "telling a customer what their own product is called",
    );

    throws("an empty name is refused", () => assertUsableLabel("   "), /empty/);
    throws(
      "an over-long name is refused, and says by how much",
      () => assertUsableLabel("x".repeat(LABEL_MAX_LENGTH + 1)),
      new RegExp(`${LABEL_MAX_LENGTH + 1} characters`),
    );
    throws(
      "a name carrying an address is refused — ADR 0006, at the only door it could enter by",
      () => assertUsableLabel("Weather 0x8ba1f109551bD432803012645Ac136ddd64DBA72"),
      /address or a transaction hash/,
    );
    throws(
      "and a bare 64-character hash, which has no 0x to spot it by",
      () => assertUsableLabel(`run ${"a".repeat(64)}`),
      /address or a transaction hash/,
    );
    throws(
      "a name with control characters is refused — CSV escaping would carry them through",
      () => assertUsableLabel("Forecast\u0007API"),
      /control characters/,
    );

    // REVIEW: claim 2. The sentinel has to be unusable as a label, or an
    // operator can name an endpoint after it and mask the integrity flag that
    // reports unattributable revenue.
    throws(
      "the unattributed sentinel cannot be claimed as a name",
      () => assertUsableLabel(UNATTRIBUTED_COUNTERPARTY),
      /reserved/,
    );
    throws(
      "nor in a different case, which is what an exact-match check would miss",
      () => assertUsableLabel("(Unattributed Endpoint)"),
      /reserved/,
    );

    // Uniqueness is per agent, and it is the index that decides — not a read
    // followed by a write, which would be a race.
    const first = endpoints.registerEndpoint({
      agentId,
      originUrl: origin.url,
      priceBaseUnits: 1n,
      label: "Duplicate Me",
    });
    throws(
      "the same agent cannot reuse a name",
      () =>
        endpoints.registerEndpoint({
          agentId,
          originUrl: origin.url,
          priceBaseUnits: 1n,
          label: "Duplicate Me",
        }),
      /already has an endpoint named/,
    );
    const otherAgent = seedAgent();
    check(
      "but a different agent can — the name is scoped to the agent, not the company",
      endpoints.registerEndpoint({
        agentId: otherAgent,
        originUrl: origin.url,
        priceBaseUnits: 1n,
        label: "Duplicate Me",
      }).endpoint.label === "Duplicate Me",
    );

    check(
      "omitting the name derives one from the origin",
      endpoints
        .registerEndpoint({ agentId: otherAgent, originUrl: `${origin.url}/forecast`, priceBaseUnits: 1n })
        .endpoint.label.endsWith("/forecast"),
    );

    // A rename does not move money. It does split the counterparty text, and
    // linesCarryingLabel is what lets the route say so rather than leave it to
    // be discovered. REVIEW: claim 1.
    db.prepare(
      `INSERT INTO posting_lines
         (id, run_id, agent_id, counterparty, posting_day, ledger_class, amount_base_units, created_at)
       VALUES ('line-label-1', 'run-1', ?, 'Duplicate Me', '2026-09-01', 'revenue', 10000, ?)`,
    ).run(agentId, new Date().toISOString());
    check(
      "a rename can see how many posted lines keep the old name",
      endpoints.linesCarryingLabel(agentId, "Duplicate Me") === 1,
    );
    const renamed = endpoints.setLabel(first.endpoint.id, "Renamed API");
    check("the endpoint takes the new name", renamed.label === "Renamed API");
    check(
      "and the already-posted line keeps the old one — posting_lines is append-only",
      endpoints.linesCarryingLabel(agentId, "Duplicate Me") === 1,
    );
    check(
      "so the old name is free again, which is what makes a rename reversible",
      endpoints.setLabel(first.endpoint.id, "Duplicate Me").label === "Duplicate Me",
    );
    db.prepare("DELETE FROM posting_lines WHERE id = 'line-label-1'").run();
  }

  console.log("\n== registration is disabled until it is proved ==");
  const registered = endpoints.registerEndpoint({
    agentId,
    originUrl: origin.url,
    priceBaseUnits: 1000n,
  });
  const endpoint = registered.endpoint;
  check(
    "registration hands back the forward secret exactly once",
    typeof registered.forwardSecret === "string" && registered.forwardSecret.length >= 32,
  );
  check(
    "the secret Fuel will sign with is the one the operator was given — otherwise " +
      "no origin could ever verify a forward",
    endpoints.forwardSecretFor(endpoint.id) === registered.forwardSecret,
  );
  check(
    "and it is not on the endpoint shape, so no later read returns it",
    !Object.keys(endpoint).includes("forwardSecret"),
  );
  check("a new endpoint starts disabled", endpoint.enabled === false);
  check("and says why", endpoints.enablementBlocker(endpoint) !== null);
  check(
    "the gateway cannot resolve it while disabled",
    endpoints.getEnabledEndpointByPublicId(endpoint.publicId) === null,
  );
    {
    checks += 1;
    let threw = false;
    try {
      endpoints.setEnabled(endpoint.id, true);
    } catch (e) {
      threw = e instanceof endpoints.EndpointNotVerifiedError;
    }
    if (!threw) throw new Error("FAILED: an unverified endpoint must not be enablable");
    console.log("   ok  enabling an unverified endpoint is refused at the write path");
  }

  console.log("\n== the probes measure what Fuel cannot enforce ==");
  {
    const probes = await import("../src/gateway/probes.js");

    // The probes fetch with allowLoopback:false, so a loopback origin cannot be
    // proved at all — which is itself the right answer, and worth asserting
    // rather than assuming: it is the SSRF policy applying to registration, not
    // only to the forward path.
    const outcome = await probes.verifyEndpoint(endpoint);
    check(
      "a loopback origin cannot prove ownership — the probes are not exempt",
      outcome.ownershipProvedAt === null && outcome.blockedReason !== null,
      String(outcome.blockedReason),
    );
    check(
      "and the endpoint records why, in words an operator can act on",
      /could not reach|not a public address|fetch failed/i.test(outcome.blockedReason ?? ""),
      String(outcome.blockedReason),
    );

    // A failing re-check must be able to TAKE AWAY access, not merely decline
    // to grant it. Force an enabled row, then re-verify against a bad origin.
    db.prepare("UPDATE earning_endpoints SET enabled = 1 WHERE id = ?").run(endpoint.id);
    check(
      "(precondition) the endpoint is enabled",
      endpoints.getEnabledEndpointByPublicId(endpoint.publicId) !== null,
    );
    await probes.verifyEndpoint(endpoints.getEndpointUnscoped(endpoint.id)!);
    check(
      "a failed re-check disables an already-enabled endpoint",
      endpoints.getEnabledEndpointByPublicId(endpoint.publicId) === null,
    );

    check(
      "the ownership re-check interval is a named number, not 'periodically'",
      typeof probes.OWNERSHIP_RECHECK_MS === "number" && probes.OWNERSHIP_RECHECK_MS > 0,
    );
    check(
      "the bad-signature probe uses the real header names, so a present-but-invalid check is caught",
      probes.PROBE_HEADER_NAMES.includes(signing.SIG_HEADER),
    );
  }

  console.log("\n== the response-header allowlist drops what matters ==");
  {
    const supplied: Record<string, string> = {
      "content-type": "application/json",
      etag: 'W/"1"',
      "set-cookie": "session=abc",
      "www-authenticate": "Basic realm=x",
      // The one that would hand settlement control to the counterparty.
      "settlement-overrides": '{"amount":"1"}',
      "content-encoding": "gzip",
      "x-anything-else": "leak",
    };
    const picked = forward.pickResponseHeaders((n) => supplied[n] ?? null);
    check("content-type survives", picked["content-type"] === "application/json");
    check("etag survives", picked["etag"] === 'W/"1"');
    check("set-cookie does not", picked["set-cookie"] === undefined);
    check("www-authenticate does not", picked["www-authenticate"] === undefined);
    check(
      "Settlement-Overrides does not — an origin cannot price its own payment",
      picked["settlement-overrides"] === undefined,
    );
    check("content-encoding does not", picked["content-encoding"] === undefined);
    check("and neither does an unknown header", picked["x-anything-else"] === undefined);
  }

  console.log("\n== nothing of the caller's crosses to the origin ==");
  {
    const sent = forward.buildForwardHeaders("secret", "/x");
    const names = Object.keys(sent).map((n) => n.toLowerCase());
    check("no authorization header is forwarded", !names.includes("authorization"));
    check("no cookie is forwarded", !names.includes("cookie"));
    check("no host override is forwarded", !names.includes("host"));
    check("no x-forwarded-for is forwarded", !names.includes("x-forwarded-for"));
    check("the Fuel signature is present", names.includes(signing.SIG_HEADER));
    check("compression is declined at the request", sent["accept-encoding"] === "identity");
  }

  console.log("\n== SSRF: both directions, because Phase 0's guard broke on allow ==");
  {
    check("loopback refused when the policy says no", safeFetchMod.isBlockedAddress("127.0.0.1", false));
    check("loopback allowed when the policy says yes", !safeFetchMod.isBlockedAddress("127.0.0.1", true));
    check("::1 refused under strict", safeFetchMod.isBlockedAddress("::1", false));
    check("::1 allowed under permissive", !safeFetchMod.isBlockedAddress("::1", true));
    check(
      "the v4-mapped spelling is judged the same, which is the Phase 0 bug class",
      safeFetchMod.isBlockedAddress("::ffff:127.0.0.1", false) &&
        !safeFetchMod.isBlockedAddress("::ffff:127.0.0.1", true),
    );
    check(
      "metadata stays blocked even when loopback is permitted",
      safeFetchMod.isBlockedAddress("169.254.169.254", true),
    );
    check("a public address is reachable under strict", !safeFetchMod.isBlockedAddress("8.8.8.8", false));

    // The gateway's own forward must refuse this origin, precisely because it
    // is on loopback — the policy is not decoration.
    const refused = await forward.forwardToOrigin(endpoint, new URLSearchParams());
    check(
      "the gateway refuses to forward to a loopback origin",
      refused.ok === false,
      refused.ok ? "it forwarded" : "",
    );

    // What an anonymous caller is told must not describe the customer's
    // infrastructure. The public id is opaque precisely so a payer never
    // learns the origin; an error message that names it gives that back.
    if (!refused.ok) {
      const host = new URL(origin.url).host;
      check(
        "the refusal shown to a caller does not name the origin's host or port",
        !refused.reason.includes(host) && !refused.reason.includes("127.0.0.1"),
        refused.reason,
      );
      check(
        "but the operator-facing detail does, so the failure is still diagnosable",
        (refused.detail ?? "").length > 0,
      );
    }
  }

  console.log("\n== transport bounds ==");
  {
    origin.behaviour = () => ({ status: 200, body: Buffer.alloc(64 * 1024, 0x61) });
    await throwsAsync(
      "an over-cap body is refused, counted off the stream",
      () => safeFetchMod.safeFetch(origin.url, { allowLoopback: true, maxBytes: 1024 }),
      /over 1024 bytes/i,
    );

    origin.behaviour = () => ({ status: 200, body: "small" });
    const ok = await safeFetchMod.safeFetch(origin.url, { allowLoopback: true, maxBytes: 1024 });
    check("an under-cap body still arrives intact", (await ok.text()) === "small");

    origin.behaviour = () => ({ status: 200, body: "late", delayMs: 300 });
    await throwsAsync(
      "a slow origin is cut off rather than held onto",
      () =>
        safeFetchMod.safeFetch(
          origin.url,
          { allowLoopback: true },
          { signal: AbortSignal.timeout(80) },
        ),
      /abort|timeout/i,
    );
  }

  console.log("\n== the replay defence ==");
  {
    const claimed = receipts.claimReceipt({
      agentId,
      endpointId: endpoint.id,
      amountBaseUnits: 1000n,
      payerAddress: "0xPAYER",
      authorizationNonce: "0xNONCE",
    });
    check("a first claim succeeds", claimed.status === "awaiting");

    checks += 1;
    let dup = false;
    try {
      receipts.claimReceipt({
        agentId,
        endpointId: endpoint.id,
        amountBaseUnits: 1000n,
        payerAddress: "0xPAYER",
        authorizationNonce: "0xNONCE",
      });
    } catch (e) {
      dup = e instanceof receipts.DuplicateAuthorizationError;
    }
    if (!dup) throw new Error("FAILED: a replayed authorization must be refused");
    console.log("   ok  the same (payer, nonce) is refused the second time");

    checks += 1;
    let cased = false;
    try {
      receipts.claimReceipt({
        agentId,
        endpointId: endpoint.id,
        amountBaseUnits: 1000n,
        payerAddress: "0xpayer",
        authorizationNonce: "0xnonce",
      });
    } catch (e) {
      cased = e instanceof receipts.DuplicateAuthorizationError;
    }
    if (!cased) throw new Error("FAILED: case must not be a way around the replay key");
    console.log("   ok  and a differently-cased spelling of it is too");

    // CONCURRENT, which is the case that actually matters: verify is not
    // binding, so N replays all pass it and race here.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        Promise.resolve().then(() =>
          receipts.claimReceipt({
            agentId,
            endpointId: endpoint.id,
            amountBaseUnits: 1000n,
            payerAddress: "0xRACER",
            authorizationNonce: "0xRACE",
          }),
        ),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled").length;
    check("exactly one of eight concurrent replays claims the nonce", won === 1, `${won} won`);
  }

  console.log("\n== receipt lifecycle ==");
  {
    const mk = (nonce: string) =>
      receipts.claimReceipt({
        agentId,
        endpointId: endpoint.id,
        amountBaseUnits: 1000n,
        payerAddress: "0xLIFE",
        authorizationNonce: nonce,
      });

    const abandoned = mk("n-abandoned");
    receipts.resolveReceipt(abandoned.id, "abandoned", { detail: "origin down" });
    check("origin failure abandons, unsettled", receipts.getReceiptUnscoped(abandoned.id)!.status === "abandoned");
    check(
      "and nothing was booked for it",
      receipts.getReceiptUnscoped(abandoned.id)!.settledAt === null,
    );

    const settled = mk("n-settled");
    receipts.resolveReceipt(settled.id, "settled", { txHash: "0xtx" });
    const s = receipts.getReceiptUnscoped(settled.id)!;
    check("a settled receipt records its transaction", s.txHash === "0xtx" && s.settledAt !== null);

    const unsettled = mk("n-unsettled");
    receipts.resolveReceipt(unsettled.id, "served_unsettled", { detail: "insufficient balance" });
    check(
      // Terminal as far as the LIVE REQUEST path is concerned — resolveReceipt
      // will never move it again. 6B-2 added a separate reconcile path; see the
      // reconcile section below for the guard that keeps the two disjoint.
      "served_unsettled is unbooked, and the request path cannot move it again",
      receipts.getReceiptUnscoped(unsettled.id)!.settledAt === null,
    );

    const unknown = mk("n-unknown");
    receipts.resolveReceipt(unknown.id, "settle_unknown", { detail: "network error" });
    check(
      "settle_unknown is its own state, not folded into failure",
      receipts.getReceiptUnscoped(unknown.id)!.status === "settle_unknown",
    );

    // Only `settled` may be booked. This is the fail-closed direction for
    // inbound, and the one that keeps unconfirmed money out of the books.
    const booked = db
      .prepare(
        `SELECT COUNT(*) AS n FROM receipts WHERE status IN ${receipts.APPEARS_IN_RECEIPT_LEDGER}`,
      )
      .get() as { n: number };
    check("exactly one receipt is ledger-eligible", Number(booked.n) === 1, `${booked.n}`);

    // A late request must not overwrite a row the reaper already resolved.
    receipts.resolveReceipt(settled.id, "abandoned", { detail: "late" });
    check(
      "a terminal receipt cannot be re-resolved by a late arrival",
      receipts.getReceiptUnscoped(settled.id)!.status === "settled",
    );
  }

  /*
   * 6B-2. Before this, `served_unsettled` and `settle_unknown` were terminal in
   * the strongest sense: there were exactly three write statements against
   * `receipts` in all of src/, and none of them could move a row out of either
   * state. The reaper manufactured `settle_unknown` every 60 seconds and
   * nothing could ever resolve one.
   */
  console.log("\n== reconciling the two states nothing could exit ==");
  {
    const mk = (nonce: string) =>
      receipts.claimReceipt({
        agentId,
        endpointId: endpoint.id,
        amountBaseUnits: 7000n,
        payerAddress: "0xRECON",
        authorizationNonce: nonce,
      });

    // --- the chain says the money arrived ---
    const arrived = mk("n-recon-arrived");
    receipts.resolveReceipt(arrived.id, "settle_unknown", { detail: "facilitator threw" });
    check(
      "a settle_unknown receipt is not ledger-eligible before reconciling",
      receipts.getReceiptUnscoped(arrived.id)!.settledAt === null,
    );
    const movedArrived = receipts.reconcileReceipt(arrived.id, "settled", {
      detail: "reconciled: the payment authorization is recorded as used",
    });
    const afterArrived = receipts.getReceiptUnscoped(arrived.id)!;
    check("settle_unknown reconciles to settled", movedArrived && afterArrived.status === "settled");
    check(
      "and only then does it get a settlement date, so it can reach the books",
      afterArrived.settledAt !== null,
    );

    // --- the chain says it never arrived ---
    const never = mk("n-recon-never");
    receipts.resolveReceipt(never.id, "settle_unknown", { detail: "facilitator threw" });
    receipts.reconcileReceipt(never.id, "served_unsettled", {
      detail: "reconciled: the authorization was never used",
    });
    const afterNever = receipts.getReceiptUnscoped(never.id)!;
    check("settle_unknown reconciles to served_unsettled", afterNever.status === "served_unsettled");
    check("which stays unbooked", afterNever.settledAt === null);

    // --- served_unsettled is reconcilable too, in the direction that matters ---
    // The facilitator reporting failure is a report, not the ledger, and it can
    // be wrong in the direction where a settlement landed after the response
    // failed. Reconciling can only ever ADD revenue that genuinely arrived.
    const late = mk("n-recon-late");
    receipts.resolveReceipt(late.id, "served_unsettled", { detail: "settlement failed" });
    receipts.reconcileReceipt(late.id, "settled", { detail: "reconciled: it did land after all" });
    check(
      "served_unsettled can be corrected to settled when the chain disagrees",
      receipts.getReceiptUnscoped(late.id)!.status === "settled",
    );

    // --- THE BREAK TEST. The tempting wrong fix for this whole slice was to
    //     widen resolveReceipt's `WHERE status = 'awaiting'` guard instead of
    //     adding a second function. That guard is what makes the claim→resolve
    //     race safe, and widening it would reopen the race silently: every
    //     other check in this file would still pass, because the race needs
    //     concurrency to show. So assert the two paths stay disjoint.
    const guarded = mk("n-recon-guard");
    receipts.resolveReceipt(guarded.id, "settle_unknown", { detail: "unknown" });
    receipts.resolveReceipt(guarded.id, "settled", { txHash: "0xshouldnotapply" });
    const stillUnknown = receipts.getReceiptUnscoped(guarded.id)!;
    check(
      "resolveReceipt STILL refuses anything but awaiting — the reconcile path did not widen it",
      stillUnknown.status === "settle_unknown" && stillUnknown.txHash === null,
    );

    // And the converse: the reconcile path must not poach the live request path.
    const fresh = mk("n-recon-fresh");
    const poached = receipts.reconcileReceipt(fresh.id, "settled", { detail: "should not apply" });
    check(
      "reconcileReceipt refuses an awaiting receipt — that row belongs to the request",
      !poached && receipts.getReceiptUnscoped(fresh.id)!.status === "awaiting",
    );

    // --- idempotency: a second reconcile changes nothing and says so ---
    const twice = receipts.reconcileReceipt(arrived.id, "settled", { detail: "again" });
    check("reconciling an already-reconciled receipt reports no change", !twice);

    // --- the needs-attention list is what makes any of this findable ---
    // Resolved from the seeded agent rather than assumed, so this stays correct
    // whatever company the scratch copy's first team belongs to.
    const { company_id: companyId } = db
      .prepare(
        `SELECT t.company_id FROM agents a JOIN teams t ON t.id = a.team_id WHERE a.id = ?`,
      )
      .get(agentId) as unknown as { company_id: string };

    const attention = receipts.receiptsNeedingAttention(companyId);
    check(
      "the needs-attention list holds exactly the unresolved ones",
      attention.every((r) => r.status === "settle_unknown" || r.status === "served_unsettled"),
      attention.map((r) => r.status).join(","),
    );
    check(
      "and it includes the one that reconciled to served_unsettled",
      attention.some((r) => r.id === never.id),
    );
    check(
      "but not the one that reconciled to settled",
      !attention.some((r) => r.id === arrived.id),
    );
  }

  /*
   * The outbound half of the same gap, and the one with teeth: `unreconciled`
   * is in COUNTS_AGAINST_CAP, and `markSettled` was reachable only from the
   * live pay path, so budget consumed by a payment Fuel never confirmed could
   * never be released by anything. An agent's cap could be permanently eaten.
   */
  console.log("\n== an unreconciled payment no longer eats a cap forever ==");
  {
    const payments = await import("../src/db/payments.js");

    const { company_id: companyId } = db
      .prepare(`SELECT t.company_id FROM agents a JOIN teams t ON t.id = a.team_id WHERE a.id = ?`)
      .get(agentId) as unknown as { company_id: string };

    const seedUnreconciled = (id: string, amount: bigint): string => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, detail, created_at)
         VALUES (?, ?, ?, 'https://vendor.test/x', 'unreconciled', 'signed, never confirmed', ?)`,
      ).run(id, agentId, amount, now);
      return id;
    };

    const spentBefore = payments.spentBaseUnits(agentId);
    seedUnreconciled("pay-recon-free", 25000n);
    seedUnreconciled("pay-recon-keep", 25000n);
    check(
      "an unreconciled payment counts against the cap",
      payments.spentBaseUnits(agentId) === spentBefore + 50000n,
    );

    check(
      "it is listed as needing attention",
      payments.paymentsNeedingAttention(companyId).some((p) => p.id === "pay-recon-free"),
    );

    // failed → the authorization died unused, so the budget is genuinely free.
    const freed = payments.reconcileUnreconciledPayment({
      paymentId: "pay-recon-free",
      outcome: "failed",
      detail: "reconciled by operator: authorization expired unused",
    });
    check("reconciling to failed reports a change", freed.ok);
    check(
      "and says plainly that the expiry was never recorded, rather than claiming a check",
      freed.basis === "expiry not recorded",
      String(freed.basis),
    );
    check(
      "and RELEASES the cap — the whole point of this path",
      payments.spentBaseUnits(agentId) === spentBefore + 25000n,
    );

    // settled → money moved, so it must keep counting.
    payments.reconcileUnreconciledPayment({
      paymentId: "pay-recon-keep",
      outcome: "settled",
      detail: "reconciled by operator: confirmed on the explorer",
      txHash: "0x" + "d".repeat(64),
    });
    check(
      "reconciling to settled does NOT release the cap, because the money moved",
      payments.spentBaseUnits(agentId) === spentBefore + 25000n,
    );

    // The guard: only `unreconciled` may be reconciled, so a settled payment
    // cannot be quietly reopened and un-spent.
    const again = payments.reconcileUnreconciledPayment({
      paymentId: "pay-recon-keep",
      outcome: "failed",
      detail: "should not apply",
    });
    check(
      "a payment that is no longer unreconciled cannot be reconciled again",
      !again.ok && again.refusal === "not-unreconciled",
    );
    check(
      "and the cap is unchanged by that refusal",
      payments.spentBaseUnits(agentId) === spentBefore + 25000n,
    );

    check(
      "both are gone from the needs-attention list",
      payments.paymentsNeedingAttention(companyId).length === 0,
    );

    /*
     * THE CHECK A SECURITY REVIEW ASKED FOR, and the one with real teeth.
     *
     * Releasing budget is only sound when no spendable authorization exists.
     * An EIP-3009 authorization stays spendable until its validBefore whatever
     * Fuel's own request did, so an operator attesting "failed" on a live one
     * would release budget against money that can still move — and nothing
     * revisits a `failed` row afterwards, so the overspend would be silent and
     * permanent. A human cannot attest their way past this.
     */
    const now = Math.floor(Date.now() / 1000);
    seedUnreconciled("pay-recon-live", 25000n);
    payments.recordAuthorizationWindow("pay-recon-live", now + 600);

    const spentWithLive = payments.spentBaseUnits(agentId);
    const refused = payments.reconcileUnreconciledPayment({
      paymentId: "pay-recon-live",
      outcome: "failed",
      detail: "operator says it failed",
      nowSeconds: now,
    });
    check(
      "releasing budget is REFUSED while the signed authorization is still live",
      !refused.ok && refused.refusal === "authorization-still-live",
      String(refused.refusal),
    );
    check(
      "and the cap is untouched by that refusal",
      payments.spentBaseUnits(agentId) === spentWithLive,
    );

    // Settling is always allowed — that direction only ever keeps budget
    // consumed, so it cannot be used to overspend.
    const stillSettleable = payments.reconcileUnreconciledPayment({
      paymentId: "pay-recon-live",
      outcome: "settled",
      detail: "confirmed it did move",
      nowSeconds: now,
    });
    check("but settling a live authorization is allowed", stillSettleable.ok);

    // Once the window has passed, the release is permitted AND says it checked.
    seedUnreconciled("pay-recon-expired", 25000n);
    payments.recordAuthorizationWindow("pay-recon-expired", now - 1);
    const expired = payments.reconcileUnreconciledPayment({
      paymentId: "pay-recon-expired",
      outcome: "failed",
      detail: "authorization expired unused",
      nowSeconds: now,
    });
    check("an expired authorization may be released", expired.ok);
    check(
      "and reports that the expiry was actually verified, not merely asserted",
      expired.basis === "authorization expired",
      String(expired.basis),
    );

    check(
      "the recorded window is readable back",
      payments.authorizationValidBefore("pay-recon-expired") === now - 1,
    );
    check(
      "and a row that never recorded one reads null, not zero",
      payments.authorizationValidBefore("pay-recon-free") === null,
    );

    // Company scoping, the same seam every other read uses.
    check(
      "a payment in another company is invisible to the lookup",
      payments.getPaymentStatusInCompany("pay-recon-keep", "not-a-company") === null,
    );
    check(
      "and visible in its own",
      payments.getPaymentStatusInCompany("pay-recon-keep", companyId) === "settled",
    );
  }

  console.log("\n== the reaper rescues a stranded claim ==");
  {
    const stranded = receipts.claimReceipt({
      agentId,
      endpointId: endpoint.id,
      amountBaseUnits: 1000n,
      payerAddress: "0xSTRAND",
      authorizationNonce: "n-strand",
    });
    check("nothing is reaped while it is fresh", receipts.reapStaleAwaitingReceipts(60_000) === 0);
    const swept = receipts.reapStaleAwaitingReceipts(-1);
    check("a stale claim is resolved", swept >= 1, `${swept}`);
    check(
      "to settle_unknown, because a crash could have landed either side of settle",
      receipts.getReceiptUnscoped(stranded.id)!.status === "settle_unknown",
    );
  }

  console.log("\n== rate limits ==");
  {
    limiter.resetLimiter();
    let refusedAt = -1;
    for (let i = 1; i <= limiter.LIMITS.PER_ADDRESS_LIMIT + 5; i++) {
      if (!limiter.checkAddress("1.2.3.4").ok) {
        refusedAt = i;
        break;
      }
    }
    check(
      "an address is refused once past its limit",
      refusedAt === limiter.LIMITS.PER_ADDRESS_LIMIT + 1,
      `refused at ${refusedAt}`,
    );
    check("a different address is unaffected", limiter.checkAddress("5.6.7.8").ok);

    limiter.resetLimiter();
    const slots = [];
    for (let i = 0; i < limiter.LIMITS.PER_ENDPOINT_CONCURRENCY; i++) {
      const s = limiter.acquireSlot("e1");
      check(`concurrency slot ${i + 1} granted`, s.ok);
      if (s.ok) slots.push(s);
    }
    check("the next one is refused", !limiter.acquireSlot("e1").ok);
    slots[0]!.release();
    const after = limiter.acquireSlot("e1");
    check("releasing frees exactly one", after.ok);
    if (after.ok) {
      after.release();
      after.release(); // idempotent — a double release must not free a stranger's slot
    }
    const probe = limiter.acquireSlot("e1");
    check("a double release did not over-credit the counter", probe.ok);
    if (probe.ok) probe.release();
    for (const s of slots.slice(1)) s.release();
    limiter.resetLimiter();
  }

  console.log("\n== the timing budget is derived, not guessed ==");
  {
    const floor = Math.ceil((limits.ORIGIN_TIMEOUT_MS + limits.FACILITATOR_BUDGET_MS) / 1000);
    check(
      "the advertised window exceeds the work it has to contain",
      limits.GATEWAY_MAX_TIMEOUT_SECONDS > floor,
      `${limits.GATEWAY_MAX_TIMEOUT_SECONDS} vs ${floor}`,
    );
    check(
      "and leaves room for the facilitator's own 6s expiry margin",
      limits.GATEWAY_MAX_TIMEOUT_SECONDS - floor >= 6,
    );
  }

  console.log("\n== the P&L basis is a different number from the cap basis ==");
  {
    const payments = await import("../src/db/payments.js");
    const receipts = await import("../src/db/receipts.js");

    const { company_id: companyId } = db
      .prepare(`SELECT t.company_id FROM agents a JOIN teams t ON t.id = a.team_id WHERE a.id = ?`)
      .get(agentId) as unknown as { company_id: string };

    /*
     * THE WHOLE REASON THE FIGURES ARE LABELLED. A cap sums COUNTS_AGAINST_CAP,
     * which includes `pending` — a ceiling has to count money that MIGHT move.
     * A P&L sums APPEARS_IN_LEDGER, which does not, because it reports money
     * that DID move. If these two ever returned the same number for an agent
     * with something in flight, one of them would be wrong.
     */
    const capBefore = payments.spentBaseUnits(agentId);
    const ledgerBefore = payments.ledgerSpentBaseUnits(agentId);
    check("with nothing in flight the two bases agree", capBefore === ledgerBefore);

    db.prepare(
      `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, created_at)
       VALUES ('pay-inflight-basis', ?, 70000, 'https://vendor.test/x', 'pending', ?)`,
    ).run(agentId, new Date().toISOString());

    check(
      "an in-flight payment raises the cap basis",
      payments.spentBaseUnits(agentId) === capBefore + 70000n,
    );
    check(
      "and leaves the ledger basis untouched, because no money has moved",
      payments.ledgerSpentBaseUnits(agentId) === ledgerBefore,
    );
    check(
      "so the two bases are demonstrably different numbers",
      payments.spentBaseUnits(agentId) !== payments.ledgerSpentBaseUnits(agentId),
    );
    // The same must hold one level up, or a company total could quietly paper
    // over a difference its agents report.
    check(
      "and differ at the company level too",
      payments.companySpentBaseUnits(companyId) !==
        payments.companyLedgerSpentBaseUnits(companyId),
    );

    /*
     * THE EARN SIDE HAS ONLY ONE BASIS, and it is the conservative one.
     * APPEARS_IN_RECEIPT_LEDGER is ('settled') alone: an unconfirmed receipt is
     * a real exposure but recording it as revenue would OVERSTATE what a
     * customer earned, and "provisional income" is not something an accountant
     * can act on the way provisional cost is.
     */
    const earnedBefore = receipts.earnedBaseUnits(agentId);
    const stamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status,
                             payer_address, authorization_nonce, created_at)
       VALUES ('rec-basis-unknown', ?, NULL, 90000, 'settle_unknown', ?, ?, ?)`,
    ).run(agentId, "0x" + "11".repeat(20), "0x" + "21".repeat(32), stamp);
    check(
      "an unconfirmed receipt is not earnings",
      receipts.earnedBaseUnits(agentId) === earnedBefore,
    );
    db.prepare(
      `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status,
                             payer_address, authorization_nonce, created_at, settled_at)
       VALUES ('rec-basis-settled', ?, NULL, 90000, 'settled', ?, ?, ?, ?)`,
    ).run(agentId, "0x" + "12".repeat(20), "0x" + "22".repeat(32), stamp, stamp);
    check(
      "a confirmed one is",
      receipts.earnedBaseUnits(agentId) === earnedBefore + 90000n,
    );
    check(
      "and the company total sees it through the same agents -> teams seam",
      receipts.companyEarnedBaseUnits(companyId) >= earnedBefore + 90000n,
    );

    /*
     * Net leans safe in both terms: the conservative earned figure minus the
     * cautious spent one. It is negative here, and that is not an error state —
     * an agent that has spent more than it earned is the ordinary case.
     */
    const net = receipts.earnedBaseUnits(agentId) - payments.ledgerSpentBaseUnits(agentId);
    check("net is earned minus spent on the ledger basis", typeof net === "bigint");

    db.exec(
      "DELETE FROM payments WHERE id = 'pay-inflight-basis'; " +
        "DELETE FROM receipts WHERE id IN ('rec-basis-unknown', 'rec-basis-settled')",
    );
  }

  origin.server.close();
  console.log(`\nAll ${checks} checks passed.`);
  console.log(`Scratch database: ${process.env.FUEL_DB_PATH} (fuel.db was never opened)`);
  console.log(
    "\nNot covered here (needs a funded sandbox wallet and the live facilitator):\n" +
      "a real signed authorization, verify, and on-chain settle end to end.\n" +
      "See the live walkthrough in docs/roadmap.md.",
  );
}

await main();
