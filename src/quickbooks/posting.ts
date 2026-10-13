/**
 * Preview, post, and correct — the three operator actions, and the rules that
 * keep them honest.
 *
 * Preview freezes a draft. Post sends that exact frozen payload and nothing
 * else. A correction is always a NEW entry linked to the one it corrects; a
 * posted document is never edited or replaced.
 *
 * None of this runs on a timer. Posting to someone's books is a decision, and
 * the only thing that should make it happen is a person choosing it.
 */
import { listPostingLines, type PostingLine } from "../db/postings.js";
import {
  AccountsFromOtherBooksError,
  currencyBlocker,
  getConfig,
  getConnection,
  missingAccounts,
  missingRevenueAccounts,
  type QboConfig,
} from "../db/qbo.js";
import { readAndRecordAccountingCurrency } from "./accounts.js";
import {
  beginPosting,
  createDraft,
  draftReadiness,
  eligibleLines,
  getDraftInCompany,
  getPostingInCompany,
  markPosted,
  markPostingAbandoned,
  markPostingFailed,
  notePostingUncertainty,
  correctionCount,
  postedGeneration,
  type PostingDraft,
  type QboPosting,
} from "../db/qbo-postings.js";
import {
  DUPLICATE_DOC_NUMBER_CODE,
  NotConnectedError,
  QboApiError,
  qboQuery,
  qboRequest,
  RealmMismatchError,
  escapeQueryValue,
} from "./client.js";
import { correctionDocNumberFor, docNumberFor } from "./config.js";
import { directionOf, type PostingDirection } from "../accounting/rollup.js";
import {
  assertBalanced,
  buildJournalEntry,
  type JournalEntryPayload,
  type MappableLine,
} from "./journal.js";

/**
 * What a preview covers.
 *
 * `daily` spans every counterparty; `counterparty_day` one of them. `direction`
 * is REQUIRED and has no default: spend and revenue are separate documents
 * (0012), and a scope that did not say which one it meant would have to guess.
 */
export interface PreviewScope {
  direction: PostingDirection;
  postingDay: string;
  counterparty?: string | null;
}

function toMappable(line: PostingLine): MappableLine {
  return {
    id: line.id,
    ledgerClass: line.ledgerClass,
    amountBaseUnits: line.amountBaseUnits,
    sourceCount: line.sourceCount,
    agentName: line.agentName,
    counterparty: line.counterparty,
  };
}

export class NotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`QuickBooks posting is not configured yet — missing: ${missing.join(", ")}`);
    this.name = "NotConfiguredError";
  }
}

/**
 * No eligible lines — but WHY matters, so the two causes are not merged.
 *
 * "Nothing happened that day" and "everything that happened is already booked"
 * call for opposite reactions: the first means look at a different day or run
 * the rollup, the second means the work is done. The original message asserted
 * the second unconditionally, so an empty day reported itself as already
 * committed and sent a reader hunting for a posting that did not exist.
 *
 * The same distinction the rollup run already draws when it reports zero lines.
 */
export class NothingToPostError extends Error {
  constructor(day: string, linesInScope: number) {
    super(
      linesInScope === 0
        ? `Nothing to post for ${day}: no rollup lines exist for that day. ` +
            `Either no payments settled then, or the rollup has not been run since they did.`
        : `Nothing to post for ${day}: all ${linesInScope} line(s) for that scope are ` +
            `already committed to a posted or in-flight document.`,
    );
    this.name = "NothingToPostError";
  }
}

/**
 * The USD-only scope gate.
 *
 * Its own error type, not folded into NotConfiguredError, because the two are
 * different problems with different fixes: a missing account is something an
 * operator sets, an unverified or non-USD currency is something they cannot
 * set at all. Blurring them would offer a remedy that does not exist.
 */
export class CurrencyScopeError extends Error {
  constructor(reason: string) {
    super(`Refusing to build a QuickBooks document: ${reason}.`);
    this.name = "CurrencyScopeError";
  }
}

function requireUsdScope(config: QboConfig): void {
  const blocker = currencyBlocker(config);
  if (blocker !== null) throw new CurrencyScopeError(blocker);
}

/**
 * Re-reads the home currency from QuickBooks and refuses unless it is USD RIGHT
 * NOW. Slice 2d.
 *
 * The stored verification that preview gates on is a fact with a timestamp, and
 * facts about someone else's system go stale. A company can switch its home
 * currency between setup and post; every figure Fuel then wrote would be
 * mis-stated at par, in books someone reconciles against.
 *
 * WHY HERE AND NOT IN PREVIEW. Preview sends nothing to QuickBooks, and that is
 * load-bearing: it is what makes "did that reach Intuit?" answerable without
 * ambiguity, and it is why preview and post are separate routes rather than one
 * route with a dryRun flag. A network call in preview would trade that clarity
 * for a freshness guarantee that post can provide anyway. So preview gates on
 * the record, and the record is re-established here, at the only moment it has
 * to be true.
 *
 * ORDERING IS THE WHOLE POINT. This runs before `beginPosting`, so a refusal
 * creates no attempt row, mints no requestid, and sends no JournalEntry. A
 * refused post must be indistinguishable from a post that never happened —
 * otherwise the fail-closed `pending` state would fill with attempts that never
 * had any chance of being sent.
 *
 * The reading is recorded even when it refuses, so `status` afterwards reports
 * the currency Fuel actually found rather than the stale one it used to hold.
 */
async function requireFreshUsdScope(companyId: string, realmId: string | null): Promise<void> {
  // PINNED to the books the document is for (7A-3). This is the first request
  // a post or a reversal makes, so it is also the first place a document made
  // for other books is refused -- before anything else is sent anywhere.
  await readAndRecordAccountingCurrency(companyId, realmId);
  requireUsdScope(getConfig(companyId));
}

/**
 * The account ids a posting writes to.
 *
 * `missingAccounts` deliberately reports only the accounts a SPEND posting
 * needs, so a company connected before the earning side shipped keeps posting
 * exactly as it did — an operator who never asked for revenue should not get
 * an outage because a new account has not been created yet. 0012.
 *
 * The revenue id is therefore allowed to be absent here and is passed as an
 * empty string. That is safe only because a company with no income account
 * also has no receipts and so produces no revenue lines: buildJournalEntry
 * skips a class whose total is zero, so the empty id is never read. If revenue
 * lines could exist without an account, this would need to refuse instead —
 * which is why `preview` asserts exactly that below, before building anything.
 */
function requireAccounts(config: QboConfig) {
  const missing = missingAccounts(config);
  if (missing.length > 0) throw new NotConfiguredError(missing);
  return {
    expenseAccountId: config.expenseAccountId!,
    suspenseAccountId: config.suspenseAccountId!,
    contraAccountId: config.contraAccountId!,
    revenueAccountId: config.revenueAccountId ?? "",
  };
}

/**
 * Builds a draft for a scope and freezes it.
 *
 * The payload is built from the lines that are eligible RIGHT NOW — lines not
 * already committed to a posted or in-flight document — and then stored
 * verbatim. Everything after this reads the stored bytes; nothing recomputes.
 */
export function preview(companyId: string, scope: PreviewScope): PostingDraft {
  const config = getConfig(companyId);
  // Before the accounts check and before any line is read: if this company is
  // out of scope, nothing about it should be turned into a document at all.
  requireUsdScope(config);
  const accounts = requireAccounts(config);

  /*
   * THE ACCOUNT IDS MUST BELONG TO THE BOOKS CONNECTED NOW (7A-3).
   *
   * The payload is built from these ids and nothing else, and an id is a small
   * per-company integer: one read from other books often names a DIFFERENT,
   * real account here, and the entry would be accepted with no error anywhere.
   * So a mapping whose stamp is not the connected realm -- or is null, which
   * means Fuel cannot say where the ids came from -- builds nothing. Preview
   * sends nothing to Intuit, so this is decided from the record; account setup
   * is how the record is re-made.
   */
  const connection = getConnection(companyId);
  if (!connection) throw new NotConnectedError();
  if (config.accountsRealmId !== connection.realmId) throw new AccountsFromOtherBooksError();

  const grain = config.rollupGrain;
  const lineIds = eligibleLines({
    companyId,
    direction: scope.direction,
    grain,
    postingDay: scope.postingDay,
    counterparty: scope.counterparty ?? null,
  });
  // Filtered by direction too, not only by grain. This set exists to explain an
  // empty result -- "nothing happened that day" versus "all of it is already
  // booked" -- and counting the OTHER direction's lines would answer that
  // question with a number about a different document.
  const inScope = listPostingLines({
    companyId,
    from: scope.postingDay,
    to: scope.postingDay,
  }).filter(
    (line) =>
      directionOf(line.ledgerClass) === scope.direction &&
      (grain !== "counterparty_day" || line.counterparty === scope.counterparty),
  );

  // Counted only to explain an empty result, never to widen it: the payload is
  // still built strictly from `eligibleLines`.
  if (lineIds.length === 0) throw new NothingToPostError(scope.postingDay, inScope.length);

  const eligible = new Set(lineIds);
  const lines = inScope.filter((line) => eligible.has(line.id));

  /*
   * THE DRAFT'S LINE SET IS THE PAYLOAD'S LINE SET, DERIVED RATHER THAN
   * REPEATED.
   *
   * `createDraft` used to be handed the raw `lineIds` above while the payload
   * was built from `lines`. Those were the same set only because both reads
   * were unscoped in the same way; the moment `inScope` gained a company
   * predicate and `eligibleLines` had not yet, they diverged — and the draft
   * would have persisted another company's line ids into `qbo_draft_lines` and
   * hashed their amounts into its own `source_fingerprint`, while sending a
   * correct payload to Intuit.
   *
   * That divergence is worse than it sounds. Posting a draft marks every line
   * it holds as consumed, and the exclusion is global by design (see
   * `eligibleLines`), so the other company's lines would become permanently
   * unpostable with no route to release them: reversal is scoped to the
   * posting's own company, so the company that owns the stranded lines cannot
   * reach them.
   *
   * Both halves are fixed — `eligibleLines` is company-scoped now — but this
   * line is what makes the two sets incapable of disagreeing rather than
   * merely equal today.
   */
  const draftLineIds = lines.map((line) => line.id);

  // The pairing requireAccounts relies on, asserted rather than assumed.
  //
  // `missingAccounts` deliberately does not require an income account, so a
  // company connected before the earning side shipped keeps posting spend
  // instead of stalling. That is only safe while such a company has no revenue
  // lines — and "no receipts yet" is a fact about today's data, not a
  // guarantee. If a revenue line ever reaches a company with no income account,
  // the empty account id in requireAccounts would be sent to Intuit as a real
  // AccountRef. Refuse instead: an un-upgraded company should see a clear
  // "run account setup" rather than a rejected document or, worse, an accepted
  // one pointing at nothing.
  if (!config.revenueAccountId && lines.some((line) => line.ledgerClass === "revenue")) {
    throw new NotConfiguredError(missingRevenueAccounts(config));
  }

  const counterparty = grain === "counterparty_day" ? (scope.counterparty ?? null) : null;

  // The generation is what keeps a re-post after a reversal from colliding with
  // the entry it replaced — a reversed document keeps its number in QuickBooks.
  // Zero for a first posting, so the common case reads as the plain scope.
  //
  // DIRECTION IS PART OF THE KEY. Without it `daily:2026-09-01` names both the
  // spend document and the revenue document for that day, and worse, posting
  // one would bump the other's generation -- two documents fighting over one
  // counter, each renumbering the other. 0012.
  const generation = postedGeneration({
    companyId,
    direction: scope.direction,
    grain,
    postingDay: scope.postingDay,
    counterparty,
  });
  const base =
    grain === "counterparty_day"
      ? `${scope.direction}:counterparty_day:${scope.counterparty}:${scope.postingDay}`
      : `${scope.direction}:daily:${scope.postingDay}`;
  const docNumber = docNumberFor(companyId, generation === 0 ? base : `${base}#${generation}`);

  const payload = buildJournalEntry({
    lines: lines.map(toMappable),
    accounts,
    docNumber,
    txnDate: scope.postingDay,
    // Points back at Fuel. The draft id is not known until the row exists, so
    // the document number is used instead — it is deterministic, unique per
    // scope, and is what an operator would search Fuel for anyway.
    fuelReference: docNumber,
  });

  // Proved on our side of the wire so the failure names Fuel's lines rather
  // than arriving later as Intuit's error -2300 with no context.
  assertBalanced(payload);

  return createDraft({
    companyId,
    direction: scope.direction,
    grain,
    postingDay: scope.postingDay,
    counterparty,
    docNumber,
    payload,
    lineIds: draftLineIds,
    // The books this draft is built for: the connected ones, which the check
    // above has just shown its account ids belong to.
    realmId: connection.realmId,
  });
}

export class DraftNotPostableError extends Error {
  constructor(reason: string) {
    super(`This preview can no longer be posted: ${reason}`);
    this.name = "DraftNotPostableError";
  }
}

interface JournalEntryResponse {
  JournalEntry?: { Id?: string; SyncToken?: string; DocNumber?: string };
}

interface JournalEntryQueryResponse {
  QueryResponse?: { JournalEntry?: { Id?: string; SyncToken?: string; DocNumber?: string }[] };
}

/**
 * Sends a reviewed draft to QuickBooks.
 *
 * The sequence matters and is the same shape as the payment path: reserve the
 * attempt (with its idempotency key) BEFORE the request exists, so a crash
 * mid-flight leaves a record saying "a document may exist and here is the key
 * to resolve it with". Then send. Only a confirmed response marks it posted.
 *
 * A failure that provably had no effect is marked `failed` and releases
 * nothing, because a draft that never posted is still postable. Anything that
 * MIGHT have landed stays `pending` — fail closed, exactly as `unreconciled`
 * does for a signed payment whose outcome we never saw.
 */
export async function post(companyId: string, draft: PostingDraft): Promise<QboPosting> {
  // Pinned to the draft's books: a draft made for other books is refused here,
  // by the choke point, with nothing sent.
  await requireFreshUsdScope(companyId, draft.realmId);

  // Readiness includes the realm again, AFTER the await: the connection can
  // move while the currency is being read, and this is the last check before
  // an attempt row exists. See draftReadiness.
  const readiness = draftReadiness(draft);
  if (!readiness.ok) throw new DraftNotPostableError(readiness.reason);

  // The DRAFT's books, not whichever are connected now. The payload carries
  // the account ids of the books it was built for, and the attempt records
  // where it is going so it can later be found, reconciled and reversed there.
  const attempt = beginPosting({ companyId, draft, realmId: draft.realmId });
  // Already confirmed by an earlier call — return it rather than sending again.
  if (attempt.status === "posted") return attempt;

  return send(companyId, attempt, draft.payload);
}

/**
 * The shared send-and-resolve path, used by both a first post and a retry.
 *
 * `requestid` makes an operator-chosen retry safe: Intuit replays the original
 * response rather than creating a second document. That only holds within
 * Intuit's replay window, which is why a duplicate-document-number fault is
 * treated as success-in-disguise below rather than as an error.
 */
async function send(
  companyId: string,
  attempt: QboPosting,
  payload: JournalEntryPayload,
): Promise<QboPosting> {
  try {
    const response = await qboRequest<JournalEntryResponse>(companyId, {
      method: "POST",
      path: "journalentry",
      body: payload,
      requestId: attempt.requestId,
      // The attempt's books, recorded before this request existed. The
      // backstop behind post's and postReversal's own checks.
      expectedRealm: attempt.realmId,
    });

    const entityId = response.JournalEntry?.Id;
    if (!entityId) {
      // A 2xx with no id is not something to guess about: the document may
      // exist. Stay pending.
      notePostingUncertainty(attempt.id, "QuickBooks accepted the entry but returned no id");
      return getPostingInCompany(attempt.id, companyId)!;
    }

    markPosted({
      postingId: attempt.id,
      qboEntityId: entityId,
      qboSyncToken: response.JournalEntry?.SyncToken ?? null,
      payload,
    });
    return getPostingInCompany(attempt.id, companyId)!;
  } catch (error) {
    if (error instanceof RealmMismatchError) {
      // NEVER marked failed. Nothing was sent this time -- but this may be a
      // retry of an attempt that already landed in its OWN books, and
      // releasing its lines would book that spend a second time. It stays
      // pending, which is the fail-closed reading, until the books it was made
      // in are connected again and it can be reconciled there.
      notePostingUncertainty(attempt.id, error.message);
      throw error;
    }
    if (!(error instanceof QboApiError)) throw error;

    // A duplicate document number means a previous attempt DID create this
    // entry, beyond the replay window. That is not a failure — it is the
    // idempotency guarantee working one layer down. Find the document and
    // adopt it rather than reporting an error an operator would try to fix by
    // posting again.
    //
    // THE LOOKUP IS PINNED TO THE ATTEMPT'S BOOKS (7A-3). Asked of other books,
    // it finds nothing, and the 4xx below would mark the attempt failed and
    // release its lines -- while the document it collided with sits in the
    // books it was really sent to. A mismatch here is handled exactly like the
    // one above: noted, left pending, never failed.
    if (error.code === DUPLICATE_DOC_NUMBER_CODE) {
      let existing: { Id?: string; SyncToken?: string } | null;
      try {
        existing = await findByDocNumber(companyId, attempt.docNumber, attempt.realmId);
      } catch (lookupError) {
        if (lookupError instanceof RealmMismatchError) {
          notePostingUncertainty(attempt.id, lookupError.message);
        }
        throw lookupError;
      }
      if (existing?.Id) {
        markPosted({
          postingId: attempt.id,
          qboEntityId: existing.Id,
          qboSyncToken: existing.SyncToken ?? null,
          payload,
        });
        return getPostingInCompany(attempt.id, companyId)!;
      }
    }

    if (error.definitelyNoEffect) {
      markPostingFailed(attempt.id, error.message);
    } else {
      // Might have landed. Fail closed: stay pending so a retry reuses the key.
      notePostingUncertainty(attempt.id, error.message);
    }
    throw error;
  }
}

/**
 * Looks up a document by its deterministic number — how a `pending` is resolved.
 *
 * `realmId` IS REQUIRED: the books the document was sent to. "Not found" is
 * only evidence of absence when asked of those books -- asked of any other,
 * it is certain, and wrong.
 */
export async function findByDocNumber(
  companyId: string,
  docNumber: string,
  realmId: string | null,
): Promise<{ Id?: string; SyncToken?: string } | null> {
  const response = await qboQuery<JournalEntryQueryResponse>(
    companyId,
    `SELECT Id, SyncToken, DocNumber FROM JournalEntry WHERE DocNumber = '${escapeQueryValue(docNumber)}'`,
    realmId,
  );
  return response.QueryResponse?.JournalEntry?.[0] ?? null;
}

/**
 * Resolves an attempt whose outcome was never confirmed.
 *
 * Asks QuickBooks whether the document exists, which the deterministic
 * DocNumber makes answerable at any distance in time. This is the only safe way
 * out of `pending`: guessing costs either a duplicated expense or a missing one.
 */
export async function reconcilePending(
  companyId: string,
  attempt: QboPosting,
): Promise<QboPosting> {
  /*
   * ASKED OF THE BOOKS THE ATTEMPT WAS SENT TO, and only those (7A-3).
   *
   * This was the double-booking path. Before the realm was recorded, a company
   * reconnected to different books would ask THEM for the document, get
   * nothing back, and take the branch below: marked failed, lines released,
   * and the next preview books the same spend again -- while the first copy
   * may sit in the old books. Now the question can only be put to the right
   * books; with anything else connected it is refused before it is asked, and
   * the attempt stays pending with its lines held.
   */
  let existing: { Id?: string; SyncToken?: string } | null;
  try {
    existing = await findByDocNumber(companyId, attempt.docNumber, attempt.realmId);
  } catch (error) {
    // Left pending, as every realm refusal is -- and the reason written onto
    // the posting, as send() does, so an operator reading the postings list
    // sees why it is still unresolved rather than only that it is.
    if (error instanceof RealmMismatchError) notePostingUncertainty(attempt.id, error.message);
    throw error;
  }

  /*
   * FROM HERE ON, QUICKBOOKS HAS ANSWERED. Whatever goes wrong below is Fuel
   * failing to RECORD a real answer, and it is reported as exactly that
   * (AnsweredButNotRecordedError) rather than escaping as a plain Error.
   *
   * The distinction is load-bearing for the write-off (7A-3 item 3): it treats
   * any plain failure as "QuickBooks could not be asked", and a bookkeeping
   * failure after a real "it exists" would otherwise let an owner write off a
   * document QuickBooks had just confirmed -- with evidence text that never
   * says so. Found in security review.
   */
  const found = Boolean(existing?.Id);
  try {
    if (!existing?.Id) {
      // Proven not to exist. The attempt genuinely had no effect, so its lines
      // become eligible again and the draft can be posted afresh.
      markPostingFailed(attempt.id, "no document with this number exists in QuickBooks");
      return getPostingInCompany(attempt.id, companyId)!;
    }

    // The document exists, so record what was sent to produce it. That is the
    // draft's frozen payload — this attempt never stored one of its own, which is
    // exactly why it was left pending. Reading it back rather than reconstructing
    // it keeps the audit record honest: it is the reviewed bytes, not a guess
    // assembled after the fact.
    const draft = getDraftInCompany(attempt.draftId, companyId);
    if (!draft) {
      throw new Error(`Cannot reconcile posting ${attempt.id}: its draft is missing`);
    }

    markPosted({
      postingId: attempt.id,
      qboEntityId: existing.Id,
      qboSyncToken: existing.SyncToken ?? null,
      payload: draft.payload,
    });
    return getPostingInCompany(attempt.id, companyId)!;
  } catch (error) {
    console.error(`[quickbooks] reconcile answered but not recorded: ${(error as Error).message}`);
    throw new AnsweredButNotRecordedError(found);
  }
}

/**
 * QuickBooks answered a reconcile, and Fuel then failed to record the answer.
 * The posting is still pending; nothing was changed. The cause is logged
 * server-side, not carried here, because it may be database detail.
 */
export class AnsweredButNotRecordedError extends Error {
  constructor(readonly found: boolean) {
    super(
      `QuickBooks answered that the document ${found ? "exists" : "does not exist"}, but Fuel could ` +
        "not record that answer. The posting is unchanged; reconcile it again.",
    );
    this.name = "AnsweredButNotRecordedError";
  }
}

/** QuickBooks could be asked, and answered -- so there is nothing to write off. */
export class QuickBooksAnsweredError extends Error {
  constructor(readonly posting: QboPosting) {
    super(
      `QuickBooks could be asked about this posting, and answered: it is now ${posting.status}. ` +
        "Nothing was written off.",
    );
    this.name = "QuickBooksAnsweredError";
  }
}

/** A write-off that must not happen, for a reason the message states. Nothing was written. */
export class WriteOffRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteOffRefusedError";
  }
}

/**
 * The owner's way out when a pending posting's books are gone for good (7A-3
 * item 3, ADR 0016).
 *
 * QUICKBOOKS IS ASKED FIRST, EVERY TIME. A write-off is only for a question that
 * cannot be put. So this runs an ordinary reconcile before anything else:
 *
 *   - QuickBooks answers (found, or not found) -> that answer stands. The
 *     posting is resolved exactly as a reconcile resolves it, and the write-off
 *     is refused. An owner cannot overrule a real answer, and cannot write off a
 *     posting whose books are perfectly reachable.
 *   - QuickBooks refuses the LOOKUP itself (a 4xx other than 401/403/429) ->
 *     refused. It was reachable; the fault is Fuel's, not lost books. This
 *     rests on qboRequest's existing reading of Intuit's 4xx answers.
 *   - Anything else -> Fuel could not ask: the connection points at other
 *     books, there is none, the token could not be refreshed, 401/403, or the
 *     network, a 429 or a 5xx. What was seen is recorded as the evidence.
 *
 * DELIBERATELY NOT a judgement of which failures are permanent. Fuel cannot
 * tell a revoked connection from a bad afternoon at Intuit, and guessing would
 * build in an assumption about someone else's error messages. So a transient
 * outage allows a write-off too. The owner's judgement covers the difference,
 * and the evidence records what they were looking at. Misused, the cost is low:
 * the lines stay held, and a reconcile in the same books still resolves it.
 *
 * WHAT A WRITE-OFF CHANGES: the guard on changing books and the
 * needs-reconciliation list stop waiting for this posting. WHAT IT DOES NOT: its
 * status (still pending), its lines (still held), its number (still taken).
 */
export async function writeOffPending(
  companyId: string,
  attempt: QboPosting,
  params: { userId: string; reason: string },
): Promise<QboPosting> {
  if (attempt.status !== "pending") {
    throw new WriteOffRefusedError(
      `This posting is ${attempt.status}; only a posting whose outcome is unknown can be written off.`,
    );
  }
  if (attempt.abandonedAt !== null) {
    throw new WriteOffRefusedError("This posting has already been written off.");
  }

  let answered: QboPosting | null = null;
  let evidence = "";
  try {
    answered = await reconcilePending(companyId, attempt);
  } catch (error) {
    // QuickBooks DID answer; Fuel failed to write the answer down. That is the
    // opposite of lost books, and must never be written off as them.
    if (error instanceof AnsweredButNotRecordedError) {
      throw new WriteOffRefusedError(
        `${error.message} Its books are reachable, so nothing was written off.`,
      );
    }
    if (
      error instanceof QboApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 401 &&
      error.status !== 403 &&
      error.status !== 429
    ) {
      throw new WriteOffRefusedError(
        "QuickBooks was reachable and refused the lookup, so its books are not lost and nothing " +
          "was written off. This needs looking at on Fuel's side.",
      );
    }
    evidence = error instanceof Error ? error.message : String(error);
  }
  // Outside the try, so this refusal is not mistaken for "could not ask".
  if (answered) throw new QuickBooksAnsweredError(answered);

  const written = markPostingAbandoned({
    postingId: attempt.id,
    userId: params.userId,
    reason: params.reason,
    evidence: evidence || "QuickBooks could not be asked (no detail was given)",
  });
  const now = getPostingInCompany(attempt.id, companyId)!;
  if (!written) {
    // Something got there while QuickBooks was being tried: a reconcile, or
    // another owner. Whatever it wrote stands; this writes nothing over it.
    throw new WriteOffRefusedError(
      now.status !== "pending"
        ? `This posting was resolved while the write-off was running: it is now ${now.status}. Nothing was written off.`
        : "This posting was written off by someone else while this request was running.",
    );
  }
  return now;
}

/**
 * Reverses a posted entry with a NEW, linked entry.
 *
 * A posted document is never edited or deleted. If a mapping was wrong or a
 * figure has to be undone, the correct accounting act is an equal and opposite
 * entry that leaves both visible — which is also what makes the history
 * auditable rather than merely current.
 *
 * The reversal flips every line's direction and takes its own document number,
 * derived from the original's plus a sequence so repeated corrections cannot
 * collide. The original's number is named in the reversal's PrivateNote so the
 * link is legible inside QuickBooks, not only inside Fuel.
 */
export function buildReversal(original: QboPosting): JournalEntryPayload {
  const source = original.postedPayload;
  if (!source) {
    throw new Error("Cannot reverse a posting whose payload was never recorded");
  }

  const sequence = correctionCount(original.id) + 1;
  const docNumber = correctionDocNumberFor(original.companyId, original.docNumber, sequence);

  const reversed: JournalEntryPayload = {
    TxnDate: new Date().toISOString().slice(0, 10),
    DocNumber: docNumber,
    PrivateNote: `Fuel correction ${sequence} — reverses ${original.docNumber}. The original entry is left in place.`,
    CurrencyRef: source.CurrencyRef,
    Line: source.Line.map((line) => ({
      ...line,
      Description: `Reversal — ${line.Description}`,
      JournalEntryLineDetail: {
        ...line.JournalEntryLineDetail,
        PostingType:
          line.JournalEntryLineDetail.PostingType === "Debit"
            ? ("Credit" as const)
            : ("Debit" as const),
      },
    })),
  };

  assertBalanced(reversed);
  return reversed;
}

/**
 * Builds a reversal and sends it, linked to the entry it corrects.
 *
 * Bypasses the preview/staleness path on purpose, and the reason is worth being
 * explicit about. A normal draft is derived from the rollup, so "has the rollup
 * moved?" is the right question to ask before posting it. A reversal is derived
 * from a DOCUMENT THAT ALREADY EXISTS — its content is fixed by what was posted,
 * not by what the rollup currently says — so staleness does not apply. Blocking
 * a correction because the rollup moved would be exactly backwards: the rollup
 * moving is often why the correction is needed.
 *
 * The reversal still gets a draft row, carrying the ORIGINAL's line ids, so a
 * drill-down from the correction reaches the same payments the original booked.
 * That is what makes the pair legible: two entries, one set of underlying
 * spend, and a visible link between them.
 */
export async function postReversal(
  companyId: string,
  original: QboPosting,
): Promise<QboPosting> {
  // A correction is a JournalEntry mutation like any other, so it gets the same
  // fresh check. Before createDraft, so a refusal leaves no orphan draft.
  //
  // Pinned to the ORIGINAL's books (7A-3): a correction only means something
  // in the books holding what it reverses. Sent anywhere else it would be a
  // one-sided entry against a document that is not there.
  await requireFreshUsdScope(companyId, original.realmId);

  // And again after the await, synchronously, as post does through
  // draftReadiness: the connection may have moved while the currency was being
  // read, and past this line a draft and an attempt row exist.
  if (original.realmId === null || getConnection(companyId)?.realmId !== original.realmId) {
    throw new RealmMismatchError();
  }

  const payload = buildReversal(original);
  const originalDraft = getDraftInCompany(original.draftId, companyId);

  const draft = createDraft({
    companyId,
    // THE ORIGINAL'S DIRECTION, not a default. A reversal of a revenue document
    // is a revenue document: it holds the same lines, and eligibleLines will be
    // asked about them under that direction once the reversal posts and the
    // exclusion lifts. Defaulting to 'spend' here would file a revenue
    // correction as a spend one, and the released lines would then be invisible
    // to the direction that owns them — the spend re-post would not find them
    // and the earn re-post would see a document it did not create.
    //
    // `?? "spend"` only when the original's draft row is gone, which is the same
    // fallback `grain` already takes and for the same reason: a correction must
    // still be postable when its draft has been cleaned up.
    direction: originalDraft?.direction ?? "spend",
    grain: originalDraft?.grain ?? "daily",
    postingDay: payload.TxnDate,
    counterparty: originalDraft?.counterparty ?? null,
    docNumber: payload.DocNumber,
    payload,
    // Deliberately the original's lines. They are already excluded from
    // eligibility by the original posting, so this creates no double-count —
    // and once this reversal posts, that exclusion lifts and the spend can be
    // booked correctly.
    lineIds: originalDraft?.lineIds ?? [],
    // THE ORIGINAL'S BOOKS. A reversal only means something in the books that
    // hold the entry it reverses; its payload is the original's lines flipped,
    // account ids and all.
    realmId: original.realmId,
  });

  const attempt = beginPosting({
    companyId,
    draft,
    correctsPostingId: original.id,
    realmId: original.realmId,
  });
  if (attempt.status === "posted") return attempt;

  return send(companyId, attempt, payload);
}
