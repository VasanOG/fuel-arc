/**
 * Finding (or creating) the three QuickBooks accounts a posting writes to.
 *
 * Runs ONLY on an explicit operator action, never implicitly during a post.
 * Creating an account changes a customer's chart of accounts, which is their
 * document, not ours — so it is something an operator asks for once during
 * setup, not a side effect of routine work that happens to find something
 * missing.
 *
 * What is deliberately NOT here: creating a Class per agent or a Vendor per
 * merchant host. Fuel keeps agent and merchant attribution; QuickBooks gets the
 * accounting summary. See ADR 0008.
 */
import { escapeQueryValue, qboQuery, qboRequest, RealmMismatchError, realmFor } from "./client.js";
import { SUPPORTED_CURRENCY } from "./config.js";
import { UnsupportedCurrencyError } from "./journal.js";
import { saveConfig, type CurrencySource } from "../db/qbo.js";

/**
 * QuickBooks account types, as its API names them.
 *
 * `Expense` for spend. The suspense and contra accounts are both
 * `Other Current Asset` by default: suspense holds money whose classification
 * is not yet known, and the contra account represents a prepaid Fuel balance
 * the customer has already funded. An operator can point either at a different
 * existing account afterwards — this only decides what gets created when
 * nothing suitable exists.
 */
interface AccountSpec {
  name: string;
  accountType: string;
  accountSubType: string;
  description: string;
}

export const REQUIRED_ACCOUNTS = {
  expense: {
    name: "Agent API Expenses",
    accountType: "Expense",
    accountSubType: "OfficeGeneralAdministrativeExpenses",
    description: "Spend by AI agents on metered APIs, rolled up by Fuel.",
  },
  suspense: {
    name: "Suspense - Unconfirmed Agent Payments",
    accountType: "Other Current Asset",
    accountSubType: "OtherCurrentAssets",
    description:
      "Authorised agent payments never confirmed settled. Cleared when settlement resolves.",
  },
  contra: {
    name: "Fuel Account",
    accountType: "Other Current Asset",
    accountSubType: "OtherCurrentAssets",
    description: "Prepaid balance funded into Fuel agent wallets.",
  },
  /**
   * The earning side. Added after the other three, which is why every company
   * connected before it exists has a null revenue_account_id and re-runs setup
   * to get one — and why missingAccounts deliberately does not require it, so
   * those companies keep posting spend in the meantime. See 0012.
   */
  revenue: {
    name: "Agent API Revenue",
    accountType: "Income",
    accountSubType: "ServiceFeeIncome",
    description: "Income earned by AI agents serving metered APIs through Fuel.",
  },
} satisfies Record<string, AccountSpec>;

export type AccountRole = keyof typeof REQUIRED_ACCOUNTS;

/**
 * QuickBooks caps both `Account.Name` and `Account.Description` at 100
 * characters.
 *
 * Checked here rather than trusted, because Intuit's refusal is close to
 * unreadable: an over-long description comes back as error 2050, "String length
 * specified does not match the supported length. Min:1 Max:100 supported.
 * Supplied length:{2}" — with `{2}` left as an unsubstituted template
 * placeholder, so the message names neither the field nor the actual length.
 * The suspense description was 106 characters and cost a live setup run to
 * diagnose.
 *
 * It also fails at the wrong moment. Setup creates accounts sequentially, so a
 * refusal on the second one leaves the customer's chart of accounts already
 * edited with the first. Catching it before the first request means a bad spec
 * changes nothing at all.
 */
const QBO_ACCOUNT_FIELD_MAX = 100;

export function assertAccountSpecsPostable(): void {
  for (const [role, spec] of Object.entries(REQUIRED_ACCOUNTS)) {
    for (const field of ["name", "description"] as const) {
      const value = spec[field];
      if (value.length < 1 || value.length > QBO_ACCOUNT_FIELD_MAX) {
        throw new Error(
          `The "${role}" account ${field} is ${value.length} characters; ` +
            `QuickBooks allows 1-${QBO_ACCOUNT_FIELD_MAX}.`,
        );
      }
    }
  }
}

interface QboAccount {
  Id: string;
  Name: string;
  AccountType?: string;
}

interface AccountQueryResponse {
  QueryResponse?: { Account?: QboAccount[] };
}

interface AccountCreateResponse {
  Account?: QboAccount;
}

/**
 * Find-or-create, keyed on the account name.
 *
 * Idempotent by name for the same reason `provisionAgentWallet` is: re-running
 * setup should be safe, and QuickBooks rejects a duplicate account name anyway,
 * so querying first turns a confusing 400 into a no-op.
 *
 * The name match is exact. A fuzzy match would be friendlier and much worse —
 * silently adopting an existing account called "Agent Expenses" would start
 * posting a customer's money somewhere nobody chose.
 */
async function findOrCreateAccount(
  companyId: string,
  spec: AccountSpec,
  realmId: string,
): Promise<{ id: string; created: boolean }> {
  // Both calls pinned to `realmId`: an id found or created anywhere else would
  // be saved under a stamp that names books it does not belong to.
  const existing = await qboQuery<AccountQueryResponse>(
    companyId,
    `SELECT Id, Name, AccountType FROM Account WHERE Name = '${escapeQueryValue(spec.name)}'`,
    realmId,
  );

  const found = existing.QueryResponse?.Account?.[0];
  if (found) return { id: found.Id, created: false };

  const created = await qboRequest<AccountCreateResponse>(companyId, {
    method: "POST",
    path: "account",
    expectedRealm: realmId,
    body: {
      Name: spec.name,
      AccountType: spec.accountType,
      AccountSubType: spec.accountSubType,
      Description: spec.description,
    },
  });

  const id = created.Account?.Id;
  if (!id) throw new Error(`QuickBooks did not return an id for the "${spec.name}" account`);
  return { id, created: true };
}

export interface AccountSetupResult {
  /**
   * The QuickBooks company these ids were read from or created in. Returned
   * with them so the caller cannot save the ids without also saving where they
   * belong -- saveConfig refuses one without the other.
   */
  realmId: string;
  expenseAccountId: string;
  suspenseAccountId: string;
  contraAccountId: string;
  revenueAccountId: string;
  created: string[];
  reused: string[];
}

/**
 * Ensures all four accounts exist, reporting which were created.
 *
 * `realmId` defaults to the books connected now; the setup route passes the
 * realm it read before verifying the currency, so the currency reading, the
 * company profile and the four ids all describe one set of books.
 */
export async function setUpAccounts(
  companyId: string,
  realmId: string = realmFor(companyId),
): Promise<AccountSetupResult> {
  // Before the first request, so a spec that cannot be posted edits nothing.
  assertAccountSpecsPostable();
  // Taken once, before any request: the books every id below must be found in.
  //
  // Reading it once is not enough on its own, and was the first version's
  // mistake: each request below resolves the connection afresh across an
  // await, so a reconnect to different books mid-setup would have sent the
  // remaining requests there while this function still reported the realm it
  // read at the start -- ids from one company saved under another's stamp. So
  // every request is PINNED to it, and a switch part-way refuses the rest.

  const created: string[] = [];
  const reused: string[] = [];
  const ids = {} as Record<AccountRole, string>;

  // Sequential rather than parallel: Intuit caps concurrency per company, and
  // four calls do not need the complexity. Sequential also means a failure
  // leaves a comprehensible partial state — the accounts before it exist, the
  // ones after do not, and re-running finishes the job.
  //
  // Iterates the spec object rather than a literal tuple, so a role added to
  // REQUIRED_ACCOUNTS is created rather than silently skipped. The literal this
  // replaced would have compiled clean and simply never made the income
  // account, leaving revenue permanently unpostable with nothing to explain it.
  for (const role of Object.keys(REQUIRED_ACCOUNTS) as AccountRole[]) {
    const spec = REQUIRED_ACCOUNTS[role];
    const result = await findOrCreateAccount(companyId, spec, realmId);
    ids[role] = result.id;
    (result.created ? created : reused).push(spec.name);
  }

  return {
    realmId,
    expenseAccountId: ids.expense,
    suspenseAccountId: ids.suspense,
    contraAccountId: ids.contra,
    revenueAccountId: ids.revenue,
    created,
    reused,
  };
}

/**
 * Reads the connected company's identity and the currency its books are kept in.
 *
 * TWO CALLS, BECAUSE THE ANSWER LIVES IN TWO PLACES. Identity is on
 * `CompanyInfo`; the home currency is not on that entity at all — it is
 * `Preferences.CurrencyPrefs.HomeCurrency`. The original version of this
 * function read `Country` off CompanyInfo and called it a currency check, which
 * it never was: a US-registered company can keep its books in any currency.
 *
 * CompanyInfo is fetched by its READ endpoint, `GET companyinfo/{realmId}`,
 * not by a query. Intuit's query language does not expose named properties on
 * this entity — `SELECT CompanyName FROM CompanyInfo` is rejected outright with
 * "Property CompanyName not found for Entity CompanyInfo", and only
 * `SELECT * FROM CompanyInfo` parses. Since the only supported query is the one
 * that returns everything anyway, the read endpoint is the honest way to ask,
 * and it cannot silently regress into an unsupported projection later.
 */
interface CompanyInfoReadResponse {
  CompanyInfo?: { CompanyName?: string; LegalName?: string; Country?: string };
}

interface PreferencesQueryResponse {
  QueryResponse?: {
    Preferences?: {
      CurrencyPrefs?: {
        HomeCurrency?: { value?: string };
        MultiCurrencyEnabled?: boolean;
      };
    }[];
  };
}

export interface CompanyProfile {
  name: string | null;
  country: string | null;
  /** From Preferences, not CompanyInfo. `null` if Intuit did not report one. */
  homeCurrency: string | null;
  multiCurrencyEnabled: boolean;
}

/**
 * `expectedRealm`: the books this reading must come from. Omitted, it is the
 * books connected at the start -- and both requests are pinned to that, so a
 * reconnect between them cannot splice one company's name onto another's
 * currency. Null (a record Fuel cannot attribute) is refused.
 */
export async function companyProfile(
  companyId: string,
  expectedRealm?: string | null,
): Promise<CompanyProfile> {
  const realmId = expectedRealm === undefined ? realmFor(companyId) : expectedRealm;
  if (realmId === null) throw new RealmMismatchError();

  // Sequential, matching setUpAccounts: Intuit caps concurrency per company.
  const info = await qboRequest<CompanyInfoReadResponse>(companyId, {
    method: "GET",
    path: `companyinfo/${encodeURIComponent(realmId)}`,
    expectedRealm: realmId,
  });
  const prefs = await qboQuery<PreferencesQueryResponse>(
    companyId,
    "SELECT * FROM Preferences",
    realmId,
  );

  const currencyPrefs = prefs.QueryResponse?.Preferences?.[0]?.CurrencyPrefs;

  return {
    name: info.CompanyInfo?.CompanyName ?? info.CompanyInfo?.LegalName ?? null,
    country: info.CompanyInfo?.Country ?? null,
    homeCurrency: currencyPrefs?.HomeCurrency?.value ?? null,
    multiCurrencyEnabled: currencyPrefs?.MultiCurrencyEnabled === true,
  };
}

/**
 * Refuses a company whose books are not kept in USD.
 *
 * Checked at setup rather than at post time, because discovering it mid-post
 * means discovering it with a document half-built. This slice does no currency
 * conversion, no FX handling and no tax calculation; posting USD amounts into a
 * company whose home currency is something else would silently mis-state every
 * figure at par. See ADR 0008.
 *
 * FAIL CLOSED ON AN ABSENT ANSWER. If Intuit reports no home currency, this
 * refuses rather than assuming USD — the whole value of the check is that it
 * does not guess, and "the field was missing" is not evidence of USD.
 *
 * Multi-currency being *enabled* is not by itself a refusal: a company can have
 * the feature on and still keep its books in USD, and the amounts Fuel posts
 * are denominated in the home currency either way. It is surfaced to the
 * operator rather than acted on.
 */
export function assertPostableCurrency(profile: CompanyProfile): void {
  if (profile.homeCurrency !== SUPPORTED_CURRENCY) {
    throw new UnsupportedCurrencyError(profile.homeCurrency ?? "an unreported currency");
  }
}

/**
 * Reads the company's home currency from QuickBooks, refuses anything but USD,
 * and RECORDS what was found so preview and post can gate on it offline.
 *
 * The evidence is `Preferences.CurrencyPrefs.HomeCurrency` — Intuit's own
 * definition of a company's home currency, and the field its Customer and
 * Vendor references point at when they say "the home currency of the company".
 * Country is NOT evidence of currency and is never consulted for this: a
 * US-registered company can keep its books in anything it likes.
 *
 * Nothing is recorded unless the check passes. A failed verification must leave
 * the previous state alone rather than write a half-answer that later reads as
 * a considered one.
 */
export async function readAndRecordAccountingCurrency(
  companyId: string,
  expectedRealm?: string | null,
): Promise<{ currency: string | null; source: CurrencySource; checkedAt: string }> {
  // Pinned when the caller says which books it means: a post reads the
  // currency of the books its DRAFT was built for, never whichever are
  // connected now. A refusal records nothing.
  const profile = await companyProfile(companyId, expectedRealm);

  // RECORDED WHATEVER IT SAYS, including a currency Fuel cannot post in and
  // including nothing at all. An earlier version saved only on success, which
  // meant a company that had switched to CAD kept a stored "USD, verified"
  // that was now false — the reading had happened and the record disagreed
  // with it. Writing the real answer means the refusal that follows can name
  // the actual currency, and `status` stops claiming something Fuel knows to
  // be untrue. The source is honest either way: this DID come from Preferences.
  const checkedAt = new Date().toISOString();
  saveConfig(companyId, {
    accountingCurrency: profile.homeCurrency,
    currencySource: profile.homeCurrency === null ? null : "quickbooks_preferences",
    currencyCheckedAt: checkedAt,
  });

  return { currency: profile.homeCurrency, source: "quickbooks_preferences", checkedAt };
}

export async function verifyAccountingCurrency(
  companyId: string,
  expectedRealm?: string | null,
): Promise<{ currency: string; source: CurrencySource; checkedAt: string }> {
  const recorded = await readAndRecordAccountingCurrency(companyId, expectedRealm);
  if (recorded.currency !== SUPPORTED_CURRENCY) {
    throw new UnsupportedCurrencyError(recorded.currency ?? "an unreported currency");
  }
  return { currency: recorded.currency, source: recorded.source, checkedAt: recorded.checkedAt };
}
