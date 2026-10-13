# 0016 — A posting whose books are gone can be written off, and its spend stays held

**Status:** accepted
**Date:** 2026-09-24
**Closes:** 7A-3 item 3 ("a company whose books are gone for good is
stranded"), carried from 7A-1's known gaps
**Builds on:** [0008](./0008-quickbooks-posting-and-attribution-boundary.md) (an
attempt is `pending` until QuickBooks says otherwise),
[0014](./0014-a-decision-has-a-name-on-it.md) (a decision has a person's name on
it; a shared key names nobody),
[0015](./0015-a-quickbooks-document-is-pinned-to-its-books.md) (a posting can only
be resolved in its own books; the guard stays a block)

## Decision

1. **An owner may write off a `pending` posting, but only when QuickBooks
   cannot be asked about it.** `POST /api/integrations/quickbooks/postings/:id/abandon`,
   guarded by `requireOwner()`. A shared key and an operator's session both get
   403. The owner gives a reason (10–500 characters) and types back the
   document number.

2. **QuickBooks is always asked first.** `writeOffPending` runs the normal
   reconcile before anything else:
   - QuickBooks answers "found" or "not found": that answer stands (`posted` or
     `failed`), and the write-off is refused with 409.
   - QuickBooks rejects the lookup itself (a 4xx other than 401, 403, 429): refused.
     The books are reachable, so this is Fuel's problem, not lost books.
   - QuickBooks answers but Fuel fails to record the answer
     (`AnsweredButNotRecordedError`): refused.
   - Anything else is "could not ask": the books point elsewhere, no
     connection, a token that cannot be decrypted or refreshed, 401/403, the
     network, 429 or 5xx. What Fuel saw is stored as `abandon_evidence`.

3. **A write-off is a flag, not a status.** The posting stays
   `status = 'pending'` and gains `abandoned_at`, `abandoned_by`,
   `abandon_reason` and `abandon_evidence`. The flag is written by one guarded
   `UPDATE … WHERE status = 'pending' AND abandoned_at IS NULL`, so a
   concurrent reconcile or a second owner wins cleanly.

4. **Its spend stays held.** The lines stay out of every later preview, the
   document number stays taken, and the generation still counts it. Nothing is
   released and nothing is re-posted automatically.

5. **Only two readers of `pending` change.** The guard on changing books
   (`pendingPostingCount`) and the needs-reconciliation list
   (`pendingPostings`) skip a written-off posting. Every other reader is
   unchanged.

6. **The guard stays a block for everything else.** An ordinary pending
   posting still refuses a disconnect and a switch of books.

7. **Who wrote it off is shown to people, not to keys.** A posting carries
   `abandonedAt` and `abandonReason`. `abandonedBy` is the owner's email for a
   signed-in reader and `null` for a shared key, as with approvals (0014). The
   evidence is never presented: it can be Intuit's own prose.

## Why

### The dead end was real, and item 2 made it permanent

While any posting is `pending`, a company cannot disconnect and cannot
connect different books (`UnresolvedPostingsError`). Only a reconcile clears
`pending`, and since 0015 a reconcile can only ask the books the posting was
sent to. If those books are gone for good (subscription cancelled, access
revoked, the customer will not consent again), nothing can ever clear it. The
ordering check showed the dead end before it was opened: against the previous
code, with six unresolvable postings, connecting other books and disconnecting
were both refused.

### Why the spend stays held

`pending` means "the document may exist". That is still true after a write-off:
the posting may be sitting in the lost books right now. Releasing its lines
would let the next preview book the same spend again, which is the
double-booking 0015 exists to prevent, reached by a different door. So the
write-off changes what Fuel will *let the company do*, and nothing about what
Fuel *believes about the document*. This was the user's decision when the
item was planned.

It follows that a written-off amount is in neither Fuel's future postings nor,
knowably, the new books. Booking it in the new books, if it belongs there, is
a human accounting decision, and the recorded reason is where that decision
starts.

### Why a flag and not a new status

A new status would have been a false statement (the outcome is still unknown),
and it would have needed every reader of `pending` to learn about it. Eight
places treat `pending` as "lines held, number taken": the eligible-lines
exclusion, `beginPosting`'s reuse of an open attempt, `markPosted`,
`markPostingFailed`, `notePostingUncertainty`, the one-live-attempt-per-number
index and its boot check, and `postedGeneration`. With a flag, six of them
keep holding with no change, and tests pin that they do. The two that change
are exactly the two that should.

It also avoided rebuilding `qbo_postings` to add a CHECK value. That is the
most sensitive table, with a self-reference and the live partial index.

### Why QuickBooks is asked first

A write-off is for when there is no answer to be had. If there is one, it must
win. Without that step, an owner could overrule a real "found", or write off a
posting whose books were fine and merely slow to be asked. Asking first also
means the common case never reaches the write-off at all: books that come back
resolve the posting the normal way.

The refusals are deliberately lopsided:
- A 4xx that means "QuickBooks heard you and said no" is refused, because the
  books are there.
- Everything that means "QuickBooks could not be asked" is allowed, including a
  transient outage.

Fuel does not try to tell a permanent loss from a temporary one, because that
would mean guessing what Intuit sends for a revoked company, which nothing
here has observed. The owner's judgement fills that gap, and the evidence
records what they were looking at.

### Why an owner, a reason and the number typed back

7A-1 recorded this as money policy needing "a role above a plain operator".
Stage 3 introduced owners, which unblocked it. A shared key is refused outright
because it names nobody, and every write-off must have a person on it. The
reason is kept because it is the only record of *why*. The typed number makes
the owner look at exactly which posting they are writing off, rather than
clicking the wrong row.

### Why the guard still blocks everything else

0015 kept the guard a block so that a switch of books could not strand a
posting silently. The write-off keeps that property: a posting is set aside
only by a named owner, one at a time, with a reason. Everything not written off
still blocks.

## Proof

- **Tests:** 17 break tests on the API commit and 4 on the dashboard commit,
  each failing its own named check. They include a control: a guard that also
  ignores ordinary pending postings is caught.
- **Security review:** one medium, fixed. An answer from QuickBooks that Fuel
  then failed to record was being read as "could not ask", so the posting
  would have been written off with misleading evidence. It now has its own
  error and is refused. The reviewer confirmed it closed. The dashboard commit
  had no findings.
- **Live, 2026-09-23:** backup `fuel.db.bak-7a3-item3-20260923T173729Z`
  (SHA-256 `4d7b6238…d816`). The migration was rehearsed on a `VACUUM INTO`
  copy, then ran when the API restarted. All 5 real postings have the four new
  columns `NULL`. The postings fingerprint and every row count were unchanged.
  Integrity ok, 0 FK violations.
- **In the browser, 2026-09-23, on a scratch copy.** The real database has no
  pending posting, and making one would be an accounting action. So:
  - A copy was made with its QuickBooks connection replaced by a made-up
    company, and its tokens replaced by text that cannot be decrypted, so no
    real credential could be used or refreshed.
  - One synthetic pending posting was added, in those unreachable books.
  - The owner opened the copy's Accounting page and pressed Disconnect, which
    was refused. They wrote the posting off, then pressed Disconnect again,
    which succeeded.
  - The copy's database recorded the owner's account (role `owner`), the reason
    as typed, the evidence "Stored secret is not in the expected v1 format", and
    status still `pending`. The scratch API made no request to Intuit.
  - Both scratch servers were stopped and the copy deleted. Afterwards the live
    database still held its real connection and its 5 posted postings, had no
    pending posting, and passed its integrity check.

## What this does not cover

- **A single owner acts alone.** In a company with one owner there is no
  second person. That meets 7A-1's requirement ("a role above a plain
  operator"). It is not four-eyes approval.
- **A transient outage also allows a write-off.** By design (above). The harm
  is bounded: the lines stay held, and reconnecting the same books still lets a
  reconcile resolve the posting truthfully, with the write-off kept as history.
- **Written-off spend has no route out except its own books.** If they never
  come back, those lines are never posted by Fuel. Fuel offers no "release"
  button, because releasing is exactly the double-booking risk above.
- **What a truly revoked Intuit connection looks like has not been observed.**
  The walkthrough's "could not ask" was a decryption failure, not a real
  revocation. Nothing depends on the difference, since every "could not ask"
  is treated alike.
- **If Intuit ever answered lost books with a plain 400**, a write-off would be
  refused when it should be allowed. That fails closed: the company stays stuck
  rather than being let out wrongly.
- **Not behaviourally tested:** the route's refusal when no user is signed in.
  `requireOwner` makes it unreachable. It is kept as a backstop.
