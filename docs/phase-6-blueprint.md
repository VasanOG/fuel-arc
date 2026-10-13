# Phase 6 — One P&L blueprint

**Date:** 2026-08-31
**Reads with:** [0011](./decisions/0011-the-earning-side.md) (where money
received comes from), [0012](./decisions/0012-revenue-in-the-ledger.md) (how
it becomes a posting). Those settle the *what* and *why*. This settles the
*shape and order*.

Not under `/docs/ui/` — unlike Phase 5, most of this phase is not interface.

---

## 1. Thesis

Every number Fuel shows today answers a question about permission: what may
this agent spend, how much is left, what was refused. That is a complete
picture of an agent as a **cost**.

Phase 6 makes an agent something that can also produce, and the question
changes from "did it stay inside its limit" to "was it worth running." Those
are different questions and they are not answered by the same arithmetic — a
cap is about money that might move, a P&L is about money that did.

The phase succeeds if an operator can look at one agent and see both sides of
it, and if both sides land in their accounting system with the same
attribution. It fails if revenue arrives as an estimate, or if the earning
side quietly changes what an agent is allowed to spend.

**One thing this phase is not:** a payouts product. Money earned accrues and
leaves by bank transfer, as an operator action. Nothing here schedules,
forecasts, or automates that.

---

## 2. Journeys

### A. Register an endpoint → first payment → it appears in the ledger

1. An operator has an API their team already serves. On the Earning page they
   register it against an agent: origin URL, price, which agent earns.
2. Fuel issues a public path and confirms the endpoint is live. **It does not
   show a receiving address** — see §6.
3. A payer calls the Fuel path. Fuel answers 402, verifies payment through the
   facilitator, forwards to the origin, returns the response.
4. A `receipts` row is written for the payment Fuel witnessed.
5. The receipt appears in the Activity Ledger alongside spend, marked as an
   inflow.

The failure branch matters as much as the success one. If the origin is
unreachable, or settlement never confirms, the operator sees exactly that —
an endpoint that served and was not paid is a real state and is shown as one,
not smoothed away.

### B. Combined P&L → per-agent margin → post to QuickBooks

1. The Overview shows earned, spent, and net for the company.
2. An agent's page shows the same three for that agent — the question "is
   this agent worth running" answered on its own row.
3. Accounting previews a posting containing both directions.
4. Posting writes one journal entry per day: expense lines, revenue lines, and
   one contra line for the net movement in the Fuel balance.

---

## 3. Data model

Two new tables, sketched in [0011](./decisions/0011-the-earning-side.md);
two existing tables rebuilt, specified in
[0012](./decisions/0012-revenue-in-the-ledger.md).

New:
- **`earning_endpoints`** — agent-owned. Origin URL, price, the public
  identifier Fuel serves it on, enabled flag.
- **`receipts`** — one row per inbound payment Fuel witnessed. Its status
  vocabulary is reasoned from the inbound direction, not copied from
  `PAYMENT_STATUSES`.

Rebuilt:
- **`posting_lines`** — `ledger_class` CHECK gains `revenue`; `vendor_host`
  becomes `counterparty`.
- **`export_postings`** — polymorphic `payment_id` / `receipt_id` with
  partial unique indexes.

Unchanged and deliberately so: `payments`, and every cap query over it. A
receipt cannot reach `COUNTS_AGAINST_CAP`, and that is the point.

---

## 4. API surface

### New routes

| Route | Role | Notes |
|---|---|---|
| `POST /api/earning-endpoints` | OPERATOR | Register. Validates the origin through `safe-fetch`. |
| `GET /api/earning-endpoints` | OPERATOR | List, company-scoped. |
| `PATCH /api/earning-endpoints/:id` | OPERATOR | Price, enabled. |
| `GET /api/receipts` | OPERATOR | Same contract shape as `GET /api/payments`. |
| `GET /api/pnl` | OPERATOR | Earned, spent, net — company and per agent. |

Plus the gateway itself, which is **not** under `/api` and is the only route
family reachable without an operator credential. It is authenticated by
payment, not by a shared secret.

**Roles.** Registering an endpoint and setting its price is an OPERATOR
action, without exception. An agent setting its own price would be an agent
setting its own money policy, which is the thing the existing role split
exists to prevent — the same reason an agent can pay but cannot change a cap.

**Tenancy.** Every new query inherits the existing
`→ agents → teams → company_id` join path, and
[0009](./decisions/0009-activity-data-contracts-and-tenancy-scope.md)'s
warning applies unchanged: that predicate is a query seam, not tenant
isolation. Nothing in this phase upgrades it, and nothing may describe it as
more than it is.

### Existing contracts that change, with blast radius

**`GET /api/payments` gains a `direction` filter.** Two consequences, both
fine, both needing to be stated rather than discovered:

- The route rejects unknown query keys with a hard 400 — *"a caller who
  misspells a filter should be told"* — so `direction` must be added to the
  allowlist before any client sends it.
- Cursors are bound to a fingerprint over the applied filter set. Adding a
  field changes every fingerprint and **invalidates every outstanding
  cursor**. Correct behaviour: a cursor from a different filter set should
  not be honoured. Users mid-pagination get a clean error, not wrong rows.

**The Activity table breaks on an inflow in two places.** The column header
reads `Paid to`, which is false for a receipt. The amount cell is a bare
`${payment.amount}` with no sign handling, so an inflow renders as a
same-looking outflow. Both are rewrites, not relabels — the table needs a
direction column and amounts need to read as in or out at a glance.

**`presentActivityPayment` has no direction field.** It is a closed
allowlist built field by field, which is exactly why adding one is safe: a
field must be named before it can reach the browser.

**Two CSV headers change** — `Vendor` → `Counterparty`, plus a `Direction`
column. [0012](./decisions/0012-revenue-in-the-ledger.md) argues why this is
done now rather than after revenue rows exist.

### Deliberately unchanged

**`dollarsToBaseUnits` keeps rejecting a leading `-`.** Every operator-entered
amount in this phase is a price, and a negative price is not a thing. The
negative amounts that exist in the system are computed, never typed.

---

## 5. UI

### New: an Earning page

Nav gains one destination in the "Operations" group — money moving belongs
with money moving. The `built: boolean` flag on `NavItem` already exists for
exactly this, and its comment predicted it: *"the next destination this nav
grows will need it again."*

Content: the agent's endpoints, their prices, whether each is live, and what
each has earned. Registration is a form. Nothing on this page projects,
forecasts, or schedules.

### Changed: Overview

Gains earned / spent / net. The existing four figures stay.

**These two families of number are computed from different status sets, and
the page must say so.** The current metrics come from `COUNTS_AGAINST_CAP`,
which includes in-flight rows because *"a cap must count money that MIGHT
move."* A P&L means `APPEARS_IN_LEDGER` — money that did move — because
reporting profit that includes reservations which may never settle would be
reporting a result that has not happened.

The two sets differ by design and the difference is documented at length in
`src/db/payments.ts`. Putting both families on one page without labelling
which basis each uses would produce two numbers that look comparable and are
not. Pick per figure, label per figure.

### Changed: Activity Ledger

A direction column, sign-legible amounts, a direction filter. The page stays
a server component with filters as a plain GET form — *"the whole page is a
URL"* — and that property is worth keeping.

### Changed: Agents

Per-agent earned / spent / net. Spend-framed copy across the page
("Spend authority is the ceiling it cannot pass") stays accurate for the cap
and becomes incomplete as a description of the agent. This is a rewrite of
copy, not a find-and-replace.

### Changed: Accounting

The preview shows both directions. If a company's income account has not been
created yet, the page says so as a missing-account state — which already
exists — and spend keeps posting.

### Deliberately absent

No projected revenue. No forecast margin. No payout scheduling. No
break-even date. Phase 5 held itself to *nothing in the UI may imply a
capability that does not exist*, and an earning page is where that rule is
hardest to keep, because every one of those is easy to draw and none of them
is backed by anything.

---

## 6. Two honesty rules that get harder this phase

### The no-crypto-surface rule now has a second frontier

Registration returns "your endpoint is live," never a receiving address. The
402 a payer receives is protocol and is not product surface; anything a
*customer* sees about their own endpoint is. The existing grep check extends
to the earning paths and to `dashboard/`.

The trap is that a receiving address is genuinely useful debugging
information, so there will be a good-faith reason to put it somewhere. The
answer is no, for the same reason [0005](./decisions/0005-dashboard-shows-wallet-addresses.md)
closed — and note that closing 0005 needed two attempts, because a TypeScript
type is erased at build time and stops a field being *rendered* without
stopping it being *transmitted*. Any new client-facing type in this phase
gets an explicit allowlist pick at the network boundary, not a narrowed
annotation.

### The environment badge grows a fifth surface

`describeEnvironment()` reports four surfaces — payments, settlement,
custody, accounting — and every one is a capability Fuel exercises **as a
payer**. Receiving needs its own.

`X402_PAY_TO` is not the value to classify: it is an address, and `KNOWN`
holds origins and network ids. The genuinely new pinned value is the
**gateway's own public origin** — the thing that distinguishes a gateway
serving loopback from one serving real traffic. That is what the fifth
surface classifies.

The module's existing rules hold without exception: exact-equality lookup
never pattern matching, an unrecognised value yields `"unknown"` and never
defaults to `"sandbox"`, and the aggregate is `"sandbox"` only when every
surface is. The file also forbids itself any network, provider or DB call, so
the gateway origin must be a pinned constant like the other four — not a
config read.

---

## 7. Slice order

Each slice ships independently and is useful or invisible, never
half-visible.

### 6A-1 — the ledger migration, with no revenue in the system — done

Everything in [0012](./decisions/0012-revenue-in-the-ledger.md) that is not
about receipts: the `posting_lines` rebuild, the polymorphic
`export_postings`, the `counterparty` rename, class-aware `directionFor`, the
signed-debit contra and its rewritten comment, the split conservation check,
the fourth account, and the `ledgerAccount` / literal-loop type fixes.

**Zero behaviour change.** No revenue exists yet, so this slice is verified
entirely by the existing suites still passing at the same check count. It is
first, and alone, because two table rebuilds under `PRAGMA foreign_keys = ON`
is the most delicate migration this project has attempted and it should not
be debugged alongside a new feature.

### 6A-2 — the gateway, headless

`earning_endpoints`, `receipts`, the proxy that serves the 402 / verifies /
forwards, registration through the API only. No UI.

Verified by Fuel paying its own earning endpoint in one process — the same
trick `/paid-hello` already plays, and the reason that endpoint exists.

Three things this slice cannot ship without, each of which a security review
of the design surfaced as missing:

1. **A way for the origin to refuse direct traffic.** Fronting an API does
   nothing if the API still answers its original address, and the origin URL
   is not a secret. Fuel forwards something the origin can check and a direct
   caller cannot forge, and the instruction to require it ships with the
   feature. Until an origin adopts it, Fuel should not describe that endpoint
   as protected.
2. **An explicit choice about forwarding on `verify` versus `settle`,** and
   whichever is chosen, a request served before settlement confirms is
   recorded as an exposure rather than as revenue. `payForAgent` already
   refuses to call an unevidenced settlement a success outbound; inbound is
   the same exposure aimed at the customer.
3. **The `safe-fetch` loopback exemption, revisited.** Its own comment names
   the trigger — *"revisit if Fuel ever fetches URLs from a less trusted
   source than an authenticated operator"* — and a registered customer origin
   is that trigger arriving. Note that fixing it addresses SSRF and **not**
   the relay problem: a correct guard still permits every public address, so
   "which hosts may Fuel be pointed at, and on whose say-so" is a separate
   question this slice also owes an answer to.

### 6B-1 — receipts reach the books

Revenue rollup, revenue lines, posting into QuickBooks. Verified against the
live sandbox company, the way the QuickBooks slice was.

Two collisions 6A-1 deliberately left alone, because they only bite once
revenue lines exist and both would have been dead code until then:

- **Document numbers must include direction.** The number derives from grain,
  counterparty, day and generation, so `daily:<day>` names both the spend and
  the revenue posting for that day. Worse, `postedGeneration` counts by
  `(company, grain, posting_day, counterparty)`, so a spend posting would bump
  a revenue posting's generation and the two would fight.
- **`eligibleLines` must filter by direction**, or the first run sweeps revenue
  lines into a spend draft.

### 6B-2 — the operator's triage loop

Added after 6B-1 shipped, when a read of the delivered code found three
operational dead ends this blueprint had not anticipated. `GET /api/receipts`
(receipts have no route at all and `listReceiptsForCompany` has zero callers),
a receipt reconciler (`served_unsettled` and `settle_unknown` are terminal —
no statement in the repo can move a receipt out of them, and the reaper
manufactures `settle_unknown` every 60 seconds), and a payment reconciler
(`unreconciled` sits in `COUNTS_AGAINST_CAP` with no operator path to
`markSettled`, so budget is consumed permanently).

API only. The dashboard's action buttons are Phase 7's.

The shape is not new: QuickBooks' `pending` postings already have
`pendingPostings()` → reconcile → reverse. This slice gives the two states
[0011](./decisions/0011-the-earning-side.md) argued hardest about the same
treatment, because careful status vocabulary with no way to act on it is a
half-built control.

### 6B-3 — the interface

*Renumbered from 6B-2 when the triage slice was inserted ahead of it; nothing
had shipped under the old number.*

The Earning page, Activity's direction column, Overview and Agents P&L
figures, the fifth environment surface. Plus stuck receipts shown read-only,
using 6B-2's read path.

Last, deliberately. Every screen in it shows something that is by then
already true.

---

## 8. Verification

Per slice, in the shapes this repo already uses (`main()`-that-throws
scripts; there is deliberately no test framework):

- `npx tsc --noEmit` and `cd dashboard && npm run typecheck`.
- `npm run verify-rollup`, `npm run verify-quickbooks`, `npm run verify-api`
  — must pass at the **same check count** after 6A-1, which is what proves
  the migration changed no behaviour.
- A new `verify-earning` covering the receipt lifecycle and, most
  importantly, **both** two-direction integrity invariants — conservation and
  over-absorption. The second one is the trap: its query inner-joins
  `payments`, so once `payment_id` is nullable it silently stops checking
  revenue instead of failing. A verification suite that only exercises
  conservation would report clean while over-absorption goes unchecked, so
  `verify-earning` must include a deliberate break test that over-absorbs a
  receipt and confirms the check actually fires.
- `npm run walk-accounting` extended to walk a posting containing both
  directions.
- `scripts/shoot-dashboard.ts` at desktop / tablet / mobile, plus axe-core,
  keyboard tab order and visible focus on every new or changed route.
- A deliberate check that no receiving address appears in delivered HTML —
  grepping the rendered output, not the source, because that is the
  distinction closing 0005 turned on.

**Security review is not optional here.** Per CLAUDE.md, anything touching
payment, wallet or custody code goes to the security-reviewer subagent. This
phase touches all three plus a new externally-reachable surface, and 6A-2 in
particular introduces the first route in the product that is reachable
without an operator credential.

**Sandbox only.** Every pinned constant stays pinned. Nothing in this phase
is a reason to enable mainnet, and enabling it remains a reviewed code change
requiring the user's explicit in-the-moment confirmation — not an env edit,
and not a consequence of the gateway needing to be publicly reachable.
