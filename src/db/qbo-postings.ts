/**
 * Drafts and posted documents: the binding between what an operator reviewed
 * and what reached QuickBooks.
 *
 * THE PROBLEM THIS SOLVES. Preview and post are two clicks with a gap between
 * them. In that gap a posting run can add lines, or a payment can settle out of
 * `unreconciled` and turn a suspense balance into a reclassification. If post
 * recomputed the rollup, the entry reviewed and the entry posted would be
 * different documents — and the review, which is the only human control on this
 * path, would mean nothing.
 *
 * So a preview FREEZES. It writes the exact payload, a hash of it, the exact
 * posting lines it covers, and a fingerprint of the state those lines were
 * derived from. Post sends the stored payload bytes. If the fingerprint no
 * longer matches, the draft is stale and posting refuses rather than quietly
 * posting something else.
 *
 * THE OTHER RULE. A posted entry is never edited or replaced. If settlement
 * later changes or a mapping was wrong, Fuel emits a NEW correction entry
 * linked to the original. An audit trail is a sequence of entries, not a
 * mutable record — the same instinct that makes payment statuses terminal.
 */
import { createHash, randomUUID } from "node:crypto";
import type { JournalEntryPayload } from "../quickbooks/journal.js";
import {
  CLASSES_BY_DIRECTION,
  POSTING_DIRECTIONS,
  type PostingDirection,
} from "../accounting/rollup.js";
import { getConnection, type RollupGrain } from "./qbo.js";
import { db } from "./index.js";

export type DraftStatus = "previewed" | "posted" | "superseded" | "discarded";

export interface PostingDraft {
  id: string;
  companyId: string;
  /** Which document this is. Spend and revenue never share one. See 0012. */
  direction: PostingDirection;
  grain: RollupGrain;
  postingDay: string;
  counterparty: string | null;
  docNumber: string;
  payload: JournalEntryPayload;
  payloadHash: string;
  sourceFingerprint: string;
  status: DraftStatus;
  createdAt: string;
  lineIds: string[];
  /**
   * The QuickBooks company this payload was built for. Its account ids belong
   * to that company's books and to no other. NULL only on a legacy draft Fuel
   * could not attribute, which is refused rather than trusted.
   */
  realmId: string | null;
}

interface DraftRow {
  id: string;
  company_id: string;
  direction: PostingDirection;
  grain: RollupGrain;
  posting_day: string;
  counterparty: string | null;
  doc_number: string;
  payload_json: string;
  payload_hash: string;
  source_fingerprint: string;
  status: DraftStatus;
  created_at: string;
  realm_id: string | null;
}

/**
 * A stable hash over a value's canonical JSON.
 *
 * Keys are sorted recursively before serialising, so two payloads that differ
 * only in property order hash the same. Without that, a hash would be a fact
 * about how an object happened to be built rather than about what it says —
 * and a draft would look tampered with after an unrelated refactor.
 */
export function canonicalHash(value: unknown): string {
  const canonicalise = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalise);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, val]) => [key, canonicalise(val)]),
      );
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonicalise(value))).digest("hex");
}

function toDraft(row: DraftRow): PostingDraft {
  const lineIds = (
    db
      .prepare("SELECT line_id FROM qbo_draft_lines WHERE draft_id = ? ORDER BY line_id")
      .all(row.id) as unknown as { line_id: string }[]
  ).map((r) => r.line_id);

  return {
    id: row.id,
    companyId: row.company_id,
    direction: row.direction,
    grain: row.grain,
    postingDay: row.posting_day,
    counterparty: row.counterparty,
    docNumber: row.doc_number,
    payload: JSON.parse(row.payload_json) as JournalEntryPayload,
    payloadHash: row.payload_hash,
    sourceFingerprint: row.source_fingerprint,
    status: row.status,
    createdAt: row.created_at,
    lineIds,
    realmId: row.realm_id ?? null,
  };
}

/**
 * The posting lines that belong to a scope and have not been committed to
 * QuickBooks yet.
 *
 * The exclusion is the important half. Without it, previewing a day a second
 * time — because a late line arrived — would gather up the lines already posted
 * the first time and post them again, doubling a customer's expenses. A line is
 * spent once it belongs to a posting that is `posted`, or one still `pending`:
 * pending means a document MAY exist, and the fail-closed reading is the only
 * safe one, exactly as `unreconciled` is for payments.
 *
 * A REVERSED POSTING RELEASES ITS LINES AGAIN, which is the one exception and
 * a deliberate one. An operator reverses an entry because something about it
 * was wrong — the contra account, the grain — and the point of doing so is to
 * be able to post that spend correctly. Holding its lines hostage to the
 * mistake would mean the only way to fix a misposting is to never book that
 * spend at all. A posting counts as reversed once a correction that points at
 * it has itself reached `posted`; a reversal that failed releases nothing.
 */
export function eligibleLines(params: {
  /**
   * WHOSE LINES THESE ARE. Required and non-defaultable.
   *
   * This query had no company predicate at all until 7A-1, and it is the one
   * that decides what goes into a real QuickBooks JournalEntry. Under two
   * companies it would have put one tenant's money into another's books — a
   * write into a third party's accounting system, which ADR 0009 already calls
   * the worst placement of this class of bug when it was only an export.
   *
   * The bug was also bidirectional, which is the half that is easy to miss: the
   * exclusion subquery below marks a line consumed once any posting holds it,
   * so tenant A posting a day would not merely borrow tenant B's lines, it
   * would mark them permanently spent and B could never book that revenue.
   */
  companyId: string;
  direction: PostingDirection;
  grain: RollupGrain;
  postingDay: string;
  counterparty?: string | null;
}): string[] {
  // First, so the scope predicate is present in every query this function can
  // build rather than depending on a later branch being taken.
  const where = ["t.company_id = ?", "pl.posting_day = ?"];
  const args: string[] = [params.companyId, params.postingDay];

  /*
   * DIRECTION IS REQUIRED AND THIS REFUSES TO GUESS AT IT.
   *
   * Without a direction filter this query sweeps every class for the day, so
   * the first run after revenue existed would have pulled revenue lines into a
   * spend draft — 0012 names this specifically.
   *
   * REVIEW: the claim to attack is that no path can build a mixed-direction
   * document. It holds ONLY because this parameter is required and
   * non-defaultable. An optional direction falling through to "no filter" would
   * falsify it silently on the first caller that forgot to pass one, and every
   * existing test would stay green — a spend draft that quietly grew a revenue
   * line still balances, still posts, and is simply wrong. So the guard is here
   * rather than in the caller, and it throws, exactly as the counterparty_day
   * scope already refuses to proceed without a counterparty.
   */
  const classes = CLASSES_BY_DIRECTION[params.direction];
  if (classes === undefined || classes.length === 0) {
    throw new Error(
      `eligibleLines requires a direction (${POSTING_DIRECTIONS.join(" or ")}), got ${JSON.stringify(params.direction)}`,
    );
  }
  where.push(`pl.ledger_class IN (${classes.map(() => "?").join(", ")})`);
  args.push(...classes);

  if (params.grain === "counterparty_day") {
    if (!params.counterparty) throw new Error("counterparty_day scope requires a counterparty");
    where.push("pl.counterparty = ?");
    args.push(params.counterparty);
  }

  const rows = db
    .prepare(
      `SELECT pl.id
       FROM posting_lines pl
       -- The same agents -> teams seam every other scoped read uses.
       -- posting_lines carries no company_id column deliberately: a second path
       -- to a company is a second path that can disagree with the first.
       JOIN agents a ON a.id = pl.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE ${where.join(" AND ")}
         -- THE EXCLUSION IS DELIBERATELY NOT COMPANY-SCOPED, and that is the
         -- fail-safe direction rather than an oversight. Scoping it would mean
         -- a line held by another company's posting became eligible here again
         -- — so a line already inside someone's QuickBooks document could be
         -- posted a second time into ours. Leaving it global means such a line
         -- is withheld instead, which check 4 of verifyPostingIntegrity reports
         -- as "nothing postable left unposted". Money stuck and visible beats
         -- money booked twice and silent.
         AND pl.id NOT IN (
           SELECT dl.line_id
           FROM qbo_draft_lines dl
           JOIN qbo_postings p ON p.draft_id = dl.draft_id
           WHERE p.status IN ('pending', 'posted')
             -- A CORRECTION DOES NOT CONSUME LINES, it releases them. Its draft
             -- carries the original's line ids so a drill-down from the
             -- reversal reaches the same payments; without this clause that
             -- borrowed list would make the reversal hold the very lines it
             -- exists to free, and the spend could never be re-booked.
             AND p.corrects_posting_id IS NULL
             -- ...and an original stops holding them once a posted correction
             -- has reversed it.
             AND NOT EXISTS (
               SELECT 1 FROM qbo_postings r
               WHERE r.corrects_posting_id = p.id AND r.status = 'posted'
             )
         )
       ORDER BY pl.id`,
    )
    .all(...(args as never[])) as unknown as { id: string }[];

  return rows.map((r) => r.id);
}

/**
 * A fingerprint of everything a set of lines was derived from.
 *
 * Includes each line's own amount and class, and every SOURCE beneath it with
 * its current status.
 *
 * THIS WAS AN INNER JOIN ON ep.payment_id, and 0012 did not name it. Once
 * payment_id became nullable, every receipt-sourced absorption failed that join
 * and vanished: a revenue draft's fingerprint covered NONE of its own sources
 * while looking exactly like a working one. The staleness guard would have been
 * blind on precisely the direction this phase adds.
 *
 * REVIEW: what including receipts actually buys is LESS than the symmetry
 * suggests, and the comment should not imply otherwise. On the payment side the
 * status is the whole point — `unreconciled -> settled` changes what a suspense
 * line MEANS without altering any row, and only this hash notices. On the
 * receipt side that cannot happen: APPEARS_IN_RECEIPT_LEDGER is `('settled')`
 * alone, resolveReceipt guards on `status = 'awaiting'` so every terminal status
 * is frozen, and nothing ever updates export_postings. A receipt behind a
 * revenue line was already settled when it was absorbed and can never move
 * again.
 *
 * So the receipt branch is not parallel protection to the payment branch. It is
 * here because "the line set is unchanged" and "what the lines are made of is
 * unchanged" are different claims, and a fingerprint that silently covered only
 * half the sources would be making the second claim while checking the first.
 * If receipts ever gain a non-terminal transition, this becomes load-bearing
 * without needing to be found again.
 */
export function fingerprintFor(lineIds: string[]): string {
  if (lineIds.length === 0) return canonicalHash([]);

  const placeholders = lineIds.map(() => "?").join(", ");

  const lines = db
    .prepare(
      `SELECT id, ledger_class, amount_base_units
       FROM posting_lines WHERE id IN (${placeholders}) ORDER BY id`,
    )
    .all(...(lineIds as never[])) as unknown as {
    id: string;
    ledger_class: string;
    amount_base_units: number | bigint;
  }[];

  interface SourceRow {
    line_id: string;
    source_id: string;
    status: string;
    absorbed_base_units: number | bigint;
  }

  // One query per source table, each joining a column that is NOT NULL within
  // its own branch — the same split drillDown and verifyPostingIntegrity use,
  // for the same reason.
  const read = (table: "payments" | "receipts", column: "payment_id" | "receipt_id"): SourceRow[] =>
    db
      .prepare(
        `SELECT ep.line_id, s.id AS source_id, s.status, ep.absorbed_base_units
         FROM export_postings ep
         JOIN ${table} s ON s.id = ep.${column}
         WHERE ep.line_id IN (${placeholders}) AND ep.${column} IS NOT NULL
         ORDER BY ep.line_id, s.id`,
      )
      .all(...(lineIds as never[])) as unknown as SourceRow[];

  /*
   * THE SOURCE KIND IS DELIBERATELY NOT IN THE HASH, and it is worth saying why
   * rather than leaving the omission to look like an oversight.
   *
   * Including it would be the more obviously-correct thing — a payment and a
   * receipt sharing an id would then hash differently — but ids come from
   * randomUUID(), so that collision is not a risk anyone is running. What
   * including it WOULD do is change the hash of every draft written before this
   * change, invalidating every open draft for a reason that has nothing to do
   * with the rollup moving. An operator would re-preview and see an identical
   * document. That is a worse trade than the collision it guards against.
   *
   * The kind is used only to order the two result sets deterministically. A
   * spend-only draft therefore hashes exactly as it did before: all rows are
   * payments, so sorting by (line_id, kind, id) reduces to the old
   * ORDER BY ep.line_id, p.id. Checked, not assumed — verify-quickbooks pins it.
   */
  const sources = [
    ...read("payments", "payment_id").map((r) => ({ kind: "payment", ...r })),
    ...read("receipts", "receipt_id").map((r) => ({ kind: "receipt", ...r })),
  ].sort((a, b) =>
    a.line_id === b.line_id
      ? a.kind === b.kind
        ? a.source_id.localeCompare(b.source_id)
        : a.kind.localeCompare(b.kind)
      : a.line_id.localeCompare(b.line_id),
  );

  return canonicalHash({
    lines: lines.map((l) => [l.id, l.ledger_class, String(l.amount_base_units)]),
    // The key stays `payments` for the same reason: renaming it changes every
    // existing hash. It now means "sources", and this comment is the only place
    // that says so.
    payments: sources.map((s) => [
      s.line_id,
      s.source_id,
      s.status,
      String(s.absorbed_base_units),
    ]),
  });
}

export function createDraft(params: {
  companyId: string;
  direction: PostingDirection;
  grain: RollupGrain;
  postingDay: string;
  counterparty: string | null;
  docNumber: string;
  payload: JournalEntryPayload;
  lineIds: string[];
  /**
   * REQUIRED, and nullable only in the sense that a caller must say "unknown"
   * out loud. There is no default: a draft that silently took the current
   * connection's realm would be stamped with wherever the company happens to
   * point at write time, which is the guess this column exists to replace.
   */
  realmId: string | null;
}): PostingDraft {
  const id = randomUUID();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO qbo_posting_drafts
         (id, company_id, direction, grain, posting_day, counterparty, doc_number,
          payload_json, payload_hash, source_fingerprint, status, created_at, realm_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'previewed', ?, ?)`,
    ).run(
      id,
      params.companyId,
      params.direction,
      params.grain,
      params.postingDay,
      params.counterparty,
      params.docNumber,
      JSON.stringify(params.payload),
      canonicalHash(params.payload),
      fingerprintFor(params.lineIds),
      new Date().toISOString(),
      params.realmId,
    );

    const insertLine = db.prepare(
      "INSERT INTO qbo_draft_lines (draft_id, line_id) VALUES (?, ?)",
    );
    for (const lineId of params.lineIds) insertLine.run(id, lineId);

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  }

  return getDraftUnscoped(id)!;
}

/** A draft, only if it belongs to this company. Scoped in the query, so another company's id and a nonexistent id both come back null — the route's 404 is produced by the SQL, not by a branch someone remembered to write. Same construction as getAgentInCompany. */
export function getDraftInCompany(id: string, companyId: string): PostingDraft | null {
  const row = db
    .prepare("SELECT * FROM qbo_posting_drafts WHERE id = ? AND company_id = ?")
    .get(id, companyId) as DraftRow | undefined;
  return row ? toDraft(row) : null;
}

/** A draft by id, UNSCOPED. Re-reads of a row just written, only. */
export function getDraftUnscoped(id: string): PostingDraft | null {
  const row = db.prepare("SELECT * FROM qbo_posting_drafts WHERE id = ?").get(id) as
    | DraftRow
    | undefined;
  return row ? toDraft(row) : null;
}

export function listDrafts(companyId: string, status?: DraftStatus): PostingDraft[] {
  const rows = (
    status
      ? db
          .prepare(
            "SELECT * FROM qbo_posting_drafts WHERE company_id = ? AND status = ? ORDER BY created_at DESC",
          )
          .all(companyId, status)
      : db
          .prepare("SELECT * FROM qbo_posting_drafts WHERE company_id = ? ORDER BY created_at DESC")
          .all(companyId)
  ) as unknown as DraftRow[];
  return rows.map(toDraft);
}

export type DraftReadiness =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Whether a draft may still be posted.
 *
 * Three ways it may not: it is not in `previewed` state, its stored payload no
 * longer hashes to its recorded hash (the row was altered in the database),
 * or the world it was derived from has moved.
 *
 * The payload check is not paranoia about attackers so much as about
 * correctness: the whole promise of this table is "what you reviewed is what
 * gets sent", and a payload that does not match its hash cannot be claimed to
 * be the reviewed one whatever the cause.
 */
export function draftReadiness(draft: PostingDraft): DraftReadiness {
  if (draft.status !== "previewed") {
    return { ok: false, reason: `draft is ${draft.status}, not awaiting a decision` };
  }

  if (canonicalHash(draft.payload) !== draft.payloadHash) {
    return { ok: false, reason: "stored payload does not match its recorded hash" };
  }

  /*
   * THE BOOKS IT WAS BUILT FOR MUST BE THE BOOKS CONNECTED NOW (7A-3).
   *
   * The payload carries the account ids of the QuickBooks company it was
   * previewed for. Sent to any other it posts into whatever accounts those ids
   * happen to name there. A null realm means Fuel cannot say where the draft
   * belongs, and is refused the same way. Neither reason names a realm.
   */
  const connectedRealm = getConnection(draft.companyId)?.realmId ?? null;
  if (draft.realmId === null) {
    return {
      ok: false,
      reason: "Fuel cannot tell which QuickBooks company this was previewed for — preview again",
    };
  }
  if (draft.realmId !== connectedRealm) {
    return {
      ok: false,
      reason:
        "it was previewed for a different QuickBooks company from the one connected now — " +
        "preview again once the right company is connected",
    };
  }

  const currentlyEligible = eligibleLines({
    // The draft carries its own company, so the staleness check asks the same
    // question the preview asked rather than a wider one.
    companyId: draft.companyId,
    direction: draft.direction,
    grain: draft.grain,
    postingDay: draft.postingDay,
    counterparty: draft.counterparty,
  });
  const recorded = [...draft.lineIds].sort();
  const eligible = [...currentlyEligible].sort();

  if (recorded.length !== eligible.length || recorded.some((id, i) => id !== eligible[i])) {
    return {
      ok: false,
      reason:
        `the rollup has changed since this was previewed ` +
        `(${eligible.length} line(s) now, ${recorded.length} when previewed) — preview again`,
    };
  }

  if (fingerprintFor(draft.lineIds) !== draft.sourceFingerprint) {
    return {
      ok: false,
      reason:
        "the payments behind this rollup have changed since it was previewed " +
        "(a settlement resolved) — preview again",
    };
  }

  return { ok: true };
}

/** Marks a draft as no longer postable. Only ever removes an option. */
export function markDraftStatus(id: string, status: Exclude<DraftStatus, "previewed">): boolean {
  const { changes } = db
    .prepare("UPDATE qbo_posting_drafts SET status = ? WHERE id = ? AND status = 'previewed'")
    .run(status, id);
  return Number(changes) > 0;
}

// ---------------------------------------------------------------------------
// Posted documents
// ---------------------------------------------------------------------------

export type PostingStatus = "pending" | "posted" | "failed";

export interface QboPosting {
  id: string;
  companyId: string;
  draftId: string;
  docNumber: string;
  requestId: string;
  qboEntityId: string | null;
  qboSyncToken: string | null;
  postedPayload: JournalEntryPayload | null;
  postedPayloadHash: string | null;
  status: PostingStatus;
  detail: string | null;
  correctsPostingId: string | null;
  createdAt: string;
  postedAt: string | null;
  /**
   * The QuickBooks company this document was sent to — for a correction, the
   * company the ORIGINAL is in, since a reversal only means anything in the
   * books that hold what it reverses. NULL only on a legacy attempt Fuel could
   * not attribute.
   */
  realmId: string | null;
  /**
   * Set when an owner WROTE THIS OFF because its books could not be asked about
   * it (7A-3 item 3). The status stays `pending` -- the document may still
   * exist -- so its lines stay held and its number stays taken; only the guard
   * on changing books and the needs-reconciliation list stop waiting for it.
   * All four are null for every posting that was never written off.
   */
  abandonedAt: string | null;
  /** The owner's user id. Never null when `abandonedAt` is set. */
  abandonedBy: string | null;
  abandonReason: string | null;
  /** What Fuel saw when it tried QuickBooks first -- why it could not ask. */
  abandonEvidence: string | null;
}

interface PostingRow {
  id: string;
  company_id: string;
  draft_id: string;
  doc_number: string;
  request_id: string;
  qbo_entity_id: string | null;
  qbo_sync_token: string | null;
  posted_payload_json: string | null;
  posted_payload_hash: string | null;
  status: PostingStatus;
  detail: string | null;
  corrects_posting_id: string | null;
  created_at: string;
  posted_at: string | null;
  realm_id: string | null;
  abandoned_at: string | null;
  abandoned_by: string | null;
  abandon_reason: string | null;
  abandon_evidence: string | null;
}

function toPosting(row: PostingRow): QboPosting {
  return {
    id: row.id,
    companyId: row.company_id,
    draftId: row.draft_id,
    docNumber: row.doc_number,
    requestId: row.request_id,
    qboEntityId: row.qbo_entity_id,
    qboSyncToken: row.qbo_sync_token,
    postedPayload: row.posted_payload_json
      ? (JSON.parse(row.posted_payload_json) as JournalEntryPayload)
      : null,
    postedPayloadHash: row.posted_payload_hash,
    status: row.status,
    detail: row.detail,
    correctsPostingId: row.corrects_posting_id,
    createdAt: row.created_at,
    postedAt: row.posted_at,
    realmId: row.realm_id ?? null,
    abandonedAt: row.abandoned_at ?? null,
    abandonedBy: row.abandoned_by ?? null,
    abandonReason: row.abandon_reason ?? null,
    abandonEvidence: row.abandon_evidence ?? null,
  };
}

/**
 * Another live attempt in this company already holds this document number.
 *
 * Raised BEFORE anything is sent to Intuit, which is the point: two live
 * attempts sharing a number is how one of them ends up adopting the other's
 * document through the duplicate-number handler in quickbooks/posting.ts.
 */
export class DocumentInFlightError extends Error {
  constructor(docNumber: string) {
    super(
      `Another posting of document ${docNumber} is already pending or posted. ` +
        "Reconcile or wait for that one, then preview again.",
    );
    this.name = "DocumentInFlightError";
  }
}

/**
 * Reserves the attempt before anything is sent.
 *
 * The `request_id` is written here, BEFORE the HTTP request exists, for the
 * same reason `markSigningStarted` writes `signing` before a signature is
 * produced: if the process dies mid-flight, the database already knows an
 * attempt was made and with which idempotency key. A retry reuses that key and
 * Intuit replays its original response rather than creating a second document.
 *
 * Returns the existing attempt if one is already open for this draft, rather
 * than minting a second — two `pending` rows for one draft would each carry a
 * different key, which is precisely how a double-post happens.
 */
export function beginPosting(params: {
  companyId: string;
  draft: PostingDraft;
  correctsPostingId?: string | null;
  /**
   * The QuickBooks company this attempt is addressed to. REQUIRED with no
   * default, for the reason createDraft's is: the caller knows which books it
   * means — the draft's for a post, the original's for a reversal — and this
   * function must not substitute whichever books are connected now.
   */
  realmId: string | null;
}): QboPosting {
  const existing = db
    .prepare(
      "SELECT * FROM qbo_postings WHERE draft_id = ? AND status IN ('pending', 'posted') LIMIT 1",
    )
    .get(params.draft.id) as PostingRow | undefined;
  if (existing) return toPosting(existing);

  const id = randomUUID();
  /*
   * ONE LIVE ATTEMPT PER DOCUMENT NUMBER, enforced by the partial unique index
   * qbo_postings_live_doc_uniq and translated here.
   *
   * Within one process this cannot be reached through post() or postReversal():
   * both run readiness, numbering and this insert synchronously after their
   * last await, so a second attempt sees the first one's row. What the index
   * covers is everything that guarantee does not -- a second server process
   * against the same file, and any future caller that puts an await in the
   * wrong place. Partial, because a FAILED attempt followed by a fresh one for
   * the same number is the ordinary retry path, not a clash.
   */
  try {
    db.prepare(
      `INSERT INTO qbo_postings
         (id, company_id, draft_id, doc_number, request_id, qbo_entity_id, qbo_sync_token,
          posted_payload_json, posted_payload_hash, status, detail, corrects_posting_id,
          created_at, posted_at, realm_id)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'pending', NULL, ?, ?, NULL, ?)`,
    ).run(
      id,
      params.companyId,
      params.draft.id,
      params.draft.docNumber,
      randomUUID(),
      params.correctsPostingId ?? null,
      new Date().toISOString(),
      params.realmId,
    );
  } catch (error) {
    if (/UNIQUE constraint failed: qbo_postings\.company_id, qbo_postings\.doc_number/.test((error as Error).message)) {
      throw new DocumentInFlightError(params.draft.docNumber);
    }
    throw error;
  }

  return getPostingUnscoped(id)!;
}

/**
 * Records a confirmed document.
 *
 * Stores the payload actually sent, not a reference to the draft's. What was
 * sent is a historical fact and has to stay readable even if the draft is later
 * superseded — and if the two ever disagree, that is something an auditor needs
 * to be able to see rather than something to paper over by reading through.
 */
export function markPosted(params: {
  postingId: string;
  qboEntityId: string;
  qboSyncToken: string | null;
  payload: JournalEntryPayload;
}): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const { changes } = db
      .prepare(
        `UPDATE qbo_postings
         SET status = 'posted', qbo_entity_id = ?, qbo_sync_token = ?,
             posted_payload_json = ?, posted_payload_hash = ?, posted_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(
        params.qboEntityId,
        params.qboSyncToken,
        JSON.stringify(params.payload),
        canonicalHash(params.payload),
        new Date().toISOString(),
        params.postingId,
      );

    if (Number(changes) > 0) {
      const posting = db
        .prepare("SELECT draft_id FROM qbo_postings WHERE id = ?")
        .get(params.postingId) as { draft_id: string };
      db.prepare("UPDATE qbo_posting_drafts SET status = 'posted' WHERE id = ?").run(
        posting.draft_id,
      );
    }
    db.exec("COMMIT");
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
 * Records a failure that we KNOW produced no document.
 *
 * Only safe when the request provably never reached Intuit — a refusal by a
 * local guard, a validation error, a connection that was never established.
 * Anything that may have landed stays `pending`, which is the fail-closed
 * reading, so it is retried under the same idempotency key rather than posted
 * afresh. Same distinction `markFailedBeforeSigning` draws against
 * `markUnreconciled`.
 */
export function markPostingFailed(postingId: string, detail: string): void {
  db.prepare(
    "UPDATE qbo_postings SET status = 'failed', detail = ? WHERE id = ? AND status = 'pending'",
  ).run(detail.slice(0, 500), postingId);
}

/**
 * Records that an owner wrote off a pending posting whose books cannot be asked
 * about it. Returns false if nothing changed.
 *
 * WHAT THIS DOES NOT DO is the point of it. The status stays `pending`, so the
 * lines stay held (eligibleLines), the number stays taken (the live-number
 * index) and the generation still counts it: the spend is NOT released to be
 * posted again, because the document may already sit in the lost books. What
 * changes is only that the guard on changing books, and the needs-reconciliation
 * list, stop waiting for an answer that cannot come. ADR 0016.
 *
 * ONE GUARDED UPDATE. `status = 'pending'` because a reconcile may have
 * resolved it since the caller looked -- and then there is nothing to write
 * off. `abandoned_at IS NULL` so two owners cannot both write it off, and the
 * second cannot overwrite the first's reason. Either way, no change and false.
 *
 * The owner is required and never inferred. SQLite cannot attach a CHECK
 * through ADD COLUMN, so "a write-off always names who did it" lives here.
 */
export function markPostingAbandoned(params: {
  postingId: string;
  userId: string;
  reason: string;
  evidence: string;
}): boolean {
  if (!params.userId) {
    throw new Error("A posting can only be written off by a named person");
  }
  const { changes } = db
    .prepare(
      `UPDATE qbo_postings
          SET abandoned_at = ?, abandoned_by = ?, abandon_reason = ?, abandon_evidence = ?
        WHERE id = ? AND status = 'pending' AND abandoned_at IS NULL`,
    )
    .run(
      new Date().toISOString(),
      params.userId,
      params.reason.slice(0, 500),
      params.evidence.slice(0, 500),
      params.postingId,
    );
  return Number(changes) > 0;
}

/** Keeps a `pending` row pending, but records what went wrong for an operator. */
export function notePostingUncertainty(postingId: string, detail: string): void {
  db.prepare(
    "UPDATE qbo_postings SET detail = ? WHERE id = ? AND status = 'pending'",
  ).run(detail.slice(0, 500), postingId);
}

/** A posting attempt, only if it belongs to this company. Scoped in the query, so another company's id and a nonexistent id both come back null — the route's 404 is produced by the SQL, not by a branch someone remembered to write. Same construction as getAgentInCompany. */
export function getPostingInCompany(id: string, companyId: string): QboPosting | null {
  const row = db
    .prepare("SELECT * FROM qbo_postings WHERE id = ? AND company_id = ?")
    .get(id, companyId) as PostingRow | undefined;
  return row ? toPosting(row) : null;
}

/** A posting attempt by id, UNSCOPED. Re-reads of a row just written, only. */
export function getPostingUnscoped(id: string): QboPosting | null {
  const row = db.prepare("SELECT * FROM qbo_postings WHERE id = ?").get(id) as
    | PostingRow
    | undefined;
  return row ? toPosting(row) : null;
}

export function listPostings(companyId: string): QboPosting[] {
  const rows = db
    .prepare("SELECT * FROM qbo_postings WHERE company_id = ? ORDER BY created_at DESC")
    .all(companyId) as unknown as PostingRow[];
  return rows.map(toPosting);
}

/**
 * Any attempt that may have created a document without confirming it, AND that
 * Fuel is still waiting on an answer for.
 *
 * A written-off posting is left out: an owner has recorded that its books
 * cannot be asked, so "reconcile this" is advice nobody can take. It is still
 * `pending` and still in `listPostings`, carrying who wrote it off and why.
 */
export function pendingPostings(companyId: string): QboPosting[] {
  const rows = db
    .prepare(
      "SELECT * FROM qbo_postings WHERE company_id = ? AND status = 'pending' AND abandoned_at IS NULL ORDER BY created_at",
    )
    .all(companyId) as unknown as PostingRow[];
  return rows.map(toPosting);
}

/**
 * How many documents have already been posted for a scope.
 *
 * This is what stops a re-post after a reversal colliding with the entry it
 * replaced. A document number is derived from the scope, which makes it
 * deterministic — the property that lets an unconfirmed posting be reconciled
 * by query, long after any replay window. But a reversed entry is NOT deleted
 * from QuickBooks: it stays, reversed, holding its number. Re-booking the same
 * spend therefore needs a distinct number, or Intuit rejects it as a duplicate
 * and — worse — the duplicate handler would adopt the old reversed entry as
 * though it were the new one.
 *
 * So the generation goes into the identity the number is derived from.
 * Determinism is preserved where it matters: the same scope previewed twice
 * before anything is posted yields the same number, because the generation only
 * advances once a document actually exists.
 */
export function postedGeneration(params: {
  companyId: string;
  direction: PostingDirection;
  grain: RollupGrain;
  postingDay: string;
  counterparty: string | null;
}): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM qbo_postings p
       JOIN qbo_posting_drafts d ON d.id = p.draft_id
       WHERE p.company_id = ?
         AND p.status IN ('pending', 'posted')
         AND p.corrects_posting_id IS NULL
         AND d.direction = ?
         AND d.grain = ?
         AND d.posting_day = ?
         AND (d.counterparty IS ? OR d.counterparty = ?)`,
    )
    .get(
      params.companyId,
      params.direction,
      params.grain,
      params.postingDay,
      params.counterparty,
      params.counterparty,
    ) as { n: number | bigint };
  return Number(row.n);
}

/** How many corrections already exist for a posting, so the next gets a distinct number. */
export function correctionCount(postingId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM qbo_postings WHERE corrects_posting_id = ?")
    .get(postingId) as { n: number | bigint };
  return Number(row.n);
}
