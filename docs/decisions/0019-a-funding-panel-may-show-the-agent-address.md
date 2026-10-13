# 0019 — A funding panel may show an agent's address, narrowly

**Status:** accepted
**Date:** 2026-09-27
**Narrows:** [0005](./0005-dashboard-shows-wallet-addresses.md), which closed
the dashboard's earlier address exception "without exception". This ADR
reopens one, smaller one.
**Does not touch:** [0001](./0001-custody-provider.md) (custody provider),
[0006](./0006-accounting-export-omits-crypto-identifiers.md) (the export
stays address-free), or mainnet readiness (see "What this does not cover").

## Decision

**One panel, on the agent detail page, may show that agent's own funding
address, network and asset — behind an explicit click, to an operator or
owner, and nowhere else.**

1. `GET /api/agents/:id` gains a `funding: { address, network, asset }`
   field. It is built by `presentFunding` in `src/api.ts`, called only from
   that one route handler — never folded into `present()` or
   `presentWithBalance()`, which also back `GET /api/agents` (the list) and
   every other reader of an agent.
2. **`network` and `asset` are named plainly: "Base Sepolia" and "USDC".**
   They come from `NETWORK_LABEL`/`ASSET_LABEL` in
   `src/fireblocks/provision.ts`, beside the asset ids they describe, not a
   second, separately maintained copy in the dashboard.
3. **The dashboard shows this only after a click.** The agent detail page
   (`dashboard/app/agents/[id]/page.tsx`) renders a "Show funding details"
   control by default and nothing crypto-flavoured until it is pressed. Once
   pressed, a client component (`FundingPanel.tsx`) shows the network, the
   asset, the address (copy-on-click), and a plain warning that a transfer on
   the wrong network is not recoverable.
4. **The screen says "funding address" or "deposit address", never
   "wallet".** The exception exists to convey network, asset and address —
   there is no safety reason to also say "wallet", so it stays out.
5. **`scripts/qa-dashboard.ts` keeps enforcing 0005's rule everywhere else**,
   including on this route before the click. Its exemption is scoped to
   exactly this route, this state, and the caller's own agent's address —
   not a blanket allowance (see "How the enforcement stays narrow").

## Why

### The need is real, and it's a safety need, not a convenience one

Testers fund their agents directly: USDC on Base, no card on-ramp, for the
beta. A wrong-network crypto transfer is not reversible. Telling a tester the
network and asset plainly, next to the address, is harm reduction — the
alternative is a person guessing, or being told nothing and finding out the
address some other way with no warning attached. That is a different kind of
argument from the one 0005's internal exception rested on ("debugging is
easier with the raw address"), and it is why this ADR treats it as narrow
rather than as evidence the old exception should simply reopen wholesale.

### Why not avoid the terms entirely

`/docs/architecture.md`'s own statement of the rule says funding "happens via
bank transfer in the UI, even though the underlying rail is stablecoin/
crypto" — describing a product that abstracts the rail away entirely. That
remains the goal. It is not what this beta slice can build: there is no
card on-ramp yet, so for now a tester's own crypto is the only source of
funds, and the transfer itself happens outside Fuel, wallet to wallet. Fuel
cannot make that transfer safe by describing it vaguely; a person copying an
address without being told the network is the failure mode this panel exists
to prevent. So this ADR is an explicit, named departure from that sentence,
not a reinterpretation of it, and it is scoped to stay exactly as small as
that need.

### Why one route, one field, and never `present()`

`present()` in `src/api.ts` stopped returning `agent.address` in slice 5B-2,
and not only at the dashboard — at the API. The finding then: `GET /agents`
was reachable with the shared `AGENT` credential (one secret issued to every
agent), so any agent's integration could enumerate every other agent's
custody address.

Checked before writing this: every current caller of `present()` — the two
read routes, plus create, patch, freeze and unfreeze — is already
`OPERATOR`-only, so putting `funding` on `present()` today would not, by
itself, hand it to the `AGENT` credential through any route that exists now.
It would still be the wrong place for it. `present()` is what every future
agent-touching route reaches for by default, including the four write routes
above, none of which have any reason to return a deposit address in their
response. Keeping `funding` out of `present()` is the same least-privilege
choice `toAgentCore` already makes one layer up, in `dashboard/lib/fuel.ts` —
an explicit pick for the one place that needs it, not a field every caller
inherits because it happened to be convenient where it was added.
`presentFunding` is called from exactly one route handler, which is already
`OPERATOR`-only and company-scoped.

### Why behind a click, not just behind a role

An operator or owner can already see this agent's spend cap, balance and
payment history on the same page with no extra step. The click is not an
access control — the API-level role check is — it is what keeps the address
off the page for the ordinary case of an operator checking on an agent that
does not need funding right now, so the far more common view of this page
stays exactly as address-free as every other dashboard route.

### How the enforcement stays narrow

`scripts/qa-dashboard.ts` scans every route twice for this reason: rendered
text (what a person can see) and every byte the page actually delivers (what
could leak with nothing shown for it — the exact bug 5A-1's security review
found, addresses arriving in the browser with no screen showing them). Both
checks keep running on the agent-detail route in its default, unclicked
state, exactly as before. A second pass, only after the reveal click, is
scoped two ways rather than exempted wholesale:
- only the three terms the design actually produces — `0x` (the address
  itself), `usdc` and `sepolia` (from "Base Sepolia") — leave the banned-term
  list, and only in the revealed state; every other term, including "wallet"
  and "custody", stays banned even here, because nothing in `FundingPanel.tsx`
  uses them;
- the delivered-bytes check does not turn off the `0x[0-9a-fA-F]{40,}`
  pattern for the route. It instead fetches the page's own agent's real
  address from Fuel directly first (using the same session cookie the browser
  is using, not the legacy operator key, which resolves to a different
  company) and asserts both the funding fetch's own response body and the
  page's full delivered content contain that one address and no other
  match — so a second, unrelated address, or a 64-character transaction hash
  (`ADDRESS_SHAPED`'s own doc comment names this as the exact trap a blanket
  bypass would miss), still fails the check;
- hiding the panel again is checked too: the address actually leaves the DOM,
  and every banned term is absent again — proving a real toggle, not a
  one-way reveal a second visit would still carry.

## Consequences

- **`GET /api/agents` (the list) is unaffected** — no `funding` field, same
  as before this ADR.
- **The shared `AGENT` credential cannot reach `funding`** — the route it
  would need was already `OPERATOR`-only before this change, and stays so.
- **Every other dashboard route is unaffected.** The terminology and
  address-bytes checks apply to them exactly as 0005 left them.
- **This does not authorize mainnet.** `NETWORK_LABEL`/`ASSET_LABEL` name
  Base Sepolia because that is what `src/fireblocks/signer.ts` and
  `provision.ts` actually sign for and hold today; changing them to a mainnet
  network is a separate, reviewed decision, alongside the guards named below.

## Proof

- **Tests (verify-api):** checked against the code before this change first —
  it had no `funding` field to check, so these establish the field exists
  with the right scope, not just that it is well-formed.
  - an operator session's `GET /api/agents/:id` returns `funding.address`
    equal to the agent's real address, and `network`/`asset` equal to
    `NETWORK_LABEL`/`ASSET_LABEL`;
  - the shared `AGENT` credential against the same route gets no `funding`
    field (or is refused, matching the route's existing role check);
  - `GET /api/agents` (list) carries no `funding` field and no
    address-shaped string, for any caller.
- **Tests (qa-dashboard), and a prerequisite fixed along the way.**
  `scripts/qa-dashboard.ts` had no sign-in step at all — a gap that predates
  this slice (ADR 0018 made every dashboard route require a session cookie;
  this script was never updated), but had to be closed before any of its
  checks could mean anything: `middleware.ts` bounces a signed-out visit to
  `/login`, and `page.goto` follows that redirect and reports the final
  page's 200, so every route this suite "checked" was silently scanning the
  login page. Fixed by signing in over HTTP against the real
  `POST /api/session` route (the same one the login form posts to) as a new,
  dedicated test account (`scripts/seed-qa-dashboard.ts`, its own company,
  never a real person's), and carrying that session cookie into every
  browser context. With that fixed:
  - the agent-detail route, unclicked, shows zero banned terms and zero
    address-shaped bytes — the same assertion every other route gets, now
    actually exercised;
  - clicked, the funding fetch's own response body and the page's full
    delivered content each carry exactly the one real address a direct,
    session-authenticated read of Fuel says this agent has, and none of the
    banned terms beyond `0x`/`usdc`/`sepolia`;
  - hidden again, the address is gone from the DOM and every banned term is
    absent, the same as before the click.
- **Break tests**, each failing its own named check:
  - **The panel renders without the click — run for real, against the live
    dashboard and the live QA agent.** `agents/[id]/page.tsx` was changed to
    also pass `debugFunding={agent.funding}` to `FundingPanel` (an unused
    prop, exactly the shape of the mistake this design exists to avoid), the
    dashboard rebuilt and restarted. Both pre-existing checks caught it on
    every viewport, with the real address: "1 custody identifier(s) in the
    page, e.g. 0xC979…0655" and the matching failure on the response watcher.
    Reverted, rebuilt, reconfirmed clean.
  - **Two more named in the plan were not run, and why not, stated plainly
    rather than left silent.** "The exemption is written as a blanket
    per-route skip" and "the revealed-state term allowance is applied to
    another route" both assume a shared, misconfigurable allowlist. The code
    has neither: the address check re-derives ground truth and requires an
    exact match every time (there is no flag that turns it off), and the term
    allowance is a `const` local to `checkFundingReveal`, called only for
    `agent-detail` — there is no route-scope to escape into. Both properties
    were read directly rather than broken and re-fixed.
  - `funding` is added to `present()` instead of the one route → run for
    real, isolated with a diagnostic once it became clear the first failure
    wasn't the assertion this break was meant to prove: the suite's own
    generic key-allowlists ("an agent's keys are exact", "an agent inside a
    team detail carries no extra fields") catch it before either of this
    slice's own assertions run, and with those disabled one at a time, so
    does the pre-existing roster/team-detail leak scan ("the agent roster:
    says nothing about '0x' outside an operator-chosen name", which already
    scans `GET /agents`, `GET /teams` and `GET /teams/:id` for banned terms,
    banned key names and every agent's actual address value). This slice's
    own two list-route assertions are real and pass, but for this specific
    break they are backups behind defenses `verify-api` already had — a
    stronger result than a new, single-purpose check would have been, and
    accurately the reason `funding` still doesn't belong on `present()`: not
    because nothing else would catch it, but because it does not need to be
    the thing five other routes now depend on to keep catching it.
- **Security review:** run on the backend/ADR commit and again on the
  dashboard commit (CLAUDE.md: any wallet/custody-touching change).
- **Live, 2026-09-27, against a dedicated test agent
  (`scripts/seed-qa-dashboard.ts`, company "Fuel QA Dashboard", handle
  `fuel-qa-dashboard-56uu`), never a real company's:**
  - `fuel.db` was backed up first (`fuel.db.bak-adr0019-20260927T140209Z`,
    SHA-256 identical to `fuel.db` at copy time), and both servers restarted
    on this slice's code before anything below.
  - The seed script created one company, one owner, one team and one agent —
    provisioning exactly one real Fireblocks sandbox vault
    (`0xC9797210D477CEAbC2EfeBD85e71cd47adC20655`) — and is idempotent: a
    second run reuses all four rows and provisions nothing further.
  - `qa-dashboard` signed in as that account for real, over the actual
    `POST /api/session` route, then ran all 1032 checks across three
    viewports: the collapsed page showed nothing; clicking revealed that
    real address, "Base Sepolia" and "USDC"; hiding it again removed the
    address from the DOM. Zero failures on `agent-detail`, on any viewport.

**Found along the way, out of scope, not fixed here.** Fixing
`qa-dashboard`'s missing sign-in step made its accounting-status checks run
for real for the first time too (ADR 0018 predates this slice and broke them
the same way it broke everything else in that script). They fail: the
accounting page's status response no longer matches
`checkAccountingStatusResponse`'s expected contract, on every viewport. This
has nothing to do with agents, custody or funding — nothing in Phase 4–6's
accounting code was touched here — and is left for whoever picks up the
accounting-status surface next.

## What this does not cover

- **Mainnet.** `provision.ts`'s `BASE_PATH = BasePath.Sandbox` and
  `signer.ts`'s refusal of any `chainId` but 84532 are unchanged and stay
  exactly as hardcoded as before. A production Fireblocks workspace (new
  credentials, a real signer-role key, a policy engine) does not exist in
  this repo. Moving this panel — or anything else — to mainnet is a separate,
  later, explicitly reviewed decision.
- **A card on-ramp**, which would let this panel's exception shrink back
  toward nothing, per architecture.md's original bank-transfer framing. Not
  built here.
- **Anyone beyond today's operator/owner roles.** If the dashboard is ever
  shown to a tester's own account with a narrower role than the ones trusted
  with spend caps today, this decision should be revisited rather than
  assumed to extend automatically.
