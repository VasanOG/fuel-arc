/**
 * Where QuickBooks lives, and the guard that keeps it sandbox.
 *
 * This is the QuickBooks equivalent of the pinned constants in
 * src/fireblocks/signer.ts, and it exists for the same reason: posting to a
 * production QuickBooks company writes into a real business's books, which is
 * outward-facing and awkward to reverse. No money moves, but an accountant who
 * has already reconciled against a wrong entry has a real problem.
 *
 * See CLAUDE.md "Non-negotiable rule".
 */
import { createHash } from "node:crypto";

/**
 * The one origin this integration may talk to.
 *
 * Hardcoded, not read from env: nothing may make production a config toggle
 * away. Enabling production is a reviewed code change, the same way enabling
 * mainnet is — .env.example says so and this is the other half of that promise.
 */
export const QBO_API_ORIGIN = "https://sandbox-quickbooks.api.intuit.com";

/**
 * The OAuth endpoints, which Intuit shares between sandbox and production.
 *
 * Worth knowing rather than assuming: authorization and token exchange happen
 * on the same hosts either way, so THESE ARE NOT the sandbox control. The
 * control is QBO_API_ORIGIN above — the only place data is read or written.
 * Sandbox and production are distinguished by which client credentials are
 * used, and production credentials fail against the sandbox API origin, so the
 * two halves fail closed together.
 */
export const QBO_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

/**
 * Accounting read/write, and an ID token. Nothing else: no email, profile,
 * phone or address.
 *
 * `openid` IS HERE FOR ONE CLAIM (7A-3 item 4, ADR 0017). The ID token's
 * `realmid` is Intuit saying which QuickBooks company it granted. Nothing else
 * says that. The redirect's `realmId` is whatever the browser sent, and a read
 * of a named company succeeding does not prove it either: measured live, a
 * token asked for another company its Intuit user can reach is answered 200,
 * with the token's OWN company.
 */
export const QBO_SCOPE = "com.intuit.quickbooks.accounting openid";

/**
 * Who issues Intuit's ID tokens, as Intuit's sandbox OpenID discovery document
 * states it (developer.api.intuit.com/.well-known/openid_sandbox_configuration).
 * Pinned rather than discovered at runtime, like every other Intuit endpoint in
 * this file.
 */
export const QBO_ID_TOKEN_ISSUER = "https://oauth.platform.intuit.com/op/v1";

/**
 * Minor version 75 is the current floor — Intuit deprecated 1–74 and treats any
 * lower value as 75. Pinned explicitly rather than omitted so a future default
 * change is a deliberate edit here, not a silent shift in response shapes.
 */
export const QBO_MINOR_VERSION = "75";

/** The only currency this slice handles. See the USD-only note in ADR 0008. */
export const SUPPORTED_CURRENCY = "USD";

export class NonSandboxUrlError extends Error {
  constructor(url: string) {
    super(`Refusing to call QuickBooks: ${url} is not on ${QBO_API_ORIGIN}`);
    this.name = "NonSandboxUrlError";
  }
}

/**
 * Refuses any URL that is not on the sandbox origin.
 *
 * COMPARES THE PARSED ORIGIN, NEVER A PREFIX. `startsWith(QBO_API_ORIGIN)` is
 * the obvious implementation and it is broken: it accepts
 * `https://sandbox-quickbooks.api.intuit.com.evil.com/v3/...`, because that is
 * a different host that happens to begin with the right characters. Parsing to
 * an origin and comparing for equality cannot be fooled that way — the same
 * lesson the dashboard's Origin/Host check had to learn, and the same one
 * scripts/create-sandbox-wallet.ts records about matching asset ids by pattern
 * instead of pinning them exactly.
 *
 * Called before every request, including reads. A read against the wrong
 * company is a data leak even though it changes nothing.
 */
export function assertSandboxUrl(url: string): void {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    // An unparseable URL is not "probably fine" — fail closed.
    throw new NonSandboxUrlError(url);
  }
  if (origin !== QBO_API_ORIGIN) throw new NonSandboxUrlError(url);
}

/** The base path for every Accounting API call against one company. */
export function companyUrl(realmId: string, path: string): string {
  const url = `${QBO_API_ORIGIN}/v3/company/${encodeURIComponent(realmId)}/${path}`;
  assertSandboxUrl(url);
  return url;
}

/**
 * QuickBooks caps DocNumber at 21 characters, which rules out putting a UUID in
 * it. `FUEL-` plus 12 hex characters of a SHA-256 over the rollup's identity
 * fits in 17 and is deterministic: the same rollup always produces the same
 * document number, however many times it is previewed or retried.
 *
 * That determinism is the last line of the idempotency defence. Intuit's
 * `requestid` replay window is finite; a DocNumber is forever, so a posting
 * whose outcome was never confirmed can be reconciled by asking QuickBooks
 * whether a document with this number already exists — long after any replay
 * window has closed.
 *
 * THE COMPANY IS PART OF THE IDENTITY, AND REQUIRED. Until 7A-1 the identity was
 * the scope alone (`spend:daily:2026-09-01`), which is the same string for every
 * company. Two Fuel companies writing into one QuickBooks company would then
 * compute the same number for the same day, the second would get Intuit's
 * duplicate-number fault, and `send` -- which reads that fault as "an earlier
 * attempt of OURS already created this" -- would adopt the other company's
 * document as its own and mark its lines booked. One QuickBooks company per
 * Fuel company is now enforced as well (qbo_connections.realm_id is unique);
 * this is the second, independent reason the adoption cannot cross tenants.
 *
 * A parameter rather than a prefix callers remember to add, so forgetting it is
 * a compile error. Numbers already stored on drafts and postings are never
 * recomputed, so nothing in flight changes.
 *
 * 48 bits of hash is not collision-proof in the abstract, but the space it has
 * to be unique across is one company's postings, a live collision inside it is
 * refused by the partial unique index on qbo_postings, and a collision with a
 * past document would be caught by the pre-post reconciliation query rather
 * than silently merging two entries.
 */
export function docNumberFor(companyId: string, identity: string): string {
  const digest = createHash("sha256")
    .update(`company:${companyId}:${identity}`)
    .digest("hex")
    .slice(0, 12);
  return `FUEL-${digest}`;
}

/**
 * A correction gets its own document identity, derived from the original's.
 *
 * Corrections are never edits: once an entry is posted it is never updated or
 * replaced, so a correction is a new document that must not collide with the
 * one it corrects. Deriving from the original plus a sequence keeps the link
 * legible while guaranteeing a distinct number. The company is passed
 * explicitly rather than trusted to be inside the original's number: numbers
 * minted before 7A-1 carry none.
 */
export function correctionDocNumberFor(
  companyId: string,
  originalDocNumber: string,
  sequence: number,
): string {
  return docNumberFor(companyId, `correction:${originalDocNumber}:${sequence}`);
}
