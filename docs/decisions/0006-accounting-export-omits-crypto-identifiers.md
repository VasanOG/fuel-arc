# 0006 — The accounting export carries no crypto identifiers

**Status:** accepted
**Date:** 2026-08-03
**Supersedes:** nothing. Scoped alongside
[0005](./0005-dashboard-shows-wallet-addresses.md).

## Decision

The accounting CSV export (`GET /api/exports/transactions.csv`) contains no
transaction hashes, no wallet addresses, no network or asset names, and no
`payments.detail` text. The reconciliation handle is the Fuel payment id.

## Why

CLAUDE.md and `/docs/architecture.md` state that no crypto terms ever appear in
the product. 0005 carved out one narrow exception for wallet addresses on the
internal dashboard, and was explicit that it "applies only to the current
internal dashboard... does not extend to any other surface, and does not mean
addresses are cleared for display generally."

An export is a different kind of surface from anything the rule has been
applied to so far. The dashboard is a screen we control, shown to us. A CSV
leaves the system entirely: it is emailed to a bookkeeper, imported into
QuickBooks or Xero, and stored in a third party's records for as long as they
keep books. Whatever it contains stops being ours to revise. If the no-crypto
rule means anything, it applies here more strongly than to a screen, not less.

There is also a plain product argument. An accountant reconciling a transaction
has no use for a Base Sepolia transaction hash. It is not a reference their
software can match on, not something they can query, and not something they can
act on. It would be noise that raises questions we do not want the product to
be answering.

## What replaces the tx hash

The Fuel payment id (a UUID, already the primary key). It is stable, unique,
and meaningful inside Fuel, so support can resolve one to an on-chain record
internally without that record ever reaching an accountant's books. It is also
the natural idempotency key for the QuickBooks/Xero integration, which needs a
per-transaction reference to avoid double-posting on a re-import.

This is worth stating plainly because the tx hash is the obvious thing to reach
for as that key, and it is the wrong choice for the reasons above.

## Also omitted: `payments.detail`

`detail` is operator-facing failure text, not a memo. Live values include
"unlocked without a settlement tx hash" and "abandoned while signing; assuming
the authorization is spendable". It is protocol-flavoured, occasionally names
the rail directly, and would read as alarming to someone outside the company.
The export emits a mapped status phrase instead — see
`src/lib/export-presentation.ts`, which is the first term-mapping layer in the
codebase and the place any future vocabulary decision belongs.

Related: `unreconciled` is engineering jargon for a genuine accounting
situation — signed, spendable, outcome unknown. It exports as "Awaiting
confirmation", which claims neither that the money moved nor that it did not.

## Known inconsistency, deliberately not fixed here

`GET /api/agents/:id` currently returns `txHash` on each payment, and the
dashboard shows wallet addresses under 0005. Both predate this decision. This
ADR does not resolve them; it records that the export was built to the rule
rather than to the existing exceptions. Tightening the agent detail route is
its own change with its own consequences for the dashboard.

## Consequences

- An accountant cannot independently verify a payment against a block explorer.
  Accepted: that is not a workflow the product supports or wants to.
- Anyone debugging a specific payment works from the payment id and the
  operator API, not from the export.
- The QuickBooks/Xero integration inherits this constraint. It must key on the
  payment id.
