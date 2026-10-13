# Phase 5 — Fuel product UI blueprint

Status: accepted, 2026-08-26. Supersedes nothing; this is the first UI document
in the repo. Read `/docs/decisions/0008` and `/docs/roadmap.md` first.

> **Scope discipline.** This blueprint describes the whole of Phase 5. Only
> Slice 5A-1 has been built. Every capability below is either backed by a route
> named in §5 or explicitly marked **not built**. Nothing in this document
> licenses a screen that implies a capability Fuel does not have.

---

## 1. Design thesis

**Every number in Fuel is a claim, and the product's job is to make every claim
answerable.**

Fuel's competitor is not a wallet or a dashboard; it is a spreadsheet someone
maintains by hand and a finance lead who does not trust it. What Fuel uniquely
holds is not the total — anything can total a column — but the chain underneath
it: this cent came from these payments, made by this agent, against this cap, on
this authority, at this moment. ADR 0008 §3 states the obligation plainly: *"the
traceable version of that chain is the product."*

The accounting page already embodies this. Its design note says *the document is
the surface; the provenance is underneath*, and a ledger line unfolds downward
into the payments beneath it, each naming the decision that authorised it. The
thesis of Phase 5 is that this stops being one page's clever idea and becomes
the product's grammar: **the same downward unfold, at every level.** A figure on
Overview unfolds into agents. An agent's spend unfolds into payments. A payment
unfolds into the policy decision or the named human that permitted it. One
interaction, learned once.

Two consequences follow, and they set the visual direction:

**The shell is dark so the evidence is light.** Navy and charcoal carry
navigation, identity and environment — and nothing else. Every figure lives on a
warm paper surface. The reader's eye goes to the record, not the furniture. This
is also why the shell borrows the ledger's own devices rather than inventing new
ones: hairline rules, small tracked uppercase labels, 2px radii, a solid rule
marking the active item instead of a filled pill. The chrome should read as part
of the same document system.

**Colour is semantic or absent.** Teal for settled and balanced, ochre for
debit, red reserved strictly for blocked, failed, and dangerous actions.
Debit and credit stay ochre and teal rather than red and green, for the reason
already written into `accounting.module.css`: in double entry they are
directions, not gains and losses, and colouring them with profit-and-loss
valence would teach the reader something false. There are no decorative
gradients, no charts that a table would say better, and no card grid whose only
job is to look like a SaaS product.

---

## 2. User journeys

### A. Register an agent → assign authority → integrate

1. **Agents → Register agent.** Name, team, spend authority. The form validates
   before submitting because `POST /api/agents` provisions custody as a side
   effect — the backend deliberately resolves a 400 *before* provisioning, and
   the UI mirrors that ordering rather than fighting it. Provisioning is slow;
   the button shows real progress and cannot be double-fired.
2. **Agent detail.** The new agent's authority, its team, and an empty spend
   history with an empty state that says what will fill it.
3. **Developer.** The exact request this agent now makes, and the outcomes it
   can receive. Read-only (see §5).

**Not built:** per-agent credentials. The agent role key is one shared secret
read from the environment at boot; agents cannot be told apart or revoked
individually. The Developer page says so in those words.

### B. Agent payment → anomaly → approval → freeze

1. **Activity Ledger** shows the refused payment, its vendor, its amount, and
   its reason in operator vocabulary (`src/lib/export-presentation.ts` is the
   term-mapping layer and stays authoritative — never raw statuses).
2. **Approvals** shows the held request grouped by scope: team, company, or
   anomaly. Each states what approving exempts **and what it does not** — the
   agent's own cap and the velocity limit are never waived
   (`src/db/payments.ts:419-460`). Approve and Deny are two-step confirms and
   are single-use; a 409 means someone else already decided it, and the UI says
   that rather than "something went wrong".
3. **Freeze** from the agent page, when the pattern repeats. Explicit confirm.
   Reason is **optional**, because `POST /api/agents/:id/freeze` accepts
   `reason?` and forcing a required field in the UI would misrepresent the
   record. The frozen-attempt counter is shown because
   `agents.frozen_attempt_count` genuinely backs it — it is the evidence the
   freeze is holding.

**Not built:** a structured anomaly feed. `approval_requests` stores the
baseline, threshold and sample size only inside a prose `detail` string written
at `src/payments/pay.ts:247`. Approvals renders that sentence as written. It
does not parse numbers out of it and re-present them as fields, because a
display that looks structured implies a structure the database does not have.

### C. Accounting preview → provenance drill-down → post

Unchanged in substance. Pick a day → **Preview entry** → read the ruled journal
entry → unfold a line into its payments → each payment names its authorisation →
**Post to QuickBooks Sandbox** behind an inline confirm.

Preview and post stay separate, snapshot-bound routes. No merged button, no
`dryRun` toggle. ADR 0008 §4 is explicit: without the immutable draft, preview
and post are two clicks with a gap, *"which makes the review — the only human
control on this path — meaningless."* Preview's silence is what makes "did that
reach Intuit?" answerable.

---

## 3. Page by page

| Route | What it is | Primary actions |
|---|---|---|
| `/` **Overview** | Exposure at a glance and the list of things needing a person. Metrics computed from real existing data only (§5). | none — Overview decides nothing |
| `/agents`, `/agents/[id]` | Roster: name, team, authority, spent, remaining, status. Detail adds spend history and freeze state. | Register agent · Edit authority (confirm) · Freeze / Unfreeze (confirm) |
| `/activity` **Activity Ledger** | Cross-agent payment feed, filterable by agent, vendor, status and date. Rows unfold into policy context and the approval, if any. | Export CSV |
| `/approvals` | Pending queue grouped by scope, each stating what it exempts and what it does not. Decided history below. | Approve / Deny (confirm) |
| `/accounting` | The journal entry and its history. Setup controls move to Integrations. | Preview entry · Post to QuickBooks Sandbox (confirm) |
| `/integrations` | QuickBooks connection, account mapping, currency verification. Custody reported honestly (§5). | Connect · Set up accounts · Verify currency · Disconnect (confirm) |
| `/developer` | The integration contract that exists today. | Copy request snippet |

### Deliberately absent

- **No Reconcile and no Reverse on Accounting.** The routes exist and are
  already allowlisted in `dashboard/app/api/quickbooks/route.ts`, but reversing
  a posted entry writes a new document to a customer's books. It gets its own
  slice, its own confirm design and its own security review — not a button
  added because the endpoint happened to be reachable.
- **No "operator-confirmed currency" state.** `qbo_config.currency_source` is
  `CHECK (currency_source IN ('quickbooks_preferences'))`. There are exactly two
  truthful states: verified from QuickBooks Preferences, or not available and
  therefore refused. A third label would invent a provenance the schema cannot
  hold.
- **No environment switcher, anywhere.** Sandbox is a hardcoded constant, not a
  setting. Reaching production is a reviewed code change, exactly as enabling
  mainnet is (CLAUDE.md; ADR 0008).
- **No wallet addresses.** See §5.

---

## 4. Components and tokens

### Extract from the accounting workbench, without changing how it looks

`AccountingWorkbench.tsx` is 593 lines holding all state, all fetching, all
formatting and all markup. Its ledger primitives — `LedgerTable`, `LedgerHead`,
`AmountCell`, `TotalRow`, `DisclosureRow`, `AuthBadge` — are the design asset,
and they become the drill-down primitive every other page reuses. Extraction is
a later slice and must be visually byte-identical.

### Shared primitives

`AppShell` · `SideNav` · `PageHeader` · `Surface` (paper card) · `DataTable` ·
`Money` · `StatusPill` · `ConfirmAction` (inline two-step — this codebase has no
modals and this blueprint does not introduce any) · `Notice` (with the live
region the current one lacks) · `EmptyState` · `ErrorState` · `Filters`.

### Tokens

One `:root` layer in `dashboard/app/theme.css`, in three groups:

- **Shell** — a navy scale rooted in the same hue as the existing `--ink`
  (`#14192b` ≈ hsl 226°), so chrome and content are demonstrably one family.
- **Paper** — `--ink`, `--ink-60`, `--ink-40`, `--paper`, `--surface`, `--rule`,
  `--rule-strong`, `--debit`, `--credit`, `--live`, promoted verbatim out of
  `accounting.module.css` at their exact existing values, so the ledger does not
  move by a pixel.
- **Scales** — space, type, radius and the one hairline shadow. None of these
  exist today; every value in the codebase is a literal.

Also captured: the success, error and info surfaces currently hardcoded as bare
hexes, and the two incompatible radius languages (2px in the accounting module,
4px in globals) resolved to one.

> **Naming note.** The file is `theme.css`, not `tokens.css`. The no-crypto
> verification greps for the substring `token`; naming a stylesheet after it
> would be the fifth instance of a trap this codebase has already been caught by
> four times. See §8 for how the check is actually scoped.

---

## 5. Data dependencies — real versus demo

**Everything renders from real API responses. Nothing is simulated in the
frontend.** Where a capability does not exist, the UI says so; it does not mock
it.

### Backed today

| Surface | Route |
|---|---|
| Agents roster, budgets, spend | `GET /api/agents` |
| Agent detail + payment history | `GET /api/agents/:id` |
| Authority edit | `PATCH /api/agents/:id` |
| Freeze / unfreeze | `POST /api/agents/:id/{freeze,unfreeze}` |
| Approvals queue and decisions | `GET /api/approvals`, `POST /api/approvals/:id/{approve,deny}` |
| Company and team budgets | `GET /api/company`, `GET /api/teams` |
| Rollup lines and residual | `GET /api/postings`, `GET /api/postings/:id` |
| QuickBooks, all of it | the thirteen `/api/integrations/quickbooks/*` routes |
| CSV export | `GET /api/exports/transactions.csv` |

### Two new read-only routes, in later slices

Both require security review before merge. Both are reads; neither mutates
anything, and neither goes near money movement.

**`GET /api/payments`** — for the Activity Ledger. The query already exists as
`listPaymentsForExport` (`src/db/payments.ts:736`). Requirements:

- strict company scoping — results are constrained to the caller's company, and
  the scope is applied in the query, never filtered after the fact
- allowlisted filter and sort fields; an unknown field is a 400, not an ignore
- bounded or cursor pagination with a hard maximum page size; no unbounded reads
- no secrets and no internal fields — in particular `payments.detail` is
  free-text carrying refusal reasons and the `demo-seed` marker, and is
  presented through `src/lib/export-presentation.ts` or not at all

**`GET /api/environment`** — so the shell's Sandbox badge reads server state
rather than a frontend literal. The whole point of the pinned constants is that
the environment is a property of the deployed code, and a hardcoded badge in the
browser would assert exactly what it is supposed to prove. Requirements:

- **display-safe labels only** — never raw URLs, ids, realm ids, network
  identifiers, asset identifiers, credential state or configuration
- the response is a closed set of presentation strings, e.g.
  `{ environment: "sandbox", label: "Sandbox" }`, and adding a field is a
  deliberate edit
- unauthenticated callers get nothing; it sits behind the same operator auth as
  every other `/api` route

### Not built, and said so on screen

- Per-agent credentials, key rotation, revocation, individual agent identity
- A custody health check. There is no route. The Integrations page reports what
  it can actually observe — whether balances are currently readable — and names
  that limitation rather than showing a green dot it cannot justify
- A structured anomaly feed
- A ledger-integrity endpoint; `verifyPostingIntegrity` is script-only

### Demo labelling

The marker is `detail = 'demo-seed'`, written by `scripts/seed-demo-day.ts` and
exposed only on `GET /agents/:id` and `GET /approvals`. The rollup, the trace and
the CSV all strip `detail` entirely, so no accounting surface can see it.

**Where it is visible, it is labelled** — payments on the agent detail page
carry a quiet `demo` marker. The test is exact equality on the whole field, not
a prefix: a real payment's `detail` is a refusal sentence written by
`src/payments/pay.ts` and is never this string. That makes it reliable in
practice while remaining a convention rather than a schema guarantee, which is
why the page says how many rows are marked rather than implying the count is
authoritative. A real `source` column is the durable fix and is listed as a
backend dependency below.

`detail` itself never reaches the browser. It is reduced to a boolean at the
network boundary in `dashboard/lib/fuel.ts`, because the same field carries
refusal reasons written in base units — the storage representation, and not
something an operator should ever be shown.

**The workspace-level label still waits on `/api/environment`**: a persistent
Sandbox marker in the shell is a claim about the deployment, and it should read
server state rather than be asserted by the browser.

---

## 6. Responsive, empty, loading, error, permission-denied

**Responsive.** Sidebar at ≥60rem; below that a top bar with a disclosure that
closes on navigation. Data tables stack under 40rem. **The ledger keeps its
columns and scrolls** — a debit/credit table that reflows into stacked
key/value pairs is no longer a ledger, and the form is the argument.

**Loading.** Per-action pending state. The accounting page currently has a
single global `busy` flag, so previewing disables Disconnect and relabels every
button on the page "Working…". Each action owns its own pending state.

**Empty.** Every table gets one. The agents table has none today — zero agents
renders a header over nothing. Empty states say what will fill them.

**Error.** `error.tsx` per route segment; none exists anywhere today, so
`listAgents()` throwing on an unreachable API yields Next's default crash
screen. Errors name what failed and what to do, in the interface's voice.

**Permission-denied.** The operator key is held server-side and never reaches
the browser, so 403 is not reachable from the dashboard. 401 (key missing or
rejected) and 502 (API unreachable) are, and get specific copy — configuration
problems, phrased as configuration problems.

---

## 7. Implementation order

| Slice | Scope | Risk |
|---|---|---|
| **5A-1** ✅ | Shell, nav, token layer, both existing pages re-homed; ADR 0005 closed; QA harness | none — no fetch, route handler, allowlist or payload touched |
| **5B-1** ✅ | Overview, `/agents`, `/agents/[id]` — all from existing read routes | read-only, no new API surface |
| **5B-2** ✅ | `GET /api/payments`, `GET /api/environment`, canonical presentation, refusal codes, demo marker, export hardening | backend/security — see ADR 0009 |
| **5B-3** ✅ | `GET /api/approvals` operator-only and allowlisted; export company predicate | backend/security — see ADR 0009 |
| **5B-4** ✅ | Agents, teams and company APIs scoped and operator-only | backend/security |
| **5B-5** ✅ | The Activity Ledger UI, on `GET /api/payments` | read-only |
| **5B-6** ✅ | Environment badge, honest demo labelling, read-only Approvals queue | read-only |
| **5C-1** ✅ | Integrations + Developer | read-only |
| 5B-7 | Freeze / unfreeze from the agent page | first dashboard mutation route → security-reviewer |
| 5B-8 | Approve / deny from the queue | mutations → security-reviewer |
| 5C-2 | Ledger primitives extracted; accounting page recomposed (renumbered from 5C-1) | touches the posting surface → security-reviewer |
| 5C-3 | Reconcile / Reverse | writes to customer books → security-reviewer, own confirm design |

### Backend dependencies, in the order they block something

1. **`GET /api/payments`** — filterable, paginated. Blocks the Activity Ledger
   entirely, and until it exists the agent detail page renders the most recent
   25 of a response that arrived in full.
2. **`GET /api/environment`** — display-safe labels. Blocks the shell's Sandbox
   badge.
3. **Freeze and unfreeze route handlers in the dashboard.** The Fuel API has
   both; the dashboard has a handler only for the cap PATCH. Until one exists,
   the agent page reports frozen state and does not offer to change it.
4. **A presented payment status on the API.** `src/lib/export-presentation.ts`
   is the stated home for vocabulary, but it is server-side and the dashboard
   cannot import across the two TypeScript projects, so
   `dashboard/lib/presentation.ts` restates the mapping. Two copies of a
   vocabulary is a drift risk with a known fix.
5. **Structured refusal reasons.** Why a payment was blocked exists only as
   free prose in `payments.detail`, written in base units. The agent page shows
   the outcome and not the reason, because parsing that sentence would be
   guessing at a shape the database does not promise.
6. **A real demo-data column.** `detail = 'demo-seed'` is a convention.
7. **A team read route with its agents**, or team context on the agent list, if
   team-level drill-down is ever wanted — `GET /api/teams/:id` exists and
   already nests agents, so this is close to free.

---

## 8. Visual and accessibility QA

The repo has no screenshot, accessibility or test tooling, and deliberately no
test framework — `scripts/verify-rollup.ts` records why, and introducing one
*"is a convention decision that should not ride in on a slice that touches
money."* A UI slice is the right place for browser tooling, and it stays in the
established shape: a `main()` that throws and exits non-zero.

**`scripts/qa-dashboard.ts`** — Playwright headless, for screenshots and
scanning only, never as a test runner. **It measures a production build and
refuses to measure anything else.** The Next development server puts things in
the page that never ship: its dev-tools overlay sits in the tab order, and on
the agent detail page it echoes the raw upstream API response — custody address
and settlement identifiers included — into the browser regardless of what the
page renders or what the boundary picked. Every server response is clean in both
modes; it appears only when a real browser loads a dev page. Measuring dev would
mean reporting failures that are not in the product, and learning to ignore
them. Per route it:

1. captures **desktop 1440×900, tablet 834×1112, mobile 390×844** into
   `docs/ui/shots/`
2. runs an **axe-core** scan and fails on any serious or critical violation
3. checks **keyboard focus** — that tabbing reaches the primary controls and
   that each focused element has a visible focus indicator
4. greps the **rendered text** for crypto terminology
5. greps the **delivered HTML** for anything address-shaped

Points 4 and 5 are two different questions and the difference is the whole
lesson of 5A-1.

*What can a person see?* — rendered text. The existing greps in
`verify-rollup.ts:409` and `verify-quickbooks.ts:224` run over serialized
payloads, where every string is user-visible. Source code is different: `token`
appears in design-token naming, `chain` in a CSS class for the accounting page's
step sequence. Grepping dashboard *source* would produce false positives that
train people to ignore the check. `document.body.innerText` asks the question
that actually matters and answers it about the rendered page.

Banned, matching the existing lists: `0x`, `usdc`, `sepolia`, `chain`, `wallet`,
`token`, `facilitator`, `x402`, and `eip155`. One deliberate difference: the
existing lists ban a bare `eip`, which is safe against a JSON payload but not
against prose, because "receipt" contains it.

*What leaves the server?* — the delivered HTML, framework payload included. A
rendered-text check cannot see this and 5A-1 proved it: removing `walletAddress`
from the dashboard's agent type stopped the field being rendered but not being
transmitted, and five addresses were reaching the browser with nothing on screen
showing them. A precise pattern rather than the word list, because the full HTML
legitimately contains hashed class names the word list would trip over.

**Both checks were confirmed to fail against the broken version before being
trusted**, which is the bar `verify-rollup.ts` and `verify-quickbooks.ts` are
written to.

**Verification bar for every UI slice**, matching house style:

```
npx tsc --noEmit
cd dashboard && npm run typecheck
npm run verify-rollup        (155 checks)
npm run verify-quickbooks    (142 checks)
npm run qa-dashboard
```

plus a prose *"Verified —"* writeup, a security-review paragraph, and a
*"Known gaps carried forward"* list.

---

## Appendix — ADR 0005 closes here

ADR 0005 permitted wallet addresses on the dashboard as a *"deliberate,
temporary exception"* whose stated revisit trigger was *"before anything
resembling a customer-facing version of the dashboard exists."*

Phase 5 is that thing. The exception is closed, not narrowed: addresses are
removed from every dashboard surface, the field is dropped by an explicit
allowlist pick at the network boundary (`toAgentCore` in `dashboard/lib/fuel.ts`)
so it never leaves the server, and both no-crypto checks in §8 now run against
the dashboard. The backend still returns the field — it is real data about a
real account — and Fuel's own operational scripts still read it. It is no longer
in the product.

Removing it from the TypeScript type was tried first and was not enough; the
dated note on ADR 0005 records why, because the same mistake is available
anywhere a typed wrapper sits in front of an untyped upstream response.

A dated closure note has been appended to `docs/decisions/0005`.

---

## Appendix — roadmap conflict

`docs/roadmap.md` describes two different Phase 5s: the header block calls it
*"polished dashboard and guided demo workspace"*, while the `## Phase 5` section
says *"One P&L — merchant/earning side registration, combined spend + earn
dashboard."* The dashboard work takes Phase 5; One P&L moves to Phase 6.
