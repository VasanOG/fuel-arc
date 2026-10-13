/**
 * The safe accounting-status contract.
 *
 * WHY THIS FILE EXISTS AS ITS OWN MODULE, and not as another function inside
 * fuel.ts: the shape of what may cross into the browser is a decision, and a
 * decision deserves a file. Three things follow from separating it.
 *
 *   1. It is PURE. No fetch, no credential, no `server-only` import. So it can
 *      be handed a deliberately poisoned object in a test and asked what it
 *      lets through — which is the only way to prove a field cannot cross,
 *      rather than observing that today's response happens not to carry it.
 *   2. It has ONE definition for every surface. /accounting and /integrations
 *      previously each described QuickBooks status in their own words; two
 *      descriptions of one thing is how they come to disagree.
 *   3. It sits below the HTTP proxy as well as above it, so the client's
 *      refetch and the server's first render narrow through the same code.
 *
 * WHAT THE RAW RESPONSE CARRIES that must never reach a browser: `realmId`
 * (the customer's QuickBooks company identifier), `accessExpiresAt` and
 * `refreshExpiresAt` (OAuth token lifetimes, which describe the credential
 * even though they are not the credential), and `config.{expense,suspense,
 * contra}AccountId` (identifiers inside the customer's chart of accounts).
 *
 * The defence is not a list of those names. A denylist protects against the
 * fields that exist TODAY and silently admits whatever the API adds next.
 * This picks its keys one at a time and builds a new object — so a field added
 * to `presentQboStatus` tomorrow arrives here and stops, without anyone having
 * remembered to forbid it.
 */

/**
 * Every key the browser may see for a plain status read. Exhaustive, and
 * asserted to be, in verify-api.
 */
export const ACCOUNTING_STATUS_KEYS = [
  "connected",
  "connectedAt",
  "readyToPost",
  "missing",
  "readyToPostRevenue",
  "missingForRevenue",
  "currency",
  "currencyVerified",
  "currencyCheckedAt",
] as const;

export interface AccountingStatus {
  /** Whether Fuel holds a QuickBooks connection for this company. */
  connected: boolean;
  /** When that connection was made. A date, not an identifier. */
  connectedAt: string | null;
  /** Whether Fuel has everything it needs to post a journal entry. */
  readyToPost: boolean;
  /**
   * What is still missing, in the words the API already uses — "expense
   * account", "USD verification". Names of things a person set up, never the
   * ids QuickBooks gave them.
   */
  missing: string[];
  /**
   * Whether REVENUE can post, as distinct from spend.
   *
   * A separate flag rather than another entry in `missing`, because the income
   * account is deliberately not a blocker for spend: a company connected before
   * the earning side existed keeps posting expenses and waits for revenue,
   * which is 0012's degrade-rather-than-stop rule. Folding the two together
   * here would re-create as a display bug the outage that rule exists to
   * prevent — the page would report a working integration as broken.
   */
  readyToPostRevenue: boolean;
  /** What is still missing before revenue can post. An account NAME, never an id. */
  missingForRevenue: string[];
  /** The currency the customer's books are kept in, if Fuel knows it. */
  currency: string | null;
  /** True ONLY for a currency read from QuickBooks' own Preferences (ADR 0008). */
  currencyVerified: boolean;
  /** When that reading was taken. */
  currencyCheckedAt: string | null;
}

/**
 * Narrows a raw `/integrations/quickbooks/status` body to the safe contract.
 *
 * Returns null for anything it does not recognise, rather than a hopeful
 * partial object: a half-read status would report `connected: false` for a
 * connection that exists, which is a confident wrong answer where "no answer"
 * is the true one. Same discipline as getEnvironment.
 *
 * Note the absence of a spread. `{ ...raw, realmId: undefined }` would look
 * equivalent and would carry every future field across.
 *
 * IDEMPOTENT, and it has to be. Applying the contract at both doors means the
 * browser's refetch narrows a body the proxy has ALREADY narrowed — so this
 * runs against the flat contract shape as often as against the nested upstream
 * one. The first version read currency only from `accountingCurrency`, the
 * upstream spelling, so a second pass found nothing there and quietly reset a
 * verified USD company to "not verified yet" after every post, account setup
 * and disconnect. A narrowing function that is not a no-op on its own output
 * is a narrowing function that destroys data.
 */
export function toAccountingStatus(raw: unknown): AccountingStatus | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.connected !== "boolean") return null;

  // Upstream nests the currency claim; the contract flattens it. Read whichever
  // is present — never merge the two, so a body carrying both cannot have its
  // flat fields quietly overridden by a stale nested block.
  const nested =
    typeof source.accountingCurrency === "object" && source.accountingCurrency !== null
      ? (source.accountingCurrency as Record<string, unknown>)
      : undefined;
  const currency: Record<string, unknown> = nested ?? {
    currency: source.currency,
    verified: source.currencyVerified,
    checkedAt: source.currencyCheckedAt,
  };

  return {
    connected: source.connected,
    connectedAt: typeof source.connectedAt === "string" ? source.connectedAt : null,
    readyToPost: source.readyToPost === true,
    // Filtered to strings rather than mapped through String(): an object in
    // this array would otherwise render as "[object Object]" in the operator's
    // "Missing: …" line, and a stray id would be stringified into it.
    missing: Array.isArray(source.missing) ? source.missing.filter((m): m is string => typeof m === "string") : [],
    readyToPostRevenue: source.readyToPostRevenue === true,
    missingForRevenue: Array.isArray(source.missingForRevenue)
      ? source.missingForRevenue.filter((m): m is string => typeof m === "string")
      : [],
    currency: typeof currency.currency === "string" ? currency.currency : null,
    currencyVerified: currency.verified === true,
    currencyCheckedAt: typeof currency.checkedAt === "string" ? currency.checkedAt : null,
  };
}

/* -------------------------------------------------------------------------
 * The ACTION contract.
 *
 * `/setup-accounts`, `/verify-currency` and `PATCH /config` all answer with
 * the same raw connection object `/status` does — `presentQboStatus` is
 * spread into each of their responses — plus a little of their own. Narrowing
 * only `/status` therefore closed one of four doors, and left the widest one
 * open: "Set up accounts" is a button an operator actually presses, and its
 * reply was handing the browser the realm id, both OAuth expiry timestamps and
 * three chart-of-accounts ids every time.
 *
 * The extra fields these routes add are safe and are kept: `quickBooksCompany`
 * is the company's DISPLAY NAME (`profile.name`), and `created`/`reused` are
 * ACCOUNT NAMES — `accounts.ts` pushes `spec.name`, never `spec.id`. Names are
 * what the operator typed or would recognise; ids are the provider's handles.
 * ---------------------------------------------------------------------- */

/** Every key the browser may see for an action response. */
export const ACCOUNTING_ACTION_KEYS = [
  ...ACCOUNTING_STATUS_KEYS,
  "quickBooksCompany",
  "created",
  "reused",
] as const;

export interface AccountingActionResult extends AccountingStatus {
  /** The company's display name. A name a person would recognise, not an id. */
  quickBooksCompany: string | null;
  /** Names of accounts this call created. Names, never ids. */
  created: string[];
  /** Names of accounts that already existed. Names, never ids. */
  reused: string[];
}

/**
 * Narrows an action response to the safe contract.
 *
 * Re-lists every status field by hand rather than spreading the result of
 * `toAccountingStatus`. A spread here would be safe TODAY — its output is
 * already narrow — but it is the exact habit this module exists to refuse, and
 * the next person copying this function would not know which spread was the
 * safe one.
 */
export function toAccountingActionResult(raw: unknown): AccountingActionResult | null {
  const status = toAccountingStatus(raw);
  if (!status) return null;
  const source = raw as Record<string, unknown>;
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

  return {
    connected: status.connected,
    connectedAt: status.connectedAt,
    readyToPost: status.readyToPost,
    missing: status.missing,
    readyToPostRevenue: status.readyToPostRevenue,
    missingForRevenue: status.missingForRevenue,
    currency: status.currency,
    currencyVerified: status.currencyVerified,
    currencyCheckedAt: status.currencyCheckedAt,
    quickBooksCompany:
      typeof source.quickBooksCompany === "string" ? source.quickBooksCompany : null,
    created: names(source.created),
    reused: names(source.reused),
  };
}
