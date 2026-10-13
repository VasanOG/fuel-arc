/**
 * Turning Fuel's posting lines into a QuickBooks JournalEntry.
 *
 * The rule itself, kept pure — no database, no network, no clock. Same shape as
 * rollup.ts, anomaly.ts and velocity.ts, and for a sharper reason than usual:
 * this produces the literal document that lands in someone's books, so it must
 * be exercisable in full without credentials, a sandbox, or anything reaching
 * Intuit.
 *
 * WHY A JOURNALENTRY AND NOT A PURCHASE. Fuel's engine emits signed whole-cent
 * amounts per account. A JournalEntry is literally a set of signed amounts per
 * account, so the mapping is total: every line the engine can produce — including
 * the negative ones that release a suspense balance — maps with no special case.
 * A Purchase is the more familiar "we paid a vendor" document, but it cannot
 * express a suspense-to-expense reclassification at all, so it would need a
 * second entity type, a second idempotency story and a second failure mode.
 *
 * WHAT IS DELIBERATELY NOT SENT. No Class per agent and no auto-created Vendor
 * per merchant host. Fuel is the source of truth for agent and merchant
 * attribution; QuickBooks gets a clean accounting summary and the detail is
 * reached by drilling back into Fuel. That keeps a customer's chart of accounts,
 * class list and vendor list free of Fuel's internal entities, and removes a
 * silent dependency on QuickBooks Plus/Advanced, which Class tracking requires.
 * See ADR 0008, which supersedes 0007 on this point.
 *
 * Also not sent, per 0006: no transaction hashes, wallet addresses, chain or
 * asset names, and no `payments.detail`. Nothing crypto-shaped crosses into
 * Intuit's records.
 */

import { CENT_BASE_UNITS, LEDGER_CLASSES, type LedgerClass } from "../accounting/rollup.js";
import { baseUnitsToWholeCents } from "../lib/money.js";
import { SUPPORTED_CURRENCY } from "./config.js";

/** The subset of a posting line this mapper needs. Structural, so db types stay in db. */
export interface MappableLine {
  id: string;
  ledgerClass: LedgerClass;
  amountBaseUnits: bigint;
  sourceCount: number;
  /** Only used to describe the entry in prose; never becomes a QuickBooks entity. */
  agentName: string;
  counterparty: string;
  /** Present so a non-USD line can be refused rather than silently posted as USD. */
  currency?: string;
}

/** The QuickBooks account ids a posting writes to. All four must be configured. */
export interface AccountRefs {
  expenseAccountId: string;
  suspenseAccountId: string;
  contraAccountId: string;
  /**
   * Added with the earning side. A company connected before revenue existed
   * has no income account until setUpAccounts runs again — requireAccounts
   * keeps spend posting in that state rather than failing the whole run, so
   * an operator who never asked for the earning side sees no outage. 0012.
   */
  revenueAccountId: string;
}

export interface JournalLine {
  Amount: number;
  DetailType: "JournalEntryLineDetail";
  Description: string;
  JournalEntryLineDetail: {
    PostingType: "Debit" | "Credit";
    AccountRef: { value: string };
  };
}

export interface JournalEntryPayload {
  TxnDate: string;
  DocNumber: string;
  PrivateNote: string;
  CurrencyRef: { value: string };
  Line: JournalLine[];
}

export class UnsupportedCurrencyError extends Error {
  constructor(currency: string) {
    super(
      `Refusing to post: ${currency} is not supported. This integration is ${SUPPORTED_CURRENCY}-only ` +
        `and performs no currency conversion.`,
    );
    this.name = "UnsupportedCurrencyError";
  }
}

/**
 * Base units to the number QuickBooks stores.
 *
 * Every posting line is an exact multiple of a cent by construction
 * (src/accounting/rollup.ts), so this is a lossless two-decimal conversion
 * rather than a rounding. The assertion below is not defensive padding: if a
 * ragged amount ever reached here it would be silently rounded into someone's
 * books, which is the precise failure this whole phase exists to prevent.
 *
 * A JSON number, because that is what the QuickBooks API accepts. The value is
 * derived from an integer count of cents rather than by parsing a decimal
 * string, so no float arithmetic accumulates — and the round-trip is checked.
 */
function toQboAmount(baseUnits: bigint): number {
  if (baseUnits % CENT_BASE_UNITS !== 0n) {
    throw new Error(
      `Refusing to post ${baseUnits} base units: not a whole number of cents. ` +
        `Posting lines must be exact cents — see src/accounting/rollup.ts.`,
    );
  }
  const cents = baseUnits / CENT_BASE_UNITS;
  const amount = Number(cents) / 100;

  if (Math.round(amount * 100) !== Number(cents)) {
    throw new Error(`Refusing to post ${baseUnits} base units: amount does not round-trip`);
  }
  return amount;
}

/**
 * The side a class posts on when its amount is positive.
 *
 * Spend is debit-natural: an expense or a suspense asset increases with a
 * debit. Revenue is credit-natural — income increases with a credit. This is
 * ordinary double-entry, not a Fuel convention.
 *
 * Typed over LedgerClass so adding a class is a compile error here rather
 * than a silent default onto whichever side an `if` fell through to. That
 * matters more than it looks: a class posting on the wrong side still
 * BALANCES (the contra absorbs it), so QuickBooks would accept the entry and
 * the mis-statement would only surface when someone read the books.
 */
const NATURAL_SIDE: Record<LedgerClass, "Debit" | "Credit"> = {
  expense: "Debit",
  suspense: "Debit",
  revenue: "Credit",
};

function opposite(side: "Debit" | "Credit"): "Debit" | "Credit" {
  return side === "Debit" ? "Credit" : "Debit";
}

/**
 * A signed amount becomes a direction plus a magnitude.
 *
 * QuickBooks carries direction in `PostingType` and rejects a negative
 * `Amount`, which is why the engine's negatives need no separate
 * reclassification path — they are simply credits.
 *
 * DIRECTION IS A PROPERTY OF THE CLASS, NOT OF THE SIGN. This used to be
 * `baseUnits > 0n ? "Debit" : "Credit"`, which was correct only because every
 * class then in existence was debit-natural, so "positive" and "debit"
 * coincided. Revenue breaks the coincidence.
 *
 * The alternative — storing revenue as negative and keeping the sign rule —
 * was rejected in 0012: `amount_base_units` already uses negative to mean
 * "the credit half of a reclassification", and one column meaning both that
 * and "this is revenue" makes `SUM` unreadable in either direction.
 *
 * A positive amount posts on its natural side; a negative one (a reclass
 * unwind) posts opposite. That generalises the old rule exactly rather than
 * replacing it.
 */
function directionFor(ledgerClass: LedgerClass, baseUnits: bigint): "Debit" | "Credit" {
  const natural = NATURAL_SIDE[ledgerClass];
  return baseUnits > 0n ? natural : opposite(natural);
}

/**
 * The class's contribution to the entry's net debit position.
 *
 * Debit-natural classes count as written; credit-natural ones count negated.
 * This is what the contra line balances against, and it is why a day of equal
 * spend and revenue produces no contra line: the Fuel balance genuinely did
 * not move.
 */
function signedDebit(ledgerClass: LedgerClass, baseUnits: bigint): bigint {
  return NATURAL_SIDE[ledgerClass] === "Debit" ? baseUnits : -baseUnits;
}

/**
 * "1 receipt", "8 receipts", "3 counterparties".
 *
 * The "N thing(s)" form this replaces was tolerable while every noun was
 * regular. `counterparty(s)` is not a word, and under 0008 §5 a posted entry is
 * never edited — so the awkwardness would be permanent in every document from
 * the first one onward. The irregular plural is passed explicitly rather than
 * derived, because a general pluraliser is a much larger promise than this
 * needs.
 */
function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function magnitude(baseUnits: bigint): bigint {
  return baseUnits < 0n ? -baseUnits : baseUnits;
}

export interface BuildParams {
  lines: MappableLine[];
  accounts: AccountRefs;
  docNumber: string;
  /** The day the entry is dated, YYYY-MM-DD. */
  txnDate: string;
  /**
   * A stable handle an operator can use to find this rollup back in Fuel. It
   * goes in PrivateNote, which is the only place QuickBooks will keep a
   * free-text reference that survives as long as the entry does.
   */
  fuelReference: string;
}

/**
 * Builds the entry, or throws.
 *
 * Aggregates by ACCOUNT rather than emitting a line per Fuel posting line,
 * because without a per-agent Class there is nothing to distinguish two lines
 * hitting the same account — they would read as an unexplained split. The
 * per-agent detail is preserved in Fuel and reachable through the draft's line
 * set, which is the deliberate division of labour described at the top.
 */
export function buildJournalEntry(params: BuildParams): JournalEntryPayload {
  const { lines, accounts, docNumber, txnDate, fuelReference } = params;

  if (lines.length === 0) {
    throw new Error("Refusing to build a journal entry with no lines");
  }

  // USD only, checked before anything is computed. This slice performs no
  // currency conversion, no FX handling and no tax calculation; a non-USD line
  // is refused rather than posted at par, which would be a silent
  // mis-statement. See ADR 0008.
  for (const line of lines) {
    const currency = line.currency ?? SUPPORTED_CURRENCY;
    if (currency !== SUPPORTED_CURRENCY) throw new UnsupportedCurrencyError(currency);
  }

  const totals: Record<LedgerClass, bigint> = { expense: 0n, suspense: 0n, revenue: 0n };
  const sources: Record<LedgerClass, number> = { expense: 0, suspense: 0, revenue: 0 };
  for (const line of lines) {
    totals[line.ledgerClass] += line.amountBaseUnits;
    sources[line.ledgerClass] += line.sourceCount;
  }

  const accountFor: Record<LedgerClass, string> = {
    expense: accounts.expenseAccountId,
    suspense: accounts.suspenseAccountId,
    revenue: accounts.revenueAccountId,
  };
  const labelFor: Record<LedgerClass, string> = {
    expense: "Agent API spend",
    suspense: "Unconfirmed agent payments",
    revenue: "Agent API revenue",
  };
  /*
   * THE WORD FOR WHAT A LINE IS MADE OF, PER CLASS.
   *
   * The field behind this was `paymentCount` and it counted `ep.payment_id`,
   * which is NULL on every revenue absorption — so the first real revenue
   * document would have read "Agent API revenue — 0 payment(s)". Both halves of
   * that were wrong: the number, fixed by `sourceCount`, and the noun.
   *
   * ONE FLAT WORD LIKE "source(s)" WAS REJECTED. It would be accurate and it
   * would read as machine output in a document a person reconciles against.
   * 0008's whole argument for what reaches QuickBooks is legibility to an
   * accountant, and under 0008 §5 a posted entry is never edited — so the word
   * chosen here is permanent from the first revenue document onward.
   *
   * A Record over LedgerClass rather than a ternary, so a new class has to be
   * given a word rather than inheriting whichever branch the else led to.
   */
  const nounFor: Record<LedgerClass, string> = {
    expense: "payment",
    suspense: "payment",
    revenue: "receipt",
  };

  const journalLines: JournalLine[] = [];

  // Iterates LEDGER_CLASSES, not a literal tuple. The literal
  // `["expense", "suspense"] as const` this replaced compiled clean when the
  // union widened and would simply have stopped emitting the new class —
  // revenue lines would have vanished from the entry with no error, and the
  // contra would have silently absorbed them into the funding account.
  for (const ledgerClass of LEDGER_CLASSES) {
    const total = totals[ledgerClass];
    // A class that nets to zero contributes nothing. Emitting a zero line would
    // be noise in a ledger, and QuickBooks would reject it anyway.
    if (total === 0n) continue;

    journalLines.push({
      Amount: toQboAmount(magnitude(total)),
      DetailType: "JournalEntryLineDetail",
      Description: `${labelFor[ledgerClass]} — ${plural(sources[ledgerClass], nounFor[ledgerClass])}`,
      JournalEntryLineDetail: {
        PostingType: directionFor(ledgerClass, total),
        AccountRef: { value: accountFor[ledgerClass] },
      },
    });
  }

  // The balancing line. QuickBooks refuses an entry whose debits and credits
  // differ (error -2300), so the contra account absorbs whatever the account
  // lines leave over.
  //
  // The contra account is the Fuel balance, and this line is how much that
  // balance moved. Spend draws it down; revenue tops it up. So the figure to
  // balance against is the entry's NET DEBIT POSITION — each class counted on
  // its natural side — not a bare sum across classes, which would add a credit
  // to a debit and get the direction wrong the moment revenue exists.
  //
  // WHEN THE SIGNED TOTAL IS ZERO, NO CONTRA LINE IS EMITTED, because the Fuel
  // balance did not move. TWO DIFFERENT SITUATIONS PRODUCE THAT, and it is
  // worth knowing they are different:
  //
  //   - A pure reclassification: money moving from suspense into expenses once
  //     a payment settles. Both sides are debit-natural and cancel.
  //   - A day whose spend and revenue happen to be equal. Two real movements
  //     that offset.
  //
  // Neither touches the funding account, so no contra line is correct in both.
  // An earlier version of this comment claimed a zero net WAS a reclassification
  // — true when every class was debit-natural, false as soon as revenue was
  // added. The arithmetic did not change; the reason did, and a correct
  // behaviour explained by a stale reason is what the next person reasons from.
  const netDebit = LEDGER_CLASSES.reduce(
    (sum, ledgerClass) => sum + signedDebit(ledgerClass, totals[ledgerClass]),
    0n,
  );
  if (netDebit !== 0n) {
    journalLines.push({
      Amount: toQboAmount(magnitude(netDebit)),
      DetailType: "JournalEntryLineDetail",
      // A net debit means the balance was drawn down to fund spend; a net
      // credit means money arrived into it. Saying "funded from" in both
      // directions would describe an inflow as an outflow.
      Description: netDebit > 0n ? "Funded from Fuel balance" : "Received into Fuel balance",
      JournalEntryLineDetail: {
        // Opposite the net: a net debit to the expense side is funded by a
        // credit here.
        PostingType: netDebit > 0n ? "Credit" : "Debit",
        AccountRef: { value: accounts.contraAccountId },
      },
    });
  }

  const totalSources = LEDGER_CLASSES.reduce((sum, c) => sum + sources[c], 0);
  const agents = new Set(lines.map((line) => line.agentName)).size;
  const counterparties = new Set(lines.map((line) => line.counterparty)).size;
  // Every line in a document shares a direction (eligibleLines guarantees it),
  // so the first line's noun speaks for all of them.
  const entryNoun = nounFor[lines[0]!.ledgerClass];

  return {
    TxnDate: txnDate,
    DocNumber: docNumber,
    // The only free-text field QuickBooks keeps for the life of the entry, so
    // it carries the handle back to Fuel. Counts rather than names: an entry
    // summarising 40 agents should not become a 40-name paragraph, and the
    // names are one drill-down away.
    // A document holds one direction, so one noun is correct for the whole of
    // it — every line here is either spend or revenue, never both. And
    // "counterparty" replaces "vendor" for the reason 0012 gives about the CSV
    // header: the other party is a vendor only on the spend side.
    PrivateNote:
      `Fuel rollup ${txnDate} — ${plural(totalSources, entryNoun)}, ${plural(agents, "agent")}, ` +
      `${plural(counterparties, "counterparty", "counterparties")}. Full detail in Fuel: ${fuelReference}`,
    CurrencyRef: { value: SUPPORTED_CURRENCY },
    Line: journalLines,
  };
}

/**
 * Proves an entry balances before it is sent.
 *
 * QuickBooks would reject an unbalanced entry anyway, so this is not about
 * avoiding an error — it is about finding out on our side of the wire, where
 * the failure names the Fuel lines that produced it instead of arriving as
 * Intuit's error -2300 with no context. Returns the two totals so a caller can
 * report the discrepancy rather than just its existence.
 */
export function assertBalanced(payload: JournalEntryPayload): {
  debits: number;
  credits: number;
} {
  let debits = 0;
  let credits = 0;
  for (const line of payload.Line) {
    if (line.Amount < 0) {
      throw new Error(`Refusing to post a negative Amount (${line.Amount}) — use PostingType`);
    }
    // Accumulated in integer cents. Summing the float amounts directly is how
    // an entry that should balance ends up off by a hundredth of a cent.
    const cents = Math.round(line.Amount * 100);
    if (line.JournalEntryLineDetail.PostingType === "Debit") debits += cents;
    else credits += cents;
  }

  if (debits !== credits) {
    throw new Error(
      `Refusing to post an unbalanced entry: debits ${debits / 100} vs credits ${credits / 100}`,
    );
  }
  return { debits: debits / 100, credits: credits / 100 };
}

/** The two-decimal string form, for anything a human reads. */
export function describeAmount(baseUnits: bigint): string {
  return baseUnitsToWholeCents(baseUnits);
}
