/**
 * Asks the REAL Intuit sandbox the question the realm-squatting fix rests on:
 * does an access token read only the QuickBooks company it was granted for?
 *
 * `grantReachesRealm` (src/quickbooks/client.ts) treats a 2xx on
 * `companyinfo/<realmId>` as proof a token belongs to that realm, and 401/403/404
 * as proof it does not. verify-api tests that against a stub that behaves the
 * way Intuit is assumed to. This checks the assumption itself.
 *
 * READ-ONLY. Every request is a GET of companyinfo on the sandbox origin (the
 * same companyUrl / assertSandboxUrl guard as all other QuickBooks calls). The
 * token is NOT refreshed -- a refresh rotates and persists tokens, which is a
 * write -- so run this within the hour after connecting. Prints realm ids, HTTP
 * statuses and Intuit fault codes. Never a token, never response bodies.
 *
 * Run (after connecting a company through the normal callback):
 *   npx tsx scripts/probe-realm-scoping.ts [--company <Fuel company id>] [--other-realm <second sandbox company id>]
 *
 * `--company` picks whose connection supplies the token; without it, the
 * bootstrap company's. It exists for case (b): a second Fuel company's fresh
 * token, read against the FIRST company's books, is exactly "a token used on a
 * company the same Intuit user owns but did not grant" (7A-3 item 4).
 *
 * WHAT INTUIT ACTUALLY ANSWERED, against the live sandbox:
 *   a. own company            HTTP 200                                  authorized   (2026-09-20, 09-23)
 *   b. another company the    HTTP 200 -- answered with the token's     "authorized" (2026-09-23)
 *      same user owns         OWN company, not the one named
 *   c. a realm nobody owns    HTTP 401 AuthorizationFault code 120      refused      (2026-09-20, 09-23)
 *   d. a garbage token        HTTP 401 AUTHENTICATION code 3200         refused      (2026-09-20, 09-23)
 *
 * (b) DISPROVED THE ASSUMPTION this probe was written to check. A read that
 * succeeds does not show the token was granted for the company named; it shows
 * the token's Intuit user can reach it. So `grantReachesRealm` is no longer the
 * callback's proof: the ID token's `realmid` is (7A-3 item 4, ADR 0017). Probe
 * (b) now asserts what Intuit does, so a change in that behaviour is noticed:
 * 200, answered with the same company as (a). It compares company names as a
 * yes/no and prints neither.
 */
import "dotenv/config";
import { bootstrapCompany, getCompanyUnscoped } from "../src/db/companies.js";
import { connectionSecrets, getConnection } from "../src/db/qbo.js";
import { grantReachesRealm } from "../src/quickbooks/client.js";
import { companyUrl, QBO_API_ORIGIN, QBO_MINOR_VERSION } from "../src/quickbooks/config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  // A flag followed by another flag is a typo, not a value.
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}
const otherRealm = arg("other-realm");
const companyArg = arg("company");
// Well-formed, and not ours. Supplementary: an unknown company may be refused
// for "not found" rather than "not yours", which is why the second sandbox
// company above is the case that actually matters.
const UNOWNED_REALM = "9130000000000000";

let failures = 0;

/** Status and Intuit's fault code for one read. Nothing from the body beyond those. */
async function observe(token: string, realmId: string): Promise<string> {
  const url = new URL(companyUrl(realmId, `companyinfo/${encodeURIComponent(realmId)}`));
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) return `HTTP ${response.status}`;
  const body = (await response.json().catch(() => ({}))) as {
    Fault?: { type?: string; Error?: { code?: string }[] };
    fault?: { type?: string; error?: { code?: string }[] };
  };
  const fault = body.Fault ?? body.fault;
  const code = (fault as { Error?: { code?: string }[] })?.Error?.[0]?.code ??
    (fault as { error?: { code?: string }[] })?.error?.[0]?.code;
  return `HTTP ${response.status}${fault ? ` fault type=${fault.type ?? "?"} code=${code ?? "?"}` : ""}`;
}

/** The company name a read answers with, or null. Compared, never printed. */
async function answeredAs(token: string, realmId: string): Promise<string | null> {
  const url = new URL(companyUrl(realmId, `companyinfo/${encodeURIComponent(realmId)}`));
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => ({}))) as { CompanyInfo?: { CompanyName?: string } };
  return body.CompanyInfo?.CompanyName ?? null;
}

async function probe(label: string, token: string, realmId: string, expect: "authorized" | "refused") {
  const verdict = await grantReachesRealm(token, realmId);
  const raw = await observe(token, realmId);
  const pass = verdict === expect;
  if (!pass) failures += 1;
  console.log(`${pass ? "ok  " : "FAIL"}  ${label}`);
  console.log(`        realm ${realmId}: grantReachesRealm=${verdict} (expected ${expect}); ${raw}`);
}

async function main(): Promise<void> {
  if (!QBO_API_ORIGIN.startsWith("https://sandbox-")) throw new Error("not the sandbox origin");

  const company = companyArg ? getCompanyUnscoped(companyArg) : bootstrapCompany();
  if (!company) throw new Error("No Fuel company has that id.");
  const connection = getConnection(company.id);
  const secrets = connectionSecrets(company.id);
  if (!connection || !secrets) throw new Error("That company is not connected to QuickBooks. Connect it first.");
  if (otherRealm !== undefined && otherRealm === connection.realmId) {
    // Probe (b) against the token's own books would "pass" as authorized and
    // prove nothing about another company.
    throw new Error("--other-realm is this company's own QuickBooks company; name a different one.");
  }
  if (Date.parse(secrets.accessExpiresAt) - Date.now() < 5 * 60_000) {
    throw new Error("The access token is expired or about to be. Reconnect, then run this straight away.");
  }

  console.log(`Fuel company ${company.id}, connected sandbox company: ${connection.realmId} (connected ${connection.updatedAt})\n`);

  await probe("a. the granted token reads its own company", secrets.accessToken, connection.realmId, "authorized");
  if (otherRealm) {
    // Not "refused": Intuit answers 200 here. What must hold is that the answer
    // is the token's OWN company -- the behaviour ADR 0017 is built around.
    await probe(
      "b. another sandbox company the same user owns answers 200 (Intuit's behaviour, 2026-09-23)",
      secrets.accessToken,
      otherRealm,
      "authorized",
    );
    const own = await answeredAs(secrets.accessToken, connection.realmId);
    const other = await answeredAs(secrets.accessToken, otherRealm);
    const same = own !== null && own === other;
    if (!same) failures += 1;
    console.log(`${same ? "ok  " : "FAIL"}  b2. and it answers with the token's OWN company, not the one named`);
    console.log(`        same company name as (a): ${same}`);
  } else {
    console.log("skip  b. no --other-realm given: the squatting case against an owned company is NOT tested");
  }
  await probe("c. the granted token is refused on a company id that is not ours", secrets.accessToken, UNOWNED_REALM, "refused");
  await probe("d. a garbage token is refused on the connected company", "not-a-real-token", connection.realmId, "refused");

  console.log(failures === 0 ? "\nIntuit behaves as recorded above (and as ADR 0017 is built around)." : `\n${failures} probe(s) did not match the assumption.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
