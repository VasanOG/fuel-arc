# 0007 — The posting model for the QuickBooks/Xero integration

**Status:** accepted
**Date:** 2026-08-25
**Builds on:** [0006](./0006-accounting-export-omits-crypto-identifiers.md), and
the "carried into Slice 2" notes at the end of Phase 4 Slice 1 in
`/docs/roadmap.md`.

## Decision

The QuickBooks/Xero integration posts transactions at **vendor + day** grain,
with **one line per agent** inside each posting, tagged with that agent's
QuickBooks Class / Xero Tracking Category. Sub-cent amounts accumulate as a
running residual per **(agent, vendor)** pair until they clear a postable
cent. `unreconciled` payments post to a **suspense account**, not the normal
expense account, and are reclassified into it if later confirmed settled.
Category/chart-of-accounts mapping ships as a single configurable default
account for the first version, not a per-vendor mapping UI.

This document does not choose QuickBooks vs. Xero, does not specify either
platform's OAuth/API shape, and does not implement any of the schema it
sketches. It exists to settle the *shape* of the integration before either is
built, so that work doesn't start by re-deriving decisions Slice 1 already
flagged as open.

## Why

### Rollup grain: vendor + day, agent as a line-level tag

The CSV export (Slice 1) already rolled Fuel's status vocabulary down to what
an accountant needs (`APPEARS_IN_LEDGER`, "Awaiting confirmation", etc.) but
left every row as one transaction per payment, because a CSV a human skims
tolerates a 6-decimal $0.001 row. A real posting into QuickBooks/Xero cannot:
both store 2 decimal places, so a single sub-cent payment posts as $0.00.

The fix has to be a rollup, and the question is what to roll up *by*. Vendor
is already the natural counterparty (Slice 1 decided vendor = resource URL
host). Day is the natural period — accounting systems post transactions
dated to a day, not a instant. That leaves agent: collapsing it away would
mean the accounting system only ever shows "we spent $X at vendor Y today,"
with no way to see which agent spent it without going back to Fuel itself.

That's the wrong trade for this product specifically. Fuel's whole pitch is
that agents are spending entities with their own caps, approvals, and freeze
controls — spend *management*, not just spend *tracking*. An accounting
export that erases agent identity the moment money crosses into the books
undercuts that pitch for the one audience (finance, auditors) most likely to
ask "which agent did this." Both QuickBooks (Class) and Xero (Tracking
Category) have a built-in field for exactly this — tagging a line with a cost
center without needing a separate transaction per tag. Using it costs a
config step per platform and nothing else, so there's no real reason to give
up agent attribution to get vendor+day-level postings.

### Sub-cent carry-forward is per (agent, vendor), not per (vendor, day)

Rolling up to vendor+day does not, by itself, solve the sub-cent problem. A
single agent paying one vendor $0.001 once a day is still $0.001 whether it's
grouped with other agents' spend at that vendor or not — a rollup only helps
once there's enough volume *inside* a bucket to add up past a cent, and the
per-agent line requirement (above) means the bucket that has to add up is
`(agent, vendor)`, not `(vendor, day)`.

So each `(agent_id, vendor_host)` pair carries a running residual, in base
units, of ledgerable spend that hasn't cleared a cent yet. Each posting run
adds new spend to the relevant residuals, posts a line for any pair whose
residual has reached >= 1 cent (the postable whole-cent portion; the leftover
fraction stays in the residual), and creates a `(vendor, day)` posting only if
at least one agent's line actually cleared. A day with no line clearing posts
nothing — an empty transaction would be noise, not information.

This is the same shape as a decision already made elsewhere in this system:
Phase 1's reserve/settle split and Phase 3's baseline logic both treat "money
that might move" and "money we know moved" as different questions with
different answers. Here the same instinct applies to *posting* — accumulate
quietly, post only once there's something real to post.

### `unreconciled` needs a suspense account, not a binary in/out choice

Slice 1 already decided `unreconciled` belongs in the *ledger* view
(`APPEARS_IN_LEDGER` deliberately includes it, on the reasoning that a signed,
spendable authorization is a real financial exposure whether or not it's
confirmed). Posting it into an actual accounting system raises a sharper
version of the same question, because a posting isn't a report a human
reads with context — it's an entry that adjusts a real account balance.

Two wrong answers present themselves. Booking it straight into the vendor
expense account overstates spend that may never have happened (Fuel does not
yet know the money moved). Omitting it entirely understates real exposure and
breaks the "no silent gaps" posture the rest of the system holds elsewhere
(the fail-closed budget accounting in Phase 1, the frozen-attempt counter in
Phase 3). A suspense account — `Suspense – Unconfirmed Agent Payments` — is
the standard accounting answer to exactly this shape of problem: a place to
hold a real dollar amount whose ultimate classification isn't known yet,
without either overstating or hiding it.

When Fuel later confirms a formerly-`unreconciled` payment as `settled` (the
`unreconciled -> settled` path `markSettled` already supports), the
integration posts a reclassifying entry — debit the real expense account,
credit suspense — for that payment's specific amount, dated at resolution
time. Finding "that payment's specific amount" inside an already-rolled-up
posting is why this document sketches (not builds) an `export_postings` join
table keyed by `payment_id`, recording which external posting/line absorbed
it. Without that, reclassification would have to guess at the amount instead
of knowing it.

An `unreconciled` payment that never resolves simply stays in suspense
permanently. That's correct, not a gap: it mirrors the actual state of the
world, which is that Fuel itself does not know whether that money moved.

### Category mapping: one default account, not a mapping UI, for the first version

Slice 1 already shipped the CSV's `Category` column empty on purpose, on the
reasoning that chart-of-accounts mapping is a per-customer decision that
wasn't invented in that slice. The same reasoning applies here, more sharply,
because the CSV's empty column costs nothing to ship while a real mapping UI
is a meaningful feature in its own right — approval flows, per-vendor
defaults, override history.

Building that UI before anything can post at all would gate the whole
integration on a feature that isn't required to post a first transaction.
Instead: one operator-configured default expense account ("Agent API
Expenses" or similar), separate from the suspense account above, that every
settled line posts against regardless of vendor. Per-vendor mapping is a
real feature and explicitly deferred, not rejected — this just refuses to let
it block the first working posting.

## What this document does not decide

- **QuickBooks vs. Xero, or both.** No developer/sandbox account exists yet
  for either. That choice needs the user's input on which their target
  customers actually use, and can't be made from inside this codebase.
- **OAuth flow, token storage, or either platform's specific API shape**
  (QuickBooks Bill vs. Xero's equivalent, exact Class/Tracking Category
  request format, rate limits). Platform-specific work for whichever is
  chosen first.
- **The exact schema** for the residual-tracking and posting-join tables
  sketched above (`export_rollup_residual`, `export_postings` are working
  names, not final ones). Real schema design happens when this is actually
  built, following this project's established migration patterns (plain
  `ALTER TABLE ADD COLUMN` where possible, full rebuild where a `NOT NULL` or
  `CHECK` constraint requires it).
- **How the posting run is triggered** — on a schedule, on demand from the
  dashboard, or both.

## Consequences

- A `(agent, vendor)` pair with genuinely low volume (a handful of sub-cent
  payments a week) can sit unposted in residual for a long time. This is
  expected, not a bug: the alternative is posting fractional cents, which no
  accounting system supports.
- The suspense account will occasionally hold money for a long time if a
  payment never resolves out of `unreconciled`. That's a real accounting
  artifact of a real system state, not something the integration should try
  to paper over by force-classifying it one way or the other.
- Reclassification depends on `export_postings` correctly recording which
  posted line absorbed which payment. If that bookkeeping is wrong, a
  reclass could misattribute — this makes `export_postings` load-bearing for
  correctness in a way worth testing deliberately when it's built, not an
  incidental detail.
- The single default expense account means the first version of the
  integration cannot yet answer "how much did we spend on category X" inside
  QuickBooks/Xero itself — only "how much did we spend, by agent and vendor."
  Accepted as an MVP boundary, not a permanent one.
