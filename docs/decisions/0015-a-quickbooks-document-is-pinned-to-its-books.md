# 0015 — A QuickBooks document is pinned to the books it was written for

**Status:** accepted. One claim corrected by
[0017](./0017-a-quickbooks-connection-is-proved-by-who-and-by-intuit.md): a
token is *served* only by its own books, but a request naming another company
its Intuit user can reach is answered 200, with the token's own company. The
decisions below are unaffected.
**Date:** 2026-09-23
**Closes:** 7A-3 item 2 ("a posting does not record which QuickBooks company it
went to"), carried from 7A-1's known gaps
**Builds on:** [0008](./0008-quickbooks-posting-and-attribution-boundary.md) (preview freezes,
post sends the frozen bytes, a posted entry is never edited),
[0010](./0010-provider-status-never-crosses-to-the-client.md) (realm ids stay
server-side)

## Decision

1. **Every QuickBooks artifact records the QuickBooks company ("realm") it
   belongs to.** `qbo_postings.realm_id` is where a document was sent;
   `qbo_posting_drafts.realm_id` is where a frozen payload was built for;
   `qbo_config.accounts_realm_id` is where the account ids were read from.

2. **Nothing is ever sent to a realm other than the one it records.** Every
   request that acts on an artifact names the realm it must reach, and
   `qboRequest` refuses (`RealmMismatchError`, 409) before anything is sent if
   the connection points anywhere else. A recorded realm of `NULL` means Fuel
   cannot say where the artifact belongs, and it is refused, never read as
   "the current books".

3. **A realm refusal never changes a posting's status.** A refused attempt
   stays `pending` with its lines held and the reason noted. It is never marked
   `failed`.

4. **Existing rows were attributed once, when the column arrived.** Each one
   got its company's connected realm at that moment, and `NULL` if there was
   no connection. The migration never fills a `NULL` later.

5. **The realm-change and disconnect guard (`UnresolvedPostingsError`) stays
   a block.** It does not relax to a warning.

6. **Realm ids stay out of every draft, posting and trace response**, and out
   of every refusal message.

## Why

### A token only reaches its own books, and every call used the current one

`qboRequest` resolves the realm from whatever the company is connected to
*now*. Before this decision, nothing an artifact stored said which books it
belonged to, so every later action on it (reconcile, reverse, post a frozen
draft) was quietly aimed at whichever books happened to be connected. With one
set of books that is invisible. Reconnect to different books with nothing
`pending` and the old guard allowed it; the live database was in exactly that
state (5 posted, 3 open drafts, 0 pending).

### The reconcile path booked spend twice, and the test showed it

`reconcilePending` asks QuickBooks whether a document exists and, if not, marks
the attempt `failed` and releases its lines. Asked of the wrong books, "not
found" is certain and wrong. Run against the pre-fix code, the new test
recorded `expected pending, got failed`. The lines were released, and the next
preview would book the same spend again while the first copy still sat in the
old books.

### Account ids fail silently, which is worse than failing loudly

QuickBooks account ids are small per-company integers (`63`, `91`, `35`) that
recur across companies. A frozen draft, or an account mapping, carried into
different books does not error. It resolves to *different, real* accounts,
and Intuit accepts the entry. This is why drafts and the mapping are pinned
too, not only postings as the roadmap item was worded: they are the same bug,
and this half of it produces no signal at all.

### The check lives at the request, not in the callers

Every multi-request operation (account setup, post, reversal) awaits between
requests, and each request resolves the connection afresh. A check at the top
of an operation can be overtaken by a reconnect halfway through. The first
version of account setup was exactly that: it read the realm once, and a
reconnect mid-setup would have saved one company's ids under another's stamp.
So the authoritative comparison is inside `qboRequest`, against the realm the
URL is about to be built from, with no `await` before `fetch`.

A cheaper check runs *before* the token is resolved, because resolving can
refresh it, and a refresh rotates and persists a company's live credentials.
A request that is going to be refused should not do that on the way out.

Callers add their own layers on top so a refusal happens **before a row
exists**:
- **post** reads the currency pinned to the draft's books, which is its first
  request. It then compares books again, after that `await` and before
  `beginPosting`.
- **postReversal** does the same against the original's books, before any
  correction draft is created.

A refused post is indistinguishable from one that never happened, as 0008
already requires.

### Why a refusal must not fail a posting

`failed` means "provably no document exists, release the lines". A realm
refusal proves nothing of the kind: this may be a retry of an attempt that
already landed in its own books. Marking it failed would release its lines,
the same double-booking by another door. `pending` is the fail-closed reading,
the one `unreconciled` already takes for payments.

### Why the backfill runs once, and only once

"This company's artifacts belong to the books it is connected to now" is true
only at the moment the column arrives. It was true on the only database this
has run on, because one sandbox company has ever existed on this developer
account. A company with no connection keeps `NULL`. If a later boot filled
that `NULL` from whatever the company had connected to since, the migration
itself would stamp old documents with new books. So the `ALTER` and the fill
share one transaction, and an existing column is never touched again. The two
older one-time table rebuilds apply the same rule at their own one-time
moment. Otherwise an old database would come out with its postings attributed
and its drafts not.

The claim was then **proved, not assumed**. Each of the 5 posted documents was
looked up by DocNumber in the books it is now stamped with. All 5 were found,
each with the QuickBooks id Fuel recorded.

### Why the guard stays a block

The roadmap expected the pending-postings guard to relax to a warning once
realms were recorded. It should not. A pending posting can now only be
reconciled in its own books, and a token reaches nothing else. Let a company
switch away and that posting cannot be resolved at all until the old books
are reconnected. Relaxing the guard would turn "you can't switch books yet"
into "a posting stranded indefinitely". The way out for a company that
genuinely must move is 7A-3 item 3's audited escape hatch. The guard is
revisited with it.

## Consequences

- **Preview needs a connection** and an account mapping stamped for the
  connected books. Account setup is how a mapping is re-made.
  `PATCH /config` stamps hand-typed ids with the connected books. It refuses
  (409) when that stamp would vouch for old ids read elsewhere, and also when
  nothing is connected.
- **Status stops claiming readiness** while the mapping belongs to other
  books. `missing` names "account setup for the connected QuickBooks company".
- **Two error types reach operators as 409.** `RealmMismatchError` ("reconnect
  the QuickBooks company it was made in") and `AccountsFromOtherBooksError`
  ("run account setup again"). Neither names a realm.

## What this does not cover

- **The currency record is not realm-stamped.** A reading from one set of
  books can sit in `qbo_config` while another is connected. It cannot carry a
  wrong send: post and reversal re-read the currency, pinned, before any
  JournalEntry. It can make status describe the wrong company's currency.
- **A token refresh can revert a racing reconnect.** This is existing
  behaviour, not introduced here. `accessTokenFor` saves the realm it read
  *before* awaiting the refresh. Security review traced it: it cannot send a
  request anywhere other than the pinned books or fail a posting, but it can
  undo a legitimate reconnect.
- **Two branches are not behaviourally tested**, because nothing in-process
  can reach them past the pre-check: `send`'s POST-level mismatch branch, and
  `qboRequest`'s post-token comparison. Both are backstops. Reaching either
  needs a switch during a token refresh.
- **A second company's own QuickBooks connection** is still unproven (item 4).
