# 0012 — Revenue in the ledger: one new class, and what it breaks

**Status:** accepted
**Date:** 2026-08-31
**Builds on:** [0007](./0007-accounting-integration-posting-model.md),
[0008](./0008-quickbooks-posting-and-attribution-boundary.md)
**Companion:** [0011](./0011-the-earning-side.md) settles where money received
comes from. This document settles how it becomes a posting.

## Decision

1. **`LedgerClass` gains exactly one member: `revenue`.** There is no
   revenue-suspense counterpart, and the reason is not symmetry-breaking for
   its own sake — see below.
2. **Direction becomes a property of the class, not of the sign.**
   `directionFor` takes the class as well as the amount. Each class has a
   natural side; a positive amount posts on it, a negative amount posts
   opposite.
3. **The contra line is computed from a signed debit total**, not from a bare
   sum across classes, and its description becomes direction-aware.
4. **A fourth required account**, `Income`, and a company connected before
   this ships keeps posting spend while its revenue account is missing.
5. **`export_postings` becomes polymorphic** — nullable `payment_id`,
   nullable `receipt_id`, exactly one set — with partial unique indexes
   rather than a nullable primary key.
6. **Conservation splits into two independent checks, one per direction.**
   The invariant gets stronger, not weaker.
7. **`posting_lines.vendor_host` becomes `counterparty`**, and the
   `vendor_day` grain becomes `counterparty_day`.
8. **Document numbers and draft eligibility become direction-aware**, so a
   revenue posting cannot collide with, or be swept into, a spend one.

## Why

### One new class, not two

The obvious move is symmetry: spend has `expense` and `suspense`, so revenue
should have `revenue` and a suspense of its own for money Fuel served but
never saw confirmed. That is wrong, and the reason is the same reason
[0007](./0007-accounting-integration-posting-model.md) gave suspense to spend
in the first place.

Outbound suspense exists because Fuel signed something spendable and does not
know whether it settled. The cautious answer there is to **record** it:
the exposure is real, adverse, and hiding it would understate what the
customer owes. Booking it as a paid expense would overstate; a suspense
account is the standard answer to a real amount whose classification is
unknown.

Inbound inverts every term. When Fuel does not know whether it was paid, the
adverse error is to **record** it, because unconfirmed revenue in a
customer's books overstates what they earned. The cautious answer is
therefore not "book it somewhere provisional" but "do not book it at all
until it is confirmed." An unconfirmed receipt is still fully visible inside
Fuel — an operator can see that an endpoint served a request and settlement
never confirmed, which is exactly the kind of thing they should see — but it
does not cross into QuickBooks.

This is the same instinct 0007 applied, run in the other direction, and it
means the phase adds one class rather than two.

### Direction belongs to the class, not to the sign

Today `directionFor` is purely sign-driven:

```ts
function directionFor(baseUnits: bigint): "Debit" | "Credit" {
  return baseUnits > 0n ? "Debit" : "Credit";
}
```

That works because every class currently posts on the debit side, so
"positive" and "debit" happen to coincide. Revenue is credit-natural, which
breaks the coincidence.

The tempting fix is to store revenue amounts as negatives and change nothing
else — the arithmetic genuinely does come out right. It was rejected because
`posting_lines.amount_base_units` already uses negative to mean something
specific: *"the credit half of a reclassification, released when an
unreconciled payment finally settles."* Overloading the sign to mean both
"this is an unwind" and "this is revenue" gives one column two jobs, and the
first honest question anyone asks of the table — how much revenue is in
here — would be answered by `-SUM(...)`, with a revenue reclass unwind coming
back positive. That is a table that reads as a puzzle.

So each class declares a natural side: `expense` and `suspense` are Debit,
`revenue` is Credit. A positive amount posts on its natural side; a negative
amount posts opposite. This generalises today's behaviour exactly rather than
replacing it — with every class debit-natural, "positive means debit" is
precisely what the rule already says.

Changing `directionFor`'s signature is deliberate. It makes the compiler walk
every call site, which is the same reason `LEDGER_CLASS` is a `Record` over
`PaymentStatus` rather than a switch.

### The contra line, and an invariant that has to be rewritten rather than quietly falsified

The balancing line today:

```ts
const net = totals.expense + totals.suspense;
if (net !== 0n) { /* contra absorbs it, opposite the net */ }
```

with a comment asserting that a zero net *is* a pure reclassification:

> WHEN THE NET IS ZERO, NO CONTRA LINE IS EMITTED — and that case is not an
> edge case, it is exactly a pure reclassification.

Once revenue exists that sentence is false. A day with $10 of spend and $10
of revenue also nets to zero, and it is not a reclassification — it is two
real movements that happen to cancel. The arithmetic result is still
correct (the Fuel balance genuinely did not change, so no contra line is
genuinely right), but the stated *reason* no longer holds, and a comment that
explains a correct behaviour with a false justification is worse than no
comment: it is what someone will reason from next time.

The replacement: the contra absorbs the **signed debit total** — each class's
amount counted positive if it is debit-natural and negative if it is
credit-natural. A zero total now means "nothing changed the Fuel balance,"
which is true of both a reclassification and an offsetting day, and that is
what the comment should say.

`Description: "Funded from Fuel balance"` also becomes direction-aware. On a
day where revenue exceeds spend the contra is a Debit — money added to the
balance — and calling that "funded from" is backwards.

`assertBalanced` needs no change. It was written direction-neutral and stays
correct.

**This rule was checked, not just asserted.** Worked against seven cases —
spend only, revenue only, spend exceeding revenue, revenue exceeding spend, an
exactly offsetting day, a pure reclassification, and a negative revenue unwind
— every entry balances, and the contra lands on the economically correct side
each time: a credit when the Fuel balance falls, a debit when it rises, and no
line at all when it does not move. Note that the offsetting day and the
reclassification both produce no contra line, which is precisely why the
existing comment's *justification* goes false while its *arithmetic* stays
right.

### A fourth account, and what an already-connected company sees

`REQUIRED_ACCOUNTS` is a three-key literal today. It gains an `Income` entry
— working name "Agent API Revenue", QuickBooks `AccountType: "Income"`, with
the subtype confirmed against the live sandbox by the slice that builds it
rather than guessed here. `qbo_config` gains a fourth account-id column, and
`missingAccounts` a fourth entry.

The part worth deciding now is the upgrade path, because every company
already connected has three account ids and will have a NULL revenue account
until `setUpAccounts` runs again.

**Posting must degrade, not stop.** A company in that state keeps posting
spend exactly as it does today, and revenue lines wait. The alternative —
refusing to post anything until the new account exists — would turn a
feature addition into an outage for customers who never asked for the
earning side. The Accounting page reports one account needing creation, which
is a state `missingAccounts` already models; it does not need a new concept,
only a fourth member.

### `export_postings`, and a SQLite trap worth naming

`export_postings.payment_id` is `NOT NULL REFERENCES payments(id)` with
`PRIMARY KEY (payment_id, line_id)`. Receipts need to be absorbable by a
line the same way payments are, and this is the table that, in the schema's
own words, *"makes the rollup a ledger rather than a total."*

It becomes: nullable `payment_id`, nullable `receipt_id`, and
`CHECK ((payment_id IS NULL) <> (receipt_id IS NULL))` — exactly one set.

**The primary key cannot simply become nullable.** SQLite permits NULLs in a
PRIMARY KEY on a non-`INTEGER` column in a non-`STRICT` table — a
long-standing quirk rather than a bug — so `PRIMARY KEY (payment_id,
line_id)` with a nullable `payment_id` would silently stop preventing the
duplicate absorption it exists to prevent. Every revenue row would have
`payment_id IS NULL` and the uniqueness guarantee would evaporate without a
single error.

So the composite key is replaced by two partial unique indexes:
`UNIQUE (payment_id, line_id) WHERE payment_id IS NOT NULL` and
`UNIQUE (receipt_id, line_id) WHERE receipt_id IS NOT NULL`. That preserves
the actual guarantee — one source may span many lines (the partial-absorption
case) but cannot be absorbed twice by the same line — for both source kinds.

### Conservation gets stronger

Today one check: every base unit that belongs in the books is either posted
or still carried.

```
SUM(posting_lines) + carried == SUM(payments WHERE APPEARS_IN_LEDGER)
```

Adding revenue lines to the left side breaks it immediately. The wrong fix is
to add receipts to the right side, producing one combined equation — because
a single equation can be satisfied by an error in one direction cancelling an
error in the other, which is precisely the kind of bookkeeping bug this check
exists to catch.

Instead it splits in two, checked independently:

```
SUM(posting_lines WHERE class IN ('expense','suspense')) + carried_spend
    == SUM(payments  WHERE APPEARS_IN_LEDGER)

SUM(posting_lines WHERE class = 'revenue')             + carried_revenue
    == SUM(receipts WHERE <ledger-eligible>)
```

Two equations over the same data are strictly harder to satisfy by accident
than one. This is the invariant that would catch a revenue line mistakenly
absorbing a payment, or a residual carried in the wrong bucket, and it should
get harder to fool as the system grows, not easier.

> **Correction (slice 6B-1, 2026-09-10).** The sentence above is wrong about
> the first example, and it is repeated in Consequences below. Conservation
> does **not** catch a revenue line absorbing a payment, and structurally
> cannot: both readers filter absorptions by the *line's* class matching their
> own direction — `readLedgerPayments` counts only `expense`/`suspense` lines,
> `readLedgerReceipts` only `revenue` lines with a non-null `receipt_id`. A
> payment absorbed under a revenue line matches neither filter, changes no term
> in either equation, and both still balance.
>
> The ledger is not unguarded: **"line parts sum to total"** catches it, because
> the line's own amount stops equalling the sum beneath it. But that is a
> different check with different coverage, and this document sent a reader
> looking to the wrong one.
>
> What conservation actually catches is errors in the engine's **arithmetic** —
> a dropped bucket, a bad rounding direction, a residual computed against the
> wrong source. Row surgery cannot break it, and that is 0007's derived-residual
> decision working rather than the check being weak: a bad absorption row moves
> `posted` and `carried` by the same amount in opposite directions, so the
> equation re-balances itself.
>
> Found by writing the break test this document asked for and watching it not
> fire. Both behaviours are now pinned in `scripts/verify-rollup.ts`, including
> an assertion that conservation does *not* fire, so the correction cannot rot
> back into the original claim.

The ledger-eligible receipt statuses are [0011](./0011-the-earning-side.md)'s
to define, and this check is one of the reasons that vocabulary has to be
reasoned rather than copied.

**Conservation is not the only integrity check that breaks, and the other one
breaks silently.** `verifyPostingIntegrity` also asserts that no source is
absorbed for more than it is worth:

```sql
FROM export_postings ep
JOIN posting_lines pl ON pl.id = ep.line_id
JOIN payments p       ON p.id = ep.payment_id
GROUP BY p.id, pl.ledger_class
HAVING absorbed > p.amount_base_units OR absorbed < 0
```

That is an **inner join on `ep.payment_id`**. The moment `payment_id` becomes
nullable, every receipt-sourced row has `payment_id IS NULL`, fails the join,
and drops out of the result — so the check would stop verifying
over-absorption for revenue entirely. No error, no failed assertion, no
symptom: a revenue line could absorb more than its receipt is worth and this
check would report clean.

It is the same failure mode as the nullable primary key above and as
`ledgerAccount`'s `?? "Unknown"` below — a widening that produces silence
rather than a complaint — and it is the reason this document lists the
integrity checks by name rather than saying "update `verifyPostingIntegrity`."
It splits per source the same way conservation does: a payments branch and a
receipts branch, or the two id columns coalesced before the join. Whoever
implements this should read the whole of `verifyPostingIntegrity` for further
instances of the same pattern rather than trusting this list to be complete.

### The counterparty is not a vendor

`posting_lines.vendor_host` is `NOT NULL` and means one specific thing: *"the
resource URL's host, exactly as src/lib/export-presentation.ts derives it for
the CSV,"* i.e. the host **our agent fetched**. Revenue has no such host. The
payer is an x402 client Fuel has no identity for, and inventing one would be
fabricating a record.

The useful axis for revenue is the **endpoint** — which of the agent's
endpoints earned the money. It is also the correct residual bucket: sub-cent
revenue at one endpoint should accumulate until it clears a cent, exactly as
sub-cent spend at one vendor does.

So the column becomes `counterparty`, `NOT NULL` preserved: the vendor host
for spend (unchanged values — no content migration), the endpoint identifier
for revenue. The `vendor_day` rollup grain becomes `counterparty_day` and the
`(posting_day, vendor_host)` index follows the rename.

The two CSV headers change with it: `Vendor` becomes `Counterparty`, and both
gain a `Direction` column. These headers are contracts — 0008's reasoning is
that they *"leave the system permanently"* — and changing one is not free.
It is done now, deliberately, because the alternative is a column labelled
"Vendor" standing over a row whose counterparty is a customer, which is a
false statement in a file an accountant reads. Changing it before any revenue
row exists costs a version note; changing it afterwards costs a reconciliation.

### Two collisions that would be silent

**Document numbers.** The number is derived from grain, counterparty, day and
generation only, so `daily:2026-09-01` names both the spend posting and the
revenue posting for that day. Worse, `postedGeneration` counts by
`(company, grain, posting_day, counterparty)` — a spend posting would bump
the generation of a revenue posting for the same day, and the two would
fight. Direction joins the key.

**Draft eligibility.** `eligibleLines` selects by posting day with no class
filter, so it would sweep revenue lines into a spend draft the first time it
ran. It gains a direction filter. Relatedly, `draftReadiness` refuses to post
when the recorded line set differs from the currently-eligible set — which
means shipping revenue invalidates every open draft. That is correct
behaviour and should be stated in the release note rather than discovered by
an operator.

### One trap that produces no error at all

`ledgerAccount` types its map as an inline union rather than as `LedgerClass`:

```ts
const LEDGER_ACCOUNT: Record<"expense" | "suspense", string> = { ... };
export function ledgerAccount(ledgerClass: "expense" | "suspense"): string {
  return LEDGER_ACCOUNT[ledgerClass] ?? "Unknown";
}
```

Widening `LedgerClass` produces **no compile error here.** The `?? "Unknown"`
fallback catches it at runtime and writes the word "Unknown" into an
accounting CSV.

This is fixed as part of the same change, by referencing `LedgerClass`
directly, so that the compiler catches the *next* widening. The same applies
to the literal `for (const ledgerClass of ["expense", "suspense"] as const)`
loop in the journal builder, which should iterate `LEDGER_CLASSES`. Both are
places where the codebase's usual discipline — make the exhaustiveness
structural — was not applied, and adding a class is the moment that costs
something.

## What this document does not decide

- **The ledger-eligible receipt statuses.** Named as a dependency above;
  [0011](./0011-the-earning-side.md) owns the vocabulary.
- **The QuickBooks `AccountSubType` for the income account.** To be confirmed
  against the live sandbox, as the QuickBooks slice confirmed the others.
- **Whether revenue rolls up at the same grain as spend** in every case, or
  whether an endpoint with many small payers warrants a different bucket.
- **Multi-currency.** Unchanged and still refused: 0008's USD-only gate
  applies to revenue exactly as it does to spend.
- **Reversal of a revenue posting.** `buildReversal` flips every posting
  type and is direction-neutral, so it should work — but "should work" is not
  "verified," and the slice verifies it.
- **The migration's mechanics.** `posting_lines` needs a full rebuild for the
  CHECK constraint, `export_postings` for the polymorphic keys.
  `migrateApprovalScopes` and `migratePaymentStatuses` are the two worked
  examples in the codebase; which pattern applies is the slice's call.

## Consequences

- **Two tables get rebuilt**, both referenced under `PRAGMA foreign_keys =
  ON`, which is the most delicate migration this project has done. It gets
  its own slice rather than riding along with a feature.
- **Every open QuickBooks draft is invalidated** the moment revenue lines
  become eligible. Correct, and it needs saying out loud.
- **Two CSV header contracts change.** Anyone with a saved import mapping
  re-maps one column and gains one.
- **The conservation check becomes the phase's best safety net** against
  arithmetic error — a residual landing in the wrong bucket, a dropped bucket,
  a bad rounding direction — and splitting it per direction is what makes it
  able to. ~~It is the one thing that would catch a revenue line absorbing a
  payment~~: see the correction above, which was found by running the break
  test rather than by reading. That case is caught by "line parts sum to
  total"; conservation never fires on it.
- **A company connected before this ships is in a partial state** until
  `setUpAccounts` re-runs — posting spend, holding revenue. That state is
  visible rather than silent, and it does not block anything that worked
  before.
- **`clearable`, `planAbsorption`, `assertBalanced`, `buildReversal`,
  `csv.ts` and `money.ts` need no changes.** They were written
  sign-agnostic and the negative case is already first-class because of
  reclassification. That is a design paying off, and it is worth noticing
  that the parts of this system that generalised cleanly are the parts that
  were written without an opinion about direction in the first place.
