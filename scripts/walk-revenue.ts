/**
 * The live revenue walkthrough: a real payer pays a real origin through Fuel's
 * gateway, and the money that arrives becomes a real JournalEntry in Intuit's
 * sandbox company.
 *
 * WHY THIS EXISTS. Slice 6B-1 built the whole earning side and proved it
 * offline — `verify-quickbooks.ts`'s `verifyDirection()` shows spend and
 * revenue cannot contaminate each other, `verify-earning.ts` covers the
 * gateway's guards — but the roadmap says plainly that Intuit had never seen a
 * revenue document from Fuel, and no receipt had ever been created by a real
 * payer. Everything below that line was reasoning about code rather than
 * evidence about behaviour. This script is the evidence.
 *
 * HOW IT DIFFERS FROM walk-accounting.ts. That one deliberately never presses
 * Post, because posting leaves a document in someone's books and a routine
 * verification run should not. Here, posting for real IS the deliverable, so
 * this runs against the REAL fuel.db and the REAL server — not a scratch copy.
 * That is required, not convenient: the OAuth tokens live in fuel.db, Intuit
 * rotates the refresh token on use, and a rotation written to a throwaway copy
 * would destroy the live connection.
 *
 * WHAT IS AND IS NOT AT RISK. Base Sepolia is a testnet and the USDC on it is
 * worthless. The Intuit company is the sandbox one, pinned by origin equality
 * in `assertSandboxUrl` — no environment variable selects production. What IS
 * real: a document appears in the sandbox books, and a tunnel briefly exposes
 * the toy origin to the public internet.
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────
 *
 * Do these in order. The order is the point: the balance check comes before
 * any exposure, so a wallet that cannot pay is discovered before a tunnel is
 * ever opened.
 *
 *   1. npm run check-payer-balance
 *      Confirm non-zero USDC. If zero, top up at https://faucet.circle.com
 *      (Base Sepolia) and re-check. Do not continue until this passes.
 *
 *   2. npm run dev                       # the real server, real fuel.db
 *
 *   3. Start a tunnel to port 8899 and note the public https URL:
 *        ngrok http 8899           (or: cloudflared tunnel --url http://localhost:8899)
 *
 *   4. npx tsx scripts/walk-revenue.ts register https://<tunnel-host>/revenue-demo
 *      Prints the endpoint id and the two secrets the origin needs.
 *
 *   5. Start the origin with the command step 4 printed.
 *
 *   6. npx tsx scripts/walk-revenue.ts run <endpointId>
 *
 *   7. STOP THE TUNNEL the moment step 6 prints its QuickBooks id. The
 *      remaining checks talk only to Fuel and Intuit; the origin is done.
 *
 *   8. Open the Intuit sandbox company and look at the document with your own
 *      eyes. This script exiting 0 proves its assertions held. It does not
 *      prove a correct document exists in someone's books — only looking does.
 *
 * IF STEP 6 FAILS AFTER THE PAYMENT ALREADY SETTLED (the QuickBooks half
 * threw — a dead OAuth token, a missing account, anything past "== a real
 * payment =="), do NOT run `run` again — it would sign and spend a second
 * real payment. Fix the underlying problem, then:
 *
 *   npx tsx scripts/walk-revenue.ts resume <endpointId>
 *
 * which re-reads the receipt `run` already wrote and continues from the
 * rollup onward, paying nothing.
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, formatUnits, http as viemHttp } from "viem";
import { baseSepolia } from "viem/chains";
import { describe, requireEnv } from "../src/lib/env.js";

const API = process.env.FUEL_API_URL ?? "http://127.0.0.1:3000";
const DB_PATH = process.env.FUEL_DB_PATH ?? "fuel.db";

/** The same rail everything else in this project is pinned to. */
const ALLOWED_NETWORK = "eip155:84532";
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/**
 * What this endpoint charges, and the payer's ceiling for it.
 *
 * Five cents rather than the one cent Phase 0 used, for an accounting reason
 * rather than a payments one: a revenue line under a whole cent is carried as
 * a residual and never reaches a document, so a sub-cent price would produce a
 * walkthrough that succeeds at every step and posts nothing. The payer's
 * ceiling is stated separately and equal to it — in x402 the server names the
 * price, so the payer is the only party with an interest in bounding it.
 */
const PRICE_USD = "0.05";
const MAX_AMOUNT_BASE_UNITS = 50_000n;

let checks = 0;
let failures = 0;

function ok(condition: boolean, description: string): void {
  checks += 1;
  console.log(`   ${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) {
    failures += 1;
    process.exitCode = 1;
  }
}

/** Stops the run. Used where continuing would post nonsense or mislead. */
function fatal(message: string): never {
  console.error(`\nSTOPPED: ${message}`);
  process.exit(1);
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireEnv("FUEL_API_KEY")}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: `unparseable response: ${text.slice(0, 200)}` };
  }
  return { status: response.status, json };
}

/** Reads the live database without opening a write handle or running migrations. */
function readDb<T>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as unknown as T[];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

async function register(originUrl: string): Promise<void> {
  console.log("\n== registering an earning endpoint ==");

  let parsed: URL;
  try {
    parsed = new URL(originUrl);
  } catch {
    fatal(`"${originUrl}" is not a URL. Pass the full public origin, e.g. https://x.ngrok.app/revenue-demo`);
  }
  if (parsed.protocol !== "https:") {
    // Not enforced by the API (http is allowed), but a tunnel gives https and
    // signing secrets should not cross the public internet in clear.
    fatal("use the https tunnel URL, not http");
  }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    fatal(
      "the origin cannot be loopback. Fuel's probes and forwarder both call safeFetch " +
        "with allowLoopback:false, so a local origin is refused by design — that is what " +
        "the tunnel is for.",
    );
  }

  const agents = await call("GET", "/api/agents");
  if (agents.status !== 200 || !Array.isArray(agents.json) || agents.json.length === 0) {
    fatal(`could not list agents (HTTP ${agents.status}). Is the server running on ${API}?`);
  }
  const agent = agents.json[0];
  console.log(`   agent: ${agent.name} (${agent.id})`);

  const created = await call("POST", "/api/earning-endpoints", {
    agentId: agent.id,
    originUrl: parsed.href,
    priceUsd: PRICE_USD,
    label: `Revenue walkthrough ${new Date().toISOString().slice(0, 10)}`,
  });
  if (created.status !== 201) {
    fatal(`registration failed (HTTP ${created.status}): ${JSON.stringify(created.json)}`);
  }

  const e = created.json;
  console.log(`\n   endpoint id: ${e.id}`);
  console.log(`   gateway url: ${e.url}`);
  console.log(`   price:       $${e.priceUsd}`);
  console.log(`   label:       ${e.label}`);

  console.log("\n== now start the origin, in another terminal ==\n");
  console.log(`FUEL_ORIGIN_NONCE='${e.ownership.expectedBody}' \\`);
  console.log(`FUEL_ORIGIN_SECRET='${e.forwardSecret}' \\`);
  console.log(`npx tsx scripts/live-origin-server.ts`);
  console.log(`\n   then:  npx tsx scripts/walk-revenue.ts run ${e.id}`);
  console.log(
    "\n   The forward secret is shown ONCE and is not readable again — if you lose it,\n" +
      "   re-register rather than trying to recover it.",
  );
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function payGateway(gatewayPath: string): Promise<void> {
  const account = privateKeyToAccount(requireEnv("TEST_PAYER_PRIVATE_KEY") as `0x${string}`);

  // Balance first, so an unfunded wallet is a clear message rather than an
  // opaque rejection from the facilitator three steps later.
  const publicClient = createPublicClient({ chain: baseSepolia, transport: viemHttp() });
  const usdc = await publicClient.readContract({
    address: USDC_BASE_SEPOLIA,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`   payer ${account.address} holds ${formatUnits(usdc, 6)} USDC`);
  if (usdc < MAX_AMOUNT_BASE_UNITS) {
    fatal(
      `the payer holds less than the $${PRICE_USD} price. Top up at ` +
        "https://faucet.circle.com (Base Sepolia) and run this again.",
    );
  }

  const client = new x402Client();
  // Registered before the scheme and as a policy, for the reason
  // pay-test-endpoint.ts gives: registerExactEvmScheme registers v1 schemes for
  // every EVM chain it knows, mainnet included, and `networks` does not
  // suppress that. A policy is the only filter that closes the mainnet path.
  client.registerPolicy((_version, requirements) =>
    requirements.filter(
      (r) => r.network === ALLOWED_NETWORK && BigInt(r.amount) <= MAX_AMOUNT_BASE_UNITS,
    ),
  );
  registerExactEvmScheme(client, { signer: account, networks: [ALLOWED_NETWORK] });
  const httpClient = new x402HTTPClient(client);

  const url = `${API}${gatewayPath}`;

  // 1. Unpaid. The gateway must quote a price rather than serve anything.
  const unpaid = await fetch(url, { headers: { Accept: "application/json" } });
  ok(unpaid.status === 402, `an unpaid request is refused 402 (got ${unpaid.status})`);
  if (unpaid.status !== 402) {
    fatal("the gateway did not quote a price; nothing below would mean anything");
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => unpaid.headers.get(name),
    await unpaid.clone().json().catch(() => undefined),
  );
  const terms = paymentRequired.accepts.find(
    (r) => r.network === ALLOWED_NETWORK && BigInt(r.amount) <= MAX_AMOUNT_BASE_UNITS,
  );
  if (!terms) {
    fatal(
      `no acceptable terms. Wanted <=${MAX_AMOUNT_BASE_UNITS} on ${ALLOWED_NETWORK}; offered: ` +
        paymentRequired.accepts.map((r) => `${r.amount} on ${r.network}`).join("; "),
    );
  }
  ok(
    BigInt(terms.amount) === MAX_AMOUNT_BASE_UNITS,
    `the quoted price is the registered one ($${PRICE_USD})`,
  );

  // 2. Sign an EIP-3009 authorization for exactly those terms, and retry.
  const payload = await httpClient.createPaymentPayload(paymentRequired);
  const paid = await fetch(url, {
    headers: { Accept: "application/json", ...httpClient.encodePaymentSignatureHeader(payload) },
  });

  if (!paid.ok) {
    const retryHeader = paid.headers.get("PAYMENT-REQUIRED");
    let reason = "(no PAYMENT-REQUIRED header)";
    if (retryHeader) {
      const decoded = Buffer.from(retryHeader, "base64").toString();
      try {
        reason = String(JSON.parse(decoded).error ?? "(no error field)");
      } catch {
        reason = `(unparseable header: ${decoded.slice(0, 120)})`;
      }
    }
    fatal(`the paid request failed (HTTP ${paid.status}): ${reason} :: ${await paid.text()}`);
  }

  const body = (await paid.json().catch(() => null)) as { resource?: string } | null;
  ok(paid.status === 200, `the paid request is served 200 (got ${paid.status})`);
  ok(
    body?.resource === "revenue-demo",
    "and the body is the ORIGIN's, relayed by Fuel — not something Fuel invented",
  );
  ok(
    paid.headers.get("PAYMENT-RESPONSE") !== null,
    "a settlement response header came back with it",
  );
}

/**
 * Everything up to and including a settled receipt. Split out from the
 * QuickBooks half below for exactly one reason: this is the part that cannot
 * be safely re-run. A crash or a fixable failure (a dead OAuth token, an
 * account not yet created — both real things that happened during this
 * script's own first live runs) must never be "fixed" by paying again. `run`
 * calls this once; `resume` skips it entirely and re-reads the receipt this
 * already wrote.
 */
async function payAndSettle(endpointId: string): Promise<{ endpoint: any }> {
  // --- the endpoint, and the probes against a real origin ------------------
  console.log("\n== the origin proves itself, over the real network ==");

  const list = await call("GET", "/api/earning-endpoints");
  if (list.status !== 200) fatal(`could not list endpoints (HTTP ${list.status})`);
  const endpoint = (list.json as any[]).find((e) => e.id === endpointId);
  if (!endpoint) fatal(`no endpoint ${endpointId}. Run the register step first.`);
  console.log(`   ${endpoint.label} -> ${endpoint.originUrl}`);

  const verified = await call("POST", `/api/earning-endpoints/${endpointId}/verify`);
  if (verified.status !== 200) {
    fatal(
      `verification failed (HTTP ${verified.status}): ${JSON.stringify(verified.json)}\n` +
        "Is the origin server running, and is the tunnel pointing at it?",
    );
  }
  const v = verified.json;
  ok(v.ownership?.provedAt !== null, "the origin echoed the ownership nonce Fuel issued");
  ok(
    v.probes?.refusesUnsignedAt !== null,
    "it refused a request carrying NO Fuel signature (the paywall is not bypassable)",
  );
  ok(
    v.probes?.refusesInvalidSignatureAt !== null,
    "and refused one whose signature was present but WRONG — the half a careless origin misses",
  );
  ok(v.blocker === null, `nothing blocks enablement${v.blocker ? `: ${v.blocker}` : ""}`);
  if (v.blocker) fatal("the endpoint cannot be enabled, so no payment can reach it");

  const enabled = await call("PATCH", `/api/earning-endpoints/${endpointId}`, { enabled: true });
  ok(enabled.status === 200 && enabled.json?.enabled === true, "the endpoint is enabled");
  if (enabled.status !== 200) fatal(JSON.stringify(enabled.json));

  // --- a real payer pays it ------------------------------------------------
  console.log("\n== a real payment, on Base Sepolia ==");
  await payGateway(endpoint.url);

  return { endpoint };
}

/**
 * Reads the settled receipt this endpoint's most recent payment produced,
 * without paying anything. Used by both `run` (right after paying) and
 * `resume` (instead of paying), so the assertions and the day computation
 * exist exactly once.
 */
function latestSettledReceipt(endpointId: string): { id: string; day: string } {
  console.log("\n== the receipt ==");
  const receipts = readDb<{
    id: string;
    status: string;
    tx_hash: string | null;
    amount_base_units: number | bigint;
    settled_at: string | null;
  }>(
    `SELECT id, status, tx_hash, amount_base_units, settled_at
       FROM receipts WHERE endpoint_id = ? ORDER BY created_at DESC`,
    endpointId,
  );
  ok(receipts.length > 0, "a receipt exists");
  if (receipts.length === 0) fatal("no receipt was written — the gateway did not record the money");
  const receipt = receipts[0]!;
  console.log(`   ${receipt.id}  ${receipt.status}  ${receipt.tx_hash ?? "(no hash)"}`);
  ok(receipt.status === "settled", `it is settled (is "${receipt.status}")`);
  ok(
    typeof receipt.tx_hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(receipt.tx_hash),
    "carrying a real transaction hash, not a placeholder",
  );
  ok(
    BigInt(receipt.amount_base_units) === MAX_AMOUNT_BASE_UNITS,
    "for the amount the endpoint charges",
  );
  if (receipt.status !== "settled") {
    fatal("the receipt did not settle, so there is no revenue to post");
  }

  const day = (receipt.settled_at ?? new Date().toISOString()).slice(0, 10);
  console.log(`   settled on ${day} — the day the revenue lands on`);
  return { id: receipt.id, day };
}

/**
 * Rollup through the reversal. Safe to call more than once: the rollup is
 * idempotent (it only ever processes what is not yet rolled up), and every
 * QuickBooks step past it either fails closed on a real problem (exactly what
 * happened the first time this ran — a dead OAuth token) or asserts its own
 * idempotency outright (the block below titled "idempotency"). Nothing here
 * signs a payment or spends the payer's money a second time.
 */
async function postToQuickBooks(day: string): Promise<void> {
  // --- the rollup ----------------------------------------------------------
  console.log("\n== the rollup turns it into a posting line ==");
  const posting = await call("POST", "/api/postings/run");
  ok(posting.status === 200, `the rollup ran (HTTP ${posting.status})`);
  console.log(`   ${posting.json?.linesCreated} line(s), $${posting.json?.posted} posted`);

  // --- accounts ------------------------------------------------------------
  console.log("\n== the revenue account in QuickBooks ==");
  const accounts = await call("POST", "/api/integrations/quickbooks/setup-accounts");
  if (accounts.status !== 200) {
    fatal(`account setup failed (HTTP ${accounts.status}): ${JSON.stringify(accounts.json)}`);
  }
  console.log(`   company:  ${accounts.json.quickBooksCompany}`);
  console.log(`   currency: ${accounts.json.homeCurrency} (${accounts.json.currencySource})`);
  console.log(`   created:  ${JSON.stringify(accounts.json.created)}`);
  console.log(`   reused:   ${JSON.stringify(accounts.json.reused)}`);
  ok(
    accounts.json.homeCurrency === "USD",
    "the books are USD, read from Preferences rather than assumed",
  );
  ok(
    [...(accounts.json.created ?? []), ...(accounts.json.reused ?? [])].includes(
      "Agent API Revenue",
    ),
    "the income account is one of the four setup ensures",
  );

  /*
   * READ FROM THE DATABASE, NOT FROM THE RESPONSE, and the reason is worth
   * recording: `presentQboStatus` lists expense, suspense and contra but NOT
   * revenue, so the status route cannot answer "which account did revenue land
   * in?" at all. That is consistent with `missingAccounts` deliberately not
   * requiring revenue — a company connected before 6B-1 keeps posting spend
   * with a null revenue account — but it does mean the id is only observable
   * here. Noted rather than worked around silently; whether the status route
   * should carry it is a question for the Slice 6B-2 interface work, which is
   * the first thing that will need to display it.
   */
  const revenueAccountId =
    readDb<{ revenue_account_id: string | null }>(
      "SELECT revenue_account_id FROM qbo_config LIMIT 1",
    )[0]?.revenue_account_id ?? null;
  ok(
    typeof revenueAccountId === "string" && revenueAccountId.length > 0,
    `a revenue account is recorded (${revenueAccountId ?? "none"})`,
  );

  // --- preview -------------------------------------------------------------
  console.log("\n== preview: the exact document, before anything is sent ==");
  const preview = await call("POST", "/api/integrations/quickbooks/preview", {
    day,
    direction: "earn",
  });
  if (preview.status !== 201) {
    fatal(`preview failed (HTTP ${preview.status}): ${JSON.stringify(preview.json)}`);
  }
  const draft = preview.json;
  console.log(`   ${draft.docNumber}  ${draft.lineCount} line(s)  ${draft.day}`);
  for (const line of draft.payload.Line) {
    console.log(
      `     ${line.JournalEntryLineDetail.PostingType.padEnd(6)} ${String(line.Amount).padStart(6)}  ${line.Description}`,
    );
  }
  ok(draft.direction === "earn", "the draft is a revenue document");
  const revenueLine = draft.payload.Line.find(
    (l: any) => l.JournalEntryLineDetail.AccountRef.value === revenueAccountId,
  );
  ok(revenueLine !== undefined, "it has a line on the revenue account");
  ok(
    revenueLine?.JournalEntryLineDetail.PostingType === "Credit",
    "which is a CREDIT — direction comes from the class, not the amount's sign",
  );
  const contraLine = draft.payload.Line.find((l: any) => /Fuel balance/.test(l.Description));
  ok(
    contraLine?.JournalEntryLineDetail.PostingType === "Debit",
    "and the contra is a DEBIT — money arrived, so the balance rose",
  );
  ok(
    contraLine?.Description === "Received into Fuel balance",
    "saying so, rather than claiming the balance funded something",
  );
  ok(
    !draft.payload.Line.some((l: any) => /payment/i.test(l.Description)),
    "no revenue line calls its sources payments — they are receipts",
  );
  ok(draft.readiness?.ok === true, "the draft is postable");

  // --- post ----------------------------------------------------------------
  console.log("\n== posting, for real ==");
  const posted = await call("POST", "/api/integrations/quickbooks/post", { draftId: draft.draftId });
  if (posted.status !== 200) {
    fatal(`the post failed (HTTP ${posted.status}): ${JSON.stringify(posted.json)}`);
  }
  ok(posted.json.status === "posted", `the posting is posted (is "${posted.json.status}")`);
  ok(
    typeof posted.json.quickBooksId === "string" && posted.json.quickBooksId.length > 0,
    "and QuickBooks returned a document id",
  );

  console.log(`\n   ***  QuickBooks Id ${posted.json.quickBooksId}  ·  ${posted.json.docNumber}  ***`);
  console.log("   *** Intuit has now seen a revenue document from Fuel. ***");
  console.log("\n   >>> STOP THE TUNNEL NOW. Nothing below touches the origin. <<<\n");

  // --- idempotency, the layers Slice 2b established ------------------------
  console.log("== idempotency ==");
  const repost = await call("POST", "/api/integrations/quickbooks/post", { draftId: draft.draftId });
  ok(repost.status === 409, `re-posting the same draft is refused 409 (got ${repost.status})`);

  const repreview = await call("POST", "/api/integrations/quickbooks/preview", {
    day,
    direction: "earn",
  });
  ok(repreview.status === 409, `re-previewing the committed day is refused 409 (got ${repreview.status})`);
  ok(
    /already committed/i.test(repreview.json?.error ?? ""),
    `and says the lines are already committed, not that none exist (got: ${repreview.json?.error})`,
  );

  // --- a correction --------------------------------------------------------
  console.log("\n== the correction path, on a revenue document ==");
  const reversed = await call(
    "POST",
    `/api/integrations/quickbooks/postings/${posted.json.postingId}/reverse`,
  );
  if (reversed.status !== 201) {
    fatal(`the reversal failed (HTTP ${reversed.status}): ${JSON.stringify(reversed.json)}`);
  }
  ok(reversed.json.status === "posted", "the reversal posted");
  ok(
    reversed.json.docNumber !== posted.json.docNumber,
    "as a NEW document with its own number — a posted entry is never edited",
  );
  ok(
    reversed.json.correctsPostingId === posted.json.postingId,
    "linked to the entry it corrects",
  );
  console.log(`   QuickBooks Id ${reversed.json.quickBooksId}  ·  ${reversed.json.docNumber}`);

  // The original must be untouched by its own correction.
  const postings = await call("GET", "/api/integrations/quickbooks/postings");
  const original = (postings.json?.postings ?? []).find(
    (p: any) => p.postingId === posted.json.postingId,
  );
  ok(original?.status === "posted", "the original is still posted, not voided");
  ok(
    original?.quickBooksId === posted.json.quickBooksId,
    "and keeps its QuickBooks id",
  );

  console.log(`\n   Verify BOTH documents in the Intuit sandbox company before believing this:`);
  console.log(`     ${posted.json.docNumber}   (Id ${posted.json.quickBooksId})  the revenue entry`);
  console.log(`     ${reversed.json.docNumber}   (Id ${reversed.json.quickBooksId})  its reversal`);
}

async function run(endpointId: string): Promise<void> {
  await payAndSettle(endpointId);
  const { day } = latestSettledReceipt(endpointId);
  await postToQuickBooks(day);
}

/**
 * Resumes after a payment has already settled — the QuickBooks half only.
 * Reads the day off the already-written receipt instead of paying again.
 *
 * WHY THIS EXISTS. The first live run of `run` stopped exactly here: a dead
 * OAuth refresh token (a real, pre-existing fact about this sandbox
 * connection, unrelated to anything this script does) made account setup
 * fail. The obvious next move — "just run it again" — would have signed and
 * spent a second real payment to retry a step that never touched the payer at
 * all. `resume` is the deliberate way to say "the money already moved, don't
 * move it again."
 */
async function resume(endpointId: string): Promise<void> {
  console.log("\n== resuming: re-reading the settlement already on record, no new payment ==");
  const { day } = latestSettledReceipt(endpointId);
  await postToQuickBooks(day);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);

  if (command === "register") {
    if (!argument) fatal("usage: walk-revenue.ts register <https://public-origin/revenue-demo>");
    await register(argument);
    return;
  }

  if (command === "run" || command === "resume") {
    if (!argument) fatal(`usage: walk-revenue.ts ${command} <endpointId>`);
    await (command === "run" ? run(argument) : resume(argument));
    console.log(`\n${checks} checks, ${failures === 0 ? "all passing" : `${failures} FAILED`}.`);
    return;
  }

  fatal(
    "usage:\n" +
      "  walk-revenue.ts register <https://public-origin/revenue-demo>\n" +
      "  walk-revenue.ts run <endpointId>       -- pays, then posts to QuickBooks\n" +
      "  walk-revenue.ts resume <endpointId>    -- posts to QuickBooks only, using the\n" +
      "                                             most recent settled receipt. Use this\n" +
      "                                             after `run` gets past payment and then\n" +
      "                                             fails later (e.g. QuickBooks) -- it does\n" +
      "                                             NOT pay again.\n\n" +
      "Read the comment at the top of this file first — the order matters.",
  );
}

main().catch((error) => {
  console.error(`\n${describe(error)}`);
  process.exit(1);
});
