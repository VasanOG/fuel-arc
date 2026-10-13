/**
 * Storage for the QuickBooks Online integration.
 *
 * Three responsibilities, kept in one module because they share a lifecycle:
 * the connection (encrypted credentials), the in-flight OAuth handshake, and
 * the posting record (drafts and the documents they became).
 *
 * TOKENS ARE ENCRYPTED AT THE BOUNDARY. Nothing outside this file sees an
 * encrypted blob and nothing inside the database holds a plaintext token — the
 * conversion happens in `toConnection` and `saveConnection` and nowhere else,
 * so there is exactly one place to check that the rule holds.
 *
 * The domain type deliberately splits: `QboConnection` carries no token at all,
 * and is what every caller and every route gets. Only `connectionSecrets`
 * returns token material, and only the HTTP client calls it. Making the safe
 * shape the default one is what stops a token reaching a response body by
 * accident.
 */
import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";
import { db } from "./index.js";

/** How long an operator has to complete the Intuit consent screen. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Refresh this far before the access token actually expires.
 *
 * Intuit's access token lasts an hour. Refreshing at the last second means a
 * request in flight when the clock ticks over fails for no reason; five minutes
 * is comfortably longer than any call this integration makes.
 */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** A connection, with no credential material in it. This is the safe shape. */
export interface QboConnection {
  id: string;
  companyId: string;
  realmId: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  connectedAt: string;
  updatedAt: string;
}

interface ConnectionRow {
  id: string;
  company_id: string;
  realm_id: string;
  access_token_enc: string;
  access_expires_at: string;
  refresh_token_enc: string;
  refresh_expires_at: string;
  connected_at: string;
  updated_at: string;
}

function toConnection(row: ConnectionRow): QboConnection {
  return {
    id: row.id,
    companyId: row.company_id,
    realmId: row.realm_id,
    accessExpiresAt: row.access_expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
  };
}

export function getConnection(companyId: string): QboConnection | null {
  const row = db.prepare("SELECT * FROM qbo_connections WHERE company_id = ?").get(companyId) as
    | ConnectionRow
    | undefined;
  return row ? toConnection(row) : null;
}

/**
 * The only function that hands back token material.
 *
 * Separated from `getConnection` so that reaching for a token is a deliberate,
 * greppable act rather than something you get for free by loading a row. Call
 * sites: the QuickBooks HTTP client, and nothing else.
 */
export function connectionSecrets(
  companyId: string,
): { accessToken: string; refreshToken: string; accessExpiresAt: string } | null {
  const row = db.prepare("SELECT * FROM qbo_connections WHERE company_id = ?").get(companyId) as
    | ConnectionRow
    | undefined;
  if (!row) return null;
  return {
    accessToken: decryptSecret(row.access_token_enc),
    refreshToken: decryptSecret(row.refresh_token_enc),
    accessExpiresAt: row.access_expires_at,
  };
}

/**
 * The QuickBooks company is already connected to a DIFFERENT Fuel company.
 *
 * WHY ONE FUEL COMPANY PER QUICKBOOKS COMPANY. Document numbers are unique
 * inside one set of books. Two Fuel companies in one realm would share that
 * namespace, and the posting path reads Intuit's duplicate-number fault as "we
 * already created this" -- adopting whatever document holds the number. The
 * company id is inside every number as well (quickbooks/config.ts), but the
 * books themselves being one tenant's is the stronger and simpler rule.
 *
 * The message names neither the other company nor the realm: the caller is an
 * operator of the second company, and who else uses Fuel is not theirs to learn.
 */
export class RealmAlreadyConnectedError extends Error {
  constructor() {
    super("This QuickBooks company is already connected to another Fuel account.");
    this.name = "RealmAlreadyConnectedError";
  }
}

/**
 * The company still has postings whose outcome in QuickBooks is unknown, and
 * this change would take away the books they have to be resolved against.
 *
 * WHY, SINCE 7A-3. A posting now records the QuickBooks company it was sent
 * to, and reconciling it asks only those books -- so a switch can no longer
 * MIS-reconcile it (before 7A-3 it asked the new books, found nothing, marked
 * the attempt failed and released its lines, and the spend was booked twice).
 * But a pending posting can only be reconciled in its own books, and a token
 * reaches only the company it was granted for. Switch away and it cannot be
 * reconciled at all until those books are reconnected: stranded, lines held.
 * That is why this stays a block rather than relaxing to a warning. The way
 * out for a company whose books are gone for good is an owner writing the
 * posting off (7A-3 item 3, ADR 0016), which removes it from this count only.
 *
 * Two doors lead there, and both are closed: connecting to a different realm,
 * and disconnecting (after which there is no current realm to compare with, so
 * the next connect could go anywhere). Reconnecting to the SAME realm stays
 * open -- that is how dead tokens are replaced, and reconciling needs a live
 * connection.
 *
 * The message names no document and no realm.
 */
export class UnresolvedPostingsError extends Error {
  constructor(readonly pendingCount: number) {
    super(
      `This company has ${pendingCount} QuickBooks posting(s) whose outcome is not yet confirmed. ` +
        "Reconcile them first; until then the connection can only be renewed for the same QuickBooks company. " +
        "If that QuickBooks company is gone for good, an owner can write a posting off.",
    );
    this.name = "UnresolvedPostingsError";
  }
}

/**
 * Pending postings that still hold this company to its current books.
 *
 * A posting an OWNER HAS WRITTEN OFF does not (7A-3 item 3, ADR 0016). It was
 * written off because its books cannot be asked about it -- and the block
 * exists only to keep those books reachable until they are asked. Once no
 * answer can come, holding the company to them protects nothing and strands
 * everything else. The written-off posting itself stays `pending` with its
 * lines held, so leaving these books cannot release its spend.
 *
 * Every OTHER pending posting still blocks, exactly as before.
 */
function pendingPostingCount(companyId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM qbo_postings WHERE company_id = ? AND status = 'pending' AND abandoned_at IS NULL",
    )
    .get(companyId) as { n: number | bigint };
  return Number(row.n);
}

/**
 * Runs a read-check-write as one IMMEDIATE transaction.
 *
 * IMMEDIATE takes the write lock before the read, so a posting cannot become
 * pending in another process between the check and the write it guards.
 */
function inWriteTransaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  }
}

/**
 * Writes a connection, replacing any existing one for the company.
 *
 * Called on first connect AND on every refresh, and the refresh case is the one
 * that matters: Intuit rotates the refresh token roughly daily and force-expires
 * the previous one, so this must be committed BEFORE the new access token beside
 * it is used for anything. A rotated token that was not persisted is a dead
 * connection that only manual re-authorisation can revive.
 *
 * A single INSERT OR REPLACE rather than a read-modify-write: the whole row is
 * replaced atomically, so a crash cannot leave an access token from one grant
 * beside a refresh token from another.
 */
export function saveConnection(params: {
  companyId: string;
  realmId: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}): QboConnection {
  inWriteTransaction(() => writeConnection(params));
  return getConnection(params.companyId)!;
}

function writeConnection(params: {
  companyId: string;
  realmId: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}): void {
  const existing = getConnection(params.companyId);
  const now = new Date().toISOString();

  // Only a CHANGE of realm is guarded. A token refresh and a same-company
  // reconnect pass the realm already on file and are never refused.
  if (existing && existing.realmId !== params.realmId) {
    const pending = pendingPostingCount(params.companyId);
    if (pending > 0) throw new UnresolvedPostingsError(pending);
  }

  // The realm UNIQUE is what enforces one Fuel company per QuickBooks company.
  // Only a DIFFERENT company's row can conflict: this company's own reconnect,
  // or a token refresh, resolves through ON CONFLICT (company_id) first.
  try {
    db.prepare(
      `INSERT INTO qbo_connections
         (id, company_id, realm_id, access_token_enc, access_expires_at,
          refresh_token_enc, refresh_expires_at, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE SET
         realm_id           = excluded.realm_id,
         access_token_enc   = excluded.access_token_enc,
         access_expires_at  = excluded.access_expires_at,
         refresh_token_enc  = excluded.refresh_token_enc,
         refresh_expires_at = excluded.refresh_expires_at,
         updated_at         = excluded.updated_at`,
    ).run(
      existing?.id ?? randomUUID(),
      params.companyId,
      params.realmId,
      encryptSecret(params.accessToken),
      params.accessExpiresAt,
      encryptSecret(params.refreshToken),
      params.refreshExpiresAt,
      // Preserved across a refresh: when the integration was first authorised is
      // a different fact from when its token was last rotated.
      existing?.connectedAt ?? now,
      now,
    );
  } catch (error) {
    if (/UNIQUE constraint failed: qbo_connections\.realm_id/.test((error as Error).message)) {
      throw new RealmAlreadyConnectedError();
    }
    throw error;
  }
}

/**
 * Forgets a connection. The tokens go with it; nothing is archived.
 *
 * Refused while postings are unresolved: see UnresolvedPostingsError.
 */
export function deleteConnection(companyId: string): boolean {
  return inWriteTransaction(() => {
    const pending = pendingPostingCount(companyId);
    if (pending > 0) throw new UnresolvedPostingsError(pending);
    const { changes } = db.prepare("DELETE FROM qbo_connections WHERE company_id = ?").run(companyId);
    return Number(changes) > 0;
  });
}

// ---------------------------------------------------------------------------
// OAuth handshake
// ---------------------------------------------------------------------------

/**
 * Records a state value before sending the operator to Intuit.
 *
 * The state is generated by the caller from `randomBytes`, not here, so this
 * module never decides how much entropy the CSRF token has.
 *
 * `userId` IS REQUIRED, AND CHECKED HERE. The callback lets only this person
 * finish the connection (7A-3 item 4, ADR 0017), so a state that names nobody
 * could be finished by nobody -- or, if a later change read NULL as "anyone",
 * by anybody. The column cannot carry a CHECK (it arrived by ADD COLUMN), so
 * this writer is where "every state names its starter" holds.
 */
export function createOAuthState(params: { state: string; companyId: string; userId: string }): void {
  if (!params.userId) {
    throw new Error("a QuickBooks connection must be started by a signed-in person");
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO qbo_oauth_states (state, company_id, created_by, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(
    params.state,
    params.companyId,
    params.userId,
    new Date(now).toISOString(),
    new Date(now + OAUTH_STATE_TTL_MS).toISOString(),
  );
}

/**
 * `createdBy` is who started the connection, or null for a state from before
 * that was recorded. The callback refuses null; it is never "anyone".
 */
export type StateRedemption =
  | { ok: true; companyId: string; createdBy: string | null }
  | { ok: false; reason: "unknown" | "already used" | "expired" };

/**
 * Redeems a state exactly once.
 *
 * The guarded UPDATE is the whole mechanism: `WHERE state = ? AND consumed_at
 * IS NULL` means a replayed callback changes no rows and is refused, even if
 * two arrive at the same instant. Same shape as burning an approval in
 * reserveIfUnderCap, and for the same reason — validating first and marking
 * afterwards would let two concurrent redemptions both pass.
 *
 * Expiry is checked in SQL too, so a state cannot be consumed a moment after it
 * lapses because the process was busy.
 */
export function redeemOAuthState(state: string): StateRedemption {
  const now = new Date().toISOString();

  const { changes } = db
    .prepare(
      `UPDATE qbo_oauth_states SET consumed_at = ?
       WHERE state = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .run(now, state, now);

  if (Number(changes) === 1) {
    const row = db
      .prepare("SELECT company_id, created_by FROM qbo_oauth_states WHERE state = ?")
      .get(state) as { company_id: string; created_by: string | null };
    return { ok: true, companyId: row.company_id, createdBy: row.created_by ?? null };
  }

  // Nothing changed. Read the row back only to say WHY, which an operator
  // debugging a failed connection genuinely needs — the three cases have three
  // different fixes.
  const row = db
    .prepare("SELECT consumed_at, expires_at FROM qbo_oauth_states WHERE state = ?")
    .get(state) as { consumed_at: string | null; expires_at: string } | undefined;

  if (!row) return { ok: false, reason: "unknown" };
  if (row.consumed_at !== null) return { ok: false, reason: "already used" };
  return { ok: false, reason: "expired" };
}

/** Clears out states nobody completed. Expiry can only ever remove permission. */
export function purgeExpiredOAuthStates(): number {
  const { changes } = db
    .prepare("DELETE FROM qbo_oauth_states WHERE expires_at < ?")
    .run(new Date().toISOString());
  return Number(changes);
}

// ---------------------------------------------------------------------------
// Posting configuration
// ---------------------------------------------------------------------------

export type ContraAccountKind = "prepaid_asset" | "cash" | "clearing";
/**
 * `counterparty_day` was `vendor_day` until 6B-1.
 *
 * Renamed with the column it groups by. The type change is what forces every
 * comparison against the old string literal to become a compile error, which is
 * the only reason this rename is safe to do at all — a grain is compared by
 * value in half a dozen places and none of them would have failed loudly.
 */
export type RollupGrain = "daily" | "counterparty_day";

/**
 * How Fuel came to believe a company's accounting currency.
 *
 * One value today, and that is the point: only a reading of Intuit's own
 * Preferences counts. The type exists so that if a weaker source is ever added
 * — an operator asserting it, say — it must be given its own name rather than
 * quietly inheriting the word "verified". Evidence and assertion are different
 * claims and the API says which one it is holding.
 */
export type CurrencySource = "quickbooks_preferences";

export interface QboConfig {
  companyId: string;
  expenseAccountId: string | null;
  suspenseAccountId: string | null;
  contraAccountId: string | null;
  /**
   * The income account revenue posts to. Null for every company connected
   * before the earning side shipped, and deliberately NOT part of
   * missingAccounts — see the note there.
   */
  revenueAccountId: string | null;
  contraAccountKind: ContraAccountKind;
  rollupGrain: RollupGrain;
  /** ISO-4217, as read from QuickBooks. Null means Fuel does not know. */
  accountingCurrency: string | null;
  currencySource: CurrencySource | null;
  currencyCheckedAt: string | null;
  /**
   * The QuickBooks company the four account ids above were read from. An
   * account id is a small per-company integer that recurs across companies, so
   * it means nothing without this. Null means Fuel does not know, which is
   * treated as a mismatch, never as "the current books". 7A-3.
   */
  accountsRealmId: string | null;
  updatedAt: string;
}

/** The fields that are QuickBooks account ids, and so belong to one set of books. */
const ACCOUNT_ID_FIELDS = [
  "expenseAccountId",
  "suspenseAccountId",
  "contraAccountId",
  "revenueAccountId",
] as const;

interface ConfigRow {
  company_id: string;
  expense_account_id: string | null;
  revenue_account_id: string | null;
  suspense_account_id: string | null;
  contra_account_id: string | null;
  contra_account_kind: ContraAccountKind;
  rollup_grain: RollupGrain;
  accounting_currency: string | null;
  currency_source: CurrencySource | null;
  currency_checked_at: string | null;
  accounts_realm_id: string | null;
  updated_at: string;
}

function toConfig(row: ConfigRow): QboConfig {
  return {
    companyId: row.company_id,
    expenseAccountId: row.expense_account_id,
    suspenseAccountId: row.suspense_account_id,
    contraAccountId: row.contra_account_id,
    // `?? null` for the same reason as the currency columns below: a database
    // migrated before this column existed returns undefined, not null.
    revenueAccountId: row.revenue_account_id ?? null,
    contraAccountKind: row.contra_account_kind,
    rollupGrain: row.rollup_grain,
    // `?? null` rather than the raw value: a database migrated before these
    // columns existed returns undefined, and undefined is not a "no".
    accountingCurrency: row.accounting_currency ?? null,
    currencySource: row.currency_source ?? null,
    currencyCheckedAt: row.currency_checked_at ?? null,
    accountsRealmId: row.accounts_realm_id ?? null,
    updatedAt: row.updated_at,
  };
}

/**
 * The company's config, or the defaults it would have.
 *
 * Returns an unsaved default rather than null so callers do not each invent
 * their own idea of what an unconfigured company looks like. The account ids
 * stay null, which is what makes a posting refuse until they are set — the
 * defaults cover preference, never identity.
 */
export function getConfig(companyId: string): QboConfig {
  const row = db.prepare("SELECT * FROM qbo_config WHERE company_id = ?").get(companyId) as
    | ConfigRow
    | undefined;
  if (row) return toConfig(row);
  return {
    companyId,
    expenseAccountId: null,
    suspenseAccountId: null,
    contraAccountId: null,
    revenueAccountId: null,
    contraAccountKind: "prepaid_asset",
    rollupGrain: "daily",
    // Not "USD". An unconfigured company has had nothing read from Intuit, and
    // a default here would be indistinguishable from a real verification.
    accountingCurrency: null,
    currencySource: null,
    currencyCheckedAt: null,
    accountsRealmId: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * WHERE THE ACCOUNT IDS CAME FROM MUST TRAVEL WITH THEM.
 *
 * A patch that sets any account id without saying which QuickBooks company it
 * was read from is refused. Otherwise the new id would sit under the OLD
 * stamp -- a claim that it belongs to books it was never read from -- and the
 * realm check at preview would pass on a lie. Making the stamp part of the same
 * write is what stops a future caller forgetting it: it cannot compile a patch
 * that "just updates the expense account" and have that succeed.
 *
 * The converse is allowed: a patch that touches no account id (currency,
 * grain) leaves the stamp alone, because it changes nothing the stamp speaks
 * for.
 */
export class AccountsRealmRequiredError extends Error {
  constructor() {
    super("QuickBooks account ids can only be saved together with the QuickBooks company they were read from.");
    this.name = "AccountsRealmRequiredError";
  }
}

type ConfigPatch = Partial<Omit<QboConfig, "companyId" | "updatedAt">>;

/**
 * Merges a patch into the stored config.
 *
 * ONE WRITE TRANSACTION around the read and the write. The merge reads the
 * row and writes all of it back, so without the lock a second server process
 * could land a full account replacement between this read and this write --
 * and this write, carrying the old snapshot, would silently put the old ids
 * and their old stamp back. Within one process that cannot interleave (all of
 * this is synchronous); across two processes on one file it can.
 */
export function saveConfig(companyId: string, patch: ConfigPatch): QboConfig {
  inWriteTransaction(() => writeConfig(companyId, patch));
  return getConfig(companyId);
}

/** No QuickBooks company is connected, so an account id cannot be said to belong anywhere. */
export class AccountsNeedConnectionError extends Error {
  constructor() {
    super(
      "Connect QuickBooks before setting account ids: an account id only means something " +
        "in the QuickBooks company it belongs to.",
    );
    this.name = "AccountsNeedConnectionError";
  }
}

/** The stored ids belong to other books, and this patch would leave some of them standing. */
export class AccountsFromOtherBooksError extends Error {
  constructor() {
    super(
      "The account ids on file were set up for a different QuickBooks company than the one " +
        "connected now. Run account setup again to replace all of them.",
    );
    this.name = "AccountsFromOtherBooksError";
  }
}

/**
 * A config patch an operator typed in: account ids are stamped with the books
 * connected NOW, and refused where that stamp would be a lie. 7A-3.
 *
 * The ids an operator sends are ids they read in the QuickBooks company
 * currently connected, so that is the stamp they are saved under. The hazard
 * is the ids they DIDN'T send: a patch naming only the expense account leaves
 * the others as they were, and if those were read from different books,
 * stamping the whole mapping with the current realm would vouch for ids nobody
 * checked against these books -- and the realm check at preview would believe
 * it.
 *
 * So when the stored mapping belongs to other books (or to none Fuel can
 * name), a patch is refused unless it leaves no old id standing. Account setup
 * replaces all four at once and is the ordinary way out. Neither message names
 * a realm.
 *
 * The check and the write share one IMMEDIATE transaction, so the connection
 * and mapping it judged are the ones it writes against.
 */
export function saveConfigByHand(companyId: string, patch: ConfigPatch): QboConfig {
  inWriteTransaction(() => {
    const stamped: ConfigPatch = { ...patch };
    if (ACCOUNT_ID_FIELDS.some((field) => field in patch)) {
      const connection = getConnection(companyId);
      if (!connection) throw new AccountsNeedConnectionError();
      const current = getConfig(companyId);
      if (current.accountsRealmId !== connection.realmId) {
        const leftStanding = ACCOUNT_ID_FIELDS.filter(
          (field) => !(field in patch) && current[field] !== null,
        );
        if (leftStanding.length > 0) throw new AccountsFromOtherBooksError();
      }
      stamped.accountsRealmId = connection.realmId;
    }
    writeConfig(companyId, stamped);
  });
  return getConfig(companyId);
}

function writeConfig(companyId: string, patch: ConfigPatch): void {
  if (ACCOUNT_ID_FIELDS.some((field) => field in patch) && !("accountsRealmId" in patch)) {
    throw new AccountsRealmRequiredError();
  }
  const current = getConfig(companyId);
  const next = { ...current, ...patch };

  db.prepare(
    `INSERT INTO qbo_config
       (company_id, expense_account_id, suspense_account_id, contra_account_id,
        revenue_account_id,
        contra_account_kind, rollup_grain, accounting_currency, currency_source,
        currency_checked_at, accounts_realm_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (company_id) DO UPDATE SET
       expense_account_id  = excluded.expense_account_id,
       suspense_account_id = excluded.suspense_account_id,
       contra_account_id   = excluded.contra_account_id,
       revenue_account_id  = excluded.revenue_account_id,
       contra_account_kind = excluded.contra_account_kind,
       rollup_grain        = excluded.rollup_grain,
       accounting_currency = excluded.accounting_currency,
       currency_source     = excluded.currency_source,
       currency_checked_at = excluded.currency_checked_at,
       accounts_realm_id   = excluded.accounts_realm_id,
       updated_at          = excluded.updated_at`,
  ).run(
    companyId,
    next.expenseAccountId,
    next.suspenseAccountId,
    next.contraAccountId,
    next.revenueAccountId,
    next.contraAccountKind,
    next.rollupGrain,
    next.accountingCurrency,
    next.currencySource,
    next.currencyCheckedAt,
    next.accountsRealmId,
    new Date().toISOString(),
  );
}

/**
 * Whether Fuel has verified this company keeps its books in USD.
 *
 * THE GATE READS A RECORD, IT DOES NOT ASK INTUIT. Preview sends nothing to
 * QuickBooks — that is what makes "did that reach Intuit?" answerable — so the
 * verification happens once, at account setup, and is stored with its source
 * and timestamp. Post consults the same record, so a company whose currency
 * changed after a draft was built still cannot post it.
 *
 * Three ways to fail, all closed:
 *   - never checked (null)          -> Fuel does not know
 *   - checked, and not USD          -> out of scope, no conversion exists
 *   - recorded from a weaker source -> not evidence, so not accepted
 */
export function currencyBlocker(config: QboConfig): string | null {
  if (config.accountingCurrency === null || config.currencySource === null) {
    return (
      "this company's accounting currency has not been verified with QuickBooks — " +
      "run account setup to read it from the company's Preferences"
    );
  }
  if (config.currencySource !== "quickbooks_preferences") {
    return `the recorded currency came from ${config.currencySource}, which is not evidence from QuickBooks`;
  }
  if (config.accountingCurrency !== "USD") {
    return (
      `this company keeps its books in ${config.accountingCurrency}. Fuel's QuickBooks ` +
      `integration is USD-only and performs no currency conversion`
    );
  }
  return null;
}

/**
 * Every account a SPEND posting needs. Posting refuses until all three are set.
 *
 * THE INCOME ACCOUNT IS DELIBERATELY NOT IN THIS LIST. Every company connected
 * before the earning side shipped has a null revenue_account_id, and adding it
 * here would turn a feature addition into an immediate outage for customers who
 * never asked for the earning side — nothing would post until an operator
 * noticed and re-ran account setup.
 *
 * A company in that state keeps posting spend exactly as before, and revenue
 * waits. That is safe because the two travel together: a company with no income
 * account also has no receipts, so there are no revenue lines for it to be
 * missing. `preview` in quickbooks/posting.ts asserts that pairing rather than
 * trusting it, so the day it stops holding is a refusal and not a mis-post,
 * and it does so before any payload is built. See 0012.
 */
export function missingAccounts(config: QboConfig): string[] {
  const missing: string[] = [];
  if (!config.expenseAccountId) missing.push("expense account");
  if (!config.suspenseAccountId) missing.push("suspense account");
  if (!config.contraAccountId) missing.push("contra account");
  return missing;
}

/**
 * What still has to be created before REVENUE can post, as distinct from spend.
 *
 * Separate from missingAccounts so the Accounting page can say "spend is
 * posting, revenue is waiting on one account" rather than presenting a company
 * as broken when it is merely un-upgraded.
 */
export function missingRevenueAccounts(config: QboConfig): string[] {
  return config.revenueAccountId ? [] : ["income account"];
}
