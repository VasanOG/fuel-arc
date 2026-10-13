# Roadmap

Update this file as work completes. Always check "Current phase" before
starting anything new — don't assume where we are.

**Current phase: Phase 6 — One P&L. EVERY SLICE IS DONE: 6A-1 (the ledger
migration), 6A-2 (the headless gateway), 6B-1 (revenue reaching the books,
live-verified — a real payer, a real settled receipt, and two real
JournalEntry documents, a revenue entry and its reversal, exist in the same
Intuit sandbox company Phase 4 posted to), 6B-2 (the operator's triage loop)
and 6B-3 (the interface). ADR 0013 settles where the earned balance sits.

**Phase 6 delivered what it set out to: one P&L.** Fuel can charge for an
agent's endpoint, take the money, know whether it actually arrived, post both
directions to the same books, and show an operator all of it in one ledger.

**The next phase is Phase 7 — the private beta.** Company signup and user
login, operator roles, per-agent credentials with rotation and revocation,
true tenant isolation, hosted deployment with monitoring and backups, an SDK
and sample integration, safe dashboard actions for approve/deny and
freeze/unfreeze, and onboarding documentation. Note what Phase 6 deliberately
left for it: every company-scoped query in this codebase is a QUERY SEAM and
not tenant isolation — `src/lib/auth.ts` resolves a role and never a tenant —
and the dashboard's earning and triage surfaces are read-only because the
actions belong with the roles that will govern them.**

**Phase 5 is DONE**, all of it: 5A-1 (the application shell), 5B-1 (Overview
and Agents), 5B-2 (safe activity-data contracts), 5B-3 (approvals and export
hardened), 5B-4 (agents and teams hardened), 5B-5 (the Activity Ledger UI),
5B-6 (environment badge, demo labelling, Approvals queue), 5C-1 (Integrations
and Developer pages) and 5C-2 with its three follow-ups — 2a (the realm id
leaves the redirect URL), 2b (three findings from a second security review)
and 2c (the other three doors) — which together closed the accounting-status
boundary. **Phase 4 is DONE**: slices 1 (CSV), 2a (rollup engine), 2b
(QuickBooks), 2c (USD-only scope gate) and 2d (post-time freshness), including
the live walkthrough — three JournalEntry documents exist in a real Intuit
sandbox company, posted by Fuel.

**Still load-bearing, whatever you are working on.** Read
`/docs/decisions/0009` before touching the Activity Ledger — in particular the
section saying the company predicate is a query seam and not tenant isolation.
Read `/docs/ui/phase-5-blueprint.md` before any UI work; it says what each
route is for and, more importantly, which capabilities do not exist and must
not be implied. Read `/docs/decisions/0008` for the posting model — it
supersedes 0007 on agent attribution and carries two dated corrections about
the USD check. Read `/docs/decisions/0010` before touching accounting status;
it is why no provider object crosses to the client. `/docs/decisions/0005` is
closed. Xero remains deferred.
Phase 3 is complete
(anomaly detection, spend-rate limit, agent freeze/unfreeze); auto-freeze is
deliberately unbuilt, see Phase 3 Slice 3.
Phases 0–2 are finished; they all stay below because their "things this taught
us" notes are still load-bearing.

## Phase 0 — Plumbing proof — done

- [x] Fireblocks sandbox account created, API keys generated
- [x] One sandbox wallet created via API — `npm run create-sandbox-wallet`
      (vault account `fuel-test-wallet`, Base Sepolia / `BASECHAIN_ETH_TEST5`).
      The sandbox's default API user has NCW_ADMIN, which cannot create vault
      accounts (fails with code 1040), so a second API user was made.
      **Correction (Slice 2):** this used to say that user has the EDITOR role.
      It does not. `GET /v1/management/api_users` reports the key in `.env`
      (`aab113e9…`, "Claude user") as **`NON_SIGNING_ADMIN`**. EDITOR was the
      role we assumed would be needed; it was never what we created. Admin
      rights cover vault creation either way, so nothing failed and nobody
      noticed. Don't re-derive this from the old note — check the API.
- [x] One test x402-protected endpoint created — `npm run dev`, then
      `GET /paid-hello` returns 402 asking $0.001 in Base Sepolia USDC.
- [x] A wallet successfully pays the test endpoint via x402, end to end —
      `npm run pay-test-endpoint` returns HTTP 200 and settles on Base Sepolia.
      Verified on-chain: payer 20 → 19.999 USDC, vault → 0.001, receipt status
      0x1, and the balance is visible in Fireblocks as
      `USDC_BASECHAIN_ETH_TEST5_29AA`. Ran twice, distinct tx hashes.
      - **Caveat:** the payer is a throwaway local key
        (`0xB4e2ad5b238181a57E5C6229c373e190A95803De`), not the Fireblocks
        vault. The vault is the *recipient*. Making the vault the payer is
        carried into Phase 1 below.

### Things Phase 0 taught us, that Phase 1 depends on

- **The payer needs no gas, ever.** x402 signs an EIP-3009 authorization
  off-chain; the facilitator broadcasts and pays. Our payer sat at 0 ETH
  through two successful payments. Don't go looking for testnet ETH.
- **Fireblocks' policy engine will not see x402 payments.** Because
  settlement is an off-chain signature the facilitator submits, Fireblocks'
  transaction policy (amount caps, allowlists, approval quorums) never
  evaluates it. **Fuel's own cap is the only control that will exist.** That
  makes Phase 1's spend-cap the sole safety mechanism, not a convenience.
- **The cap belongs on the client.** In x402 the *server* dictates the price,
  so the payer is the only party with an interest in bounding it. See the
  network+amount policy in `scripts/pay-test-endpoint.ts`, which refuses
  anything off Base Sepolia or over its ceiling.
- **Fireblocks sandbox has no Base USDC by default.** We registered it
  ourselves (`npx tsx scripts/register-base-usdc.ts`). That endpoint wants the
  legacy chain id `BASECHAIN_ETH_TEST5`, not the blockchain UUID.

## Phase 1 — One agent, one wallet, one cap

### Slice 1: agent records, wallet provisioning, spend-cap enforcement — done
- [x] Agent record + wallet provisioning via Fireblocks — `src/db/agents.ts`,
      `src/fireblocks/provision.ts`. Creating an agent provisions a real
      Fireblocks vault (`fuel-agent-<id>`) with gas + USDC activated.
- [x] Spend cap enforcement before a payment is allowed through —
      `src/payments/pay.ts`. Cap check and payment insert are atomic in one
      DB transaction, so no signature is produced for a request that would
      exceed the cap. Verified: 5 payments settle against a $0.005 cap, the
      6th is blocked with the on-chain balance unchanged, and 5 concurrent
      requests against a one-payment cap yield exactly 1 settlement.
- [x] `POST/GET/PATCH /api/agents`, `POST /api/agents/:id/pay` —
      `src/api.ts`, mounted in `src/server.ts`.
- [x] Security review — found and fixed two cap-bypass bugs before this
      slice could be called done:
      - The candidate-term filter matched network + asset but not **scheme**,
        so a server could offer a cheap decoy in an unregistered scheme
        alongside an expensive `exact` charge; x402's own selector would take
        the `exact` term while we reserved budget against the decoy amount.
        Fixed: filtering now matches scheme too, and the policy asserts
        against the amount actually in `authorization.value` right before
        signing.
      - `markFailed` returned reserved budget to the cap for payments that
        had already been signed. An EIP-3009 authorization is spendable the
        moment it exists, so a server could settle, return a failure, and be
        paid repeatedly at zero cost against the cap. Fixed: post-signature
        failures now land in a new `unreconciled` status that still counts
        against spend (fail closed, not open).
      - Verified the fix against a hostile server reproducing the scheme
        bypass exactly (a $0.001 decoy `upto` term next to a $500 `exact`
        term): no funds moved, payment correctly refused.

  **Known gaps carried forward, not fixed in this slice:**
  - [x] ~~`/api` has no authentication~~ — fixed as a follow-up:
        `src/lib/auth.ts` requires `Authorization: Bearer <FUEL_API_KEY>` on
        every `/api/*` request (mounted in `src/server.ts`), timing-safe
        compare, fails the server at boot if the key is unset. Verified:
        no header → 401, wrong key → 401, correct key → 200 unchanged
        response, `/paid-hello` and `/health` unaffected. `127.0.0.1`
        binding kept as defense in depth, not replaced.
        **Limitation:** one shared operator secret, not per-agent
        credentials or roles — that's still Phase 2 ("Basic roles").
  - [x] ~~No global spend ceiling across agents~~ — fixed:
        `src/db/global-cap.ts`, checked inside the *same* `BEGIN IMMEDIATE`
        transaction as the per-agent cap in `reserveIfUnderCap`, so it
        inherits the same TOCTOU protection for free (SQLite's write lock is
        database-level, so reserves for *different* agents serialise too).
        `GET`/`PATCH /api/global-cap`. **Defaults to $0 — deny until an
        operator grants budget**, matching how a new agent already defaults
        to a $0 cap. A refusal now reports `scope: "agent" | "global"` so
        the two are distinguishable; the fix for each is different.
        Verified: an agent with $0.007 of its own budget left was correctly
        refused by the global ceiling with no money moving, and 3 concurrent
        payments from 3 *different* agents against a ceiling with room for
        one settled exactly one.
  - [x] ~~No reaper for `pending` reservations left behind by a crash~~ —
        fixed: `reapStaleReservations` in `src/db/payments.ts`, run at boot
        and every 60s from `src/server.ts`.
        The real problem was that crash recovery couldn't tell "nothing was
        signed" (safe to release the budget) from "something may have been
        signed" (an EIP-3009 authorization stays spendable, so the budget
        must stay consumed) — that bit lived only in a local variable and
        died with the process. So it's now persisted: a new `signing` status
        written *before* the signing call. `pending` → `failed` (released),
        `signing` → `unreconciled` (held). Stale window is 2 minutes, well
        above the 15s fetch timeout, so a merely-slow merchant is never
        reaped out from under a live request.

  **Two bugs found while doing this, both fixed:**
  - The live DB's `CHECK` constraint never included `unreconciled` —
    `CREATE TABLE IF NOT EXISTS` silently skips existing tables, so the
    constraint was frozen at its original four statuses. `markUnreconciled`
    would have **thrown** against it, stranding a signed payment in
    `pending`, where the new reaper would then have *released* its budget —
    exactly the overspend `unreconciled` exists to prevent. It had never
    fired only because every failure so far happened before signing.
    `src/db/index.ts` now rebuilds the table, and reclassifies any
    pre-existing `pending` row as `unreconciled` (it cannot prove such a row
    was never signed). Detection matches the `CHECK` clause specifically,
    not the whole DDL, since the comments name every status.
  - Status transitions were not terminal: the reaper could judge an
    abandoned payment `unreconciled`, and a late-returning request could
    then overwrite that with `failed` and release the budget. Harmless with
    local signing (which is fast and synchronous) but live the moment
    `FireblocksSigner` lands, since remote signing can outlast the reaper
    window. `markSettled`/`markFailedBeforeSigning`/`markUnreconciled` now
    carry status guards and warn when they change nothing.
  - [x] ~~The outbound resource URL is not validated (SSRF)~~ — fixed:
        `src/lib/safe-fetch.ts`, used for both fetches in
        `src/payments/pay.ts`. Blocks RFC1918, link-local (incl. the
        169.254.169.254 metadata IP), CGNAT, multicast/reserved and
        non-http(s) schemes; **loopback is deliberately allowed** so Fuel can
        keep paying its own `/paid-hello` test merchant.
        Validated in three places, because one is not enough: literal IPs up
        front (`net.connect` skips DNS for those), hostnames inside the DNS
        lookup at connect time (which is what resists rebinding), and every
        redirect hop — redirects are followed manually so a merchant cannot
        302 the payment-carrying request somewhere internal. Sensitive
        headers (`X-PAYMENT`, `Authorization`, cookies) are dropped on a
        cross-origin redirect.
        Two review rounds each found a real fail-open, both fixed and
        re-verified against a live RFC1918 service: the DNS callback returned
        the wrong shape (blocking worked, *allowing* broke), and IPv6 was
        matched as text when `new URL()` canonicalizes
        `[::ffff:169.254.169.254]` to `::ffff:a9fe:a9fe` — so the guard never
        fired. IPv6 is now parsed to numeric groups with a default-deny
        (only global unicast 2000::/3 allowed).
        **Limitation:** other loopback-bound services on the same host remain
        reachable through this path — accepted while `/api` is itself behind
        a shared secret and bound to 127.0.0.1.

### Slice 2: real per-agent custody
- [x] Make the Fireblocks vault the *payer*, not just the recipient —
      `src/fireblocks/signer.ts` (`fireblocksSigner`), wired in at
      `signerForAgent` in `src/api.ts`, which is the only call site.
      Implements `PaymentSigner` and nothing wider: `address` +
      `signTypedData` only, so the server-triggerable Permit2 branch stays
      unreachable.
      **No new key was needed.** The existing `NON_SIGNING_ADMIN` key signs
      fine — see "why the non-signing key signs" below.
      Verified end to end: vault `fuel-test-wallet` (`0xa3c6df6f…`) paid
      $0.001 to an external address, tx
      `0x5a69ce6750324e62e48e86c0990861049c3fc47f751e302b93cbf5b0a28aca73`,
      receipt status success, balance 0.017 → 0.016 USDC on-chain. ~9s
      round trip, of which ~5s is Fireblocks.

  **Why the "non-signing" key signs — and why that won't survive production.**
  The role governs who may *initiate* a transaction. The MPC key shares live in
  the workspace's `Fireblocks Communal Test Co-signer` (type `SANDBOX`), which
  auto-approves. "Non-signing" means the user holds no key share of its own,
  not that what it initiates can't be signed. A production workspace has no
  communal co-signer: it needs a Signer-role key plus your own API Co-Signer,
  and the policy engine actually gates it there. **Treat this as a sandbox
  affordance we are borrowing, not as the production design.**

  **Fireblocks does not validate the EIP-712 payload — two traps, both live:**
  - It requires `EIP712Domain` in `types`; x402 omits it (viem derives it).
    Given a payload without it Fireblocks does **not** error — it hashes a
    different domain separator and returns a well-formed signature over the
    wrong digest, which recovers to an unrelated address. Verified both ways.
    `fireblocksSigner` injects `EIP712Domain`, and then re-derives the digest
    with viem and recovers the address locally before returning, so a wrong
    digest can never be shipped.
  - The message carries BigInts (`value`, `validAfter`, `validBefore`) and
    `JSON.stringify` throws on those. They are stringified before the call.

  **Budget accounting gained a third case.** A remote signer can time out with
  a signature that may still complete, which is neither "signed" nor "not
  signed". `SignatureMayExistError` (in `src/payments/signer.ts`) marks those
  `unreconciled` — budget consumed, fail closed. Verified: a payment from an
  empty vault signs, fails to settle, and its budget stays consumed.

  **A server-set timeout could expire an authorization in flight.** x402 sets
  `validBefore = now + maxTimeoutSeconds` *before* signing, and the server
  picks that number; vault signing adds a ~5s round trip. `pay.ts` now refuses
  terms shorter than 30s, checked before anything is reserved or signed.

  **Signer refuses, before calling Fireblocks:** a non-`TransferWithAuthorization`
  `primaryType` (the Permit2 path), a `verifyingContract` other than Base
  Sepolia USDC, any `chainId` but 84532 (so a mainnet payload cannot be
  signed), and any `from` that is not this agent's own vault. All four verified
  refused.

  **Security review — found two real fail-opens, both fixed before this was
  called done:**
  - **Most post-submission failures released the budget.** `SignatureMayExistError`
    was thrown from only two places, so every *other* error after the Fireblocks
    request was dispatched (a transient blip in the poll loop, a malformed
    response, the recovery-mismatch throw itself) surfaced as a plain `Error`
    and hit `markFailedBeforeSigning` — **budget released while a spendable
    authorization was live**, since the communal co-signer auto-approves
    whatever arrived. This inverted the exact property the slice rests on.
    Fixed: submission is now the fail-closed boundary. A `submitted` flag flips
    *before* `createTransaction` (a client-side timeout does not prove the
    request never landed), and any error escaping after it is reclassified as
    `SignatureMayExistError`. The poll loop also now tolerates transient read
    failures until the deadline instead of abandoning a live signing request.
  - **`MIN_TIMEOUT_SECONDS` was shorter than the path it protects.** It was 30s
    while signing alone allows 60s and delivery another 15s, so an accepted
    authorization could be ~75s old on arrival — expiring in transit, budget
    consumed for nothing. Fixed: the bounds moved to `src/payments/limits.ts`
    and the minimum is *derived* from them (now 120s), so they cannot drift
    apart again.

  Also hardened from the same review: `EIP712Domain` is injected last so a
  caller-supplied one cannot displace the canonical entry; `fullSig` shape and
  recovery-id presence are asserted; and a high-`s` signature is rejected
  locally (OpenZeppelin's `ECDSA` would revert on-chain, after the budget was
  already spent).

  **Accepted, not fixed:** the signer does not bound `message.value`. The amount
  is bound pre-signature by the client policy in `pay.ts` and re-asserted after,
  so a divergent amount is caught — but the catch is post-signature. Moving a
  `maxValue` into the signer would make that refusal free; it needs the amount
  threaded through signer construction, which is a Slice 3 shape change.

  **Test fixtures left in the dev DB** (`fuel.db`), deliberately not deleted
  because payment rows reference them and removing them would distort spend
  totals:
  - `vault1-signing-test` → vault 1. Note vault 1 is also `X402_PAY_TO`, so
    this agent pays *from* the wallet that normally receives. It exists only
    because vault 1 was the sole vault holding USDC.
  - `vault4-empty-test` → vault 4, no USDC. Used for the fail-closed test.

  **Funded and settled from its own vault, not a fixture:** vault 2
  (`research-bot`, `0x41E1676b…`) was sent USDC by the user from a Base
  Sepolia faucet. Its own $0.005 cap (already fully spent by earlier Phase 1
  testing) was raised to $0.01 through the real `PATCH /api/agents/:id`, and
  it then paid `/paid-hello` from its own vault — tx
  `0x7c50b5f73d3509e9657706772151d708808baf2b19ff195c2e3ff76ea48b7c9c`, receipt
  success, on-chain `Transfer` from `0x41E1676b…`, balance 20 → 19.999 USDC.
  This is the first payment in the project where a *specific agent's own
  vault* paid for something, as opposed to a shared or fixture wallet.
  Vaults 3 and 4 are still unfunded (0 USDC): they can sign but not settle.

- [x] Minimal dashboard: list agents, see balance + spend, set a cap —
      `dashboard/` (Next.js). One table: name, wallet address (copyable),
      balance, spent, remaining, cap. Setting a cap requires an explicit
      confirm step (type → Save → "Set cap to $X? Confirm/Cancel") before the
      PATCH fires — the user asked for that extra click given how much weight
      the cap carries.

  Talks to Fuel's existing `/api`; the only new backend surface is a read,
  `getVaultUsdcBalance` in `src/fireblocks/provision.ts`, wired into
  `GET /agents` and `GET /agents/:id` only (`presentWithBalance` in
  `src/api.ts`) — `POST`/`PATCH /agents` and `POST /agents/:id/pay` are
  untouched, so this cannot affect a cap or payment decision. Best-effort:
  Fireblocks 404s (code 1006) an activated asset with zero balance and no
  history, which is a real "$0", not a failure — verified directly and
  special-cased; any other error is reported as `null` ("unknown") rather
  than a possibly-wrong "$0".

  `FUEL_API_KEY` lives only in `dashboard/lib/fuel.ts` (marked
  `import "server-only"`, so a Client Component importing it fails the
  build) and the dashboard's own `.env.local` — never sent to the browser.
  Both dev and start scripts bind `127.0.0.1` explicitly, matching Fuel's own
  loopback convention.

  **Security review — one fix applied, one conflict flagged, not resolved:**
  - Fixed: the cap route (`dashboard/app/api/agents/[id]/cap/route.ts`) had
    no explicit cross-origin check — only incidentally protected by the
    browser's CORS preflight blocking a non-simple `PATCH` with no
    `Access-Control-Allow-Origin` set. Since this route is the only thing in
    the dashboard that can move the system's one spending control, it now
    checks explicitly. First attempt compared against `req.nextUrl.origin`
    and **broke same-origin saves** — that property silently normalizes to
    `http://localhost:PORT` regardless of how the server is actually bound
    (verified: bound and browsed via `127.0.0.1`, `nextUrl.origin` still read
    `localhost`). Fixed to compare the `Origin` header against the `Host`
    header instead, which reflects what the browser actually connected to.
    Verified both directions: a same-origin save succeeds, a spoofed
    `Origin: http://evil.example.com` gets 403'd.
  - **Resolved:** CLAUDE.md says wallet addresses should never appear in the
    product ("no crypto terms ... ever appear"). The dashboard shows one
    anyway (truncated, copy-on-click, full address in the tooltip) — the
    reviewer caught the conflict with the standing rule after the fact.
    Decision: keep it, as an explicit, temporary exception, not a precedent —
    this dashboard is an internal operator tool, and the address is shown
    deliberately for debugging/funding. Must be revisited before anything
    resembling a customer-facing version of the dashboard exists. See
    `/docs/decisions/0005-dashboard-shows-wallet-addresses.md`.

## Phase 2 — Budget hierarchy + approvals — done

### Slice 1: Company/Team entities + cascading cap enforcement — done
- [x] `companies` and `teams` tables, `agents.team_id` (NOT NULL) —
      `src/db/index.ts`, `src/db/companies.ts`, `src/db/teams.ts`.
- [x] Cascading enforcement — `reserveIfUnderCap` in `src/db/payments.ts`
      now checks three ceilings, agent → team → company, inside the *same*
      `BEGIN IMMEDIATE` transaction the per-agent check already used, so all
      three inherit its TOCTOU protection. `CapScope` widened to
      `"agent" | "team" | "company"`; the refusal reports which one tripped,
      because the fix for each is different.
- [x] `GET/PATCH /api/company`, `POST/GET /api/teams`,
      `GET/PATCH /api/teams/:id`; `POST /api/agents` now requires `teamId`.

  **Cascading here means three independent ceilings, not an allocation.**
  Nothing validates a team's cap against its company's, or an agent's against
  its team's — exactly as per-agent caps were already allowed to sum past the
  old global ceiling. A company card limit is not the sum of every employee's
  limit. What each level bounds is money that actually moved beneath it.

  **`global_cap` is retired, not duplicated.** Its single row's value ($0.025)
  was carried onto the seeded "Default Company" and the table dropped — the
  company cap *is* the old global ceiling, renamed and given an owner. There
  is one company; multi-company was deliberately not built (`createCompany`
  exists in the db layer with no route, for when it is real). That is why
  `/api/company` is singular with no id in the path.

  **The default Team was seeded to the carried-over value, not $0**, which is
  what a deliberately-created team gets. This team is created by a migration,
  not by an operator: seeding it to $0 would have hard-blocked all 5 existing
  agents at the team level the moment this shipped — indistinguishable from an
  outage, with nobody having lowered a cap. Carrying the value over leaves
  enforcement identical immediately post-migration (the team check is
  redundant at first, never *more* restrictive).

  **Migrating `agents` meant rebuilding a table that another table
  references.** SQLite cannot add a NOT NULL column to populated rows, so
  `migrateAgentsAddTeamId` uses the same drop/rename rebuild as the earlier
  payments-status fix — but `payments.agent_id` points *at* `agents`, which
  the earlier migration never had to deal with (it rebuilt the referencing
  side). Ids are copied verbatim, so nothing should dangle; a
  `PRAGMA foreign_key_check` after the rebuild proves it rather than assuming,
  because a silent dangling reference here would mean payments no cap check
  can ever see again.

  Verified end to end against the live DB (backed up first):
  - All 5 existing agents backfilled onto the default team, ids/caps/31
    payment rows intact, `foreign_key_check` clean, `global_cap` dropped.
  - Migration is idempotent — a second boot logs nothing and creates no
    duplicate company/team. Fresh-install path seeds $0 (deny by default).
  - A payment that worked before still settles — tx
    `0x27dc518b49cc09405700d5c2d7049890a522ab5b2f3a9451dcdc72d59aa8976c`.
  - Team ceiling and company ceiling each refuse correctly with their own
    `scope`, on-chain balance unchanged. With *both* exhausted the refusal
    reports `team` — narrowest first, so the reported cap is the one that
    actually needs raising.
  - Concurrency: 5 concurrent payments against a team with room for exactly
    one settled exactly one (4 refused `scope: "team"`); the same against the
    agent cap behaved as it did in Phase 1; and 4 concurrent payments from
    agents on *two different teams* against a company ceiling with room for
    one settled exactly one — the write lock still serialises across teams.
  - `POST /agents` with a missing or unknown `teamId` 400s *before*
    `provisionAgentWallet`, so a bad request cannot orphan a real vault.

  **One transient failure seen and worth recording:** in the first
  team-concurrency run the single payment that passed the cap check then
  failed with `HTTP 402 with no PAYMENT-REQUIRED header` from the facilitator.
  It was correctly marked `unreconciled` — budget held, failing closed, which
  is the designed behaviour for a post-signature failure. It did not
  reproduce: the identical run afterwards settled, as did the agent-cap and
  cross-team runs. Not caused by this slice (the cap check had already
  succeeded), but noted because it is the first time that path has fired
  outside a deliberate test.

  **Security review — no cap bypass, no injection, all invariants intact.**
  One real (non-money) finding fixed: the seed's "has this already run?"
  `COUNT(*)` was read *outside* its transaction, so two processes booting
  against one file could both try to seed and the loser would die on the
  UNIQUE name constraint. The check now sits inside the `BEGIN IMMEDIATE`.

  **Known gaps carried forward, not fixed in this slice:**
  - No route moves an agent between teams. Doing it during testing required
    direct SQL — see the fixture note below.
  - No multi-company API, by decision above.
  - `present(agent)` reports only the agent's own remaining budget, so a
    dashboard can show headroom for an agent whose team or company is
    actually exhausted. Not a control gap (all three are enforced
    server-side regardless), but a real display gap when the dashboard grows
    hierarchy awareness.
  - No roles — `/api` is still one shared bearer token. That is Slice 3.
    (Closed in Slice 3, below.)
  - `research-bot` is now over its own cap ($0.012 spent against $0.01) from
    verification traffic, so it cannot pay until someone raises it. Left that
    way deliberately rather than widening a cap to tidy the numbers — see the
    fixture note below.

  **Test fixtures added to the dev DB** (`fuel.db`), on top of the Slice 2
  ones already recorded above:
  - `Team B` — a second team, created through the real `POST /api/teams`, so
    the cross-team concurrency test had two teams to race. `vault1-signing-test`
    was moved onto it by direct SQL, since no reassignment route exists.
  - Test payments during verification consumed roughly $0.006 of sandbox
    budget. Caps were restored to their pre-slice values afterwards, which
    leaves some agents at or over their cap (e.g. `research-bot` has spent
    $0.012 against a $0.01 cap) — deliberate, so no cap was silently widened.
    Raise them when more testing is needed.

### Slice 2: approval flow for team/company blocks — done
- [x] `approval_requests` table + `src/db/approvals.ts`. A payment refused by
      the **team or company** ceiling is no longer terminal: it becomes a
      request a human can approve or deny, and the caller gets **202** with
      the request id instead of a 402.
- [x] Redemption inside `reserveIfUnderCap` (`src/db/payments.ts`) —
      `POST /api/agents/:id/pay` accepts `approvalRequestId`; that payment
      skips the team and company checks and burns the approval.
- [x] `GET /api/approvals` (`?status=`), `GET /api/approvals/:id`,
      `POST /api/approvals/:id/approve|deny`.

  **An agent over its OWN cap is still a hard block.** The agent cap is the
  narrowest and is reported first, so `scope: "agent"` never reaches the
  approval path — a payment that does not fit the budget its own operator set
  for it is not an exception worth asking a human about.

  **Why approval could not simply hold the payment mid-flight.** x402 stamps
  `validBefore` onto the authorization *before* signing and the **merchant**
  picks the window — `MIN_TIMEOUT_SECONDS` refuses anything under 120s. A human
  decision takes minutes to days, so a signed authorization would expire in the
  queue. The pause therefore happens exactly where the cap check already
  refuses, before any signature exists, and redemption re-fetches the
  merchant's terms and signs fresh. Everything else in this slice follows from
  that constraint.

  **An approval is a one-time exemption, not a cap change.** The cap keeps the
  value the operator set, and the approved payment's spend still counts toward
  every total, so the next unapproved payment is refused as before. Accepted
  consequence: `spent <= cap` is no longer an invariant — verified spend of
  $0.022 against a $0.021 team cap. Each overage instead traces to a named
  approval row, which `payment_id` links to the payment that spent it.

  **Single-use is enforced by burning the approval in the SAME transaction
  that reserves the budget**, with a guarded
  `UPDATE ... WHERE id = ? AND status = 'approved'`; zero rows changed rolls
  the whole thing back. Validating the approval without that would let two
  concurrent retries both find it valid and both pay.

  Approvals expire 15 minutes after being granted (`APPROVAL_VALIDITY_MS`),
  checked both at redemption and by `reapStaleApprovals`, which runs on the
  existing 60s reaper alongside `reapStaleReservations`. Undecided requests
  expire after 24h. Expiring can only ever *remove* permission, so unlike the
  payment reaper there is no fail-open direction to get wrong.

  Verified end to end (DB backed up first), all against real Base Sepolia:
  - Blocked-by-team → 202 + request id, and **only `blocked` payment rows** —
    nothing signed, nothing settled, no on-chain movement.
  - Deny → redemption refused; re-deny → 409; a fresh attempt correctly opens
    a *new* request (a denial governs that request, not the agent forever).
  - Approve → redemption settles above the team cap, tx
    `0xde6dd9cbdf1ee1abd71be78fa913edf235d1e169f80c8a44fbe62a6dff96698a`;
    the approval flips to `consumed` with `payment_id` set.
  - **3 concurrent redemptions of one approval → exactly 1 settled**, 2
    refused.
  - Refused correctly: wrong agent, wrong resource URL, amount above what was
    approved, already-consumed, denied, and expired.
  - Agent cap still enforced while holding a valid approval (402
    `scope: "agent"`), and that refusal does **not** burn the approval.
  - An agent-cap block creates no approval request at all (row count
    unchanged).
  - Reaper expired one unredeemed approval on boot and left `denied`/`consumed`
    rows untouched; a freshly approved request survived a restart unexpired.

  **Security review — no exploitable issues.** It confirmed something worth
  writing down: redemption is atomic today partly *by construction*, because
  `node:sqlite` is one synchronous connection and nothing in the transaction
  yields the event loop. The guarded UPDATE is therefore belt-and-braces right
  now — but it becomes the only thing preventing a double-spend the moment
  this moves to Postgres or a second process. Noted in the code at that branch
  so it is not "simplified away" later.

  **Known gaps carried forward, not fixed in this slice:**
  - **The shared API key means "operator approves" is not a separate party.**
    Anything holding `FUEL_API_KEY` can both request a payment and approve it.
    This slice delivers a pause, an audit trail and an explicit redemption
    step — not true two-party control. That needs roles, below.
    **Closed in Slice 3.**
  - A consumed approval is never returned if the payment then fails *before*
    signing (deliberate, fail-closed — handing spending permission back on a
    failure path is the shape of the two Phase 1 overspend bugs). A merchant
    that was down costs the agent its approval.
  - Nothing bounds total outstanding approvals: an operator approving many
    requests can take spend arbitrarily far above a cap. Operator judgment is
    the only limit.
  - No notification — an operator has to poll `GET /api/approvals`.
  - No dashboard surface for any of this (out of scope by decision).

### Slice 3: two roles, so approval is actually two-party — done
- [x] `src/lib/auth.ts` now resolves a **role** from which secret was
      presented: `FUEL_API_KEY` = `operator`, new `FUEL_AGENT_KEY` = `agent`.
      `authenticate` (401 if neither) is mounted once ahead of `/api`;
      `requireRole(...)` (403 for the wrong role) guards every route.
- [x] All 15 routes in `src/api.ts` declare a role. Operator: `PATCH /company`,
      `POST /teams`, `PATCH /teams/:id`, `POST /agents`, `PATCH /agents/:id`,
      `POST /approvals/:id/approve|deny`. Agent: `POST /agents/:id/pay`, and
      **only** that. Reads are open to both.

  **The operator is forbidden from paying, and that is the point.** Slice 2's
  gap was one credential doing both halves; letting the operator key also call
  `/pay` would have left that intact. Money now moves past a team or company
  ceiling only if *two different secrets* are used — one to request, one to
  approve — and neither can do it alone.

  **The role is derived from the secret, never self-declared.** A role in a
  header or body would be worthless: anything holding a key could claim any
  role. This is also why the split is two keys rather than one key plus a
  claim.

  **The server refuses to boot if the two keys are equal.** Identical values
  would silently collapse the split back into a single all-powerful
  credential — the exact gap being closed — with no error and no symptom.
  Verified: it exits with a message naming the problem.

  **Reads are shared on purpose**, including `GET /api/approvals`: an agent
  has to be able to see whether its own paused payment was approved before it
  retries. Deciding one stays operator-only, which is where the control lives.

  Every route declares a guard, even the shared reads (`requireRole("operator",
  "agent")`). A route with no guard is reachable by any authenticated caller —
  omission **fails open** — so making the declaration universal turns a missing
  one into the single odd route out in review.

  **A typing trap worth remembering.** Adding a middleware typed as plain
  `Request` hands Express 5's overload an inference candidate for its params
  generic, collapsing every guarded route's `req.params` from `{ id: string }`
  to `ParamsDictionary`, where `id` is `string | string[]`. Eight routes broke
  the typecheck. `requireRole` returns a guard generic in `P`, which
  contributes no candidate and leaves route params typed as before.

  Verified end to end, against real Base Sepolia:
  - Boot refuses when `FUEL_AGENT_KEY` is missing, and when the two keys match.
  - No header / unknown key / non-Bearer scheme → 401.
  - Agent key on all 7 operator routes → 403; operator key on `/pay` → 403.
  - **The whole loop:** agent key attempts a team-capped payment → 202 with a
    request id; agent key tries to approve it → **403**, and the request is
    still `pending` (proven by the operator's approve then returning 200, since
    that UPDATE is guarded on `status = 'pending'`); operator approves; agent
    redeems → settled, tx
    `0xf4f2dfe68ea81907eb444e72f46f3457a514018eba72f36a5b47cc33a8c39524`,
    approval flipped to `consumed`.
  - All 6 read routes → 200 with both keys.
  - Dashboard unchanged and still working (lists agents, sets a cap) — it only
    ever did operator actions, which is why `FUEL_API_KEY` kept its name.

  **Security review — no exploitable issues.** It checked specifically for a
  bypass via method override, Express 5 route normalization (case, trailing
  slash), an unguarded route, and a fail-open path if `authenticate` were
  unmounted (it throws → 500, so it fails closed). It noted that 401-vs-403
  does tell a holder of *a* valid key that their key is valid — accepted, since
  it reveals nothing to someone without a key, and conflating the two would
  make a misconfigured key indistinguishable from a missing one.

  **Known gaps carried forward, not fixed in this slice:**
  - **No per-agent identity.** One shared agent key can pay as *any* agent.
    Agents cannot be told apart or revoked individually — the key identifies a
    role, not a principal.
  - **No per-person attribution.** With one operator secret, `approval_requests`
    can only ever record "someone holding the operator key" approved. Real
    attribution needs distinct per-operator credentials, which needs a
    DB-backed key registry (considered, deliberately deferred).
  - **No rotation without a restart** — both keys are read at boot.
  - **No viewer role.** The roadmap's original "view only" wording is dropped
    on purpose: it does not close this gap, and it is easy to add now the
    mechanism exists.
  - A future route that forgets `requireRole` is reachable by any
    authenticated caller. Convention, not structure, is what prevents this.

## Phase 3 — Live spend intelligence

### Slice 1: per-payment amount anomaly detection — done
- [x] `src/payments/anomaly.ts` — a pure rule: flag a payment above
      `max(3 × median of the agent's last 20 counted payments, $0.002)`.
      No database, no clock, so it can be exercised without money moving.
- [x] Checked inside `reserveIfUnderCap`, in the existing transaction, after
      all three caps and before anything is signed.
- [x] A flagged payment creates an `approval_requests` row with
      `blocked_scope = 'anomaly'` and returns **202**, reusing the Slice 2
      queue rather than inventing a second alerting mechanism.

  **A ratio against a median, not a variance model — forced by the data.**
  Every payment this system had ever made was exactly $0.001: one test
  merchant, one price, variance exactly zero. A z-score or MAD detector divides
  by that spread, so the first differently-priced payment scores as infinitely
  anomalous and the detector fires on the first legitimate price change. Median
  over mean for the same robustness reason: a mean lets one large payment shift
  the baseline enough to mask the next one.

  **The floor is not decoration.** A ratio alone is not an anomaly — four times
  a trivial amount is still trivial. Without `ANOMALY_FLOOR_BASE_UNITS` an agent
  whose typical payment is $0.0001 gets flagged at $0.0005, and a queue full of
  noise is a queue operators stop reading, which costs more than the false
  negatives the floor allows.

  **Cold start fails open** (under 5 counted payments, nothing is flagged).
  Failing closed would queue every new agent's first payments, teaching
  operators to click through the queue — corroding the Slice 2 control that
  actually stops overspend. Such an agent is still bounded by three caps and the
  per-payment ceiling.

  **Baseline statuses reuse `COUNTS_AGAINST_CAP`**, so "spend that happened"
  means one thing everywhere. Concretely load-bearing: `research-bot` had 56
  payment rows of which 42 were `blocked`, and letting refused payments shape
  the baseline would let an agent move its own baseline with payments it was
  never allowed to make.

  **The check runs last, after every cap.** Forced, not stylistic: flagging
  first would hold a payment for a human that, once approved, still dies on a
  cap the operator was never shown. It also gives the path a useful property —
  a payment produces at most **one** approval request, because a team or company
  block returns before the anomaly check is reached.

  **An anomaly approval is not a budget exemption**, and this was the trap in
  reusing Slice 2. Redemption previously skipped the team and company ceilings
  whenever *any* approval was present. Left alone, an operator waving through an
  odd-looking payment would silently also have waived the team's ceiling.
  Redemption now branches on what the approval is *for*: `team`/`company`
  approvals skip those ceilings as before; an `anomaly` approval skips only the
  anomaly rule and faces every cap. Any approval skips the anomaly check, since
  a human has already judged that exact agent, url and amount — without which an
  approved anomaly would be re-flagged on redemption forever.

  **`approval_requests.blocked_scope` widened to include `'anomaly'`** via the
  established SQLite rebuild migration (CHECK constraints cannot be ALTERed),
  with `PRAGMA foreign_key_check` afterwards because this table references both
  `agents` and `payments`.

  **A second test merchant at $0.005** (`GET /paid-hello-large`) exists solely so
  the detector is testable: with a single price there is no such thing as an
  unusual amount. Still under `MAX_PER_PAYMENT_BASE_UNITS`, so it is a
  behavioural outlier rather than a payment we refuse outright.

  Verified, all against real Base Sepolia:
  - The rule directly: cold start at every sample size below the minimum, odd
    and even medians, a payment exactly at the threshold (not flagged — `>`,
    not `>=`), and the floor binding for a micro-baseline agent.
  - Migration on a scratchpad copy first, then live: CHECK widened, all 6
    existing approvals preserved with their `payment_id` links, index recreated,
    FK enforcement restored, `foreign_key_check` clean, idempotent on re-run.
    A fresh install builds the new CHECK directly and still rejects a bogus
    scope.
  - **No false positive**: a normal $0.001 payment settled with no approval row
    created. The check that matters most.
  - **The flag fires**: $0.005 → 202, `blocked` payment row, **nothing signed**,
    and the approval carries the numbers an operator needs
    ("above the 0.003 threshold, against a median of 0.001 over 16 payments").
  - **The exemption fix, explicitly**: with the team cap dropped below spend,
    redeeming the *anomaly* approval was refused by the team ceiling (402,
    `scope: "team"`) and the approval survived unburned; with the cap restored
    it settled, tx
    `0xfa3729888543442720839e402ccbecec014970851a63dd02cedb006ea73edc4c`.
    A *team* approval still bypasses the team ceiling, unchanged.
  - Redemption is not re-flagged: no second request, no loop.
  - Cold start end to end: `vault1-signing-test` (3 counted payments) paid the
    same $0.005 that `research-bot` was flagged for, unflagged.
  - Blocked rows do not feed the baseline: 42 blocked rows present, the
    `LIMIT 20` sample returned 14.

  **Security review — one real finding, fixed and re-tested.** The approval
  dedupe key was `(agent, url, amount, pending)` and did not include
  `blocked_scope`. That was harmless while every approval bought the same
  exemption, but this slice made scope decide what redemption skips — so an
  anomaly refusal could silently reuse a pending `team` row and inherit a
  team/company cap bypass nobody granted. Reachable without malice: payment
  blocked by the team ceiling, ceiling raised, same payment retried and this
  time flagged as unusual. `blocked_scope` is now part of the key. Re-tested by
  running that exact sequence: two correctly-scoped rows instead of one reused
  one, and same-scope retries still collapse to a single row.

  **Known gaps carried forward, not fixed in this slice:**
  - **No velocity or rate detection** — the unbounded hole. The per-payment
    ceiling caps a single spike at $0.01; nothing caps the *rate*, so many
    normal-sized payments can still drain a cap, and an agent evades this
    detector entirely by splitting one large payment into several ordinary ones.
    This slice buys visibility and a human in the loop more than it reduces
    worst-case loss.
  - **No team or company baseline.** Aggregate series mix agents, so adding or
    removing one shifts the baseline discontinuously — a harder statistic than
    the per-agent case.
  - **No agent freeze / one-click unfreeze.** A flag pauses the payment, not
    the agent.
  - **Window, multiple and floor are global constants**, not per-agent or
    API-configurable.
  - **Baseline poisoning**: an approved anomalous payment enters the sample, so
    repeated approvals walk the median upward. Bounded per step (one row of
    twenty) and overall by the per-payment ceiling.
  - **No dashboard surface and no notification** — operators poll
    `GET /api/approvals`, as in Slice 2.
  - The reaper overwrites an expired approval's `detail`, losing the
    explanation there; the `blocked` payment row keeps its own copy.

  **Test fixtures added to the dev DB** (`fuel.db`):
  - `GET /paid-hello-large` is a permanent part of the test merchant, not a
    fixture — the detector cannot be exercised without a second price.
  - Verification spent roughly $0.018 of sandbox budget across 6 settled
    payments, and left 1 consumed + 1 denied `anomaly` approval as examples.
  - `Default Team`'s cap and `vault1-signing-test`'s cap were raised to let
    payments reach the anomaly check, then **restored to their pre-slice
    values** ($0.021 and $0.005). As after Phase 2, that leaves some agents at
    or over their caps — deliberate, so no cap was silently widened.

### Slice 2: spend-rate limit — done
- [x] `src/payments/velocity.ts` — no agent may spend more than **$0.02 in any
      60 seconds**. Checked in `reserveIfUnderCap` after the three caps and
      **before** the anomaly check.
- [x] Refused with **429 + `Retry-After`**, not an approval request. Three
      refusals now, three meanings: 402 raise a cap, 202 ask a human, 429 wait.

  **A fixed policy, deliberately not a learned baseline.** Slice 1 could learn
  from a stable truth (every payment was $0.001). There is no equivalent truth
  about *rate*: observed inter-payment gaps for the busiest agent run 1s, 1s,
  1s, 9s, 28s, 49s, 101s, 42 minutes, 4 hours, 2 days — five orders of
  magnitude, and every one is an artifact of manual `curl` testing rather than
  agent behaviour. A baseline fitted to that would be a statistic about a test
  session wearing the costume of a control. Revisit when real traffic exists.

  **This refusal is self-healing, which is why no human is involved.** A cap
  block needs someone to raise a cap; an amount anomaly needs someone to say "I
  meant that". A rate refusal clears itself when the window slides. Sending it
  to the approval queue would ask an operator to rule on something that resolves
  in sixty seconds, devaluing the queue that actually stops overspend.

  **No approval exempts it** — not even a team/company one, unlike the anomaly
  check which any approval skips. An operator answering a question about an
  *amount* has said nothing about a *rate*. And because the refusal returns
  before the approval is burned, a rate-limited redemption costs nothing: the
  agent simply redeems a moment later.

  **Ordered before the anomaly check** so a throttled payment never raises an
  approval request it could not redeem anyway, preserving the "at most one
  approval request per payment" property from Slice 1.

  **`spendInWindow` counts only `COUNTS_AGAINST_CAP`, and that is what stops the
  limit sustaining itself.** The refusal writes a `blocked` payment row; had
  `blocked` counted, every refusal would push the window forward and an agent
  that hit the limit once could never escape it. Verified directly: with 10
  blocked rows sitting inside the window, the window sum read 20000, not 30000.

  **No cold-start hole**, unlike Slice 1 — a fixed limit needs no history, so a
  brand-new agent is rate-limited from its first payment. That covers the one
  case the amount detector deliberately cannot.

  Verified, all against real Base Sepolia:
  - The rule directly: under, exactly at the limit (allowed — same `>` boundary
    the caps use), one base unit over, an already-full window, and a single
    payment larger than the whole limit. Retry hint floors at 1, never 0.
  - **The burst, the point of the slice**: 30 concurrent $0.001 payments against
    an empty window admitted **exactly 20000 base units** and refused the other
    10 with 429 — the serialisation property `BEGIN IMMEDIATE` buys.
  - **An approval does not exempt it**: an approved request redeemed against a
    full window returned 429 with `Retry-After: 5`, and the approval stayed
    `approved`, unburned.
  - **Self-healing**: that same approval redeemed successfully 65s later with no
    intervention, tx
    `0x048dab0c54c95a8bcdc35c7d878075d80e7978cbcd301b9f7f6e72cb616067f5`.
  - Ordering: an over-cap payment still reports 402 `scope: "agent"`, not 429.
  - Slice 1 unchanged: a $0.005 payment still returns 202 with the baseline.

  **Infrastructure limit found while testing, not caused by this slice.** Under
  30-way concurrency, 11 of the admitted payments failed *after* signing —
  the public Base Sepolia RPC (`sepolia.base.org`) returned
  `unexpected_error: RPC Request failed` and the facilitator returned a 402 with
  no header. They were correctly recorded `unreconciled` (signed, so budget
  held), which is precisely why admission still stopped at exactly $0.02. Same
  class as the transient failure recorded in Phase 2 Slice 1. Worth knowing
  before anyone treats a burst test failure as a Fuel bug.

  **Security review — no exploitable findings.** It specifically checked bypass
  via redemption, window-boundary gaming (there is none: the cutoff is
  recomputed per call, so this is a true sliding window, not a bucket),
  transaction discipline on the new early return, and the lexicographic
  timestamp comparison (safe — both sides are `toISOString()`, fixed-width UTC,
  and `created_at` is never client-supplied). It noted two operational items,
  recorded as gaps below.

  **Known gaps carried forward, not fixed in this slice:**
  - **The limit is a guess.** $0.02/60s is roughly 3x the busiest minute ever
    recorded, calibrated against test traffic and nothing else. One constant,
    easy to change, and it should be revisited the moment real agents generate
    real traffic.
  - **Per-agent only.** Fifty agents each just under the limit is fifty times
    the burn rate with nothing objecting. The team and company *caps* still
    bound the total, but there is no team-level rate limit.
  - **Global constant**, not per-agent or API-configurable.
  - **Retries are not themselves throttled.** A caller ignoring `Retry-After`
    in a hot loop still takes the write lock and inserts a `blocked` row each
    time, and `node:sqlite` is a single connection — so one misbehaving agent
    can add lock contention for every other agent. An availability concern, not
    a fund-safety one.
  - **An approval can expire unused** if the agent stays rate-limited across its
    full 15-minute validity. Fails closed (nothing is paid), but an operator's
    decision is wasted.
  - A payment stuck `pending`/`signing` occupies window budget until the reaper
    resolves it (~2 minutes).
  - **Still no agent freeze / one-click unfreeze** — the last open Phase 3 item.
    A runaway agent is throttled, not stopped.

  **Test fixtures:** verification spent roughly $0.041 of sandbox budget across
  16 settled payments, and left 25 `unreconciled` rows from the RPC failures
  above (budget correctly held). Caps raised to let the rate limit be the
  binding constraint were **restored to their pre-slice values** afterwards
  (company $5, Default Team $0.021, both test agents $0.005).

### Slice 3: agent freeze / unfreeze — done
- [x] `agents.frozen_at` / `frozen_reason` (NULL = running), with guarded
      `freezeAgent`/`unfreezeAgent` in `src/db/agents.ts`.
- [x] `POST /api/agents/:id/freeze|unfreeze`, operator-only. A frozen agent
      cannot pay at all, **including redeeming an approval it already holds**.
- [x] Refused with **423 Locked**. Four refusals now, four codes, four fixes:
      402 raise a cap, 202 ask a human, 429 wait, 423 an operator must let it
      run again.

  **Manual only — the data ruled out auto-freeze.** At a threshold of 3+
  refusals in a minute, `research-bot` would have been auto-frozen **8 times**
  during ordinary testing, mostly for plain "would exceed team spend cap"
  refusals (27 of the blocked rows in the DB are exactly that). The deeper
  objection is that it inverts Slice 2: a rate-limit false positive costs sixty
  seconds and fixes itself, while a freeze false positive costs however long
  until a human notices. Auto-freeze converts a self-healing condition into a
  human-gated one. The narrow high-signal alternative — an agent retrying an
  approval a human explicitly *denied* — has occurred **once** in all history,
  so there is neither calibration data nor much to catch.

  **This is not "set the cap to $0".** A cap is a budget statement: zeroing it
  destroys the real value, has to be remembered and restored by hand, and reads
  as a budget decision to anyone looking later. Freezing leaves every budget
  untouched — verified, a frozen `research-bot` still reported a $5 cap and
  $4.937 remaining while unable to spend a cent.

  **The check runs FIRST, ahead of approval validation and all three caps**,
  deliberately breaking the narrowest-first ordering the caps follow. Frozen is
  the most severe state and the most explanatory answer; telling a stopped
  agent to raise a cap, or that its approval looks invalid, sends it chasing a
  problem that is not the problem. Verified: an agent that was both frozen and
  over its team cap reported frozen.

  **Redemption was the hole worth closing.** An agent holding a valid, approved
  exemption must not be able to spend it while frozen, or freezing is
  decorative for exactly the agent most likely to have one. Because the check
  precedes the approval path entirely, the approval is never even read — so a
  frozen refusal cannot burn it. Freezing leaves pending and approved requests
  alone rather than denying them: denial is terminal, and unfreezing could not
  bring them back.

  **Two checks, on purpose.** The authoritative one is inside
  `reserveIfUnderCap`'s transaction; a second sits at the top of `payForAgent`,
  before the outbound merchant fetch, because "stopped" should mean an agent is
  not reaching the network at all, not merely that it cannot pay. Both were
  verified independently — the early one refuses without touching network or
  database, the transactional one refuses *and* records a `blocked` row.

  **A plain `ALTER TABLE ADD COLUMN`, unlike the last two migrations.** Both
  columns are nullable with no default, the one shape SQLite handles directly.
  `migrateAgentsAddTeamId` needed a full rebuild because SQLite cannot add a
  NOT NULL column to populated rows, and `migrateApprovalScopes` because it
  cannot ALTER a CHECK constraint; neither constraint applies here. Each column
  is added independently, so a process killed between the two ALTERs completes
  on the next boot.

  Verified, against real Base Sepolia:
  - Migration on a scratchpad copy then live: both columns added, all 5
    existing agents came through unfrozen, `foreign_key_check` clean,
    idempotent on re-run, and a fresh install builds them directly.
  - A frozen agent's payment → **423**, nothing signed, no approval created.
  - **The redemption hole**: approve a request, freeze, redeem → 423 with the
    approval still `approved` and unburned; unfreeze, redeem → settles, tx
    `0xcb65985a98ba95bc4f816bfa369cb303540ed334821b6aeac86e18a8bfc75ccd`.
    Freezing left the approval untouched throughout.
  - Role split: the agent key gets **403** on both freeze and unfreeze.
  - Guarded transitions: freezing a frozen agent → 409, unfreezing an unfrozen
    one → 409, round-trips clean.
  - Isolation: with `research-bot` frozen, another agent reached its own cap
    check and got a 402 — a refusal only a non-frozen agent can receive.
  - Slices 1 and 2 unaffected: the anomaly check still returns 202 with the
    baseline once the team has headroom.

  **Security review — no exploitable findings.** It confirmed
  `reserveIfUnderCap` has exactly one call site, so there is no second path
  into a reservation that could skip the check, and that the single synchronous
  `node:sqlite` connection makes the guarded freeze/unfreeze UPDATEs race-safe.
  It raised one thing worth recording that had not been considered: the freeze
  *reason* is readable by the shared agent credential via `GET /agents`.

  **Known gaps carried forward, not fixed in this slice:**
  - **No auto-freeze.** A runaway agent is still only throttled until a human
    intervenes. Revisit when real traffic exists to calibrate a trigger.
  - ~~Attempts made while frozen leave no record at all.~~ **Closed** — see
    "Frozen-attempt counter" below.
  - **The freeze reason is visible to the agent credential.** Since agent
    credentials are not per-agent yet, any holder can read every agent's
    `frozenReason` through `GET /agents`. Do not put sensitive operator notes
    in it ("compromised, rotating key") until per-agent identity exists.
  - **Freezing does not recall an in-flight payment** whose budget was already
    reserved before the freeze committed; it blocks new reservations only. The
    existing reaper resolves whatever was mid-flight.
  - **No freeze history** — current state only, and with one shared operator
    key "who froze this" could not be recorded meaningfully anyway.
  - **No team- or company-level freeze**; stopping a team means freezing each
    agent.
  - **No notification and no dashboard surface** — API-only.

  **Test fixtures:** verification settled 2 payments (~$0.002) and left every
  agent unfrozen. The Default Team cap was raised to $1 to give the anomaly
  regression check headroom, then **restored to $0.021**.

#### Frozen-attempt counter — done (follow-up to the Slice 3 review)
- [x] `agents.frozen_attempt_count` / `last_frozen_attempt_at`, incremented on
      every payment attempt refused because the agent is frozen, surfaced as
      `frozenAttempts` / `lastFrozenAttemptAt` on `GET /agents`.

  Closes the one gap the Slice 3 security review raised: because the early
  containment check short-circuits before any write, essentially *every*
  post-freeze retry was invisible — not deduplicated, absent. An agent
  hammering a stop order is itself a signal, and it was being thrown away.

  **A counter, not a row per attempt.** A retry loop would otherwise fill the
  payments table with rows restating one fact the operator already knows.
  Verified: 5 attempts against a frozen agent produced 5 increments and **zero**
  new payment rows.

  **Reset on freeze, kept on unfreeze.** The number therefore always answers
  "is this agent respecting the *current* stop?" rather than accumulating
  across unrelated incidents — while still surviving an unfreeze long enough to
  review what happened. Verified: 5 → unfreeze → still 5 → re-freeze → 0.

  **Incremented in SQL and guarded on `frozen_at IS NOT NULL`**, so concurrent
  attempts cannot lose counts and an attempt racing an unfreeze cannot credit a
  freeze that is already over. Verified: calling it against a running agent is
  a no-op, and a running agent's ordinary cap refusals never touch it.

  **Best-effort, never throws into the payment path.** Failing to record an
  attempt must not change whether the payment was refused — the refusal is the
  control, this is only the note about it.

  **Security review — no issues affecting money.** It confirmed the counter is
  purely observational, cannot double-count (only one of the two frozen checks
  can fire per attempt), and that the `ALTER TABLE ADD COLUMN ... NOT NULL
  DEFAULT 0` is the one NOT NULL shape SQLite permits on a populated table.

  **Known gap:** this adds one `UPDATE` per refused attempt where the early
  path previously did no write at all, so a hot retry loop now contends for the
  single SQLite writer. Recorded rather than fixed, and worth keeping in
  proportion: the rate-limit path already does strictly more per refused
  attempt (a full `BEGIN IMMEDIATE` plus an INSERT), and that contention is
  already carried as a gap in Phase 3 Slice 2. The reviewer's suggested
  debounce was **declined on purpose** — coalescing writes to one per second
  would make `frozen_attempt_count` mean "seconds spent attempting" rather than
  "attempts", and an operator reading "N attempts" would be misled. An honest
  count with a known contention cost beats a cheaper misleading one; revisit
  together with the Slice 2 contention gap if either bites.

- [ ] Auto-pause (deliberately unbuilt — see Slice 3)

## Phase 4 — Accounting export

### Slice 1 — CSV export — done

  `GET /api/exports/transactions.csv?from=&to=&include=`, operator-only, plus a
  date-range form on the dashboard that downloads it.

  **"All transactions" does not mean "all rows".** The roadmap line said "CSV
  export of all transactions", and taken literally that is wrong: 80 of the 155
  live payment rows are `blocked` — refusals where nothing was ever signed.
  Exporting them by default would book $0.112 of money that never left the
  building. The export defaults to `settled` + `unreconciled` and takes
  `?include=all` for the audit view.

  That required a **new status set, `APPEARS_IN_LEDGER`, deliberately not
  `COUNTS_AGAINST_CAP`.** The two answer different questions and the difference
  is load-bearing: a cap counts money that MIGHT move, so it must include
  in-flight `pending`/`signing` reservations — being wrong in the cautious
  direction there costs one rejected payment. A ledger reports money that DID
  move, and booking a transient reservation records a transaction that may
  never happen. Reusing the existing constant would have been the wrong kind of
  consistency; both now carry comments saying so.

  **`settled_at` added to `payments`.** `created_at` is when budget was
  reserved, not when money moved. Same cheap `ALTER TABLE ADD COLUMN` path as
  the freeze columns — nullable, no default. The 47 pre-existing settled rows
  keep NULL and the export falls back to `created_at`; their true settlement
  time is unrecoverable and inventing one would be worse. Stamped in
  `markSettled`, including on the `unreconciled → settled` path, so a payment
  the reaper gave up on still gets a real date if a settlement arrives later.

  **The trap this slice was mostly about.** `migratePaymentStatuses` rebuilds
  the payments table with an *explicit* column list in its `INSERT … SELECT`. A
  column added to `paymentsTable()` but not to that list does not error — the
  rebuild succeeds and silently returns NULLs, which for `settled_at` would
  quietly re-date every historical transaction in the export. Verified by
  forcing a rebuild on a scratch copy with 47 stamped rows and confirming all
  47 survived.

  **No-crypto-surface: the export is held to the rule, not to 0005's
  exception.** No tx hashes, no addresses, no chain or asset names, and no
  `payments.detail` (which carries text like "assuming the authorization is
  spendable"). The reconciliation handle is the Fuel payment id — also the
  right idempotency key for the integration, and the thing someone will
  otherwise reach for the tx hash to do. See
  `/docs/decisions/0006-accounting-export-omits-crypto-identifiers.md`. This
  produced `src/lib/export-presentation.ts`, the first term-mapping layer in
  the codebase — `src/api.ts`'s `present*` functions convert units, not
  vocabulary.

  **First operator-only read on the API.** Every other read is `ANY`, for a
  stated reason: an agent must be able to see whether its own paused payment
  was approved. Nothing equivalent justifies handing an agent credential a file
  containing every payment the company has made.

  Verified:
  - Migration on a scratch copy then live: column added, all 155 rows intact,
    idempotent on re-run, fresh install builds it directly.
  - Forced status rebuild: all 47 stamped `settled_at` values survived.
  - `markSettled` stamps from `pending` and from `unreconciled`; a `blocked`
    row stays blocked and unstamped, so the transition guards still hold.
  - **Gap closed: a real end-to-end sandbox payment through `payForAgent`**,
    not the standalone `pay-test-endpoint.ts` script (which pays with a
    throwaway wallet and never touches Fuel's payment route). Against live
    `fuel.db`, not a scratch copy — this is what actually needed proving.

    `research-bot` (own cap $5, plenty of headroom) sits on `Default Team`,
    whose cap ($0.021) was already exceeded by prior activity ($0.074 spent) —
    exactly the "spent <= cap is no longer an invariant" state the roadmap
    already documents. That made this a better test than a clean run: it
    exercised the full path — `POST /pay` → **202 awaiting_approval** (scope
    `team`, and a `blocked` row recorded for the refusal, per "recorded, not
    just refused") → operator `POST /approvals/:id/approve` → agent retries
    `POST /pay` with the approval id → signed, submitted, and settled for real
    on Base Sepolia.

    Payment `f999bbfb-4bea-41e1-9db0-127b78bdde05`:
    `created_at` `2026-08-03T07:26:24.517Z` (the moment the approval was
    redeemed and budget reserved) vs `settled_at`
    `2026-08-03T07:26:34.414Z` (once the facilitator confirmed) — **9.9s
    apart**, tx
    `0x436365dae7293c926650a253eff1cdfd719770220d94a844a5cd88caf24bbdf3`.
    Exported via `?from=2026-08-03&to=2026-08-03` and confirmed the row reads
    `2026-08-03,f999bbfb-…,research-bot,localhost:3000,/paid-hello,0.001000,
    USD,,Paid` — dated by `settled_at`, not `created_at`. `fuel.db`
    `PRAGMA integrity_check` and `foreign_key_check` clean afterward; row
    count 155 → 157 (one settled, one blocked from the initial refusal), both
    accounted for.
  - 74 ledger rows / 155 with `include=all`; CSV amount column sums to
    `0.082000`, matching `SELECT SUM(...) WHERE status IN ('settled',
    'unreconciled')` = 82000 base units exactly.
  - Date filtering matches per-day DB counts (15 / 16 / 124); the `to` bound is
    inclusive of the whole day.
  - Validation: malformed dates, `08/01/2026`, `from > to`, and an unknown
    `include` value all 400 with the expected message.
  - Auth: operator 200, **agent 403**, no key 401.
  - No-crypto grep over both files (`0x…`, usdc, sepolia, eip155, chain,
    wallet, token, facilitator, x402, tx hash) — clean.
  - CSV injection: agents named `=HYPERLINK("http://evil.test","Refund")`,
    `@SUM(A1:A9)` and `Acme, Inc. "Bot"` all defused — apostrophe-prefixed,
    quotes doubled, comma-bearing fields quoted. Amounts stay bare and numeric.
  - BOM + CRLF present; opens cleanly as numbers and dates.

  **Security review — one real finding, fixed.** The dashboard proxy's
  same-origin check was Origin-only, and browsers do not send `Origin` on a
  top-level GET navigation — which is exactly what the export form uses, so the
  guard skipped itself on the one vector it existed to catch. Now checks
  `Sec-Fetch-Site` first (allowing `same-origin` and `none`), with the Origin
  comparison kept as a fallback. Worth recording the *severity* accurately: the
  route sets no CORS headers, so an external page could force a download onto
  the operator's disk but could not read the data. Verified after the fix:
  cross-site and same-site → 403, same-origin and none → 200.

  The reviewer also flagged that `csv.ts` assumes amounts never start with `-`.
  True today (no negative-amount path exists) and not exploitable either way —
  a leading `-` would be defused as text, not executed. Left as-is, noted here.

  Carried into Slice 2, and it changes that slice's shape:
  - **Sub-cent amounts are unbookable per-transaction.** Every settled payment
    is $0.001; QuickBooks and Xero store 2dp, so each one rounds to $0.00. The
    CSV ships full 6dp and stays honest, but the integration cannot post these
    one-to-one. Rollup (per agent, per vendor, per day) is likely required —
    meaning "the integration is just the CSV over an API" is false.
  - `unreconciled` has no clean accounting analogue. It may need a suspense
    account rather than being booked as paid.
  - `Category` ships as a deliberately empty column so the file's shape does
    not change when a chart-of-accounts mapping arrives. That mapping is a
    per-customer decision and was not invented here.
  - Vendor is the resource URL's **host**, decided now on purpose: if the
    integration later derives vendors differently, an accountant's existing
    vendor mapping breaks silently.
  - Attribution is still limited by the single operator secret — no export can
    name a human approver.

- [x] CSV export of all transactions

### Slice 2a — the rollup / residual / suspense engine — done

  The posting model 0007 designed, built against Fuel's own database. No
  QuickBooks/Xero calls, no OAuth, no developer account — wiring to a real
  platform is Slice 2b, and 0007's open questions about which platform and what
  API shape are still open on purpose.

  `POST /api/postings/run`, `GET /api/postings`, `GET /api/postings/:id`,
  `GET /api/exports/postings.csv` — all operator-only. Two new tables,
  `posting_lines` and `export_postings`. The arithmetic lives in
  `src/accounting/rollup.ts`, the engine in `src/db/postings.ts`.

  **This is the first thing in the project that COMPUTES a financial number
  rather than recording one.** Everything before it wrote down what happened: a
  payment settled, a cap refused, an agent was frozen. Every figure the API
  reported was a sum over observed events. This one produces numbers intended to
  become entries in someone else's books, which changes what "correct" means —
  a bug here misstates real money while moving none, and would do it silently.

  **No residual is stored anywhere, and that is the whole design.** The obvious
  implementation is a mutable counter per bucket that you add to and subtract
  from. Instead the amount waiting to clear is always derived:

      residual = owed (from payments, by current status)
               - posted (from export_postings absorptions)

  The precedent was already in the codebase — `spentBaseUnits` is derived
  rather than kept as a running total on the agent "so it cannot drift out of
  sync with what actually happened". Same reasoning, higher stakes. It buys
  three things: the residual cannot drift; a run that crashes between writing a
  line and writing its absorptions cannot delete money from the books or post it
  twice; and reclassification needs no code.

  **Reclassification really does fall out for free, and this was the payoff.**
  `ledger_class` partitions the ledgerable set exactly — `settled` → expense,
  `unreconciled` → suspense — so when an unreconciled payment finally settles,
  suspense simply stops owing what it has already posted and expense starts
  owing what it has not. Those appear as a negative and a positive residual, and
  the ordinary posting loop emits both without knowing the word
  "reclassification": a credit releasing suspense, a debit landing in expenses.
  Verified end to end — a bucket's suspense went 0.02 → 0.00 while the money
  reappeared in expenses, with conservation holding throughout.

  **Absorption is FIFO and partial, which the schema had to allow for.** A line
  posts an exact whole number of cents but payments are arbitrary amounts, so
  the last payment a line reaches is usually split across two lines. Hence
  `export_postings.absorbed_base_units` rather than bare membership. Absorbing
  only whole payments was considered and rejected: with $0.0015 payments no run
  of them sums to a whole cent until the twentieth, so whether a bucket ever
  cleared would depend on an arithmetic coincidence rather than on how much was
  spent.

  **The drill-down is the point, not the totals.** Every line resolves to the
  payments beneath it, each to the agent that made it, and each — through
  `approval_requests.payment_id` — to the human decision that authorized it.
  That link needed no new schema; it has been written inside
  `reserveIfUnderCap`'s transaction since Phase 2. Against real data, 6 of the
  26 payments in the first expense line trace to named approvals (5 team-ceiling
  exemptions and 1 anomaly confirmation). A billing pipeline reconciling charges
  after the fact cannot reconstruct that, because it never saw the decision.

  **Bucketed by (agent, vendor, class), not (agent, vendor) as 0007 wrote it.**
  The security review flagged the divergence and agreed with it: collapsing
  expense and suspense into one residual makes the credit/debit math ambiguous,
  and the class has to be part of the key for a bucket to be able to go negative
  in one account while positive in the other.

  **On-demand only, deliberately not on the 60s reaper.** That loop repairs
  state the system already knows is wrong; this one computes new financial
  values, and a brand-new engine doing that should not advance unattended. An
  arithmetic mistake compounding across unwatched runs is a worse failure than
  books that are a few hours stale.

  **A plain `CREATE TABLE IF NOT EXISTS`, unlike the last four migrations.**
  Both tables are new, so there is no CHECK to widen and no NOT NULL column to
  backfill. Worth stating because the previous three slices all needed the
  rebuild dance and it would be easy to perform it out of habit.

  **Security review — one real defect, found and fixed.** Negative amounts were
  corrupted on their way into `postings.csv`. `csv.ts` defuses spreadsheet
  formula injection by prefixing any cell starting with `=`, `+`, `-` or `@`
  with an apostrophe, and Slice 1's own review had noted that "`csv.ts` assumes
  amounts never start with `-`. True today (no negative-amount path exists)."
  **This slice created that path.** A reclassification credit rendered as
  `'-0.02`, which is text, not money — so the one row that releases a suspense
  balance was unreadable to the importer it was written for. Reproduced (the
  cell round-tripped as `NaN`), then fixed: `defuseFormula` now exempts values
  matching a strict `^-?\d+(\.\d+)?$`, which cannot match anything a spreadsheet
  would execute. Both halves are regression-checked — credits parse as numbers,
  and `=HYPERLINK(…)`, `@SUM(…)`, `+1+1` and `-1+cmd|' /C calc'!A0` are all
  still defused.

  **The general lesson, which matters more than the bug.** Slice 1 did the hard
  part — it *noticed* the assumption and wrote it down. That turned out not to
  be enough, because writing it down is a one-time act and the assumption needed
  watching. Nothing re-checked it when the conditions under it changed, and the
  very next slice changed them. A recorded "true today" is not a resolved
  question; it is an open one with a note attached, and the note does not
  re-read itself.

  So the practice this project should adopt: when a slice introduces something
  the codebase has never produced before — here, a negative amount — go looking
  for the assumptions that were previously safe *because* it did not exist.
  Grep for them. The relevant ones in this codebase are recorded in exactly two
  places, this roadmap and the comments at the assumption site, and both are
  searchable. Concretely, `csv.ts` had spelled out its own precondition in a
  comment ("amounts are generated by baseUnitsToDollarsFixed and always start
  with a digit"), and the fix's real content was noticing that precondition had
  quietly stopped holding. Other live examples worth re-checking whenever their
  ground shifts: "an approval is a one-time exemption" (Phase 2 Slice 2),
  "`spent <= cap` is no longer an invariant" (same), and the sandbox co-signer
  affordance in Phase 1 Slice 2, which is explicitly labelled as not surviving
  production.

  The review found nothing else exploitable, and specifically cleared: the
  negative-residual arithmetic, over- and double-absorption, `runPosting`'s
  atomicity and its consistency with `reserveIfUnderCap`, concurrent runs,
  BigInt/Number contamination, the conservation check itself, operator-only
  auth on all four routes, SQL injection, and the no-crypto rule.

  Verified — `npx tsx scripts/verify-rollup.ts`, 136 checks, run against a
  scratch copy of the live database (never `fuel.db` itself):
  - **Conservation, the check that matters most:** posted + carried equals what
    the ledger owes, asserted before the first run, after it, after a repeat
    run, and after reclassification. Almost any arithmetic mistake anywhere in
    the engine shows up as money appearing or vanishing.
  - `clearable` on 12 cases in both directions, including the negatives a
    "fix" to floor semantics would break (−15,000 → −10,000 postable, −5,000
    carried, NOT −20,000). `postable + carried === residual` and
    `|carried| < 1 cent` asserted on every one.
  - `planAbsorption`: exact fit, the partial case real data has not yet
    produced, one payment larger than the line, empty input, a credit, mixed
    signs mid-reclassification, and that it throws rather than post a line its
    parts cannot cover.
  - After a run, no bucket holds a postable cent; every line is an exact
    multiple of 10,000 base units; every line's parts sum to its total; a second
    run immediately after posts nothing.
  - Real data, 83,000 base units ledgerable: run 1 posted 50,000 across 2 lines
    with 7 buckets still under a cent. **`transactions.csv` sums to exactly
    83,000 too** — the rollup and the transaction ledger describe the same money.
  - Reclassification: 26 unreconciled payments settled, suspense released to
    net zero for that bucket, the money reappearing in expenses, conservation
    intact, and every part of the credit itself a credit.
  - Auth: operator 200, **agent 403**, no key 401, on all four routes. 404 on an
    unknown line id. Date validation rejects malformed dates, `08/01/2026`, and
    `from > to`.
  - CSV: BOM (`ef bb bf`) and CRLF present; amounts bare and numeric; agents
    named `=HYPERLINK("http://evil.test","Refund")`, `@SUM(A1:A9)` and
    `Acme, Inc. "Bot"` all defused; the whole reclassification story readable
    from the file (0.02 posted to suspense, −0.02 released, money in expenses).
  - No-crypto grep over the drill-down output: no `0x`, usdc, sepolia, chain,
    wallet, token, facilitator or x402.
  - Migration: fresh install builds both tables, all three indexes and a working
    CHECK; live `fuel.db` boot left all 157 payments intact, is idempotent on a
    second boot, `foreign_key_check` clean, `integrity_check` ok.
  - `npx tsc --noEmit` clean. `transactions.csv` unchanged at 75 rows / 83,000
    base units after the `csv.ts` fix.

  **Known gaps carried forward, not fixed in this slice:**
  - **Nothing posts to QuickBooks or Xero yet.** No platform chosen, no
    developer sandbox account, no OAuth, no token storage. That is Slice 2b and
    it needs the user to pick a platform first.
  - **No `postings` grouping table with an external id.** The (vendor, day)
    posting is a `GROUP BY` over lines today. The table that carries a
    QuickBooks/Xero document id, and the idempotency contract around it, should
    be designed against a real API rather than guessed at now.
  - **No chart-of-accounts mapping.** `ledgerAccount()` returns two hardcoded
    labels. 0007 settles that the first version uses one operator-configured
    default account; even that config does not exist yet.
  - **A low-volume (agent, vendor) pair can sit unposted indefinitely** — three
    $0.001 payments a week never reach a cent. Correct, not a bug, but nothing
    surfaces "this has been carried for 90 days" to an operator.
  - **`?to=2026-13-45` is accepted**, matching the existing transactions export:
    `ISO_DAY` checks shape, not validity, so an impossible date passes the regex
    and then matches nothing. Left consistent with the sibling route on purpose
    — fixing one and not the other is worse than the shared gap. Fix both
    together.
  - **The engine never runs itself.** Books are as current as the last time an
    operator called `/postings/run`.
  - **No dashboard surface** — API and CSV only.
  - Reclassification credits are dated when Fuel learned of the settlement, not
    when it occurred on-chain. `markSettled` has never claimed otherwise, but it
    means a credit can land in a period a bookkeeper has already closed.

### Slice 2b — QuickBooks Online — done, verified against a live sandbox

  **QuickBooks chosen.** The engine from 2a now has a transport: preview a day's
  rollup, read the exact JournalEntry it would post, post it deliberately, and
  drill from the posted document back to the approval that authorised each
  payment. `src/quickbooks/`, `src/db/qbo*.ts`, five new tables, four operator
  routes, an OAuth callback, and a dashboard page at `/accounting`.

  **Verified end to end against Intuit's sandbox on 2026-08-25.** Company
  `9341457784003246`. Two documents exist there, posted by Fuel:

  | QBO Id | DocNumber | TxnDate | Lines |
  |---|---|---|---|
  | 145 | `FUEL-f16a2204a3d9` | 2026-08-24 | Dr 0.09 Expenses · Dr 0.02 Suspense · Cr 0.11 Fuel Account |
  | 146 | `FUEL-694f3e952b09` | 2026-08-25 | Dr 0.02 Expenses · Cr 0.02 Suspense |
  | 147 | `FUEL-eef5803a8eb2` | 2026-08-02 | Dr 0.03 Expenses · Dr 0.02 Suspense · Cr 0.05 Fuel Account (posted during Slice 2d) |

  Net across both: Expenses Dr 0.11, **Suspense Dr 0.00**, Fuel Account Cr 0.11.
  Entry 146 is the reclassification, and it carries **no contra line at all** —
  the Fuel Account does not appear in it. That is the property 0008 called the
  strongest available evidence that the posting model is right, and it now holds
  against real Intuit rather than only against the test suite.

  **Attribution stops at Fuel's boundary — this REVERSES part of 0007.** 0007
  specified a QuickBooks Class per agent. That is now wrong on three counts: it
  fills a customer's class list with forty entities they never asked for; Class
  tracking silently requires a QuickBooks **Plus or Advanced** subscription; and
  it gives away the thing Fuel uniquely has. QuickBooks gets a clean accounting
  summary; the detail stays in Fuel and is reached by drill-down. Class survives
  as an optional mapping onto customer-defined teams, and Vendors are mapped
  only when an operator says so. See
  `/docs/decisions/0008-quickbooks-posting-and-attribution-boundary.md`.

  **JournalEntry, not Purchase, and the zero-net case is why.** The engine emits
  signed whole-cent amounts per account; a JournalEntry is literally that, so
  the mapping is total — a negative amount is simply a credit, since QuickBooks
  carries direction in `PostingType`. Purchase reads more naturally to a
  bookkeeper but cannot express a suspense-to-expense reclassification at all.
  The confirming property: for a pure reclassification the amounts net to zero
  and **no contra line is emitted**, because moving money between two accounts
  does not touch the funding account. That falls out of the model rather than
  being special-cased.

  **Preview and post are bound by an immutable snapshot.** A preview writes a
  durable draft holding the exact payload, its hash, the exact lines, and a
  fingerprint over the payments beneath them. Post sends the stored bytes.
  Without this, preview and post are two clicks with a gap, and in that gap a
  posting run can add lines or a payment can settle — so the entry reviewed and
  the entry posted would be different documents, and the review, which is the
  only human control on this path, would mean nothing. The fingerprint covers
  payment **status**, not just line ids: a payment moving `unreconciled →
  settled` changes what a suspense line means without touching any existing row.

  **A posted entry is never edited.** Corrections are new documents linked by
  `corrects_posting_id` and naming the original in `PrivateNote`. Two
  consequences that only became clear while building it: a posted correction
  must **release** the original's lines, or the only way to fix a misposting
  would be to never book that spend at all; and a re-post after a reversal needs
  a **new document number**, because the reversed entry keeps the old one —
  without that, the duplicate-number path would adopt the reversed entry as
  though it were the new one. Both were caught by testing, not by design.

  **Idempotency has three layers.** Intuit's `requestid` is a QUERY PARAMETER,
  not a header (the easy thing to get wrong), written to the row *before* the
  request exists so a retry reuses it and Intuit replays rather than duplicating.
  A deterministic `DocNumber` makes a posting reconcilable by query long after
  any replay window. And `pending` is fail-closed in exactly the sense
  `unreconciled` is for payments: it means a document *may* exist, is never
  blind-retried, and is resolved by asking QuickBooks.

  **Sandbox pinned by origin equality, never a prefix.** `startsWith` accepts
  `https://sandbox-quickbooks.api.intuit.com.evil.example`, which is a different
  host that merely begins with the right characters. No env var selects
  production; that is a reviewed code change, as with mainnet.

  **First OAuth, first secret held at rest.** Every prior secret in Fuel is
  compared, never stored. OAuth gives tokens that must be KEPT, and Intuit
  rotates the refresh token roughly daily while force-expiring its predecessor —
  so the new pair is persisted *before* the new access token is used, or a
  process that refreshes and dies has destroyed its own connection. They are
  encrypted (AES-256-GCM, `src/lib/secrets.ts`) because a database file gets
  copied to laptops and attached to bug reports, and "not in git" is not the same
  as protected.

  **No PKCE, deliberately.** Intuit documents no `code_challenge`. Sending one
  anyway would look like protection while providing none. Fuel's backend is a
  confidential client with an exactly-registered redirect URI, and the control is
  a durable, company-bound, single-use `state`. Recorded in 0008 rather than left
  as a code comment, because a security decision nobody reviewed is not a
  decision.

  **USD only.** Refused in the mapper and again at connection, since FX, tax
  calculation and tax reporting are each real features whose absence should fail
  loudly rather than produce authoritative-looking wrong numbers.

  Verified — `npm run verify-quickbooks`, 73 checks, scratch copy only:
  - Sandbox guard refuses the prefix attack, the production host, plain http, an
    embedded origin, a userinfo trick and a malformed URL.
  - Tokens: round-trip, unique IV per call, tamper-evident, unknown version
    refused, and a decryption error names no secret material.
  - Mapper: positive → Debit, negative → Credit, every `Amount` positive, every
    entry balanced; **the zero-net reclassification emits no contra line**;
    non-USD, sub-cent and empty entries all refused; no-crypto grep clean.
  - Document numbers deterministic, ≤21 chars, distinct across days,
    generations and corrections.
  - Snapshot: a tampered payload is refused; a new line makes a draft stale; **a
    settlement makes it stale via the fingerprint**, which a line-id comparison
    would miss.
  - Idempotency: a second attempt reuses the first and its `requestid`; a
    `pending` attempt holds its lines; posted lines never become eligible again
    except through a posted reversal.
  - Corrections: distinct number, directions flipped, balanced, linked, and the
    original's id and payload are untouched.
  - Dashboard proxy allowlist blocks traversal and non-allowlisted paths;
    cross-site is 403; the full preview flow through the browser path produces a
    balanced ledger.
  - Migration: five tables on a fresh install and on live `fuel.db`; 157
    payments intact; idempotent re-run; `foreign_key_check` and
    `integrity_check` clean.
  - `npx tsc --noEmit`, `npm run verify-rollup` (136), `dashboard/ typecheck`.

  **Security review — no exploitable findings.** It cleared the sandbox pin,
  secret leakage across every error path, the unauthenticated callback and its
  state handling, double-posting, the snapshot binding, injection into Intuit's
  query language, the dashboard proxy allowlist, and BigInt/Number
  contamination. Two real notes, both fixed: ADR 0008 was cited six times before
  it existed (now written), and the `qbo_oauth_states` comment claimed
  operator-binding the table does not implement — corrected, with the reason
  (there is one shared operator credential, so "which operator" is not a fact
  this system can know yet).

  **Verified: the live walkthrough.** Setup is an account at developer.intuit.com
  with the `com.intuit.quickbooks.accounting` scope, its **sandbox** client
  id/secret in `.env`, redirect URI
  `http://localhost:3000/integrations/quickbooks/callback` registered under
  **Development Settings** (not Production — they keep separate redirect lists
  *and* separate client ids, and mixing them gives the unhelpful
  "redirect_uri query parameter value is invalid"), and `openssl rand -hex 32`
  for `FUEL_TOKEN_ENCRYPTION_KEY`.

  Connect: tokens landed as `v1.`-prefixed AES-256-GCM ciphertext, survived a
  server restart, and no token material appeared in any log line — the only
  callback log is `connected to sandbox company <realm>`. Exactly one OAuth
  state was consumed; two abandoned ones stayed unconsumed and expired.
  **Token refresh also ran live**, unplanned: the access token lapsed between
  posting and the retry, and the rotation path persisted the new token before
  using it.

  Accounts: three created on an explicit operator action, with a live USD check
  passing first.

  Post: entry 145, from a frozen snapshot whose stored hash matched.

  **Idempotency, three independent layers, all exercised.** The sandbox held at
  four JournalEntry documents throughout:
  - Re-posting the posted draft → 409, refused at draft readiness.
  - A second draft carrying the *same* deterministic DocNumber → 409, refused as
    stale ("0 line(s) now, 4 when previewed") because its lines were committed.
  - Fuel's guards bypassed entirely and the exact stored payload re-sent to
    Intuit **with the stored `requestid`** → Intuit replayed **Id=145**, no new
    document. This is the layer that still holds if Fuel's own record is lost,
    which is why the `requestid` is written to the posting row before the
    request goes out.

  Reclassification: settling the 20 unreconciled payments produced expense
  `+20000` and suspense `-20000`, netting to zero, and posted as entry 146 with
  two lines and no contra line. Drill-down survives the correction — both the
  release and the rebook trace to the same 20 payments.

  **A detail worth knowing before a demo:** the reclassification lands on the
  day settlement *resolved*, not the day the payment was made. Settling
  2026-08-24's payments on 2026-08-25 put the correction on 2026-08-25. Correct,
  and surprising if you are expecting the original day.

  **Demo data.** `scripts/seed-demo-day.ts` seeds one controlled day of
  synthetic spend — records only, no Fireblocks call, nothing signed, no funds
  moved. Every row is stamped `detail = 'demo-seed'`; a re-run deletes only rows
  carrying that stamp, and the script refuses any day that already has posting
  lines, so a demo can never be the reason a committed line changes. That guard
  lives *inside* the `BEGIN IMMEDIATE` transaction, not before it — the security
  review caught it outside, where a concurrent rollup could slip between check
  and write. Narrow is not closed.

  **Four bugs only live credentials could have found.** All fixed, each with a
  regression test that was checked to fail against the old code:

  1. **`SELECT CompanyName, Country FROM CompanyInfo` is rejected by Intuit.**
     That entity supports no projection at all — only `SELECT *` parses. Now
     read via `GET companyinfo/{realmId}`. The same trap bit again later on
     `SELECT ... TotalAmt FROM JournalEntry`, so treat *any* named-property
     projection against an Intuit entity as unproven until it has run.
  2. **The USD check did not check a currency.** `companyProfile` was named and
     documented as the USD enforcement point but read `Country` and never looked
     at a currency — and home currency is not on `CompanyInfo` at all, it is
     `Preferences.CurrencyPrefs.HomeCurrency`. 0008's claim that USD was
     "enforced twice" was false; only the mapper enforced it. A US-registered
     company keeping its books in CAD would have passed setup and had every
     figure mis-stated at par. Now genuinely enforced, failing closed when Intuit
     reports no currency at all.
  3. **A 106-character account description against a 100-character cap.** Intuit
     reported it as error 2050 with `Supplied length:{2}` — an unsubstituted
     template placeholder naming neither the field nor the length. It also failed
     *after* the first account had been created, leaving the chart of accounts
     half-edited. Now bounds-checked before the first request.
  4. **The drill-down was dead on previews.** The trace endpoint took a posting
     id, but the dashboard's drill-down button passes a *draft* id, and the
     handler ignored failures — so clicking it before posting silently did
     nothing. Provenance that only appears after posting arrives too late to
     inform the decision it exists to support.

  **A "true today" assumption expired, again.** `verify-rollup` asserted
  `postedTotal() === 0` under the description "a fresh scratch copy has posted
  nothing" — an encoding of "the live database has never had the rollup run
  against it", true when written and false the moment the engine ran for real.
  It failed as a broken *test*, not a broken engine. Replaced with conservation
  (`posted + carried === owed`), which holds from any starting state. This is the
  second time this codebase has been bitten by a fact that was true when recorded
  (see the CSV negative-amount note in Slice 1) — and this time it was bitten
  *inside the very file* where the lesson was written down. Recording an
  assumption does not watch it. Prefer asserting the invariant over asserting
  the current state.

  **Known gaps carried forward:**
  - **No vendor or class mapping UI.** Both are optional and configured by API
    only; the tables to hold per-vendor mappings do not exist.
  - **`pending` needs a human.** There is no automatic reconciliation sweep, on
    purpose — asking QuickBooks costs an API call and the answer changes what
    gets booked.
  - **No per-operator attribution on the OAuth state**, because there is one
    shared operator credential.
  - **The dashboard page is not linked from the agents page**; navigate to
    `/accounting` directly.
  - Token encryption key and database live side by side; an attacker with both
    has the tokens.

### Slice 2c — the USD-only scope gate — done

  **The problem was a false claim, not a crash.** 0008 said USD was "enforced
  twice". It was enforced once, in the mapper. The setup-time half read
  `CompanyInfo.Country`, which is not evidence of a company's accounting
  currency — a US-registered company can keep its books in anything. Slice 2b
  fixed the reading; this slice fixes the claim, and makes the system incapable
  of making that class of claim again.

  **How Fuel knows the currency now.** It reads
  `Preferences.CurrencyPrefs.HomeCurrency` — Intuit's documented home-currency
  source, the field its own Customer and Vendor references point at — and stores
  the answer with `currency_source` and `currency_checked_at`. **Verified, not
  operator-confirmed.** There is deliberately no operator-assertion path: a
  reliable field exists, and offering an "I promise it's USD" button would
  reintroduce exactly the unevidenced claim being removed.

  **Country is never consulted**, not even as a fallback. A regression test
  asserts the gate's source contains no reference to a country.

  **The gate reads a record, not the network.** Preview must send nothing to
  QuickBooks — that is what makes "did that reach Intuit?" answerable — so
  verification happens at setup and preview gates on the stored result. Post
  re-checks the same record, so a draft frozen while a company was in scope
  cannot post after it leaves.

  **Fail-closed on migration.** Existing companies migrated to `null`, not
  `"USD"`. The live database's already-connected, already-set-up company went
  straight to `readyToPost: false`, `missing: ["USD verification"]` — correct,
  because Fuel had genuinely never read its currency. One
  `POST /integrations/quickbooks/verify-currency` against Intuit returned
  `USD / quickbooks_preferences` and unblocked it.

  **Verified:** 120 checks in `verify-quickbooks` (up from 103), with the new
  section checked to fail when the gate is stubbed out. Covers: unverified
  blocks preview; non-USD blocks preview and names both currency and scope; a
  USD value from a non-QuickBooks source is refused rather than downgraded; post
  is gated independently of preview; and a refused post leaves the frozen draft
  byte-identical and still `previewed`. Live: re-previewing 2026-08-02 after the
  gate produced `payloadHash 35737b78…`, identical to the pre-gate preview —
  the scope check changed nothing about the document itself.

  **The limitation this left open** — that the stored verification goes stale —
  was closed by Slice 2d below. Notable as the one instance in this file where a
  recorded "true today" assumption was closed deliberately in the next slice
  rather than discovered later by a bug.

### Slice 2d — currency freshness at post time — done

  **Post no longer trusts the stored record at all.** Immediately before any
  JournalEntry mutation it re-reads `Preferences.CurrencyPrefs.HomeCurrency`,
  records what it finds, and refuses unless that fresh reading is USD.

  **Preview still sends nothing to QuickBooks.** That was the objection to
  re-reading, and the resolution is that preview does not need to: preview gates
  on the record, post re-establishes it. Preview's silence is what makes "did
  that reach Intuit?" answerable, and it is why preview and post are separate
  routes rather than one route with a `dryRun` flag.

  **Ordering is the substance.** The check runs before `beginPosting`, so a
  refusal creates no attempt row, mints no `requestid`, and sends no
  JournalEntry — a refused post is indistinguishable from one that never
  happened. Ordered the other way, the fail-closed `pending` state (which means
  "a document may exist") would fill with attempts that never had a chance of
  being sent, and the one state that must stay meaningful would stop being so.

  **A refusal records what it found**, so a company that switched to CAD ends up
  storing CAD rather than a stale USD, and `status` reports what Fuel actually
  observed.

  **Verified:** 142 checks in `verify-quickbooks` (up from 120), the new section
  checked to fail when the fresh read is stubbed out. The tests assert what was
  NOT sent, which is the only way to know: preview makes **zero** requests; a
  stale USD record followed by a fresh CAD reading refuses with **zero**
  JournalEntry mutations and **zero** new attempt rows; an unreported currency
  refuses the same way; fresh USD posts exactly one; and the posted hash equals
  the reviewed hash, so the freshness check recomputes nothing.

  **Live:** stored record poisoned to `USD, checked 2026-01-01`. Preview passed
  offline on that record. Post then re-read live Intuit and moved
  `currency_checked_at` to `20:08:25.686` — **4ms before** the attempt row's
  `createdAt` of `20:08:25.690`, which is the ordering proven by timestamp
  rather than asserted. Posted as **QBO Id 147** (`FUEL-eef5803a8eb2`,
  2026-08-02: Dr 0.03 Expenses, Dr 0.02 Suspense, Cr 0.05 Fuel Account), with
  `postedPayloadHash` identical to the previewed `payloadHash`. Separately, a
  record poisoned to CAD blocked preview offline with no network call at all.

  **What remains.** The window is now one QuickBooks round-trip wide: a company
  changing its home currency between Fuel's read and Intuit's write of the same
  document would still be posted in USD. Closing that needs a transaction across
  two systems, which QuickBooks does not offer. Corrections are the remedy, as
  for any other post-hoc discovery.

- [ ] Xero (deferred — the posting model in 0007/0008 is platform-neutral)

## Phase 5 — The product UI

  Blueprint: `/docs/ui/phase-5-blueprint.md`. It carries the design thesis, the
  page-by-page architecture, the component and token inventory, and — the part
  that matters most — an explicit list of capabilities Fuel does not have, which
  no screen may imply.

  This heading used to read "One P&L", while the header block at the top of this
  file described Phase 5 as the dashboard. Two different Phase 5s had been
  written months apart. The dashboard takes Phase 5; One P&L moves to Phase 6.

### Slice 5A-1 — the application shell — done

  **The problem was not polish.** The backend had run well ahead of the
  interface: company and team budgets, agent CRUD, freeze/unfreeze, an approvals
  queue and thirteen QuickBooks routes, against a dashboard of two pages that
  did not link to each other and were set in two unrelated visual systems. An
  operator on the agents page could reach accounting only by typing the URL.

  **What shipped:** `AppShell`, `SideNav` and `PageHeader`; one `:root` token
  layer in `dashboard/app/theme.css`; IBM Plex moved from the accounting page to
  the root layout so the whole product is set in one superfamily; both existing
  pages re-homed unchanged; `error.tsx` and `not-found.tsx`, which did not exist
  anywhere.

  **Seven destinations, two with pages behind them.** The other five render as
  plain text marked "soon" rather than links. A link into a 404 is worse than an
  honest absence, and a stub page saying "coming soon" is a page pretending to
  be a feature.

  **No global environment badge yet, deliberately.** The shell is the right
  place for one, but the only machine-readable sandbox signal today is
  `environment: "sandbox"` on the QuickBooks status object, which describes
  QuickBooks and not the payment rail. Hardcoding "Sandbox" in the browser would
  assert exactly the thing it is supposed to prove. It waits for
  `GET /api/environment` in 5B-3. The accounting page keeps its own real,
  QuickBooks-derived badge in the meantime.

  **ADR 0005 is closed, and the first attempt at closing it was wrong.**
  Removing `walletAddress` from the dashboard's `FuelAgent` type looked like it
  made the compiler the enforcement, and the ADR said so. It did not. A
  TypeScript annotation is erased at build time: it stops a field being
  *rendered* but not being *transmitted*. `listAgents()` still did `return
  res.json()`, handing the whole upstream object to a Server Component, which
  passed it as a prop to a Client Component, and Next.js serialises the object
  it is actually given — so **five custody addresses were arriving in the
  browser with nothing on screen showing them.**

  Found by the security-reviewer subagent, confirmed by grepping the delivered
  HTML, fixed with an explicit allowlist pick at the network boundary
  (`toAgentCore`), written as a pick rather than a delete so a field the API
  adds later has to be named before it can reach the browser. The fix needed a
  second pass too: the first version returned `balance: null` from the cap PATCH
  response, which has no balance, and `AgentsTable` spreads that response over
  the row it already has — it would have blanked a good balance on every save.

  **The lesson is general**: a type is not a boundary. It is available anywhere
  a typed wrapper sits in front of an untyped upstream response, which in this
  codebase is every function in `dashboard/lib/fuel.ts`.

  **Three defects the screenshot and axe passes found, all pre-existing:**

  - `--ink-40` (`#8b90a3`), the colour of every ledger column header, section
    eyebrow and provenance heading, measured about **3.0:1** against paper —
    below AA for text that small. It had never been legible; it only looked
    deliberate. Darkened to `#656b80`, which clears 4.7:1 on every surface Fuel
    paints, keeping the three-step ink hierarchy.
  - The accounting page's step chain rendered its `<ol>` decimal markers on top
    of its own state dots — two markers competing for one position, since the
    dots are what light up as the chain advances. The dots stay.
  - `<input type="date">` was reachable by keyboard with no focus ring, because
    Chromium reports no outline on the host once focus enters the field's
    internal segments.

  **Verified — `npm run qa-dashboard`, 96 checks, 0 failures**, across two routes
  at desktop 1440, tablet 834 and mobile 390:

  - **axe-core**, WCAG 2.0/2.1 A and AA, failing on any serious or critical
    violation. Clean. The first run was not: it produced 12 failures, which is
    what the three defects above were.
  - **Keyboard focus**, asked per control rather than per keypress — Chromium's
    date input is one control with four internal tab stops, and asking per
    keypress made a control that plainly has a focus ring look like it did not.
    The skip link is asserted to be the first tab stop.
  - **No crypto terminology in rendered text.** `document.body.innerText`, not
    source: source contains `token` in design-token naming and `chain` in a CSS
    class, and a check that cries wolf is a check people learn to skip.
  - **No custody address in the delivered HTML**, framework payload included —
    a separate check, because a rendered-text grep cannot see what is
    transmitted but not shown, and that is exactly what went wrong. Both checks
    were confirmed to fail against the broken version: reinstating the
    pass-through turns 96 green into 3 named failures on the one route that
    lists agents.
  - **No horizontal page scroll** at any width. Wide tables scroll inside their
    own focusable region instead.

  **Verified: the ledger is unchanged.** The thing this slice was most able to
  break was the accounting module's token block, which moved to `:root`. Driven
  in a real browser against **a scratch copy of `fuel.db`, never `fuel.db`
  itself** — every day in the live database already has its lines committed, so
  a scratch copy was seeded with a demo day and a second API instance run
  against it. Preview makes no network calls (Slice 2d), so nothing reached
  Intuit and nothing was posted.

  Computed styles read back off the live element: ledger still painted on
  `--paper` `rgb(252, 251, 248)`, border still `--rule-strong`
  `rgb(205, 199, 184)`, the **2px** `--ink` document rule under the header
  intact, debit still ochre `rgb(164, 96, 28)`, credit still teal
  `rgb(22, 112, 107)`. The entry reported itself **balanced** at 0.11 / 0.11. A
  line unfolded downward into **90 payments**, each naming its authorisation,
  including the loud blue badges for the three that needed a human. On a 390px
  screen the ledger kept all **three** columns rather than reflowing — the
  debit/credit form is the argument, so it scrolls instead of stacking.
  Screenshots: `docs/ui/shots/walkthrough-*.png`.

  - `npx tsc --noEmit` clean; `dashboard/ npm run typecheck` clean.
  - `npm run verify-rollup` (155) and `npm run verify-quickbooks` (142) both
    still clean — this slice touches no backend code, and the runs prove it.

  **Known gaps carried forward, not fixed in this slice:**

  - No global sandbox badge until `GET /api/environment` exists (5B-3).
  - The accounting workbench is still one 593-line component holding all state,
    all fetching and all markup. Extracting the ledger primitives is 5C-3
    (renumbered — 5C-1 became Integrations and Developer, done below).
  - `busy` is still a single page-wide flag on the accounting page, so every
    button disables and relabels together. Per-action pending state is 5C-3.
  - Notices are still not live regions, so a screen reader does not announce a
    posting result.
  - `qa-dashboard` runs against the dev server, so the Next dev-tools overlay is
    in the tab order and is explicitly skipped. Running it against a production
    build would be better.
  - Five of the seven destinations have no page.

### Slice 5B-1 — the real Overview and Agents — done

  **Built entirely from routes that already existed.** No API was added, no
  backend file changed. What this slice adds is a field list: which parts of
  `GET /api/company`, `/api/teams`, `/api/agents`, `/api/agents/:id` and
  `/api/approvals` are allowed to leave the server.

  **`/agents`** — every agent with its team, spend against its ceiling drawn to
  scale, remaining, balance and frozen state. The cap editor carries over
  unchanged in behaviour; only its trigger changed, from the bare word "edit"
  styled as a link to a real button whose accessible name carries the agent it
  belongs to. Five controls all announcing "edit" was the accessibility problem;
  a text-coloured word that does something was the affordance problem.

  **`/agents/[id]`** — a financial authority record. Identity, team, authority,
  spend, balance, registration, and the payment history joined against approvals
  so each payment names what authorised it. A payment with no approval is not
  unauthorised: it fitted inside every cap, which is a decision too, just not one
  that needed a person. That distinction is drawn explicitly rather than left as
  a blank cell.

  **`/` Overview** — four figures and a list of things that need a person, each
  linking to the agent it concerns. Every line is computed from recorded spend.
  Real output on the current database: two agents over authority, one with none
  left, and one team past its ceiling.

  **Over-authority is shown, not clamped.** An approved payment can push spend
  past a cap — `src/db/approvals.ts` says outright that "spent <= cap is not an
  invariant" — so the bar clamps its width but the words do not: an agent at
  800% says 800%. Every overage traces to a named approval, which is why it is
  worth showing.

  **Frozen and "no authority left" are deliberately not one status.** Freezing
  is a decision someone made and `frozen_at` records it; running out is
  arithmetic on two other numbers. One pill for both would suggest a frozen
  agent has budget left, or that an exhausted one has been acted on.

  **What was left out on purpose:**

  - **Freeze and unfreeze.** The Fuel API has both routes; the dashboard has a
    route handler only for the cap PATCH. Adding one is a new mutation surface
    and gets its own slice. The page reports frozen state and does not offer to
    change it.
  - **Why a payment was refused.** That reason exists only as free prose in
    `payments.detail`, written in base units ("5000 base units is above the
    threshold of 3000"). Parsing it into fields would be guessing at a shape the
    database does not promise, so the page shows the outcome and says why the
    reason is absent.
  - **The anomaly baseline, threshold and sample size**, for the same reason.
  - **Pagination.** `GET /api/agents/:id` returns an agent's whole history — 220
    rows for the busiest one. The page renders the 25 most recent and says so
    rather than truncating quietly.

  **Demo data is labelled where it can be.** `detail = 'demo-seed'` is tested by
  exact equality on the whole field, and reduced to a boolean at the network
  boundary so the raw string never reaches the browser.

  **Verified — `npm run qa-dashboard`, 204 checks, 0 failures**, four routes at
  desktop 1440, tablet 834 and mobile 390: axe-core WCAG A+AA with no serious or
  critical violations, per-control keyboard focus, no crypto terminology in
  rendered text, no custody identifier in the page **or in any response the page
  received**, and no horizontal page scroll.

  - `npx tsc --noEmit`, `dashboard/ npm run typecheck`, `npm run build` all
    clean. `npm run verify-rollup` (155) and `npm run verify-quickbooks` (142)
    still clean — this slice touches no backend code, and the runs prove it.
  - Security-reviewer: no issues. It checked every field of every upstream
    response against what each picker takes, and found no path by which an
    unlisted key reaches a browser.

  **Three things the checks caught that reading would not have:**

  - `txHash` is **64** hex characters. The leak check written in 5A-1 matched
    `0x[0-9a-fA-F]{40}` — an address exactly — and would have watched the agent
    detail page ship 220 settlement identifiers and reported all clear. Widened
    to `{40,}` before the page that returns them was written.
  - **The check only read the settled DOM.** A payload the browser fetched and
    held without rendering — a prefetch, a framework cache — reached the browser
    just as surely. It now scans every textual response body the page receives,
    which is what turned the next finding from a mystery into a fact.
  - **The Next dev server echoes the raw upstream API response into the page.**
    Custody address and settlement identifiers, on the agent detail route,
    regardless of what the page renders or what the boundary picked. Every
    server response is clean in both modes — plain and RSC, dev and production —
    and a production build is clean end to end; it appears only when a real
    browser loads a dev page. First guess was Next's dev fetch cache; disabling
    it changed nothing, and that config was removed rather than left in place
    with a comment claiming a fix it did not provide.

    So `qa-dashboard` now **refuses to run against a dev server** and says how to
    start a production build. Measuring dev would mean reporting failures that
    are not in the product and learning to ignore them. This also closes the
    5A-1 gap about the dev overlay sitting in the tab order.

  **And one the checks nearly let through.** The agent detail route was resolved
  from the roster once per viewport, and on a cold-started server the desktop
  pass found no link yet and *skipped the page* — reporting a clean run that had
  not opened the route at all. 187 checks instead of 204, which is the only
  reason it was noticed. Resolution now happens once, waits for the selector,
  and a run that cannot cover the route says so. A check that can silently not
  happen is worse than no check.

  **Known gaps carried forward, not fixed in this slice:**

  - No Activity Ledger, Approvals, Integrations or Developer page.
  - No global Sandbox badge, still waiting on `GET /api/environment`.
  - `dashboard/lib/presentation.ts` restates the status vocabulary that
    `src/lib/export-presentation.ts` owns, because the dashboard cannot import
    across the two TypeScript projects. Two copies of a vocabulary drift.
  - Agent names in the live database are test artefacts (`trap-bot`,
    `vault1-signing-test`). They are real records and are shown as they are;
    nothing pretends they are customer data.
  - The roster scrolls sideways inside its own region on a narrow screen rather
    than reflowing into cards.

### Slice 5B-2 — safe activity-data contracts — done

  A backend/security slice with no UI. Two read-only operator endpoints, three
  additive columns, and hardening of two existing read surfaces.

  **`GET /api/payments`** — the Activity Ledger's data source. Keyset
  pagination on `(created_at, id)`, both immutable. Allowlisted filters only;
  an unknown query key is a 400, never an ignore. Every response field is built
  by hand, never spread from a row.

  **Why not `COALESCE(settled_at, created_at)` as the sort key**, which is what
  the CSV dates rows by: that expression *mutates*. A pending payment settles
  and its ledger date jumps, so a row can move after a cursor has passed it and
  never be seen. `ledgerDate` is returned for display and never ordered on.

  **`GET /api/environment`** — a verdict, never the evidence. Pure reduction of
  four pinned constants through an exhaustive known-value lookup; no network
  call, no provider call, no database read. An unrecognised value yields
  `unknown`, never a default of `sandbox` — defaulting to sandbox is the one
  answer that could tell someone their money is safe when it is not.

  **One vocabulary.** `src/lib/payment-presentation.ts` now owns payment status
  wording for every surface. The dashboard's hand-copied duplicate is deleted
  and it renders what the server sends. The six CSV strings are pinned by a
  regression test so a change made for a screen cannot alter a customer's books.

  **The CSV was leaking URL query strings**, and that is fixed. The Description
  column emitted `${pathname}${search}` into a file that leaves Fuel
  permanently — a paid endpoint with `?api_key=` would have written a credential
  into a customer's accounting records. It now reads "Agent API payment". The
  path went too: `/v1/scrape` is harmless and `/services/T000/B000/xoxb-…` is a
  secret in path form, and nothing separates them without a heuristic that will
  eventually be wrong in the expensive direction.

  **The demo marker was a deletion hazard, not just a labelling one.** The seed
  script deleted `WHERE detail = 'demo-seed'`, and its comment claimed a real
  payment could never match. That was wrong: `describeRejection` in
  `src/payments/pay.ts` writes a THIRD-PARTY MERCHANT's error string verbatim
  into `payments.detail`, so a merchant answering `{"error":"demo-seed"}` could
  have had a real payment deleted by a demo re-seed. The predicate is now
  `is_demo = 1`, a column no production write path can set, and the script
  refuses to run without it rather than falling back.

  That same fact killed the planned migration backfill. `scripts/mark-demo-rows.ts`
  prints every candidate id and changes nothing without `--confirm`, so the one
  remaining free-text read happens in the open with a person watching.

  **`walletAddress` stopped leaving the API.** 5A-1 took it off the dashboard
  and 5B-1 stopped transmitting it to the browser, but `present(agent)` kept
  emitting it and `GET /agents` was reachable with the shared AGENT credential
  — so every agent could read every other agent's custody address. Nothing
  consumed the field. That is where ADR 0005 actually finishes.

  **`GET /api/agents/:id` was `ANY`** and returned `txHash`, the full
  `resourceUrl` with its query string, raw `detail`, and every payment an agent
  had ever made. Now operator-only, an explicit field list, bounded at 25 with
  the total alongside.

  **Refusals are coded, history is not invented.** Seven closed codes, set only
  by `recordBlocked`. Rows recorded earlier keep NULL and report "reason
  unavailable" — their `detail` looks parseable and deliberately is not parsed.

  **Verified — `npm run verify-api`, 894 checks**, the first HTTP-level harness
  in this codebase: it builds the real Express app from the exported `api`
  Router on an ephemeral port against a scratch database copy. Auth, tenancy,
  validation, pagination stability and the response allowlist are all properties
  OF THE ROUTE and cannot be observed from below it.

  - **Tenancy**: a second company is seeded into the scratch database and a full
    walk returns exactly this company's rows and none of its. Filtering by a
    foreign agent or team is a 400, not an empty page.
  - **Pagination**: full walks at `limit=7` in both directions return every row
    once, in exact reverse of each other, with a total order verified pairwise.
    A row inserted at the head mid-walk disturbs no page already returned.
    Malformed, wrong-shape, wrong-order, wrong-filter and SQL-shaped cursors are
    all 400.
  - **The response contract is a CLOSED key set**, not a denylist. A denylist
    only catches what someone thought to grep for; this fails on any column a
    later migration adds that a presenter starts spreading.
  - **A crafted payment** whose URL carries `SUPERSECRETPATH` and
    `SUPERSECRETQUERY` emits neither.
  - **The adversarial demo case**: a real payment whose `detail` says
    `demo-seed` survives a re-seed, reports `isDemo: false`, and is not matched
    by the demo filter.
  - `npx tsc --noEmit`, `dashboard/ npm run typecheck`, `npm run build`,
    `verify-rollup` (155), `verify-quickbooks` (142), `qa-dashboard` (204) all
    clean. `foreign_key_check` 0, `integrity_check` ok, 267 payments and 20
    approvals preserved, 3 posted / 0 pending.

  **Security review found one real inconsistency**, since fixed: the dashboard's
  `toApproval` still derived demo status from `detail === "demo-seed"` — the
  exact pattern this slice removed everywhere else. Approvals now carry
  `is_demo` end to end, and a check asserts no file infers it from text. The
  check itself needed a second pass: its first version scanned raw source and
  fired on the comment explaining the removal, which is the "check that cries
  wolf" failure this codebase keeps having to avoid.

  **The fourth backtick-inside-a-SQL-template-literal bug** happened during this
  slice, in the new DDL comments. Fourth occurrence. The rule is simply never to
  use one there.

  **Known gaps carried forward, not fixed in this slice:**

  - **The company predicate is not tenant isolation** (ADR 0009). One company,
    one shared operator credential with no tenant claim. Sufficient for the
    current internal/sandbox phase; **insufficient for an external beta**, which
    needs a company-bound credential first.
  - ~~**`GET /api/approvals` is still `ANY`** and unscoped, and returns
    `resourceUrl` and raw `detail`.~~ Closed in 5B-3.
  - ~~**`listPaymentsForExport` has no company predicate.**~~ Closed in 5B-3.
  - The CSV route still validates dates with a shape regex, so `2026-13-01` is
    accepted there. The new route uses a real calendar check.
  - The dashboard cannot show which exact resource an agent paid for. Recovering
    that safely needs an operator-configured per-vendor mapping, not a parsed
    URL.
  - Demo rows in the live database are still unmarked: `mark-demo-rows.ts` was
    run in inspect mode only (110 payments, 3 approvals are candidates) and the
    `--confirm` run is the operator's call.

### Slice 5B-3 — approvals and export, hardened — done

  A narrow security follow-up. No UI, no schema change, no new capability —
  it closes the two gaps 5B-2 named in its own "known gaps" list and nothing
  else.

  **`GET /api/approvals` is OPERATOR-only and company-scoped.** The comment that
  used to defend `ANY` said an agent "has to be able to see whether its own
  paused payment was approved before it retries". The need is real; the list was
  never how it was met. The agent credential is SHARED by every agent, so "its
  own" was not a question that route could answer — it returned every approval
  for every agent in the company to a key that lives wherever an agent runs. And
  an agent never needed the list: the `202` that holds its payment hands back
  `approvalRequestId` directly.

  So `GET /api/approvals/:id` stays open to both roles and keeps the capability,
  while the bulk read does not. The residual limitation is written down rather
  than papered over: one shared credential means Fuel cannot tell whether the
  caller owns the approval it asks about. Per-agent credentials are the fix, and
  the allowlist is what bounds the damage until then (ADR 0009).

  **The approval response is a closed allowlist**, built field by field, and
  applies to all four routes including approve and deny. `resourceUrl` and raw
  `detail` are gone; the vendor **host** and display-safe labels replace them.
  Dropping `detail` has a real cost, named in 0009: the anomaly baseline,
  threshold and sample size exist only inside that prose, in base units, so an
  operator deciding an anomaly approval can no longer see the numbers behind it.
  Structured columns are the fix; a prose string that half looks like data is
  not.

  **`listPaymentsForExport` takes a required `companyId`.** Required and first,
  so no caller reaches it without deciding whose books it is writing. This was
  the worst placement of that bug in the codebase: an export is the one surface
  whose output LEAVES Fuel permanently and lands in a third party's accounting
  system, so a foreign row is not a read someone discards — it is a line in a
  customer's books, reconciled and filed.

  **Approval decisions are untouched.** The `pending`-guarded UPDATEs, the 409
  on a second decision, the reaper's expiry races — all unchanged, and now
  exercised end to end by the HTTP suite rather than trusted.

  **Verified — `npm run verify-api`, 1844 checks** (894 before). Each new class
  of check was proven to FAIL against a deliberately broken build first:
  reverting the list to `ANY` fails the role check, re-adding `resourceUrl` and
  `detail` fails the closed-key-set check, and removing the export predicate
  fails the isolation check.

  - Another company's approval never appears in the list, is 404 by id to both
    roles, and **cannot be approved or denied** — the attempt leaves it pending.
  - A crafted approval whose URL carries a credential in its path AND its query
    emits neither, to either role.
  - The export contains exactly this company's payments — the predicate neither
    widens nor drops rows — and no row carries a URL, a `?` or an `=`.
  - `verify-rollup` (155), `verify-quickbooks` (142), `qa-dashboard` (204), both
    typechecks and the production build all clean.

  **Demo candidates inspected, nothing written.** `mark-demo-rows.ts` was run in
  inspect mode only; `--confirm` has still never touched this database. The full
  categorised evidence is in `/docs/demo-data-inspection.md`. The short version:
  110 payments and 3 approvals are candidates, all from 2026-08-24, and the
  decisive corroboration is that every candidate's `tx_hash` is two concatenated
  UUIDv4s (the seed's construction, identifiable by the version and variant
  nibbles) while none of the 48 real settled payments' hashes are. 20 of the 110
  are NOT provable from the script's predicate alone — they were seeded
  `unreconciled` and bulk-settled later, which is exactly the shape a real
  merchant-rejected-then-settled payment would have. They rest on the
  corroboration, which is the argument for why this is a watched script and not
  a migration.

  **Known gaps carried forward:**

  - Tenancy is still a seam, not isolation (ADR 0009). Unchanged by this slice
    and still the prerequisite for an external beta.
  - `GET /api/approvals` is **unpaginated**. Fine while approvals are created
    only by cap refusals (20 rows against 267 payments); `listPaymentsPage` is
    the model to copy when it stops being fine.
  - An anomaly approval's baseline, threshold and sample size are no longer
    reachable by any surface. Needs structured columns on `approval_requests`.
  - The CSV route still validates dates with a shape regex, so `2026-13-01` is
    accepted there. `isCalendarDay` already exists in the same file; deliberately
    not changed in a slice scoped to access control.
  - ~~**`GET /api/agents` is the next target.**~~ Closed in 5B-4, along with
    `/teams`, `/teams/:id`, `/company` and every unscoped agent/team lookup.
  - Demo rows remain unmarked pending the operator's `--confirm` decision. Until
    then a re-seed of 2026-08-24 will duplicate the day rather than replace it.

### Slice 5B-4 — agents and teams, hardened — done

  The other half of 5B-3, and the larger half. `GET /api/agents` was `ANY`, and
  `listAgents()` beneath it was a bare `SELECT * FROM agents` with **no company
  predicate at all** — not a seam, nothing. Since one agent key is issued to
  every agent, that handed any agent's integration every other agent's cap,
  spend, frozen state and reason, and a live custody balance. `GET /teams/:id`
  was the same shape and returned the team's whole roster with it.

  Now: `/agents`, `/company`, `/teams` and `/teams/:id` are all OPERATOR, and
  every agent and team lookup in the routing layer goes through
  `getAgentInCompany` / `getTeamInCompany` / `listAgentsInCompany`.
  `listTeams(companyId)` is required rather than optional — an optional scope
  parameter is a trap, because omitting it reads every company and the unscoped
  call is the shorter one to write. `listAgents()` is **deleted** rather than
  deprecated: a function whose only correct use is "never" should not be
  callable.

  `getAgent()` and `getTeam()` survive as documented internal re-reads (a row
  fetched back by primary key after writing it, where scoping would check a fact
  the write already established). verify-api asserts `src/api.ts` never calls
  either.

  **The money path is scoped too.** `POST /agents/:id/pay` resolves through
  `getAgentInCompany`. The direction is what makes that safe: it can only ever
  refuse a payment that would previously have been attempted, never permit one,
  and with a single company every agent resolves exactly as before.

  **Two orderings that had to be preserved, and are now pinned by tests:**

  - `POST /agents` proves the team is in this company **before**
    `provisionAgentWallet` runs. A 400 that leaves an orphaned Fireblocks vault
    behind is not a refusal. The test asserts both the 400 and the source order.
  - Every cross-company write returns 404 **and changes nothing**. A 404 that
    still wrote would be worse than a 200, so each test reads the database back:
    the foreign agent's cap does not move, its freeze state is untouched, no
    payment is reserved, and no agent row is created.

  **Verified — `npm run verify-api`, 1974 checks** (1844 before). Proven to fail
  against broken builds first: reverting `/agents` to `ANY`, removing the
  roster's company predicate, and swapping one route back to the unscoped
  `getAgent()` each fail their own check. `verify-rollup` 155,
  `verify-quickbooks` 142, `qa-dashboard` 204, both typechecks, production build.

  **A check that cried wolf, fixed properly.** The first version scanned agent
  responses for the word "vault" and failed — because two agents in this
  database are named `vault1-signing-test` and `vault4-empty-test`. An agent
  name is operator-chosen text, so matching a substring of one says nothing
  about whether a custody field leaked. The terminology scan now runs with name
  values stripped, and the leak scan looks for the real custody address values
  and quoted key names instead.

  **Which surfaced a real data problem, not a code one:** those two agent names
  are custody vocabulary on a customer-facing surface, and the dashboard renders
  them. Left alone deliberately — renaming rows is a data change, and it is the
  operator's call.

### Slice 5B-5 — the Activity Ledger UI — done

  The first page built on the 5B-2 contract, and the fourth route in the shell.
  Every payment across every agent, filterable by agent, team, outcome, date
  range and demonstration status, cursor-paginated.

  **No client JavaScript at all** — 440 B of route payload. The filters are a
  plain `<form method="get">` and Next is a link, so the whole page IS a URL. A
  filtered view can be bookmarked, sent to someone else, or reopened next week
  and still mean the same thing, which is what an operator wants from a ledger.
  Nothing on this page needs state a query string cannot hold.

  **The filter menu's words come from the server.** `statusFilters()` in
  `src/lib/payment-presentation.ts` emits the selectable options, and it
  deduplicates BY LABEL — `pending` and `signing` are two database states that
  read as one thing ("In progress"), so listing them separately would offer an
  operator a distinction Fuel deliberately does not make in words. That collapse
  is a vocabulary decision, so it belongs with the vocabulary rather than being
  reinvented in a form. `GET /api/payments` carries it in a new `filters` key;
  a test asserts every value it offers is one the route accepts.

  **Two design decisions the first draft got wrong, both the same mistake:**

  - The ledger date ("books to 2026-08-25", when a payment settles on a later
    day than it was recorded) started as a full-width band under the row. Twenty
    of fifty rows have one, so the table read as stripes and the band stopped
    meaning "this row needs explaining". It is now a quiet second line inside
    the date cell, which is where it belongs — it qualifies the date.
  - Filtering to Refused printed the same sentence fifty times, because every
    historical refusal predates the codes. A caveat true of every visible row is
    a property of the SET, not of each row. It is now stated once above the
    table: "Every refusal shown here was recorded before Fuel stored a
    structured reason. The outcome is on the record; the reason is not, and Fuel
    will not guess at one."

  The explanation line under a row is now rare and therefore worth reading: a
  coded refusal reason, a human approval and what it did *not* waive, or what an
  in-progress or unconfirmed status actually means.

  **Honest about what it cannot show.** Demonstration rows are labelled from
  `payments.is_demo`, and the page says in a footnote that rows seeded before
  that marker existed are not labelled yet and that marking them is an operator
  decision nobody has made. A bad filter renders the API's refusal beside the
  form rather than throwing the route to the error boundary — a mistyped date is
  the operator's typo, not Fuel falling over.

  Forward-only paging, said plainly. The API issues a cursor for the row after
  the last one on a page and none for the row before the first, so there is no
  Back to offer; a disabled Back button would imply the ledger could go that way.
  There is a Next and a "Back to the start".

  **Verified — `qa-dashboard` 306 checks** (204 before) across three viewports,
  including two Activity routes: the plain ledger and a filtered view, because
  the filtered render takes different branches (the caveat, the Clear control,
  the empty-result path). axe-core, contrast, keyboard focus and the
  response-body leak scans all clean. `verify-api` 1981, `verify-rollup` 155,
  `verify-quickbooks` 142, both typechecks, production build.

  **One thing this page changed about the API.** `GET /api/payments` used to
  answer a bad filter with `unknown agentId: <whatever you sent>`. That message
  only ever reached someone reading JSON — until this page started rendering it
  beside the filter form, at which point the API was reflecting arbitrary caller
  text into a page shown to a person. Never an injection (React escapes it, and
  the API sends `application/json`), but a habit worth not having. A value is
  now quoted back only when it is a well-formed id, which is where all the
  diagnostic value was anyway: "which of my ids was wrong". Probes carrying
  `<script>`, an SQL fragment and an `onerror` attribute are pinned by tests,
  and asserted to produce a refusal containing no `<` at all.

  **Known gaps carried forward:**

  - The shell still has no environment badge; `GET /api/environment` exists and
    is unused. Next slice.
  - Vendor is a filter the API does not offer — the blueprint listed it, the
    endpoint has no such parameter, and inventing a client-side one would filter
    a page rather than the ledger. Left out rather than faked.
  - Two agents in this database are named `vault1-signing-test` and
    `vault4-empty-test`, and the ledger renders those names. That is custody
    vocabulary on a customer-facing surface. It is data, not code, so renaming
    is the operator's call.

### Slice 5B-6 — truthful environment, honest demo labelling, Approvals — done

  Three data-honesty jobs and a page, all read-only. No payment, budget, freeze,
  approval-decision, custody or posting logic was touched, and `fuel.db` was not
  written to.

  **The environment badge says what the server says, or says nothing.** A
  persistent badge in the nav, driven only by `GET /api/environment`. Four
  states, and the silence is the important one: Sandbox (quiet), Production
  (filled, red — the only state where a mistake on that screen costs real
  money), Environment/Unknown (warning), and **nothing at all** when Fuel could
  not be asked.

  "Unknown" and "unreachable" are deliberately not merged. Unknown is a verdict
  the server reached — a pinned constant it does not recognise. Silence means
  Fuel never got to look. Borrowing the word "unknown" for a network blip would
  make the two indistinguishable, and any fallback resolving to "Sandbox" would
  tell someone their money was safe on precisely the evidence that Fuel has
  none. `getEnvironment()` returns null on any failure and the badge renders
  nothing.

  It is an async Server Component passed into the client nav as a slot, wrapped
  in Suspense with a same-height placeholder — so a hanging Fuel API delays a
  badge and not the whole document, and the badge resolving never pushes a nav
  link out from under a cursor already moving towards it.

  **Demo labelling is structural only, and now silent by default.** One
  `DemoTag` component, rendered only from `isDemo`, replaces three different
  hand-written labels ("demo", "Demo", "Demo data") on three surfaces that had
  already started to drift. A record without the marker gets no label — not
  "real", not "unverified".

  The Activity Ledger's demo paragraph used to be unconditional, which meant a
  page of entirely real payments still carried a claim about demonstration data
  that nothing on it had earned. It now appears only when a row on screen
  carries the marker. QA enforces both halves: every visible "Demo data" must be
  the shared pill, and a page with no marked record must not mention
  demonstration data at all.

  **`/approvals` is a real page.** Read-only, no client JavaScript, 387 B. It
  answers what needs a decision, which agent and team asked, for how much, which
  ceiling refused it, the decision and its expiry, and whether the record is
  demonstration data. Status/scope labels and tones all come off the row.

  The empty state is the one that mattered most: **there are zero pending
  approvals in this database**, so the default view is empty, and an empty
  approvals queue is the healthy condition rather than a page that failed. It
  says so, and explains what would put something there.

  **The one gap, reported rather than papered over.** `GET /api/approvals`
  returns an array, so there is nowhere to carry a filter vocabulary the way
  `GET /api/payments` gained a `filters` key in 5B-5 — and the API can only
  supply a status's words by returning a row that HAS that status. With zero
  pending rows there is no server label for the default view. Rather than invent
  a contract or restate the vocabulary, the page authors exactly one string —
  "Needs a decision" — which names a VIEW, not a record. Every label describing
  a record still comes from the server. The other views take their names from
  the rows they contain, with counts.

  **Verified — `qa-dashboard` 533 checks** (306 before), three viewports, seven
  routes including both Approvals views. Three new check families, each proven
  to fail against a deliberately broken build first: a badge hardcoding
  "Sandbox", a badge guessing sandbox when Fuel is unreachable, and an
  unconditional demo claim on a page with no marked rows. QA now reads
  `dashboard/.env.local` so it can compare what the badge SAYS against what the
  server ANSWERS — a badge reading "Sandbox" is not evidence of anything if the
  dashboard could have written that word itself. `verify-api` 1991,
  `verify-rollup` 155, `verify-quickbooks` 142, both typechecks, production
  build, `integrity_check` ok, `foreign_key_check` 0.

  **Two decisions left with the operator, both documented rather than made:**

  - `docs/demo-data-inspection.md` now carries an appendix with all 113 exact
    candidate ids (110 payments, 3 approvals). `--confirm` has still never been
    run. **Consequence, stated plainly: until it is, the ledger shows 110 seeded
    payments as indistinguishable from real ones.** That is what the database
    says, and inventing a UI caveat about it would be the inference this slice
    exists to remove.
  - `docs/agent-name-remediation.md` proposes renaming `vault1-signing-test` →
    `signing-test-agent` and `vault4-empty-test` → `empty-balance-test-agent`,
    with the trace showing both are REAL test records (8 and 2 real payments, 0
    demo, 0 approvals, 0 postings) and the guarded SQL to apply it. Not run.

  **Known gaps carried forward:**

  - `dashboard/app/accounting/page.tsx` renders `Sandbox · {status.realmId}` —
    a QuickBooks realm id, a provider identifier, on a customer-facing surface.
    Predates this slice, same class of problem, decided separately.
  - Approve and deny still are not available from the dashboard. The page says
    so rather than rendering controls that would not act.
  - The approvals queue has no agent, team, scope or demo filter: `GET
    /api/approvals` accepts `status` and nothing else. Adding query keys is a
    backend change and was out of scope here.

### Slice 5C-1 — Integrations and Developer pages — done

  The last two nav destinations that were rendering "soon" now have real
  pages. Both read-only, both honest in the sense that matters: nothing on
  either page is asserted because it would be a reasonable guess — every value
  has a named source, and an unreachable source is reported as unreachable
  rather than folded into a worse-sounding wrong answer.

  **`/integrations`** answers what Fuel can currently prove about its own
  connections. The QuickBooks section reads a NEW narrow allowlist,
  `getAccountingIntegration()` in `dashboard/lib/fuel.ts`, picked field by
  field from the same `GET /api/integrations/quickbooks/status` response
  `/accounting` already uses — but `/accounting`'s `callQuickBooks()`
  passthrough hands the whole object to `AccountingWorkbench`, realm id and
  OAuth expiry timestamps included, because that page needs it to drive setup.
  `/integrations` is a different surface — the first thing anyone asks "how is
  Fuel connected" on — and it gets its own picked type that cannot inherit a
  wider passthrough's fields by accident: no `realmId`, no `accessExpiresAt` /
  `refreshExpiresAt`, no QuickBooks account ids. `connected`, `connectedAt`,
  `readyToPost`, the already-sanitized `missing` string list, and the currency
  verification fact are all that cross this boundary. Confirmed against the
  live database: the real sandbox realm id never appears anywhere in the
  page's delivered response.

  A connection failure is reported as **unknown**, not **disconnected** — a
  distinct and less certain fact. Folding the two together would tell an
  operator their books are unmanaged when the truth is Fuel simply has no
  current answer.

  The environment fact shown twice on the page (once beside QuickBooks, once
  beside payment execution) is the same `getEnvironment()` read the shell
  badge already uses — not a second badge with its own styling, not a literal.
  Verified two ways: a source scan asserts the page never writes
  `"Sandbox"`/`"Production"`/`"Unknown"` itself, and a live check compares the
  page's rendered value against a direct `GET /api/environment` call, the same
  way `checkEnvironmentBadge` already proves the shell badge.

  **`/developer`** is the integration contract that exists today, fact-checked
  against `src/api.ts` and `src/payments/pay.ts` line by line rather than
  paraphrased from memory — including the real check order (agent cap → team
  cap → company cap → rate limit → anomaly, confirmed from the comments in
  `reserveIfUnderCap`) and the real HTTP status per outcome (200 / 202 / 402 /
  423 / 429 / 502). The outcomes table uses no vocabulary of its own — every
  status pill is a word `src/lib/payment-presentation.ts` already owns, so this
  page cannot drift from what the Activity Ledger actually prints.

  One accuracy nuance worth keeping: a 423 (frozen) response usually creates NO
  payment record at all — `pay.ts`'s early frozen check returns before any
  reservation exists, and only the rarer race (frozen mid-attempt, inside
  `reserveIfUnderCap`'s own transaction) writes a blocked row. The table says
  so rather than claiming every refusal is uniformly logged.

  The required limitation notice is verbatim: *"Fuel currently uses
  environment-managed integration credentials in this internal sandbox.
  Per-agent credentials, rotation, revocation, user login, and tenant isolation
  are not built yet."* Both request examples use placeholder values
  (`<your FUEL_API_KEY>`, `https://vendor.example/resource-to-pay-for`) — the
  page is a static Server Component with zero data fetching, so there is no
  path by which a real secret could be interpolated into either example.

  **A real bug, found in a screenshot and fixed properly rather than around.**
  The outcomes table's prose cells first tried `.prose { white-space: normal }`
  to stop a full sentence forcing the whole table wider than the page. It never
  took effect: `.data-table td { white-space: nowrap }` is a class+element
  selector (specificity 0,0,1,1), and a bare `.prose` class (0,0,1,0) cannot
  outrank it regardless of source order, so the table kept using nowrap and
  adjacent cells' text visibly overlapped on screen. The fix matches the
  codebase's own existing convention for the identical problem —
  `.data-table td.numeric` — scoped to `:global(table.data-table) td.prose` so
  it wins deterministically. Caught by looking at the actual screenshot rather
  than trusting that a class name being present meant the rule was applying.

  Two `<pre>` code blocks and the outcomes table's `.scroll-x` wrapper needed
  `tabIndex={0}` + `role="region"` + `aria-label` — axe's
  `scrollable-region-focusable`, a real WCAG gap: a horizontally-scrolling
  region a mouse can pan but a keyboard could not reach.

  **"custody" was missing from `qa-dashboard.ts`'s banned-vocabulary list**
  entirely until this slice — every other no-crypto term was checked, that one
  was not. Added, and confirmed clean against every existing rendered page
  before relying on it going forward.

  **Verified — `qa-dashboard` 695 checks** (533 before), across nine routes ×
  three viewports. Two new checks: `checkIntegrationsSource()` (a static scan
  proving the page and `getAccountingIntegration()` never reference the
  excluded QuickBooks fields, never call the raw passthrough, and never write
  a hardcoded environment name) and `checkIntegrationsEnvironmentClaim()` (the
  live comparison described above). `verify-api` 1991, `verify-rollup` 155,
  `verify-quickbooks` 142, both typechecks, production build,
  `foreign_key_check` 0, `integrity_check` ok — this slice touches no backend
  code and no database write, and the runs confirm it.

  **Security review found no issues.** It independently confirmed
  `getAccountingIntegration()` builds a new object field by field rather than
  spreading the raw response, that `/integrations` never imports the raw
  passthrough, that `/developer`'s credential placeholders are literal text
  with no `process.env` interpolation, and that neither page has a Client
  Component boundary for a hidden field to ride across.

  **Known gaps carried forward:**

  - `/accounting` still hands `AccountingWorkbench` the raw, unfiltered
    QuickBooks status object (realm id and OAuth expiry included) via
    `callQuickBooks()`. Flagged as out of scope in 5B-6's report; unchanged
    here too — fixing it means touching the accounting posting surface, which
    this slice was scoped never to do. **Closed by 5C-2 below.**
  - Ledger primitives extraction and per-action pending state on
    `AccountingWorkbench` (renumbered from 5C-1 to 5C-2 by this slice, then to
    5C-3 when 5C-2 became the security remediation below).
  - `/integrations` has no equivalent of a "last checked" timestamp for the
    payment-execution environment fact — it is read fresh on every request
    (`force-dynamic`), so there is nothing to date, but a future slice adding
    a real per-surface health signal would need one.

### Slice 5C-2 — the safe accounting-status boundary — done

  A security-remediation slice, closing the gap 5B-6 and 5C-1 both reported
  and neither was scoped to fix.

  **The problem.** `GET /api/integrations/quickbooks/status` returns the API's
  own view of the connection: the customer's `realmId`, `accessExpiresAt`,
  `refreshExpiresAt`, and a `config` block holding three QuickBooks account
  ids. `/accounting` passed that object into `AccountingWorkbench` as a prop
  and printed the realm id in the page header and the setup line. Worse and
  less visible: the browser proxy at `/api/quickbooks` relayed the same object
  back to the browser verbatim, and the workbench refetches it after connect,
  account setup, post and disconnect.

  **The fix.** One pure contract module, `dashboard/lib/accounting-status.ts`,
  seven keys wide — `connected`, `connectedAt`, `readyToPost`, `missing`,
  `currency`, `currencyVerified`, `currencyCheckedAt`. It picks each key by
  hand and builds a new object; there is no spread, so a field added to
  `presentQboStatus` tomorrow arrives and stops. It is applied at **both**
  doors: the server render and the proxy route. Narrowing only the props would
  have left every refetch leaking, which is the door an operator actually uses.
  See ADR 0010.

  Two things fell out of the same change. `AccountingWorkbench` had declared
  its own copy of the status shape — which is what made `realmId` available to
  render — and now imports the one contract instead. And the page header
  hardcoded the string `"Sandbox"`, which 5B-6 had banned everywhere else; it
  now reads the server's own label and claims nothing when Fuel is unreachable.

  **Proven, not assumed.** `toAccountingStatus` is fed a poisoned object
  carrying the realm id, both OAuth expiries, three account ids, an access
  token, a refresh token, a client id, a redirect URI, a provider URL, a nested
  raw provider payload and a field named for a quarter that has not happened —
  and the output is asserted to have exactly the seven keys. The reverse is
  asserted too, so the leak test cannot be passed by returning `{}`.

  The QA suite's new provider-leak scan **failed against the pre-fix build**
  before it passed against the fixed one, naming the live realm id, both OAuth
  expiry timestamps, all six forbidden key names and one real account id value
  across both `/accounting` and its `/status` refetch. It hunts for the live
  values read from the API at start-up, not for key names — an identifier is a
  bare number in JSON and would sail past a name scan.

  **Behaviour preserved,** demonstrated by `npm run walk-accounting`: preview,
  the already-committed guard, provenance load, ledger-line unfold into all 90
  underlying payments with their authorisations, and the Post control present
  and enabled by a ready draft. Post is deliberately never pressed — it would
  leave a real document in someone's books — and no QuickBooks document was
  created during verification. The walkthrough runs against a copy of
  `fuel.db`, because preview writes a draft row.

  `verify-api` 1991 → 2074 · `qa-dashboard` 695 → 752 · `verify-rollup` 155 ·
  `verify-quickbooks` 142 · both typechecks · production build ·
  `integrity_check ok` · `foreign_key_check` 0 · `fuel.db` byte-identical.

  **Known gaps carried forward:**

  - The posting trace still carries `accountId` to the browser, by design — it
    is the grouping key, and matching on the account name was tried and was
    silently broken. The QA scan exempts that one path by name.
  - ~~The OAuth callback still redirects to `/accounting?connected=<realmId>`.~~
    **Closed by 5C-2a below.**
  - Ledger primitives extraction and per-action pending state on
    `AccountingWorkbench` — still open, now **5C-3** and the remaining 5C work.

### Slice 5C-2b — three findings from a second security review — done

  A re-review of 5C-2's final committed diff (the first review ran against an
  earlier version of it) found three things, all real, all fixed here.

  **The presenter was not idempotent, and had to be.** Applied at two doors,
  `toAccountingStatus` runs on its own output as a matter of course: the
  browser's refetch narrows a body the proxy already narrowed. It read the
  currency claim only under `accountingCurrency`, the upstream spelling, so a
  second pass found nothing there and reset a verified USD company to "not
  verified yet" — after every post, account setup and disconnect. Reproduced
  before fixing. It degraded in the safe direction, which is exactly why it
  would never have been noticed.

  **A failed refetch kept a stale status.** `refresh()` only overwrote the
  status when narrowing succeeded, so a Disconnect whose follow-up read did not
  come back left "Connected. Expense, suspense and contra accounts are set." on
  screen. That guard existed because `null` used to render as "not connected";
  the three-state model added later made it obsolete, and it now sets `null`,
  which renders as "Connection unknown" and disables Preview.

  **The post-OAuth banner trusted a query string.** `?connected=1` is where the
  operator came from, not evidence a connection exists — anyone can type it, and
  the banner would announce a connection while the badge two lines above it said
  otherwise. It is now confirmed against the real status.

  `verify-api` 2107 → 2118, `qa-dashboard` 752 → 767. The QA addition compares
  every delivered value against the API's own answer, not just the key set: a
  closed-key check alone is passed by a contract returning the right key names
  holding nothing, which is precisely the bug that shipped. Four break tests
  confirm the checks fire, including restoring the original double-narrowing.

### Slice 5C-2c — the other three doors — done

  A third security review of the committed 5C-2 work found the remediation had
  closed one of four doors.

  `presentQboStatus` is spread into **four** replies, not one:
  `GET /status`, `POST /setup-accounts`, `POST /verify-currency` and
  `PATCH /config`. The proxy narrowed `/status` only, and the comment above
  that branch called it "the boundary that actually matters" — which was wrong
  in the way that matters most, because "Set up accounts" is a button an
  operator presses. Its reply handed the browser the realm id, both OAuth
  expiry timestamps and three chart-of-accounts ids, every time. Proven live
  against the sandbox: upstream returns 17 keys, the browser now receives 10.

  **The fix is structural, not another `if`.** The narrowing is a required
  field on each proxy allowlist entry, so a new endpoint cannot be added
  without stating what happens to its body, and `"none"` must be typed rather
  than fallen into. The routes that add their own fields get their own
  contract — `quickBooksCompany`, `created[]`, `reused[]`, all of them names
  (`accounts.ts` pushes `spec.name`, never `spec.id`), never ids.

  The regression test reads the list of status-bearing routes **out of
  `src/api.ts`** rather than hardcoding it, so a fifth route that spreads
  `presentQboStatus` tomorrow fails the suite instead of silently leaking.

  `verify-api` 2118 → 2201, `qa-dashboard` 767 → 781. Five break tests confirm
  the checks fire, including restoring the original defect on each of the three
  routes. No document created (all three accounts already existed —
  `created: []`), `fuel.db` byte-identical.

### Slice 5C-2a — the realm id leaves the redirect URL — done

  The one gap 5C-2 documented and did not close, because it sat in OAuth code
  that slice was scoped out of.

  `/integrations/quickbooks/callback` redirected to
  `/accounting?connected=<realmId>`, putting the customer's QuickBooks company
  identifier in the address bar and the browser's history on every successful
  connect. It now redirects to `?connected=1`. The realm id is still stored —
  Fuel needs it to address the company's API — server-side, where it belongs.
  The page only ever read the parameter's presence; its value was never used.

  **The interesting part is not the one-line change.** The handler lived inline
  in `src/server.ts`, which calls `listen()` at import time, so importing it to
  test it started a server on a real port. That meant **the one route in Fuel
  with no authentication was the one route no verification suite could drive.**
  It moved to `src/quickbooks/callback.ts` and `src/server.ts` now mounts it —
  identical behaviour, but reachable by a test.

  33 new checks (`verify-api` 2074 → 2107), covering ground that was never
  covered rather than only the change: the redirect target and its absence of
  anything identifier-shaped; single-use state; a state Fuel never issued; each
  missing parameter on its own; a declined consent screen; that state is
  redeemed **before** a token exchange is spent; that the grant's access and
  refresh expiries are recorded; that the realm id is still stored; and that no
  QuickBooks document or draft is created — asserted by count *and* by checking
  the callback reached only the token endpoint. Intuit is stubbed throughout;
  no network call leaves the machine.

  Five break tests confirm the checks fire: restoring the realm id to the
  redirect, interpolating it directly, reordering state redemption after the
  exchange, dropping the stored realm id, and introducing an open redirect from
  `req.query` each fail on the assertion that names them.

## Phase 6 — One P&L

**Scoped, not started.** Read
`/docs/decisions/0011-the-earning-side.md`,
`/docs/decisions/0012-revenue-in-the-ledger.md` and
`/docs/phase-6-blueprint.md` before touching any of this. They were written
before implementation on purpose — the same reason 0007 was written before
the QuickBooks integration existed — so a slice does not open by re-deriving
decisions already made.

**The phase in one line:** an agent stops being only a cost. It can be paid,
and both directions land in the customer's books with the same attribution.

**The five decisions already settled**, so nobody relitigates them mid-slice:
Fuel hosts the paywall as a gateway in front of an origin the customer
already serves; the **agent** owns the earning endpoint, not the team or
company; **money received never raises what an agent may spend**; inbound
payments live in a new `receipts` table rather than a `direction` column on
`payments`; and Fuel takes no fee this phase.

**The thing that makes this phase harder than it looks** is not the debit
direction — `clearable`, `planAbsorption`, `assertBalanced` and
`buildReversal` were all written sign-agnostic and need no changes at all.
It is that **every postable base unit currently has to trace to a row in
`payments`**, enforced by `export_postings.payment_id NOT NULL` and by the
conservation check in `src/db/postings.ts`. Revenue has nowhere to live until
that changes, and changing it means rebuilding two tables that reference each
other under `PRAGMA foreign_keys = ON`.

There is also one trap that produces no error at all: `ledgerAccount` in
`src/lib/export-presentation.ts` types its map as an inline
`Record<"expense" | "suspense", string>` rather than as `LedgerClass`, so
widening the class union compiles clean and writes the word "Unknown" into an
accounting CSV. 0012 fixes it as part of the same change.

### Slice 6A-1 — the ledger migration, with no revenue in the system — done

  **No change to any posted amount or direction — and one string corrected.**
  `verify-rollup` (155) and `verify-api` (2201) pass at exactly the numbers they
  did before. `verify-quickbooks` went 142 → 162 because twenty checks were
  *added* for revenue; every pre-existing one still passes unchanged.

  The claim was checked rather than asserted: across all 25 combinations of
  expense and suspense totals, old and new logic produce identical posting
  directions and identical amounts. **Ten of those 25 produce a different
  contra DESCRIPTION**, and that is a fix rather than a regression, found by
  the security review because the comparison above comparing directions and
  amounts could not have caught it. The old code hardcoded "Funded from Fuel
  balance" on a line whose direction it computed dynamically — so on any day
  where suspense releases outweighed expenses, the contra was a Debit (money
  arriving into the balance) labelled as money leaving it. That was already
  wrong before this slice and simply never reachable often enough to notice. It
  now reads "Received into Fuel balance" when the net is a debit. None of the
  arithmetic changed.

  **What shipped:** `posting_lines` rebuilt (`ledger_class` gains `revenue`,
  `vendor_host` becomes `counterparty`); `export_postings` made polymorphic;
  class-aware `directionFor`; the signed-debit contra line; conservation and
  over-absorption both split per direction; a fourth (income) required account
  and `revenue_account_id` on `qbo_config`; the `ledgerAccount` type fix.

  **`receipts` was created here, not in 6A-2 as 0011 first said.**
  `export_postings.receipt_id` references it, and adding a foreign key to an
  existing SQLite column means a rebuild — so deferring the table would have
  cost a *second* rebuild of the absorption table. Creating it empty one slice
  early costs nothing. Its status vocabulary is settled in `src/db/receipts.ts`
  and recorded in 0011.

  **The nullable-primary-key trap, confirmed rather than assumed.** The obvious
  migration keeps `PRIMARY KEY (payment_id, line_id)` and lets `payment_id` go
  null. SQLite permits NULLs in a primary key on a non-INTEGER column in a
  non-STRICT table, so every receipt row would have had a NULL payment_id and
  the duplicate-absorption guarantee — the only reason that key exists — would
  have evaporated with **no error at all**. Two partial unique indexes carry it
  instead. `scripts/verify-migration.ts` inserts a duplicate receipt absorption
  and asserts it is refused, which is the check that would have failed silently.

  **A second silent-drop, caught by the design review before it shipped.** The
  over-absorption check in `verifyPostingIntegrity` inner-joined `payments` on
  `ep.payment_id`. Once that column is nullable, every receipt row fails the
  join and vanishes from the result — the check would have gone on reporting
  clean while checking nothing on revenue. Split per source, so each branch
  joins a column that is NOT NULL within its own branch.

  **Two things deliberately NOT done here**, because they only bite once
  revenue lines actually exist, and both belong with 6B-1: document numbers do
  not yet include direction (`daily:<day>` would name both a spend and a
  revenue posting for the same day), and `eligibleLines` has no direction
  filter (it would sweep revenue lines into a spend draft). The `vendor_day`
  rollup grain also keeps its name; renaming it to `counterparty_day` means
  rebuilding `qbo_config` for a CHECK constraint, which is cosmetic cost with
  no correctness benefit in this slice.

  **New:** `npm run verify-migration` — builds a database in the pre-6A-1
  shape and migrates it, because verify-rollup and verify-quickbooks build
  theirs fresh and so never take the migration path at all. A migration only
  ever run on machines that have already run it is a migration nobody tested.

### Slice 6A-2 — the gateway, headless — done

  **Fuel's first route reachable from the public internet with no credential.**
  Authenticated by payment, not by a shared secret. `GET /earn/:publicId`,
  mounted after `/api` and therefore outside `authenticate`, which is
  positional.

  **What shipped:** `earning_endpoints` and a rebuilt `receipts`; the gateway
  (route, forwarder, HMAC signing, probes, limiter) in `src/gateway/`; a
  per-call loopback policy on `safeFetch`; operator registration routes; a
  fourth reaper pass; `npm run verify-earning` (68 checks).

  **The library's middleware is deliberately NOT used, and that was a finding,
  not a preference.** `@x402/core` wraps every lifecycle hook in a try/catch
  that only `console.warn`s (`server/index.mjs:970-980`). A receipt write
  throwing inside `onAfterSettle` would be swallowed — settlement succeeds, the
  payer gets their response, money moves, and the row stays `awaiting` with
  nothing raised. Fuel drives `verifyPayment`/`settlePayment` directly instead,
  so every transition sits in control flow where a throw propagates. See 0011.

  **Ordering: verify → claim → fetch origin → settle → deliver.** The payer
  receives nothing until settlement confirms, and an origin failure means Fuel
  never settles at all — so money taken for something never delivered, which
  x402 has no refund path for, cannot arise. The accepted mirror exposure is an
  origin doing work for a payment that later fails to settle.

  **The replay defence is a UNIQUE constraint, and it had to be.** The x402
  resource-server path has no nonce store, no idempotency and no dedup: verify
  is not binding, so N concurrent requests replaying one signed payload all pass
  it. The receipt is claimed before the origin is touched, which makes the
  synchronous insert the serialization point. `UNIQUE (payer_address,
  authorization_nonce)` is **global, not per endpoint** — an EIP-3009 nonce is
  one-time-use per `from` regardless of payee, so a per-endpoint constraint
  would let one authorization be replayed once against every endpoint.
  Verified with eight concurrent claims; exactly one wins.

  **Nothing may be awaited between verify and that insert.** The serialization
  depends on `DatabaseSync` being synchronous. An async pre-check added in that
  gap would reopen amplification silently, with every existing test still green.
  Written down in `claimReceipt` because it is the kind of invariant that erodes.

  **The three requirements, re-verified against code rather than the design doc:**

  - *The origin must be able to refuse non-Fuel traffic.* Fuel cannot enforce
    anything on someone else's server — it supplies an HMAC over method, path,
    timestamp and a per-request nonce, then **measures** whether the origin
    honours it. **Two probes, not one:** one with no signature headers, one with
    the correct header NAMES and an invalid signature. Without the second, an
    origin that checks the header is merely present would pass — and the header
    names are not secret, so any caller could then walk through with garbage.
    A failed probe refuses to enable, and a failed re-check *disables* an
    already-enabled endpoint.
  - *Settlement ordering.* Above.
  - *SSRF, and the relay problem, as two separate fixes.* `safeFetch` gains a
    **required** `allowLoopback` parameter with no default — `pay.ts` passes
    `true` (it is the caller the exemption existed for), the gateway and both
    probes pass `false`. The old exemption's own comment named its expiry
    condition; a public gateway is that condition arriving. Fixing it addresses
    SSRF and **not** the relay problem, because a correct guard still permits
    every public address: that is what ownership proof is for, and neither fix
    is credited for the other.

  **Rate limiting** (not in the design docs; added because this endpoint is
  public). Four layers, cheapest first, all before any DB read: per source
  address, per endpoint, per-endpoint concurrency, and a **global** concurrency
  cap. The last one exists because the gateway shares a process and a single
  synchronous SQLite connection with `/api` — a flood here would otherwise
  degrade cap checks, approvals and agent payments, the spend controls every
  earlier phase exists to provide. In-memory deliberately: a DB-backed limiter
  is itself a write-amplification DoS against the connection that serialises
  cap checks. Bounded with TTL eviction, because an unbounded map keyed on
  source address is the exhaustion vector it was added to prevent.

  **Slow or oversized origins.** `ORIGIN_TIMEOUT_MS` and a 1 MiB response cap,
  with `GATEWAY_MAX_TIMEOUT_SECONDS` **derived** from them, so Fuel cannot
  advertise a validity window it could not itself meet. The cap counts bytes off
  the stream rather than trusting `content-length`, which the origin controls.
  Compression is declined at the request and refused in the response: counting
  compressed bytes would make the cap advisory against a compression bomb, and
  stripping the header while relaying compressed bytes would hand the payer
  undecodable data.

  **Both boundaries are allowlists.** Nothing of the caller's crosses to the
  origin — relaying caller headers would let an anonymous party set `Host`,
  `Authorization` or `Cookie` on a request the origin reads as Fuel's. Coming
  back, only `content-type`, `etag`, `cache-control` and `last-modified`
  survive. The decisive reason it is an allowlist: `@x402/express` reads a
  `Settlement-Overrides` **response** header to decide what to actually charge,
  so a denylist that missed one name would let an origin price its own payment.
  No caller-supplied path segment is ever appended, and the query string is
  rebuilt through `URLSearchParams` rather than relayed.

  **Known limits, stated rather than papered over.** The bypass probe proves the
  origin refuses *Fuel* unsigned; it cannot prove the origin refuses *anyone
  else* unsigned, and an origin can cloak by special-casing Fuel's address.
  Ownership proof by nonce echo is satisfiable by anyone who can publish a file
  at an arbitrary path on a shared host, and it proves control rather than
  benign use — it makes relay abuse attributable to an operator credential, not
  impossible. On testnet the "each attempt costs a signed authorization"
  argument is weak, since USDC is faucet-free, so the rate limiter is the real
  backstop until mainnet — a named re-review trigger.

  **A security review of the diff found five things, all fixed before commit.**
  Two were real holes rather than hardening:

  - **The forward secret was never given to the operator.** Fuel generated it,
    encrypted it, and dropped the plaintext — and a comment in
    `earning-endpoints.ts` confidently justified that ("an operator has no
    reason to read it back"). The comment was wrong: Fuel *signs*, but the
    ORIGIN has to *verify*, and verifying needs the same secret. The
    anti-bypass mechanism 0011 calls non-negotiable was unimplementable by any
    customer. It is now returned exactly once at registration, in the create
    response only, the way an API key is.
  - **Origin failures leaked the customer's hostname and IP to anonymous
    payers.** Only the timeout and over-size cases were sanitized; everything
    else interpolated the raw error — `getaddrinfo ENOTFOUND <host>`,
    `ECONNREFUSED <ip>:<port>` — into a 502 body reachable by anyone holding
    one valid signature. The public id is opaque precisely so a payer never
    learns the origin, and this handed it back on any DNS blip. `reason` is now
    generic and `detail` carries the real message to the receipt and the log.

  The other three: `OWNERSHIP_RECHECK_MS` was **dead code** — nothing called
  `endpointsNeedingRecheck`, so the drift window it names was unbounded in
  practice; there is now a fifth reaper pass. A 401/403 from the origin was
  billed to the payer, which is the wrong party bearing a customer's
  misconfiguration — those no longer settle, while a 404 still does, because a
  404 can be a legitimate paid answer. And `req.query` was cast to
  `Record<string,string>`, which is a lie at runtime for repeated keys.

  **Not covered by `verify-earning` (73 checks), and not pretended otherwise:**
  a real signed authorization, verify, and on-chain settle end to end. That
  needs a funded sandbox wallet and the live facilitator, and is a walkthrough
  to run separately — the same split `verify-quickbooks` makes.

### Slice 6B-1 — receipts reach the books — done, verified against a live sandbox
- [x] Revenue rollup, revenue lines, direction through QuickBooks, and both
      contract surfaces. Six commits, each green on its own: the endpoint
      label, the `qboConfigTable()` extraction, the earn-side rollup, the two
      table rebuilds, direction through QuickBooks, and the contracts.
- [x] **The live walkthrough.** `scripts/live-origin-server.ts` (a real,
      publicly-reachable customer origin — the first thing in this project
      ever exposed to the public internet, torn down the moment posting
      succeeded) and `scripts/walk-revenue.ts` (`register` / `run` / `resume`)
      drove a real payer through the real gateway, a real settlement on Base
      Sepolia, and a real post to the Intuit sandbox company Phase 4 already
      uses. Two documents exist there, posted by Fuel:

  | QBO Id | DocNumber | TxnDate | Lines |
  |---|---|---|---|
  | 148 | `FUEL-6355a0e5315d` | 2026-09-13 | Cr 0.05 Agent API Revenue · Dr 0.05 Fuel Account ("Received into Fuel balance") |
  | 149 | `FUEL-354699b3c527` | 2026-09-13 | Dr 0.05 Agent API Revenue · Cr 0.05 Fuel Account — reverses 148, corrects_posting_id set, 148 left untouched |

  The payment underneath: agent `research-bot`, one registered earning
  endpoint, one receipt (`amount_base_units 50000`, settled, a real 64-hex
  transaction hash on Base Sepolia). Both documents were confirmed by eye in
  the Intuit sandbox UI, not just by the script's own exit code — the script
  proves its assertions held; only looking proves a correct document exists in
  someone's books.

  **Three bugs, all real, none catchable offline — the same shape as Phase 4's
  "bugs only live credentials could have found," and for the identical reason:
  nothing before this had ever sent a real request down this path.**
  1. The gateway's `resourceServer` never called `.initialize()`, so it had
     never fetched the facilitator's supported kinds — every request threw
     "Make sure to call initialize()". `/paid-hello`'s tests never caught this
     because that route goes through `@x402/express`'s middleware, which
     initializes itself; the gateway drives x402's primitives directly instead
     (deliberately — see `src/gateway/route.ts`'s own header) and
     initializing was the one thing left out. Fixed by copying the
     middleware's own eager-start, awaited-and-retried-on-failure pattern.
  2. The gateway priced with `{ asset: "", amount: ... }`. The library's
     `AssetAmount` branch requires a real contract address and throws
     otherwise. Fixed by resolving it via `@x402/evm`'s own
     `getDefaultAsset(ALLOWED_NETWORK)` rather than a fourth hardcoded copy of
     the address — it agrees with the three already independently hardcoded in
     `payments/pay.ts` and `check-payer-balance.ts` by construction, not by
     discipline.
  3. Same call was still missing the EIP-712 domain (`extra.name`/`version`):
     the `Money`/dollar-string price path fills these in for you, the
     `AssetAmount` path does not, and the first real client to sign against
     the gateway's quote threw "EIP-712 domain parameters... are required."
     Fixed by reading `name`/`version` off the same `getDefaultAsset` call
     already used for the address, so all three fields come from one lookup.

  **A fourth thing broke, and it was not a bug.** Account setup returned a
  generic 500. The real error, surfaced by reproducing the call directly
  rather than trusting the wrapped message: `"Incorrect or invalid refresh
  token"` from Intuit's own token endpoint. The request construction was
  correct; the stored refresh token was bound to different QuickBooks client
  credentials than the ones currently in `.env` (confirmed by comparing
  against a backup file timestamped to the original connection, without
  printing either secret). Fixed by reconnecting — a fresh OAuth grant under
  the current credentials — not by changing any code. Recorded here because it
  is exactly the class of thing Slice 2b's own notes on refresh-token rotation
  warned about, now actually observed.

  **This is also why `walk-revenue.ts` has a `resume` command.** The first
  live run got through a real settled payment and stopped on the dead token
  above, one step later. Re-running `run` would have signed and spent a
  second real payment to retry a step that never touched the payer.
  `payAndSettle()` (irreversible) and `postToQuickBooks()` (idempotent — the
  rollup only processes what is not yet rolled up, and QuickBooks' own
  409-on-repost is asserted, not assumed) are now separate; `resume
  <endpointId>` re-reads the receipt already on record and continues from the
  rollup, paying nothing. The existence of document 149 above is itself the
  proof that the idempotency checks passed: `postToQuickBooks` asserts a
  repost is refused 409 and a re-preview is refused 409 with "already
  committed" (not "no lines exist") *before* it ever requests a reversal, so
  reaching 149 at all means those held.

  **`computeBuckets`'s note is discharged.** `readLedgerReceipts` and an earn
  pass now exist, and the earn conservation equation has non-zero on both sides
  for the first time.

  **ADR 0012 is amended, and the correction is the most useful thing this slice
  produced.** 0012 says twice that conservation is "the one thing that would
  catch a revenue line absorbing a payment." It is not, and structurally cannot
  be: both readers filter absorptions by the *line's* class matching their own
  direction, so a payment absorbed under a revenue line matches neither and
  changes no term in either equation. "Line parts sum to total" catches it.
  Conservation catches ARITHMETIC error — a dropped bucket, a bad rounding
  direction — and row surgery cannot break it, because the residual is derived
  and a bad row moves `posted` and `carried` equally in opposite directions.
  Found by writing the break test 0012 asked for and watching it not fire.
  `verify-rollup` now asserts conservation does *not* fire on that case, so the
  correction cannot rot back.

  **Four silent drops fixed, none of which ever threw.** `drillDown` returned an
  empty constituent list for a revenue line while reporting its amount;
  `COUNT(ep.payment_id)` made every revenue line's source count 0, so a posted
  JournalEntry would have read "Agent API revenue — 0 payment(s)";
  `fingerprintFor` covered *none* of a revenue line's sources, which 0012 never
  named; and `presentStatus` would have written the literal word "Unknown" into
  an accounting export for a receipt status — 0012's own `ledgerAccount` trap
  sitting in the sibling function.

  **Two migration hazards worth remembering.** A rebuild applies CHECK
  constraints that `ALTER TABLE ADD COLUMN` could never attach, retroactively,
  against data written when nothing was checking — `migrateQboConfigGrain`
  pre-flights and names the offending rows rather than aborting with SQLite's
  message. And a table's declared shape and its migrated shape hold the same
  columns in *different orders*, because ALTER appends, so a rebuild must name
  every column and never `SELECT *`.

  **Contract changes, for a release note.** Both CSV headers changed (`Vendor` →
  `Counterparty`, `Payments` → `Sources`, both gain `Direction`); the trace
  route renamed `vendor`/`payments`/`paymentId`; `rollupGrain` is now
  `counterparty_day`; and `POST /api/integrations/quickbooks/preview` **requires
  a `direction`** with no default. Nothing on the dashboard consumed the grain
  or the preview scope, checked rather than assumed.

  **The diff review found two things, both real, both shipped-and-fixed.** The
  label BACKFILL never called `assertUsableLabel`, whose own comment called
  itself "the single gate every label passes, whoever is setting it" — it could
  not have called it without an import cycle. An origin path carrying an MD5, a
  git SHA or a hyphen-less UUID would have written a hash-shaped string into a
  QuickBooks document. The rule now lives in `src/lib/endpoint-label.ts`, which
  imports nothing, so the claim is true by construction rather than by
  discipline. And requiring `direction` on `/preview` broke the dashboard's
  Preview button outright: the component still sent `{ day }`. The comment
  saying "checked, not assumed" had checked the two RENAMED fields and said
  nothing about the ADDED one. `verify-api` now greps the request body the
  component actually sends, not only the response shape it declares.

  **Named debt, not fixed here.** `listPostingLines` and `drillDown` carry no
  company predicate — `posting_lines` has `agent_id` but no `company_id` —
  while `listPaymentsForExport`, `listReceiptsForCompany` and
  `listEndpointsForCompany` all scope through `agents -> teams -> company_id`.
  Pre-existing, equal across spend and revenue, and not exploitable while the
  product is single-tenant (`getDefaultCompany()` throughout). This slice
  rewrote that code without fixing it. Same treatment 0009 gives "the company
  predicate is a query seam and not tenant isolation": when multi-company is
  real, this is one of the first things that has to change.

### Decision — ADR 0013, where the earned balance sits — done
- [x] [0013](./decisions/0013-where-the-earned-balance-sits.md) closes 0011's
      "where the earned balance actually sits" open item. **The operator-set
      cap is the sole authority on what an agent may spend**; earnings landing
      in the agent's own spending vault is accepted and chosen, not inherited.
      Zero code change — the gateway already pays to `agent.address`.

  **The consequence is a gate on the beta, not a note.** A cap that was only
  ever safe because the wallet behind it was empty is now a live
  authorization. Every agent's cap is reviewed as a deliberate figure, at all
  three levels, before that company is allowed to earn — this decision is what
  converts the cap table from theoretical to binding.

### Slice 6B-2 — the operator's triage loop — done
- [x] `GET /api/receipts`, a receipt reconciler, and a payment reconciler.
      API only; the dashboard's action buttons belong to Phase 7.
      51/197/191/123/2276 checks pass.

  **Receipts are reconciled against the chain; payments cannot be.** That
  asymmetry is the design, not an inconsistency. A receipt stores
  `payer_address` and `authorization_nonce` because they are its replay key, so
  `authorizationState(authorizer, nonce)` answers "did this money arrive"
  exactly — which is what 0011 meant by "reconcilable later against the chain",
  finally built. A payment row stores neither, so the same question is not
  answerable from what is kept; the alternatives are heuristics that
  mis-attribute the moment an agent makes two identical payments, so that path
  is an operator attestation and says so in its own response.

  **The security review found the hole in that attestation, and it was real.**
  Releasing an unreconciled payment's budget on a human's word, with no check,
  against an authorization that may still be spendable: the agent spends again,
  the original may still settle, and nothing ever revisits a `failed` row —
  `markSettled`'s guard no longer matches it and there is no outbound
  settlement poller. Silent, permanent overspend. So `payments` now carries
  `authorization_valid_before`, read from the payload actually signed (the same
  instinct as re-reading `authorization.value` rather than trusting the amount
  requested), and a release is refused outright while that window is open. Rows
  signed before this report "expiry not recorded" rather than claiming a check
  that never ran — refusing them instead would recreate the permanent dead end
  this slice exists to remove.

  **`resolveReceipt`'s `awaiting` guard was not widened, and that was the
  tempting wrong fix.** It is what makes the claim→resolve race safe, and
  widening it would have reopened that race with every existing test still
  green, because the race needs concurrency to show. The reconcile path is a
  separate function over a disjoint status set, and `verify-earning` asserts
  the separation in both directions.

  **The allowlist was checked by breaking it.** `presentReceipt` withholds the
  payer address, the authorization nonce, the tx hash and `detail`;
  `verify-api` asserts that against the *delivered bytes*, and the assertion
  was confirmed to fail by deliberately leaking the payer address. ADR 0005
  needed two attempts for exactly this reason. That same no-crypto check then
  caught the word "facilitator" in one of this slice's own error messages.

  **Three dead ends, verified in source, all of which a beta would hit.**
  Receipts are invisible: `src/api.ts` never imports `db/receipts`, and
  `listReceiptsForCompany` has zero callers — the only receipt visibility
  anywhere is the posting drill-down, which filters to `('settled')` and so by
  construction shows only the ones that are fine. Worse, two states are
  **terminal**: there are exactly three write statements against `receipts` in
  all of `src/`, and `resolveReceipt` is guarded `WHERE status = 'awaiting'`,
  so nothing in this repo can move a receipt out of `served_unsettled` or
  `settle_unknown` — while `reapStaleAwaitingReceipts` manufactures
  `settle_unknown` every 60 seconds. `RECEIPT_PRESENTATION` already writes
  operator labels ("Served, not paid") for states that can never reach an
  operator's screen. And separately, `unreconciled` payments sit in
  `COUNTS_AGAINST_CAP` forever: `markSettled` permits the transition but its
  only callers are the live pay path and two scratch-DB verify scripts, so an
  agent's budget can be permanently eaten with no way to free it.

  **The model already exists in this codebase** — QuickBooks' `pending`
  postings get `pendingPostings()` → reconcile → reverse. Copy that shape:
  ask the authority, record what it says, never guess. `resolveReceipt`'s
  `awaiting` guard is load-bearing (it makes the claim→resolve race safe), so
  the reconciler is a *separate* function, never a loosened guard.

### Slice 6B-3 — the interface — done
- [x] The Earning page, a merged two-direction Activity Ledger, P&L figures on
      Overview and Agents, a fifth environment surface, and a direction choice
      in the accounting workbench. 51/132/191/197/3320 checks pass.

  **Renumbered from 6B-2** when the triage loop was inserted ahead of it.
  Nothing had shipped under the old number, so no delivered slice moved.

  **Last, deliberately** — every screen in it shows something already true by
  then.

  **The Activity Ledger merges both directions over one cursor.** A direction
  column only means something if receipts actually appear in the same list, so
  `listPaymentsPage` became `listLedgerPage` in a new `src/db/ledger.ts`. It
  does NOT live in `payments.ts`: that file's whole argument is that a receipt
  must not be reachable from a cap query, and a UNION built inside it would put
  both tables one import from the cap sums.

  The UNION carries only the sort key — a direction tag, an id and a timestamp
  — and that page of keys drives two ordinary per-table reads. `computeBuckets`
  in `db/postings.ts` had already rejected a wide UNION for the accounting path
  ("columns that mean different things per row"), and a compound SELECT matches
  its arms by POSITION, so a wide one is one misplaced column from mapping
  `settled_at` onto `detail` in silence.

  **A correction worth keeping.** Three comments written during this slice
  claimed the two status vocabularies were disjoint. They are not:
  `PaymentStatus` and `ReceiptStatus` share `settled`, and it means the same
  event on both sides. The split was already right — it is by membership, so
  `settled` lands in both halves — but the false reasoning changed the filter
  menu. Two menus would have offered "Paid" and "Received" as two options
  issuing one identical query, so the menu is now merged into one option per
  question a person would actually ask ("Paid or received", "Not completed" =
  `failed,abandoned`, and so on).

  **Three filters do not mean one thing in two directions**, and each is
  pinned by a break test:
  - `status` — a word from one vocabulary DROPS the other arm rather than
    leaving it unfiltered, which would have returned every receipt ever
    written in answer to `?status=blocked`.
  - `demo` — `receipts` has no `is_demo` column because nothing writes a demo
    receipt, so `demo=true` drops the earn arm and `demo=false` keeps it whole.
  - `vendor` became `counterparty` across the wire, the backend and the
    dashboard together — the same rename 6B-1 took through the CSV.

  `GET /api/payments` is now `GET /api/activity`. It returns receipts, so the
  old name was false about half its rows. `POST /api/payments/:id/reconcile`
  is unchanged — it really is about a payment.

  **The P&L figures name their basis, and the bases demonstrably differ.** The
  four ledger-basis totals added in `900bd17` had no callers; they are now a
  nested `ledger` block on `GET /api/company` and every agent response. Nested
  rather than flat, because a flat `ledgerSpent` beside the existing `spent`
  would put two differently-defined figures at the same level under names that
  read as synonyms. New coverage proves an in-flight payment raises the cap
  figure and leaves the ledger figure untouched — at the database level and
  again on delivered bytes, at both agent and company scope.

  Overview shows two labelled blocks rather than one row of seven figures. The
  agent page gets its own section and its cap figure is renamed "Spent against
  the cap", so two rows labelled "Spent" never share one definition list. The
  roster gains **Earned and deliberately not Spent or Net**: earned has only
  one basis so the column means one thing anywhere, while Net cannot be shown
  without implying the spent figure behind it.

  **The Earning page is read-only, and says so.** Registering an endpoint sets
  a price and names a host Fuel will send traffic to; enabling one opens a paid
  route to the public internet. Both are money policy, which CLAUDE.md wants
  plan mode for rather than a form arriving with a layout change. The API has
  had both actions since 6A-2.

  It cannot hide the unpaid. `earned` counts confirmed receipts only, so an
  endpoint serving work that never settles reports $0 and looks merely idle —
  the stuck count travels beside every revenue figure, and the unresolved rows
  sit ABOVE the table, not below it, because a healthy-looking total is at its
  most misleading exactly when those rows are piling up.

  **The accounting workbench finally lets an operator choose a direction**,
  which 6B-1 left hardcoded to `spend` with a comment pointing at this slice.
  `presentQboStatus` gained `readyToPostRevenue` and `missingForRevenue`, so a
  company with no income account can be told "expenses are posting normally,
  revenue is waiting on one account" — the true statement 0012's
  degrade-rather-than-stop rule always assumed someone would make, and which
  nothing could actually say until now.

  **One new permanent guard, found the hard way.** Next types a CSS module as
  `any`, so `styles.dirctionIn` compiles, renders as `className={undefined}`
  and ships an unstyled element that looks almost right. `qa-dashboard` now
  checks every `styles.*` a component reads against the stylesheet it imports,
  statically and before the browser starts.

  **Left for Phase 7, deliberately:** the dashboard has no button to reconcile
  a stuck row, register an endpoint, or enable one. Those are actions on money
  policy and they belong with the operator roles Phase 7 introduces.

## Phase 7 — the private beta

### Slice 7A-2 — users, sessions, invite-gated signup — done, proven live

  Stage 1 made the tenant real in the data; Stage 2 made it real on the request.
  Neither could make a PERSON real. This slice does, which is also what makes a
  second real company possible.

  **Commit A — identity exists.** `users` and `sessions` tables; passwords via
  `scrypt` in `src/lib/passwords.ts`; `Principal` gains its `session` arm, so
  `roleOf` and `companyOf` keep their signatures and none of the ~44 route sites
  changed; `POST /api/auth/login` mounted ahead of `authenticate` alongside the
  OAuth callback, with `me` and `logout` on the authenticated router where a
  session already exists.

  The decisions worth remembering:

  - **A session's company comes from the user's own row**, not from the
    bootstrap binding. That is the difference between a tenant that is a
    property of the server and one that is a property of who is asking.
  - **A session is always an operator and never an agent**, written as a
    literal. The agent credential moves money; nothing a browser holds should.
  - **A cookie AND a bearer key together is a 401**, not a precedence rule.
    "Which one wins" is the ambiguity an attacker picks at.
  - **The cookie value is never stored** — `sessions.id` is its SHA-256 — so a
    copied `fuel.db` is not a set of live logins. Same argument
    `src/lib/secrets.ts` makes about database files being copied around.
  - **Every sign-in costs the same**, because an unknown address still burns a
    hash. Skipping it answers in ~1ms against ~67ms, which is a free oracle for
    which addresses have accounts.
  - **Cost parameters were measured here, not copied**: N=32768 gives ~67ms and
    32MB per hash on this machine. Because the work is deliberately expensive,
    the route that triggers it is deliberately expensive to call, so hashing has
    a concurrency ceiling (4) on top of the per-email and per-address limits.
  - **Two independent CSRF layers**: `SameSite=Lax` is the browser's promise,
    and an `Origin`-vs-`Host` check is ours. Bearer keys are exempt — no browser
    attaches one on its own — so shell workflows keep working, and a request
    with no `Origin` at all is allowed for the same reason.

  **What security review changed.** One finding, and it was a good one: the
  cookie's `Secure` attribute was decided from `req.hostname`, which is the
  `Host` header. The code argued it failed safely, and that was only true in one
  direction. The dangerous direction is ordinary and silent — a reverse proxy
  forwarding to the app's loopback address without passing the original host
  makes every production request arrive saying `Host: localhost`, and `Secure`
  would be dropped from every session cookie with nothing looking wrong. It is
  now `FUEL_COOKIE_SECURE`, read once at boot, defaulting to ON, and only the
  exact string `false` turns it off. A source check asserts nothing in the
  cookie's attributes can be reached from a request header.

  **Known residuals, recorded rather than implied away:**

  - **A distributed burst can still hold all four hashing slots** and hand
    legitimate people a 503, because the per-email and per-address limits are
    per process and in memory. That is the stated tradeoff in
    `src/lib/buckets.ts`, not something this slice introduced, and it becomes
    real only with a deployment that has more than one instance or a proxy.
  - **Login itself has no CSRF defence**, and structurally cannot: there is no
    session yet to bind a token to. The attack it permits is "log the victim
    into an attacker's account", which is visible in the UI (the wrong company
    is on screen) and triggers nothing destructive on its own. Worth revisiting
    when signup and invites exist, because an account the attacker controls is
    a more interesting place to land someone.

  **What Commit A does NOT yet do:** nobody can create an account. There is no
  invite, no signup, and no route that mints a user — Commit B adds those. Until
  then the tables exist and the only way to get a row into `users` is a script.

  **Commit B — accounts can only be created deliberately.** The `invites` table,
  `POST /api/auth/signup`, owner-only invite and user routes,
  `scripts/mint-invite.ts`, and `scripts/set-password.ts`.

  - **There is no open signup.** An account exists only by redeeming an invite
    somebody minted. The token is 32 CSPRNG bytes, stored only as a SHA-256,
    bound to one address, single-use, and expiring in a week — shown once when
    minted and never recoverable, which is the price of a stolen database being
    worth nothing.
  - **`invites.company_id IS NULL` means "redeeming this creates a company",**
    and no route can express it. `POST /api/invites` writes the owner's own
    `companyOf(req)` and has no parameter for a company at all, so creating a
    tenant always costs somebody a shell. A CHECK constraint also forces a
    founding invite's first member to be an owner — otherwise a company could
    exist with nobody able to administer it.
  - **The legacy keys are barred from every power that makes an identity.**
    `requireOwner` refuses them outright on all five management routes. A secret
    that names nobody should not decide who else gets an account.
  - **Redemption is one transaction, and the invite is marked used LAST.** A
    signup that fails on a taken email or a weak password rolls back and leaves
    the invite usable — a typo must not cost somebody their only way in. The
    password is hashed BEFORE the transaction opens, because scrypt is async and
    hashing inside the write would hold the lock, and every spend-cap check
    behind it, for ~67ms.
  - **Every refusal reads the same.** Forged token, expired, revoked, wrong
    address — one message. "Expired" would confirm a token was real; "wrong
    address" would confirm who an invite was for.

  **The way back in — `scripts/set-password.ts`.** Stage 3 gives Fuel real
  logins and no password reset, because there is no email provider to send a
  link. Without a recovery path, a forgotten password would mean no way to sign
  in as yourself and no way to compute a valid scrypt hash by hand. The script
  resets an existing account's password, prints it once, and revokes that user's
  live sessions.

  Two deliberate choices in it. It **refuses to create an account** — recovery
  must not be a second door into existence, which is the property invite-gated
  signup exists to have. And it **resets a password rather than minting a
  session**: a minted session token would be a live credential sitting in
  terminal scrollback, and it would bypass the login path entirely, so the
  recovery route would never exercise what production does. Setting a password
  sends you through the ordinary rate-limited login, which means this path is
  tested every time it is used.

  **What break-testing corrected, which is the part worth reading.** Nineteen
  breaks were written for this commit and six did not fire. Chasing each one
  down changed the code, the tests, or an over-claiming comment:

  - **The single-use guards are redundant today.** Removing the `redeemed_at`
    check and the UPDATE's guard — together and separately — left every test
    passing, because an invite is bound to one address and `users.email` is
    globally unique, so a reused token is refused either for naming a different
    address or for naming one that now has an account. Email uniqueness is
    doing the work. The guards stay as the statement of intent, and the code
    now says all of this plainly instead of claiming they catch a race.
  - **The in-process race test cannot fail.** `redeemInvite` contains no
    `await`, so Node runs it to completion before the second request is
    touched: two concurrent HTTP signups are serialised by JavaScript, not by
    SQLite. Removing the transaction left that test green. The race is now also
    staged across two OPERATING-SYSTEM PROCESSES in `verify-migration`, and both
    test comments say which one proves what.
  - **Even the cross-process test does not prove the transaction is needed.**
    The window where a second process could read the invite as unredeemed is
    microseconds wide, and two processes synchronised to the millisecond miss it
    almost every time. `BEGIN IMMEDIATE` stays because two accounts from one
    invite is not an undoable mistake — not because a test caught it. Said in
    the test rather than implied by its presence.
  - **Three real test gaps**, now closed: nothing sent a `companyId` in the body
    to the invite route, so a break that honoured one went unnoticed; the signup
    route normalised the address before the data layer saw it, so the data
    layer's own normalisation was untested; and the account-enumeration test
    compared three refusals that all came from the same `throw`, so it could not
    see a refusal that named its reason.

  **What security review changed:** both scripts now print the resolved database
  path before they write. Neither did, and both write a credential — a reset
  password and a minted invite — where the difference between the live file and
  a scratch copy is one environment variable. Nothing blocking was found;
  review also traced that the owner count cannot reach zero through the API,
  since the only route that reduces it refuses self-disable.

  It grants **no authority that filesystem access does not already confer**:
  anyone who can run it can already write any row with `sqlite3`. What it adds
  is the ability to compute a valid hash. Same argument as
  `scripts/remediate-shared-vault.ts`. Its tests run it as a real child process,
  not by calling its functions, because an imitation of the recovery path is the
  wrong artifact to test.

  **Commit C — the dashboard signs people in, and can decide.** `FUEL_API_KEY`
  is gone from `dashboard/lib/fuel.ts` and from its env example. Every call to
  Fuel now goes through one `fuelFetch`, which attaches the viewer's session
  cookie and nothing else. A `/login` page, a `middleware.ts` routing gate, a
  session badge and sign-out in the shell, and — the control
  `docs/ui/phase-5-blueprint.md` deferred until the roles governing it existed —
  **Approve and Deny on the Approvals page**, behind the same two-step confirm
  the cap editor uses.

  This had to land before Commit D. D refuses a shared key the right to approve
  for a company that has users; without a dashboard that can decide, that
  refusal would leave hand-written HTTP as the only way to release a held
  payment.

  The decisions worth remembering:

  - **Only the one named cookie is forwarded**, rebuilt by name, never
    `headers().get("cookie")` passed through whole. A blanket forward would hand
    Fuel every unrelated cookie the browser holds for that host — and since
    cookies ignore the port, in development that is everything on localhost.
  - **The API's `Set-Cookie` is relayed byte for byte.** The sign-in route is a
    proxy, not a cookie author: `HttpOnly`, `SameSite`, `Secure`, `Path` and
    `Max-Age` are decided once, by the process that knows whether it is behind
    TLS. A dashboard that set the cookie itself would be a second authority on
    those attributes, and a dashboard that forgot `HttpOnly` would look
    identical until a script read the session.
  - **A 401 from Fuel becomes a redirect to sign in, not an error.** It used to
    surface as "Fuel could not be reached", which would now be a lie in the
    commonest case: Fuel was reached, answered at once, and said the session had
    ended. An operator told the service is down goes and checks the service.
  - **The same-origin check was extracted, not copied.** One implementation in
    `dashboard/lib/same-origin.ts` guards all four write routes. Four hand-made
    copies would be three chances for one to drift weaker.
  - **The middleware is not a security boundary and says so.** It checks that a
    cookie with the right NAME exists; anyone can set that in their own browser.
    What they reach is pages whose every byte comes from the API, which
    validates properly and refuses. Validating in middleware was considered and
    rejected: a round trip per navigation, still not a boundary, and it would
    couple the ability to ROUTE to Fuel's availability — an API blip would bounce
    a signed-in operator to a sign-in page that then could not sign them in.

  **What the live two-server run found, that the unit tests could not.** The
  suite was run against a real production build of the dashboard talking to a
  real API over loopback, on a scratch copy of the database. Thirty checks; two
  genuine bugs, both in code whose unit tests were green:

  1. **A relative `Location` from middleware is a 500.** It is legal HTTP, and
     it avoided the host question entirely — but Next's middleware runtime
     parses that header as a URL and threw `ERR_INVALID_URL`, so every
     signed-out request failed. Calling `middleware()` directly and reading the
     header never reaches that parse.
  2. **Next owns the origin of a middleware redirect.** The second attempt built
     an absolute URL from the `Host` header, because `req.url` and
     `req.nextUrl.origin` both report `localhost` for a request actually made to
     127.0.0.1, and cookies are scoped by host. It computed the right URL, set
     it, and Next rewrote it anyway. Measured against the running build:

         Host: example.test:3400  ->  http://example.test:3400/login
         Host: 127.0.0.1:3400     ->  http://localhost:3400/login

     So Next honours the Host header in general and special-cases the loopback
     IP. In production that is correct. In development a browser opened at
     127.0.0.1 is moved to localhost on its first redirect and stays there — a
     different cookie host, but a consistent one, so nothing loops. The
     host-reading code was deleted rather than kept: code that looks like it
     controls something it does not is worse than code that admits otherwise.

  A third finding was a correction to a TEST rather than to the product: an
  assertion that the redirect preserved the host passed in-process while the
  real thing did something else, because the rewrite happens after middleware
  returns. It was removed. A test that is green while production differs is
  worse than no test.

  **Confirmed live, so the plan's assumptions 5–7 are no longer assumptions:**
  Next relays `Set-Cookie` from a route handler to the browser with `HttpOnly`,
  `SameSite=Lax` and `Max-Age` intact; `cookies()` in a Server Component
  forwards it back; and the browser's jar keys the cookie by host with no port,
  so `:3000` and `:3100` share one jar while `localhost` and `127.0.0.1` do not.

  **A deployment note that cost a debugging session.** `FUEL_COOKIE_SECURE` was
  documented in `.env.example` but absent from the working `.env`, so the API
  defaulted `Secure` ON — correct for production, and fatal over loopback http,
  where the browser accepts the sign-in and then never sends the cookie back.
  Sign-in appears to succeed and every page bounces to `/login`. The line is now
  in `.env`.

  **Known and not fixed.** A page reached with a cookie that has expired answers
  **200 with the redirect carried in the RSC payload**, not a 307, because the
  shell has already begun streaming inside its `Suspense` boundaries by the time
  Fuel answers 401. A browser executes it on hydration and lands on `/login`, so
  the outcome is right and the status is not; a non-browser client sees a 200
  with an almost-empty document. Fixing it properly means validating in
  middleware, which is the round trip rejected above.

  **Security review found one real defect, and it was the recurring one.**
  `ViewerBadge` rendered the words "Signed in" in the branch its own docblock
  said was silent — so a browser holding `fuel_session=anything` got the full
  navigation and an assurance it was signed in, until the page body's own fetch
  redirected it. No data was exposed (the API refuses every read), but the
  chrome asserted something false to the two people who most need it not to:
  someone whose session is invalid, and someone the API could not be asked
  about. Fixed to render nothing, with a break test that fires on the exact
  check. Everything else came back clean, including the cookie round trip
  (`encodeURIComponent` on the way out, symmetric with Express's encoding and
  `cookieFrom`'s decode), path construction in `decideApproval`, and the
  relayed `Set-Cookie`.

  **A coverage gap review named, recorded rather than closed.** The dashboard's
  write routes are checked two ways — `refuseCrossOrigin` is imported and
  exercised directly, and each route file is grepped for calling it and
  returning on it — but the suite never invokes the Next route handlers
  themselves, because they import through the `@/` alias that only Next
  resolves. A future refactor could break the wiring while the grep still
  passed. What covers it today is the live two-server run, which POSTs
  cross-origin at `/api/session` and `/api/approvals/:id/decide` and gets 403
  from both. That run is manual, so this is a real gap in the automated suite
  rather than a solved problem.

  **Race tests, added after the fact because the first pass did not have any.**
  Commit C's original fifteen break tests probed CSRF, the routing gate, cookie
  handling and redirects, and raced nothing — an omission worth naming, since
  this stage had already been bitten twice by collisions. Two races now covered:

  - **Two operators, one held payment, the same instant** (verify-migration,
    beside the invite race). Deliberately APPROVE versus DENY rather than two
    approvals, because those two outcomes disagree about whether money moves.
    Cross-process for the reason Commit B established: node:sqlite is
    synchronous and `approveRequest`/`denyRequest` contain no `await`, so two
    calls in one process are serialised by JavaScript and an in-process race
    test could never fail.

    Breaking it is instructive in two stages. Dropping `AND status = 'pending'`
    gives `WON approve approved | WON deny denied` — both operators told their
    decision landed. Keeping the WHERE clause but not checking how many rows
    changed gives `WON approve approved | WON deny approved`: the operator who
    pressed **Deny** receives a success answer that says **approved**. The
    `changes === 0` check is the load-bearing half, not the WHERE clause — the
    same conclusion invite redemption reached, reproduced here on the money
    path.

    The test also asserts a denied row holds no approval expiry, because that is
    the field that would survive from a losing approve UPDATE: a row reading
    "denied" while carrying a live permission that outlasts the refusal.

  - **One operator double-clicking Approve** (verify-api). `send()` marks the
    row in flight before it awaits anything, and the sending state renders no
    button, so there is nothing left to press. The server would answer the
    second press with a 409 and no harm done — but the operator would be shown
    a refusal for a decision that actually succeeded. Stated honestly: this is a
    source assertion about the state machine's shape. It does not execute React
    and so cannot prove React flushes between two clicks in separate tasks.

  **Considered and not tested: sign-out racing an in-flight decision.** If a
  session is revoked between `authenticate` resolving it and the decision being
  written, the decision proceeds. That is correct — the person was signed in
  when they pressed — so there is nothing to guard and a test would only pin
  down behaviour that is already right.

  **Commit D — the audit trail gets a name, and isolation is proven.**
  `approval_requests.decided_by`, written in the same UPDATE as the status;
  `approveRequest`/`denyRequest` collapsed into one `decideRequest`; the shared
  key refused a decision for any company that has accounts; the two-company
  isolation sweep; ADR 0014.

  - **One function and one route handler where there were two of each**, because
    approve and deny now share a precondition. A refusal that exists in two
    places is one that will eventually exist in one — and the copy that would be
    forgotten is `deny`, since approving is what everyone thinks of as the
    dangerous verb. A denial is equally a two-party-control decision.
  - **403 rather than the 423-style code the plan floated.** The credential is
    valid and understood; it simply may not do this, which is what 403 means,
    and every other refusal on that router is already one. What stops it reading
    as "your key is misconfigured" is the message, which names the reason and
    the fix, so the message is where that work was put.
  - **The refusal un-refuses itself.** `activeUserCount` counts accounts that are
    not disabled, so a company whose every account has been disabled falls back
    to the key rather than becoming undecidable. Held payments nobody can
    release is a worse failure than a nameless decision.
  - **The response carries an address, never the user id.** A UUID answers no
    question an operator has and would be a second identifier to correlate
    people by. Resolved by a LEFT JOIN in the query that already runs, so a list
    of twenty approvals is still one statement, and scoped to the caller's own
    company by a predicate that is redundant today and there so that removing it
    is the only way another company's address could surface.

  **The races, which is where this commit earned its tests.**

  - **Two people deciding at the same instant, and whose name ends up on it.**
    Cross-process, two different users. Break it by writing `decided_by` in a
    second UPDATE after the guarded one — the realistic way somebody would add
    the column later — and the result is `status denied, decided_by
    racer-approve`: the row says the payment was refused and names the person
    who tried to approve it. That is worse than a double decision, because a
    double decision is visible and this looks perfectly normal.
  - **The refusal is a check-then-act**, which is the shape this stage has been
    bitten by twice. `decideRequest` takes the write lock up front with
    `BEGIN IMMEDIATE`, and signup uses the same pattern, so a company cannot
    gain its first account between the check and the write.

  **Seven break tests. Five fire on exactly the check written for them; two do
  not, and both are recorded rather than dressed up.** Emptying `/api/company`
  to probe the sweep's positive control trips a Commit A assertion first, and so
  does pointing a session at a company nobody owns. The sweep's LEAK direction
  is independently proven — scoping a session to the bootstrap binding makes it
  fail with the bootstrap company's id found in the other company's response —
  but its positive control is covered by older assertions rather than
  exclusively by the new one.

  **0009's "a seam, not tenant isolation" is closed for the routes swept.**
  Sixteen operator reads, read by a person at a second company, asserted to
  contain not one identifier belonging to the first — plus the reverse direction
  and a control proving the same routes DO return the caller's own rows, without
  which the sweep would pass just as well on empty responses.

  **Security review found two things, and both were mine rather than the
  design's.**

  1. **A test that claimed to prove recovery and proved only its precondition.**
     The "it un-refuses itself" block created a company, disabled its only
     account, and asserted the active count reached zero — while its own comment
     said it proved the shared key could decide again. It never tried to decide.
     The count is not the point; a queue of payments nobody can release is the
     point. It now actually decides, before and after disabling, and asserts
     both outcomes. Breaking it realistically — counting accounts that ever
     existed rather than active ones — now fires on exactly that check.

  2. **The shared key could read the addresses of everyone who had decided.**
     The legacy key resolves to `operator`, so the first version of `decidedBy`
     handed the credential this commit declares untrustworthy to ATTACH a name
     to a decision the ability to ENUMERATE the names on all of them — a new
     category of personal data on that surface, introduced by the commit whose
     whole argument is that a nameless credential should not touch identity.
     Nothing legitimate wanted it: the dashboard carries sessions and no script
     reads the field. It is now withheld, from the agent credential too, and the
     response keeps the same shape for both callers so nothing can be inferred
     from a missing field. Recorded as decision 6 in ADR 0014, including the
     cost: null is overloaded for a key caller, which is acceptable because both
     meanings collapse to "no identity is available to you".

  **Proven against the live database, not a fixture (2026-09-22).** Every test
  in this slice runs on a scratch copy of `fuel.db`, which proves the code and
  not the database. Stage 3 does not close on that evidence alone, because both
  bugs this stage actually shipped were found by running the real thing and
  neither was visible to a green suite.

  `fuel.db` was copied to `fuel.db.backup-pre-stage3-20260922-162202` first
  (sha256 `575125eb…`, compared against the original at the moment of copying),
  and the Stage 3 migration then ran against the real database for the first
  time: three empty tables added,
  `approval_requests.decided_by` added, every existing row count unchanged — 267
  payments, 20 approvals, 5 agents, 5 postings — 0 foreign-key violations, and
  `integrity_check ok` on both the copy and the original.

  An owner invite was minted into the live database with `scripts/mint-invite.ts`,
  redeemed against the running API, and the resulting account signed in through
  a real browser. What the database holds afterwards:

  - One `users` row, owner, in the bootstrap company — which keeps its id, its
    agents, its vaults, its QuickBooks connection and its five posted documents.
    Nothing was migrated and nothing was re-created.
  - The invite consumed exactly once, `redeemed_by` naming that user.
  - `invites.token_hash` equal to the SHA-256 of the minted token, and the token
    itself nowhere in the file.
  - The password as `v1.32768.8.1.…`, 122 characters, no plaintext and no
    fragment of the address.
  - Two sessions — the redemption and the browser sign-in — and the browser
    one's `last_seen_at` six minutes ahead of its `created_at`. That bump is the
    one part of the session design a test cannot really prove: it exists so a
    person clicking around does not hit the 30-minute idle timeout, and it only
    means anything against a person clicking around.

  **Commit D's refusal turned itself on.** `activeUserCount` for the bootstrap
  company went from 0 to 1 at the moment of redemption, so the shared key lost
  the right to approve or deny for that company with no deploy, no flag and no
  second step. That is the sequencing the plan insisted on, observed rather
  than asserted.

  **All twenty existing approvals still have `decided_by` NULL** — 3 approved,
  9 consumed, 6 denied, 2 expired, none named. Correct, and worth stating
  plainly: they were decided by a shared key before people existed, and nothing
  was backfilled. ADR 0014's honest NULL is now a fact about real rows instead
  of an argument about fixtures.

  **Two things the live run found that no test had.**

  1. **The migration had never run against the real database.** Every suite
     builds its schema on a scratch copy, so "the migration works" was only ever
     a statement about copies. Running it for real was the first time, and the
     copy-first rehearsal was what made that safe rather than lucky.
  2. **`.env` carried no `FUEL_COOKIE_SECURE`.** It defaults to ON, which is the
     right default and which over loopback http means the browser silently
     discards the session cookie and sign-in fails with nothing in any log
     looking wrong. Found by trying it, not by reading it.

  **Not proven, and deliberately not attempted:** the shared key being refused
  a decision was confirmed from its input (`activeUserCount` = 1) rather than by
  firing a real approve against live money data, where a wrong refusal would
  have decided somebody's payment to prove a point. The break test for it runs
  on a scratch copy, which is the right place for that experiment.

  **There was no signup page when this slice closed.** Commit C built `/login`
  only, so redeeming an invite was a `curl` against `POST /api/auth/signup` —
  acceptable for the one owner who has a terminal, wrong for everybody invited
  after them. Closed by slice 7A-2b below.


### Slice 7A-2b — redeeming an invite in a browser — done, proven live

  7A-2 ended with accounts that only `curl` could create. This closes that, and
  is deliberately a separate slice: it touches the route that mints identities
  and is reachable with no credential at all, so it got its own plan, its own
  break tests and its own security review rather than being folded into the
  stage that preceded it.

  **A page, a form-post proxy, and nothing clever.** `dashboard/app/signup` is a
  server component with no client JavaScript, posting to a route handler that
  relays Fuel's `Set-Cookie` byte for byte — the same two reasons
  `app/api/session/route.ts` records, since this is somebody's first contact
  with the product and must work before hydration and with JavaScript off.

  The decisions worth remembering:

  - **The invitation code is typed in, never read from a link.** There is no
    `/signup?t=…`, deliberately. A token in a URL survives in browser history,
    over a shoulder, and in every access log the request passes — three places
    that outlive a single-use credential. Fuel sends no email, so no link is
    being clicked anyway: the code already arrives as text somebody copies, and
    a paste costs nothing against a click that does not exist.
  - **The confirmation field is a safety feature, not a courtesy.** Fuel has no
    self-serve password reset, so a typo produces an account nobody can open
    without shell access to the machine. It is compared BEFORE Fuel is called,
    which also means a typo costs the invite nothing — no attempt spent against
    the five-per-token limit, no single-use token touched.
  - **Refusals travel as a code, never as prose.** `src/auth/codes.ts` holds the
    closed vocabulary; the page maps it to its own sentences through a lookup.
    Rendering the server's sentence would put attacker-influenced text on a
    genuine Fuel URL, which is the phishing page `/login`'s `NOTICES` already
    exists to avoid. Every unusable invite — forged, expired, withdrawn,
    addressed to somebody else — still answers one code, so the machine-readable
    field discloses exactly as little as the prose did.
  - **The page asks for no company name.** A founding invite redeemed in a
    browser gets the default `<email>'s company` and there is no rename route,
    so founding invites stay on the `curl` path where a name can be passed.
    A small, real gap, recorded rather than designed around.

  **Security review found two things, and the first is the one worth reading.**

  1. **The middleware matcher excluded literal PREFIXES, not path segments.** No
     route collides today, which is precisely what made it dangerous:
     `/signup-secret`, `/login-as` and `/api/session-refresh` would each have
     inherited the unauthenticated status of the page whose name they start
     with — silently, with no build error and no failing test, directly in front
     of the only surface in the product that mints identities. Now anchored to
     whole segments, with the colliding paths asserted to be gated so the trap
     cannot be reset by a future route.

  2. **Login and signup shared one per-address rate-limit bucket.** Because the
     dashboard calls Fuel server-side, every browser request arrives from the
     dashboard's own address, so that bucket counted every operator together.
     **Measured rather than argued: nineteen anonymous posts to the public
     signup page made `/login` answer 429 to everybody.** The buckets are now
     split, so a page anybody on the internet can post to can no longer lock
     out people who have already signed up.

  **Known residual, and the split above does not close it.** A per-address limit
  is close to meaningless behind a proxy, and signup remains exhaustible — the
  test asserts containment, not immunity, and says so. `addressOf` reads the
  socket peer on purpose, so making this limit mean anything per-person needs
  either a forwarded address trusted only from a configured peer (reversing a
  rule `src/auth/routes.ts` states deliberately, twice) or a client identifier
  the dashboard forwards — and Next 15's `NextRequest` exposes no client address
  at all, so the dashboard cannot simply supply one. `byToken` (five per token)
  is unaffected by any of this and remains the limit that actually bounds
  guessing an invite. Its own slice, not a tail-end addition to this one.

  **Separately found, pre-existing, and NOT fixed here.** `POST /api/invites`
  does not check that an address is unclaimed, and `users.email` is globally
  unique rather than unique per company. So an owner can mint an invite for any
  address and learn from the `email_taken` refusal whether that address already
  has an account *anywhere on the platform* — a cross-tenant existence oracle,
  gated behind owning a company but not behind owning the address. It was
  already distinguishable by status code before this slice; the refusal code
  only makes the probe easier to script. Belongs with whoever decides whether
  company-scoped addresses are wanted. **Closed by slice 7A-2c below
  ([ADR 0018](./decisions/0018-an-account-belongs-to-one-company.md)):
  company-scoped addresses were chosen, and no response shape could have
  closed it.**

  **What the tests here do NOT prove, stated plainly.** The route handler
  imports through the `@/` alias, which only Next resolves, so it cannot be
  imported by `verify-api` — the same constraint `middleware.ts` documents and
  the reason it alone uses a relative import. Its checks are therefore source
  assertions: they establish the code is WRITTEN in the right order, not that it
  RUNS that way. That gap is what the live run below closed.

  **Proven against the live database (2026-09-23).** `fuel.db` was backed up
  first to `fuel.db.backup-pre-signup-20260923-024534` (sha256 `f696fa48…`,
  byte-identical at copy time). An operator invite was minted for a `+tag`
  address — deliverable to the owner's inbox, but a distinct account, since the
  suite proves `+tag` addresses are not folded together — and redeemed entirely
  in a browser, in a private window, against a production build. No `curl`.

  The three failure paths were exercised by hand first, since those are what a
  real person hits: a wrong code, a mismatched confirmation, and a short
  password (reached by removing the form's `minlength` in devtools, because the
  browser otherwise refuses to submit it). Each showed its own notice. **None
  left a trace**: afterwards the database held exactly one new user, one new
  session, the same single company, and every other row count unchanged — 267
  payments, 20 approvals, 5 agents, 5 postings.

  What the database holds for the new account: operator, in the bootstrap
  company; the invite consumed once, `redeemed_by` naming it; the token absent
  from the file and its SHA-256 in its place; the password as `v1.32768.8.1.…`
  like the first account's; one session, stored as a 64-character hash.
  `integrity_check ok`, 0 foreign-key violations.

  **The live run found one thing, and it was operational rather than a bug.**
  The first attempt served a broken page: `next dev` and `next build` write to
  the same `.next` directory, and a dev run after the production build had
  replaced the server runtime and route manifest with dev versions. `next start`
  then served a production build id over dev-mode files — a webpack module error
  on one page and a 404 on `/signup`, whose compiled output was on disk but
  missing from the dev manifest. Fixed by clearing `.next` and rebuilding; the
  walkthroughs had alternated between `npm run dev` and `npm start` without
  saying they share a folder. After any `npm run dev`, rebuild before
  `npm start`.

  The rebuilt server was also checked over HTTP before handing it back, and
  `/signup-secret` answered 307 to sign-in — the matcher fix above, confirmed on
  a running production server rather than only in the regex test.

### Slice 7A-1 — tenancy groundwork — done

  Everything a second real company needs to exist safely, before Stage 3 lets
  one sign up. 7A-2 has now let one sign up, so this slice is closed and the
  residuals it deliberately left open have moved to 7A-3, where a second company
  makes them reachable. Committed:

  - `54ce7f4` the accounting engine is company-scoped.
  - `ca3b983`, `9eee108` the tenant is a property of the request (a principal),
    the legacy keys bind to a RECORDED bootstrap company, and every unscoped read
    is named `*Unscoped` and kept out of the route layer by a source guard.
  - `c3af8ab` agent names unique per team; one agent per Fireblocks vault, with
    vaults named after the agent id (the provisioner reuses vaults by name).
    The shared vault 4 was repaired live: the empty-balance test agent moved to
    new sandbox vault 5. See `docs/shared-vault-remediation.md`.
  - `0daf75c` QuickBooks document numbers include the company; one live attempt
    per number; one Fuel company per QuickBooks company; the OAuth callback
    proves the granted token can read the realm it names before saving it.
  - The company's books cannot move (connect to a different realm, or
    disconnect) while any of its postings is `pending`.

  **The realm check, verified against the real Intuit sandbox (2026-09-20).**

  `grantReachesRealm` rests on an assumption about someone else's server: that
  an access token reading `companyinfo/<realmId>` gets a 2xx only for the
  company it was granted for, and 401/403/404 otherwise. Every test before this
  ran against a stub that behaved the way we assumed — which confirms the code,
  not the assumption. `scripts/probe-realm-scoping.ts` asks Intuit itself. It is
  read-only, refuses to run against anything but the sandbox origin, never
  refreshes the token (a refresh rotates and persists credentials, which is a
  write), and prints statuses and fault codes, never tokens or company data.

  Run immediately after a fresh consent, against the live connection:

  | probe | result | verdict |
  |---|---|---|
  | a. the granted token on its own company | HTTP 200 | `authorized` |
  | c. the same token on a company id nobody owns | HTTP 401, `AuthorizationFault` code 120 | `refused` |
  | d. a garbage token on the connected company | HTTP 401, `AUTHENTICATION` code 3200 | `refused` |
  | b. *(run 2026-09-23 and 09-25, 7A-3 item 4)* a token on ANOTHER company the same user owns | HTTP 200, **answered with the token's own company** | `authorized` — the assumption was wrong |

  **Intuit behaves as the check assumes, and no code changed as a result.** Both
  refusals land in the 401/403/404 bucket the callback already treats as "this
  grant does not reach that realm", so a squatted `realmId` in the callback is
  refused with a 400 rather than mistaken for an unverifiable 502.

  One operational note worth keeping: the callback saved the connection and then
  redirected to the dashboard at `localhost:3100`, which was not running, so the
  browser showed `ERR_CONNECTION_REFUSED` after a **successful** connection. The
  state row was consumed and the tokens were stored. The visible failure was the
  last hop and nothing else; re-consenting would have been the wrong instinct.

  **Known gap — case (b) is unproven.** The probe supports an `--other-realm`
  argument for the case that actually matters: a token used against a DIFFERENT
  sandbox company THE SAME USER OWNS. That is the squatting scenario — an
  attacker naming a realm they have some relationship with, rather than one
  drawn from nowhere. It was skipped because no second sandbox company exists on
  this developer account, and it is recorded here rather than quietly folded
  into (c). (c) proves Intuit refuses an unknown company id; it does NOT prove
  Intuit refuses a company the caller owns but did not grant. Those could differ
  — "not found" and "not yours" are different answers, and only one of them is
  the question we are asking. Closing it costs one command
  (`npx tsx scripts/probe-realm-scoping.ts --other-realm <id>`) against a fresh
  token, whenever a second sandbox company exists.

  **Closed by 7A-3 item 4, and the caution above was right.** Run on
  2026-09-23, (b) got HTTP 200. The answer was the token's OWN company, not the
  one named, so "the read succeeded" proved only that the user can reach that
  company. The verdict above ("Intuit behaves as the check assumes") was true
  of (a), (c) and (d), and false of the check. The callback now takes the
  granted company from Intuit's ID token. See
  [ADR 0017](./decisions/0017-a-quickbooks-connection-is-proved-by-who-and-by-intuit.md).

  **Known gaps carried forward:**

  - **A posting does not record which QuickBooks company it went to.** Every
    call resolves the realm from the company's CURRENT connection. 7A-1 closes
    the dangerous case with a guard: the connection cannot change realm, or be
    removed, while a posting is `pending` — otherwise reconciliation would ask
    the new books for the document, find nothing, mark it failed and release
    its lines to be booked twice.

    What the guard leaves open: once nothing is pending, a company may move to
    different books, and a later **reversal of a document posted to the old
    books** is sent to the new ones — a correction of an entry that does not
    exist there. Reconnecting after a disconnect has the same effect.

    The fuller fix, not built: add `realm_id` to `qbo_postings` (backfilled from
    the current connection for existing rows, which is correct today because no
    company has ever changed realm), write it in `beginPosting`, and make
    `reconcilePending`, `postReversal` and `findByDocNumber` address that realm
    and refuse — rather than silently use the current connection — when it is
    no longer the connected one. At that point the pending-postings guard can be
    relaxed to a warning.

  - **The guard can strand a company whose books are gone for good.** While a
    posting is `pending`, the connection can only be renewed for the same
    QuickBooks company, and only reconciling clears the pending state — which
    needs that company to still be reachable. If it never will be again
    (subscription cancelled, access permanently revoked, the customer will not
    re-consent), nothing in Fuel lets the operator out: they cannot reconcile,
    disconnect, or connect different books. Nothing mis-posts; it is an
    availability dead end. Same root cause as the gap above. The escape hatch
    would be an audited "record this pending posting as failed" action gated to
    a higher role than a plain operator — money policy, so it belongs with the
    roles Stage 3 introduces, and is not built.


### Slice 7A-3 — a posting run is per company — done (items 1–4; items 2–4 proven live)

  7A-1 and 7A-2 both end by pointing here. Every item below was known during
  7A-1 and left alone on one explicit basis: only one company could post, so
  each was unreachable in practice rather than fixed. 7A-2 removed that basis —
  a second company is now one minted invite away — so they are reachable now,
  and this slice is where they get paid for.

  1. **Done — `3bcb90c`, `ca3dbf7`.** `runPosting()` posted every company inside
     one transaction, under one shared run id. It is now `runPosting(companyId)`,
     required, one company per transaction; the route passes the caller's own
     company, and the per-company tally that reconstructed attribution afterwards
     is deleted because a run can no longer contain anyone else's lines.

     **The bugs were demonstrated before they were fixed.** Against the unchanged
     engine, the new tests failed on their named checks: another company went
     from 1 line to 2 when this company pressed the button, and this company's
     run answered 500 because of a fault injected into the other company's books.
     There was one more problem the item did not name: 7A-1 had stopped the
     route REPORTING other tenants' totals, but the writes went on happening.

     **Consequence, stated rather than discovered:** a company's books now
     advance only when its own run is triggered. That is the intended semantics
     — posting is on-demand and never on the reaper — and with one company
     today, nobody's cadence changed.

     **A race test that can actually fail.** The read happens after
     `BEGIN IMMEDIATE`, and `busy_timeout` makes a second writer wait rather than
     fail, so reading first would post the same money twice. An in-process test
     cannot catch that — `runPosting` has no `await` — so two OS processes race
     one company's books in `verify-migration`. Moving the read above the lock
     made both processes post, two runs out of two.

     **Proven against real data without touching the real books.** Two
     consistent snapshots of the live `fuel.db` were taken with `VACUUM INTO`
     from a read-only connection (the API had the file open). The pre-change
     engine, checked out into a temporary worktree, ran on one; the new engine
     on the other. On the real data alone both posted nothing and carried the
     same 9 buckets — identical, but nearly vacuous, since every real bucket sat
     under a cent. So nine identical payments were added to both copies, one in
     each real spend bucket, merging with the real sub-cent history: both
     engines then posted **the same 8 lines, 12 cents, 31 absorptions — every
     line, day, class and absorbed source identical** — and both copies passed
     `verifyPostingIntegrity` with no problems. The split changed attribution
     and isolation, not arithmetic. The live books were fingerprinted before and
     after (9 lines, 197 absorptions, unchanged), as was the whole file.

     **Two notes carried from security review, not built:**

     - **A run that holds the lock past `busy_timeout` (5s)** makes a concurrent
       run fail with 500 instead of waiting. Nothing partial is written — it
       rolls back — but an operator would see an error rather than a queue. Not
       reachable at today's volume (a run is milliseconds); worth a retry or a
       503 "already running" once a company's ledger is large.
     - **A line's company is derived, not stored** — through
       `agent -> team -> company`, deliberately, so there is one path rather
       than two that could disagree. That stays sound only while nothing moves
       an agent between companies. Verified: every `UPDATE agents` and
       `UPDATE teams` in `src/` touches caps or freeze state, never `team_id` or
       `company_id`. If moving agents is ever built, this is the first thing it
       breaks.
  2. **Done, proven live — `800075a`, `8e2c6c4`.** Every QuickBooks artifact
     records the books it belongs to, and nothing is sent to any other books.
     See [ADR 0015](./decisions/0015-a-quickbooks-document-is-pinned-to-its-books.md).

     **Wider than the item as worded.** It named postings only. Reading the
     code in full showed the same gap in the frozen drafts and in the account
     mapping. There it fails *silently*: account ids are small per-company
     integers, so a stale id resolves to a different, real account and Intuit
     accepts the entry. All three now carry a realm (`qbo_postings.realm_id`,
     `qbo_posting_drafts.realm_id`, `qbo_config.accounts_realm_id`).

     **The bugs were demonstrated before they were fixed.** The new tests ran
     against commit 1's code (a non-throwing diagnostic copy, in a temporary
     worktree) and failed on their named checks:
     - a pending posting reconciled after a switch of books came back
       `expected pending, got failed`, with its lines released: the
       double-booking path;
     - a stale draft was posted into the other books;
     - a reversal sent requests to books that never held the original.

     **One choke point, plus layers so that refusals happen before rows exist.**
     - `qboRequest` takes the realm a request must reach and refuses before
       `fetch`. A cheap pre-check also runs before the token is resolved, so a
       doomed request cannot refresh anyone's credentials.
     - Post and reversal read the currency pinned to the artifact's books, which
       is their first request, then re-check synchronously after that `await`,
       before an attempt or a correction draft is written.
     - Reconcile and the duplicate-number adoption ask only the posting's books.
     - A realm refusal never marks a posting failed.
     - Preview refuses a mapping stamped for other books.
     - Status stops claiming readiness in that state.
     - Account setup pins its currency read, company profile and all four
       account lookups to one realm. Security review found the first version
       did not.

     **The backfill runs exactly once**, in the same transaction as the column,
     so a company that later connects to different books never gets its old
     artifacts re-stamped. A `NULL` is refused, never read as "current".

     **Proven live on 2026-09-23.**
     - **Backup:** the API was stopped; backup `fuel.db.bak-7a3-item2-20260923T093452Z`
       (SHA-256 `75fdee92…d0cb`, identical to `fuel.db`, integrity ok).
     - **Rehearsal:** the migration was first run on a `VACUUM INTO` copy.
     - **Real migration:** it then ran on the real database when the API
       restarted. 5/5 postings, 8/8 drafts (5 posted, 3 previewed) and the
       mapping were attributed to the connected company, none left unattributed.
     - **Nothing else moved:** 9 lines, 197 absorptions, 267 payments and
       2 users matched the backup. Integrity ok, 0 FK violations.
     - **The stamps are true, not assumed:** each of the 5 posted documents was
       looked up by DocNumber in the books it is stamped with, read-only, and
       all 5 were found with the QuickBooks id Fuel recorded (145–149).
     - **Side effect:** the lookup refreshed the access token, as any posting
       would, and the rotated credentials were saved. The postings table's
       fingerprint was identical before and after.

     **Different from what this item said: the pending-postings guard stays a
     block.** A pending posting can now only be reconciled in its own books, so
     switching away would strand it instead of mis-reconciling it. Relaxing the
     guard waits for item 3's escape hatch.

     **Suites and review:**
     - Suites: migration 166, api 4164, rollup 211, quickbooks 285, earning 132.
     - 32 break tests across the two commits, each failing its named check. Two
       needed one-off diagnostics, recorded in the commit messages.
     - Security review on both commits. Commit 1's high finding (account setup
       could save ids under the wrong stamp) and its lost-update race were
       fixed. Commit 2 had one low finding, fixed.

     **Carried, not built:**
     - The currency record is not realm-stamped. It can make status describe
       the wrong company's currency, but cannot cause a wrong send: post re-reads
       it, pinned.
     - `accessTokenFor` saves the realm it read *before* a refresh, so a
       reconnect racing a refresh can be silently reverted. Existing behaviour;
       review found no path to the wrong books.
     - Two backstop branches are unreachable in-process and so untested:
       `send`'s POST-level mismatch branch and `qboRequest`'s post-token
       comparison.
  3. **Done, proven live — `ab0f2df`, `ea8547c`.** An owner can write off a
     pending posting whose books cannot be asked about it. That lifts the block
     on changing books for that posting only. See
     [ADR 0016](./decisions/0016-a-posting-whose-books-are-gone-can-be-written-off.md).

     **Not what the item said: the posting is not "recorded as failed".**
     `failed` means "provably no document, release the lines", and nothing here
     proves that. The posting stays `pending`, with four new columns recording
     who wrote it off, when, why, and what Fuel saw when it could not ask. Its
     lines stay held and its number stays taken, so its spend is never re-posted
     automatically (the user's decision). Only the guard and the
     needs-reconciliation list skip it. Tests pin the six other readers of
     `pending`, which must keep holding.

     **QuickBooks is asked first.** If it answers, that answer stands and the
     write-off is refused. A 4xx that means the books heard and said no is
     refused too. Only "could not ask" is allowed: books elsewhere, no
     connection, an unusable token, 401/403, the network, 429 or 5xx.

     **Who and how:** a signed-in owner only; a shared key and an operator
     session both get 403. The owner types a reason (10–500 characters) and the
     document number. In the dashboard, "Write off…" appears only for owners, in
     an inline panel that states what it does and does not do.

     **The dead end was demonstrated before it was opened.** Against the
     previous code, six unresolvable postings left a company unable to
     disconnect or connect other books.

     **Proven live on 2026-09-23.**
     - **Backup:** `fuel.db.bak-7a3-item3-20260923T173729Z` (SHA-256
       `4d7b6238…d816`). The migration was rehearsed on a `VACUUM INTO` copy,
       then ran when the API restarted.
     - **Result:** all 5 real postings have the four columns `NULL`. The
       postings fingerprint, 9 lines, 197 absorptions, 267 payments, 2 users and
       8 drafts all matched. Integrity ok, 0 FK violations.
     - **The write-off itself, in the browser, on a scratch copy**, because the
       real database has no pending posting and making one would be an
       accounting action. The copy's QuickBooks connection was replaced with a
       made-up company and undecryptable tokens, so no real credential could be
       used or refreshed. One synthetic pending posting was added. The owner saw
       Disconnect refused, wrote the posting off, and Disconnect then succeeded.
       The copy recorded the owner, the reason, the evidence ("Stored secret is
       not in the expected v1 format") and status still `pending`. No request
       reached Intuit. The scratch servers were stopped and the copy deleted.

     **Suites and review:**
     - Suites: migration 180, api 4202, rollup 211, quickbooks 331, earning 132.
     - 21 break tests across the two commits (17 and 4), each failing its named
       check, including a control on the guard.
     - Security review on both commits. One medium on the first, fixed and
       confirmed closed: an answer from QuickBooks that Fuel failed to record
       was read as "could not ask". The dashboard commit had no findings.

     **Carried, not built:**
     - A single owner acts alone. This meets 7A-1's "a role above a plain
       operator"; it is not four-eyes approval.
     - A transient outage also allows a write-off. By design: Fuel does not
       guess which failures are permanent. The lines stay held, and reconnecting
       the same books still resolves the posting truthfully.
     - Written-off spend has no way out except a reconcile in its own books. If
       they never return, booking it in the new books is a human accounting
       decision.
     - What Intuit returns for a truly revoked company has not been observed.
       Nothing depends on it.
  4. **Done, proven live — `c38333a`, `7bc4a4a`, `65b5b4b`, `22b0f41`.** A
     second Fuel company connected its own QuickBooks company, and running it
     found two holes, both now closed. See
     [ADR 0017](./decisions/0017-a-quickbooks-connection-is-proved-by-who-and-by-intuit.md).

     **Hole 1, found by reading the code: a connect link was bound to a
     company, not a person.**
     - The attack: an operator at company B could hand the Intuit link to
       someone at company A, which hadn't connected yet. That person's books
       were then saved under B, and A could never connect them.
     - The fix: the link now records who pressed Connect, and the callback
       requires that person's live session before exchanging the code. A
       shared key can no longer start a connection.
     - Against the previous code, the test connected (302) and a key started a
       link (200).

     **Hole 2, found by running 7A-1's case (b) live: the realm proof proved
     less than it claimed.**
     - What Intuit did: company B's token, sent to company A's books, got 200,
       answered with B's own company. A company nobody owns is still refused.
     - The attack: someone with Intuit access to another business's books
       could consent for their own, edit `realmId`, and have Fuel save the
       other business's ID against a token served by their own books.
     - The fix: Fuel now asks for `openid` and saves a connection only for the
       ID token's `realmid`. The signature isn't checked (the token comes
       straight from the token endpoint over TLS; OpenID Connect Core
       3.1.3.7(6)), and a source guard keeps it to that one caller.
     - Against the previous code, the test connected (302).

     **Live runs, 2026-09-23 and 2026-09-25.**
     - **Migration:** backup `fuel.db.bak-7a3-item4-20260923T212051Z`
       (SHA-256 `47f1fcd4…e000`), the migration rehearsed on a copy, then run
       on `fuel.db`. Every count and hash was unchanged.
     - **Company B:** created by a founding invite; its owner connected
       sandbox company …2698 in a private window. That was also the first
       proof that the session cookie reaches the callback.
     - **The hijack:** a link B's owner started, finished in a window signed
       in as A, was refused, with no code exchanged.
     - **Probe (b):** B's token on A's books failed the old expectation, which
       found hole 2.
     - **After the fix:** three connections, each logged as confirmed by
       Intuit's ID token. The consent screen showed nothing new. Probe (b), now
       asserting Intuit's measured behaviour, passes on fresh grants.
     - **Company A:** its connection, account mapping and postings hashed the
       same through every step until 2026-09-25. That day the owner, by
       accident while switching between browser windows, connected A briefly to
       B's sandbox (while B was disconnected), then back to its own books, in a
       new row. The owner confirmed it was their action. Its mapping and
       postings were unchanged, and nothing was pending.

     **Suites and review:**
     - Suites, final: migration 191, api 4321, rollup 211, quickbooks 357,
       earning 132.
     - 24 break tests (13 and 11), each failing its own named check.
     - Security review on both code commits, with no vulnerability. It noted a
       stale comment (fixed) and suggested the single-caller guard (added).

     **Found along the way:** a `verify-api` check asserted that no founding
     invite exists at all. The suite runs on a copy of `fuel.db`, which
     legitimately holds one since company B was created, so the check now
     counts before and after.

     **Carried, not built:**
     - The company-ID edit was not run against real Intuit (offered, skipped).
       It is proven by the stub, which is modelled on the measured behaviour.
     - A refused grant is not revoked at Intuit (the tokens are discarded), and
       neither is a Disconnect (existing behaviour).
     - The dashboard and API must share a cookie host, or every connection is
       refused. It fails closed. This is recorded for deployment.
     - The signup form cannot name a founding company, so company B is
       "owner@example.com's company". The API accepts
       `companyName`; the form never sends it.
     - Only the Accounting page's Connect button can start a connection, and
       it shows only while a company is disconnected. Finishing a link in
       another browser is refused by design.

  **Not in this slice, and named so it is not mistaken for forgotten:** retiring
  the legacy operator key. Its criterion is that every script needing it has
  either a service credential or a person with a session, which belongs with the
  per-agent credentials Phase 7 already lists.

### Slice 7A-2c — an account belongs to one company — done, proven live

  Closes the invite email-existence oracle that 7A-2 recorded above. The owner
  decided that addresses are scoped to a company. See
  [ADR 0018](./decisions/0018-an-account-belongs-to-one-company.md).
  Commits `48155e6` (the API and schema) and `aeb217e` (the dashboard).

  **The leak was not in any response.** Fuel sends no email, so whoever mints
  an invite holds its token. An owner could invite any address, redeem their
  own token, and read 409 `email_taken` (an account exists somewhere) against
  201 (none does, and the owner now holds the address for the whole platform).
  Flattening the refusal was tested and doesn't close it: success still differs
  from failure (break test C2). So the uniqueness itself changed:
  - `users` is `UNIQUE (company_id, email)`, by a one-time rebuild that keeps
    every id;
  - every company has a handle, a slug plus four random characters, never
    "-2", which would itself reveal that a name is taken;
  - sign-in takes `{ company, email, password }`, with one refusal at one
    hashing cost for every way to be wrong, and a rate limit per handle and
    address;
  - the dashboard asks for the handle first and shows it on the viewer badge.

  **Reverses a recorded decision.** The users table chose global uniqueness so
  the form would never ask "which company?". The answer is that the person
  types it, and Fuel never answers it: no list, and an unknown handle is
  refused exactly as a wrong password is.

  **Security review found two more, both fixed here.**
  - **A taken company name leaked.** Founding a company under a taken name
    sent the SQLite error to Express's default handler, which answered with the
    message, the stack and file paths. `companies.name` is no longer unique.
    That rebuild refuses to commit unless every row reads back identical,
    spend caps included.
  - **The API had no catch-all error handler.** Now any unexpected error answers
    500 "internal error". Only the JSON parser's own errors, recognised by
    `type`, keep their 4xx.

  **Checked against the old code first:** O1 and O2 failed with 409, N1 with
  500, and E1 with a stack in the body.

  **Proven live on 2026-09-26.**
  - **Backup:** `fuel.db.bak-adr0018-20260926T113246Z` (SHA-256
    `4e74e04f…8dad54`), taken with the API stopped.
  - **Rehearsal:** the migration ran on a copy, booted twice.
  - **Migration:** it then ran on `fuel.db`.
    - All 19 tables hashed the same, companies without the new column.
    - Both spend caps are unchanged (5000000 and 0).
    - Integrity ok, 0 FK violations.
  - **Handles:** `default-company-33kj` and `owner-example-com-evg7`.
  - **Probes:** every wrong combination got the identical 401, and malformed
    JSON got a generic 400.
  - **The owner** signed out and back in with the handle, and the badge showed
    it.

  **Suites and review:**
  - Suites: migration 231, api 4404, rollup 211, quickbooks 357, earning 132,
    both typechecks, and the dashboard build.
  - 25 break tests (20 API, 5 dashboard), each failing its own named check. C2
    was isolated with a diagnostic, and C14 was stopped by the rebuild's own
    guard.
  - Security review: three rounds, with no vulnerability.

  **Carried, not built:**
  - **The oracle itself was not run live.** That was offered separately
    because it adds a user to company B for good. O1 and its breaks prove it.
  - **A company founded without a name gets a handle that starts with its
    founder's email** (company B's does). It isn't a cross-company leak, but it
    is one more reason for the signup form to name the company (7A-3's carried
    item).
  - **The rate-limit key joins handle and address with a NUL character.** A
    crafted value can collide keys, but only into a bucket anyone could fill by
    typing that account's handle and address.
  - **The dashboard checks and E4 read the source.** The live sign-in covers
    the running sign-in path.

### Slice 7A-4 — an agent's funding address is visible, narrowly — done, proven live

  Wallet funding for the beta: testers fund their own agents directly with
  USDC on Base Sepolia, no card on-ramp. See
  [ADR 0019](./decisions/0019-a-funding-panel-may-show-the-agent-address.md).
  Commits `64178c5` (the API and ADR) and `f0eb7a0` (the dashboard).

  **Half of the request was already built.** `GET /api/agents` and `/:id`
  have read an agent's live custody balance since Phase 1 Slice 2, and both
  the roster and the agent detail page already show it next to the spend
  cap. Only the address itself — network, asset, address, and a warning
  about wrong-network transfers — was missing.

  **This ran straight into a closed decision.**
  [ADR 0005](./decisions/0005-dashboard-shows-wallet-addresses.md) removed
  every wallet address from the dashboard "without exception" when it became
  a product surface in Phase 5. ADR 0019 narrows that, deliberately as
  small as the need: one panel, on the agent detail page, behind a click, to
  an operator, and nowhere else. The narrowing is safety-motivated — a
  wrong-network crypto transfer is not reversible — not a convenience
  rollback of 0005.

  **`GET /api/agents/:id` gains `funding: { address, network, asset }`**,
  built by a new `presentFunding` called from that one route handler only —
  never folded into `present()`, which also backs the list route and every
  write route. `present()` lost `agent.address` once already (5B-2, after
  the shared `AGENT` credential could reach it via the list route); keeping
  `funding` out of it is the same least-privilege choice, not a new one.

  **No funding data is ever passed as a React prop**, on purpose. Next.js
  serializes every prop a Server Component hands a Client Component into the
  page's delivered bytes regardless of what renders — the exact 5A-1 leak
  ADR 0005 documents. `agents/[id]/page.tsx` hands `FundingPanel` only the
  agent's id and a boolean; the address exists in the browser only after the
  click fetches it, on demand, from a new relay route.

  **Verified for real, not just by design.** Reintroducing that exact
  prop-leak mistake was caught by the dashboard's pre-existing
  custody-identifier checks, on every viewport, against a real agent's real
  address, on the live running dashboard. Reverted and reconfirmed clean.

  **A prerequisite, found and fixed along the way.**
  `scripts/qa-dashboard.ts` had no sign-in step at all — a gap predating this
  slice (ADR 0018 made every dashboard route require a session cookie; this
  script was never updated), so every route it "checked" was silently
  scanning the login page. Fixed: it signs in as a new, dedicated,
  idempotent test account (`scripts/seed-qa-dashboard.ts`, its own company,
  0 spend cap throughout, never a real person's) over the real sign-in
  route, and carries that session into every browser context. A new check
  verifies the funding panel's collapsed state (same as every other route)
  and its revealed state (an exact match against Fuel's own answer, so a
  second address or a transaction hash riding along would still fail it),
  and that hiding it again actually removes the address from the page.

  **Security review, two rounds, one finding.** The backend commit had none.
  The dashboard commit's one finding: the seed script's company lookup
  matched by name only, which could have silently taken over an unrelated
  same-named company — and, on an email collision, reset an unrelated
  person's password. Fixed: it now refuses unless every existing user in a
  found company is the one it expects. A `NODE_ENV=production` refusal was
  added too.

  **Live, 2026-09-27.**
  - `fuel.db` was backed up first
    (`fuel.db.bak-adr0019-20260927T140209Z`, hash-identical), both servers
    restarted on this slice's code.
  - The seed script created one company ("Fuel QA Dashboard"), one owner,
    one team and one agent, provisioning exactly one real Fireblocks
    sandbox vault. A second run reuses all four rows and provisions
    nothing further.
  - Signed in for real, `qa-dashboard` ran all 1032 checks across three
    viewports: the collapsed page showed nothing; the click revealed that
    real address, "Base Sepolia" and "USDC"; hiding it again removed the
    address from the DOM. Zero failures on `agent-detail`, any viewport.

  **Found along the way, out of scope, not fixed here.** Fixing the sign-in
  gap made `qa-dashboard`'s accounting-status checks run for real for the
  first time too, and they fail on every viewport — unrelated to agents,
  custody or funding; nothing in Phase 4–6's accounting code was touched by
  this slice. Left for whoever picks up the accounting-status surface next.

  **Resolved afterwards: the QA script's expectation was wrong, not the
  page.** Two defects in `scripts/qa-dashboard.ts` only. Its expected key list
  predated 6B-1, which added `readyToPostRevenue` and `missingForRevenue` to
  the contract. And it compared the browser's answer with Fuel's answer for
  the shared operator key, which resolves to the bootstrap company, while the
  page shows the signed-in company (the QA account's, with no QuickBooks
  connection) since ADR 0018. It now reads Fuel's answer with the same
  session, and a failed read is a failure rather than a silent return.
  1032 checks, 0 failures. **One limit, stated plainly:** the QA company has no
  QuickBooks connection, so the value comparisons now compare "not connected"
  with "not connected". They would not notice a narrowing that reset a
  verified currency; verify-api's `toAccountingStatus` checks still do.

  **Found afterwards, and owned: the QA agent broke a suite that picks "any
  agent".** The suites run on a copy of the live `fuel.db`, and the QA agent
  the seed script created belongs to "Fuel QA Dashboard", not to the company
  the suites post for. `verify-quickbooks` seeded its test spend on
  `SELECT id FROM agents LIMIT 1`, which started returning that agent, so
  the seeded day produced rollup lines that company never committed. I ran
  that suite before seeding and not after. Fixed in `58780d5`: both picks
  are scoped to the company under test (`JOIN teams … WHERE company_id = ?`).

  **Known gap, not fixed: `verify-rollup` has the same unscoped pick.**
  `scripts/verify-rollup.ts` (the earning section, `SELECT id, name FROM
  agents LIMIT 1`) registers its two seeded endpoints on whichever agent
  SQLite returns first, then asserts on `listPostingLines({ companyId:
  COMPANY })`. So it silently assumes that agent belongs to `COMPANY`, and
  passes today only because the first agent happens to. One more agent in
  the live database, or a different query plan, could move it onto another
  company's agent. It would then fail for reasons unrelated to whatever
  change was being verified, exactly as `verify-quickbooks` did. (The
  comment near the top of that file, "this copy of fuel.db has exactly one
  company", has also been untrue since 7A-3.) The fix is the same scoping
  `58780d5` applied. It was deliberately left out of the rate-limit slice
  (ADR 0020), so that slice changes only what it is about.

  **Carried, not built:**
  - **Mainnet.** `BASE_PATH = BasePath.Sandbox` and the signer's chainId
    refusal are unchanged. A production Fireblocks workspace (new
    credentials, a real signer-role key, a policy engine) does not exist in
    this repo. Moving this panel to mainnet is a separate, later, reviewed
    decision.
  - **A card on-ramp**, which would let this exception shrink back toward
    nothing.
  - **The rate-limit-shaped NUL-key residual and the founder-name-in-handle
    residual from 7A-2c are unaffected by this slice.**

### Slice 7A-5 — sign-in limits count per browser, not per dashboard — done, proven live

  The real fix for the shared sign-in bucket that 7A-2c split but did not
  solve. See
  [ADR 0020](./decisions/0020-sign-in-limits-key-on-the-browser-the-dashboard-vouches-for.md).
  Commits `54ed1ed` (the API), `160f541` (the dashboard) and the ADR commit.

  **The problem.** The dashboard calls Fuel from its own server, so every
  browser's sign-in and signup arrived from the dashboard's address and
  shared one 20-attempt allowance. One anonymous browser could lock every
  operator out. The dashboard could not pass the browser's address on,
  because Next 15 keeps a browser-written `X-Forwarded-For` and never shows a
  route handler the socket.

  **The fix, in two halves.**
  - **The dashboard now runs behind `dashboard/server.mjs`.** On every request
    it deletes the browser's address headers and writes the real socket
    address, plus a per-process proof. Plain `next start` still serves pages,
    but sign-in and signup refuse ("could not reach Fuel").
  - **The API believes that address only with the relay key
    (`FUEL_RELAY_KEY`, in both `.env` files) from an allowed peer.** Everyone
    else is counted against their own connection, whatever headers they send.
    A ceiling of 500 relayed attempts per 15 minutes bounds a leaked key.

  **The dashboard now holds one secret again**, narrowly: the relay key is not
  an API credential (as a Bearer token it gets 401), and only the two
  sign-in calls send it.

  **Start the dashboard with `npm start` or `npm run dev`, never `next start`.**
  After an API restart, restart the API first, then the dashboard.

  **Two departures from the plan, both from reading Next's source:**
  `X-Forwarded-Host` copies the browser's own `Host` header rather than a
  fixed `127.0.0.1:3100`, because operators browse at `localhost` and a fixed
  value would break Next's Server Action origin check. And Next handles
  WebSocket upgrades itself, so the edge adds no second handler. ADR 0020
  records both, with the reasons.

  **Proof.** R1–R22 and E1–E6 in verify-api; 32 break tests, each failing its
  own named check; all five suites pass; three security reviews (the plan and
  each commit). Live on 2026-10-07: 21 sign-ins through the real dashboard,
  each forging every address header and using a different email, were
  counted as one browser, so the 21st was throttled. A direct call to the
  API straight afterwards was not; `next start` run directly refused sign-in;
  and the dashboard listened on `127.0.0.1:3100` only. After an API restart
  to clear that allowance, `qa-dashboard` signed in with its own test account
  through the real sign-in route, so through the edge and the relay, and ran
  1032 checks: 1014 passed. The 18 failures are the six accounting-status
  checks per viewport already failing under 7A-4. **The owner did not sign in
  by hand**; the QA account's sign-in is the proof of a successful one.

  **Hosting is now constrained.** A custom Next server can't use Vercel's
  native Next.js hosting; per Vercel's own guide it would need the container
  path, which is in beta and expects `$PORT`. That is a precondition for the
  hosted-deployment slice, not a blocker for the beta. ADR 0020 has the
  sources.

  **Known gaps carried forward, not fixed in this slice:**
  - **Tunnels and proxies.** Putting port 3100 behind a tunnel or proxy makes
    every visitor look like `127.0.0.1`, which brings the shared bucket back.
    The owner has undertaken not to tunnel 3100 without saying so first.
  - **Zero trusted hops only.** A load balancer in front of the dashboard
    needs a configured hop count, which isn't built.
  - **Distributed lockout.** 25 or more coordinated browsers can exhaust the
    relayed ceiling for 15 minutes.
  - **The adapter proof is live-only.** No suite proves that Next builds a
    route's headers from the edge-stamped request. Repeat the live spoof test
    after any Next upgrade.
  - **`scripts/walk-accounting.ts` starts the dashboard with `next start -p
    3101`.** Sign-in would refuse there. That script already predates the
    sessions of ADR 0018 and never signs in.
  - The rest are listed in ADR 0020's "Residuals".

### Slice 7A-6 — Fuel tells a company's owner when something needs them — done, proven live

  Alerting. See
  [ADR 0021](./decisions/0021-fuel-tells-a-companys-owner-when-something-needs-them.md).
  Commits `a7eeef9` (the engine and API), `184524e` (the dashboard) and the ADR
  commit.

  **What it does.** Once a minute, Fuel checks every company for what needs a
  person. It sends that company's owner one Slack-compatible message for
  whatever has newly started needing someone. The owner sets the webhook on
  /integrations; nobody else can.

  **One list for the screen and the alerts.** The Overview's "Needs attention"
  rules moved from `dashboard/app/page.tsx` into the API
  (`src/alerts/attention.ts`). The Overview now renders `GET /api/attention`
  and the sweeper alerts from it, so the two cannot disagree. The list is
  collapsed per agent and kind ("26 payments … from research-bot" is one line).
  The five kinds the Overview already had read word for word as before. Nine
  kinds are new: anomaly holds, unconfirmed payments, stuck incoming payments,
  QuickBooks entries needing reconciliation, frozen agents still trying to pay,
  QuickBooks expired or expiring, rate-limited agents, and agents near their
  cap.

  **The webhook URL is a credential.**
  - It is stored encrypted and bound to its company.
  - No route returns it, and nothing logs it; an owner sees its host only.
  - It is validated when set and again before every send.
  - Each send is SSRF-guarded at connect time, follows no redirects, and times
    out after 5 seconds.

  **Noise.**
  - At most one message per company per minute.
  - Three hourly ceilings: money 10, approvals 6, watch 4.
  - Silent reopen within an hour.
  - Setting the first webhook baselines everything already open, so old
    conditions are never sent.

  **Proof.**
  - Suites: verify-api 5,477 (the AL-… checks), migration 234, rollup 211,
    QuickBooks 357, earning 132.
  - Break tests: 47 for commit 1 and 30 for commit 2, each
    failing its own named check.
  - Security reviews of the plan and of both commits.
  - **Live on 2026-10-10.** The owner saved a webhook and the test alert
    arrived. All 31 conditions already open in the owner's company were
    baselined, and none was sent. On the QA company only, freezing
    `qa-dashboard-agent` sent exactly one alert ("Frozen for
    `qa-dashboard-agent`"), with the freeze reason left out. Five more sweeps
    while it stayed frozen sent nothing, and unfreezing it resolved the event
    without a message. ADR 0021 has the timeline.

  **Before any demo, clear two old test rows from the Overview.** They are
  payments authorised in August and never confirmed:
  - one of $0.001 from `empty-balance-test-agent`;
  - 26 from `research-bot`.

  They now show under "Payment outcome unknown". There is no button for it yet:
  each needs `POST /api/payments/:id/reconcile` with `settled` or `failed` and
  a note, decided by a person.

  **Known gaps carried forward, not fixed in this slice:**
  - **Alerts reach each company's owner, not whoever runs Fuel.** A beta
    tester's broken system tells their owner, not Fuel's operator.
    Platform-level monitoring is the follow-up. It should start with:
    - `relay_rejected`;
    - QuickBooks refresh failures (`quickbooks_failing`, which needs a
      write in `src/quickbooks/` to record them at all);
    - the sweeper itself stopping.
  - **The recovery digest was cut.** Held events join the next message
    instead, and message text is built when sent. ADR 0021 explains.
  - **No reconcile button for unconfirmed outgoing payments** (above).
  - The rest are listed in ADR 0021's "Residuals".

### Slice 7A-7 — one command runs every check, and a push can require it — done

  Automated tests. The guide is [docs/testing.md](./testing.md). Commits
  `1184bf7` (the test database), `c04940c` (the runner) and the hook commit.

  **What it does.** `npm test` runs every suite and both typechecks in about a
  minute and a half. It stops at the first failure and ends with one line,
  `npm test: PASS (9/9)` or where it failed and why.
  - A step passes only on exit 0 **and** a check count at or above its floor
    in `scripts/test-baseline.json`, so a suite that quietly runs fewer checks
    fails.
  - Each step gets a bare environment: no key, credential or proxy from your
    shell, and no `.env`.

  **A pre-push hook runs it on what is being pushed.** Each pushed tip is
  checked out alone in a temporary worktree, so uncommitted files can neither
  break the check nor slip past it. It is installed only by
  `npm run hooks:install`, and `git push --no-verify` skips it.

  **The suites no longer touch `fuel.db`.** verify-api, verify-rollup and
  verify-quickbooks used to copy it, so clearing old test data could switch a
  check off, and a machine without it could not run them.
  - Each now builds its own database in the temp directory, from code, with
    the same shape as the real one: 267 payments, 20 approvals, 9 rollup lines
    and 5 QuickBooks postings, the derived rows made by Fuel's own engines.
  - Four guards (TD-1 to TD-4) keep the real file out of reach.

  **Two checks that had never run now do.** verify-quickbooks'
  settlement-staleness check and verify-api's approval demo-marker check each
  sat behind an `if` the real data never met. Each skipped itself while its
  suite printed a pass. Both are now assertions.

  **One change from the plan.** The hook was to refuse a push while the working
  tree had uncommitted changes. The owner keeps three regenerated Accounting
  screenshots uncommitted on purpose, so that would have blocked every push.
  Testing the pushed commit in its own worktree is the stricter check anyway.

  **Proof.**
  - Counts: verify-runner 80, the dashboard's source checks 69, earning 132,
    rollup 212, QuickBooks 361, migration 234, verify-api 5,509.
  - Each commit was checked out alone in a temporary worktree and passed
    there: commit 1's suites and typechecks, and `npm test` for commits 2
    and 3.
  - An assertion-by-assertion comparison with the old real-data runs: no
    check lost in any of the three suites.
  - All five suites and both typechecks passed under a macOS sandbox profile
    that denies any access to `fuel.db`. A control confirmed the profile
    blocks it.
  - 38 break tests, each failing its own named check, all rerun on the final
    code: 15 on the database guards, 17 on the runner and 6 on the hook (one
    by hand).
  - Two security reviews, of the test database and of the runner and hook.
    Their findings are applied.
  - **The floor caught a real problem before commit 2.** Measured in a built
    checkout, verify-api's floor failed a fresh clone: one scan counted a file
    Next generates on a build. That scan now skips it, and docs/testing.md
    states the rule.

  **Known gaps carried forward, not fixed in this slice:**
  - ~~**verify-api needs `x402.org`.**~~ **Closed in 7A-8.** The gateway's
    handshake started on import with nothing handling a failure, and the same
    flaw did crash the live API on startup, through both payment servers.
    `npm test` now runs offline.
  - **Only the tip of each pushed branch is tested,** not each commit under it.
  - **The hook borrows this checkout's `node_modules`,** so a push that changes
    dependencies is tested against the ones installed here.
  - **TD-1 is a pattern check, not a proof.** TD-4 is what makes the `fuel.db`
    default unreachable.
  - **Test databases are left in the temp directory,** about 10 MB per run.
  - **The seeded QuickBooks realm ids are shaped like sandbox ids.** They are
    made up, and nothing is sent to QuickBooks.
  - **The hook is not installed in the owner's checkout.** That is the owner's
    call.

### Slice 7A-8 — the API stays up when the payment network is down — done

  Commits `2b0de92` (the fix and its checks), `3490bcf` (the docs) and the
  commit that applied the commit review's findings. The guide is
  [docs/testing.md](./testing.md#the-payment-network-being-down).

  **The problem, reproduced.** Fuel's two x402 resource servers each started
  their handshake with the facilitator the moment they were created, with
  nothing listening for it to fail:
  - the gateway's, in `src/gateway/route.ts`, on import;
  - `/paid-hello`'s, inside the library's `paymentMiddleware`.

  With `x402.org` unreachable, that was an unhandled rejection, and Node ends
  the process on one. **The whole API went down within a second of boot:**
  caps, approvals and the dashboard's API included. That is also why
  verify-api needed the internet: `src/api.ts` imported the gateway router for
  one constant.

  **The fix.** `src/payments/facilitator-sync.ts` owns both handshakes.
  - **When they start:** at boot, never on import.
  - **On failure:** handled, then retried in the background after 2, 4, 8, 16
    and 32 s, then every minute. The timer never keeps a process alive.
  - **How often they run:** one attempt at a time, and never again after
    success. The library clears its list of payment kinds at the start of each
    handshake, so a second one could fail requests in flight.
  - **What a request does:** it never starts a handshake. It waits up to 5 s
    for one already under way, and is otherwise refused.
  - **Until a server's handshake succeeds,** its paid routes answer **503 with
    `Retry-After: 30`**. Nothing is quoted, verified, claimed or settled, and
    the seller is not contacted. Everything else serves as usual.
  - **What counts as ready:** the gateway is ready only when the facilitator
    offers exact payments on Base Sepolia.
  - **What is unchanged:** the testnet rail stays hardcoded, with no new
    setting, and no process-wide error handler was added.

  **No payment decision moved.**
  - The gateway's handling from "3. No payment offered" to its end is
    byte-identical to the code before the fix.
  - `pay.ts`, `src/db/`, the forwarder, limiter, probes, limits and signer
    have empty diffs.
  - The three price quotes ($0.05 on the gateway; $0.001 and $0.005 on
    `/paid-hello`) match, field by field, a fixture recorded by running the
    code from before the fix.

  **Proof.**
  - **verify-startup**, 88 checks (GS-1 to GS-14). It runs the real API
    offline under a test-only preload that plays the facilitator and refuses
    everything else. While the facilitator is down, a paid request gets 503,
    with no receipt, no money-table change and no lookup of the seller's
    hostname; a control shows that detector firing in the same process.
  - **The facilitator fixture** was recorded with a bare request, carrying no
    keys, and is dated. **The quote fixture can be re-derived:**
    `scripts/record-quote-fixture.ts d660535` reproduces it exactly.
  - **20 break tests,** all rerun on the final code, each failing its own named
    check.
  - **`npm test` 10/10** on exactly the commit, in an isolated worktree, and
    again with the network blocked by a macOS sandbox.
  - **Live, on 2026-10-11.** The real API ran under that sandbox, which was
    proven first to block outbound network, DNS, `fuel.db` and its backups,
    `.env`, and the keys. It used a throwaway generated database with no
    webhooks, and made no payments.
    - It stayed up for two minutes and answered `/health`.
    - It logged the outage once per server.
    - The gateway and both `/paid-hello` routes answered 503 with
      `Retry-After: 30`.
    - The money tables were unchanged.
  - **The plan's security review (Opus):** nothing blocking. Its findings,
    all in the test plan, were taken before building.
  - **The commit's security review (Opus):** nothing blocking or high. All
    its findings were applied:
    - **One medium:** GS-8's "no handshake for 10 s, with traffic" sent no
      traffic. It now sends some, and counts from the ready wave.
    - **Six low:**
      - a log sink that throws can no longer crash anything (GS-14);
      - the preload judges the database file itself, and refuses links;
      - the gateway's rail failure is checked by its own log line;
      - the overlap control has a margin;
      - the quote recorder is committed;
      - the `/paid-hello` guard is checked to ask its own sync.
    - **Counted honestly:** 69 one-per-file assertions became three, so the
      check count fell from 152 to 88.

  **Known gaps carried forward:**
  - **Accepted limit: a facilitator failing at *settle*,** after the seller
    has answered, is not driven end to end. That code is byte-identical to
    before. verify-earning checks the receipt rules it relies on. The
    gateway's own catch for it is exercised by no suite.
  - **A 5 s wait cap.** A paid request arriving during a very slow handshake
    is refused at 5 s instead of waiting without limit, as before. That happens
    before any budget is reserved.
  - **The library logs its own warning on every failed attempt,** about once
    a minute during an outage. Fuel's own lines appear only on transitions.
  - **Platform monitoring should alert on this outage.** It is a platform
    signal, not a company's (see 7A-6).
  - **Follow-up, closed by 7A-9 below, for both routes: `HEAD /paid-hello` ran the handler unpaid.** The plan's
    security review found it, and it was reproduced offline on 2026-10-11.
    It predates this slice: `main` has the same route and middleware.
    - **What happens:** `GET /paid-hello` answers 402 with a price quote.
      `HEAD /paid-hello` answers 200 with `content-length: 68`, so the
      handler ran without payment, and Express then dropped the body, as it
      does for `HEAD`.
    - **Why:** the library's route table says `GET`, so its middleware lets
      `HEAD` through. Express answers `HEAD` with the `GET` handler.
    - **Why it isn't urgent:** no paid content leaves, and `/paid-hello` has no
      side effects.
    - **Why it still matters:** it is a hole in the paywall, and any paid
      handler with side effects would run them for free.
    - **The follow-up should:** refuse `HEAD` on paid routes, or list `HEAD`
      in the route table so it is quoted like `GET`.
    - **Decide the gateway too:** Express routes `HEAD /earn/:id` to the
      gateway's `GET` handler as well.
    - **Add a check that fails today,** before the fix.

### Slice 7A-9 — a HEAD to a paid route is refused — done

  Commits `7adb546` (the fix and its checks), the commit that applied the
  security review's findings, and the commit that carries this entry and the
  testing guide. The guide is
  [docs/testing.md](./testing.md#a-head-to-a-paid-route).

  **The problem, reproduced on `main` before anything was changed.** Express
  answers a `HEAD` with a route's `GET` handler and drops the body. Neither
  paid route asked which method it had been given.
  - **`/paid-hello` and `/paid-hello-large`** answered a `HEAD` with `200`: the
    handler ran with no payment at all, with the facilitator down as well as
    up. The library's route table says `GET` and compares the verb exactly, so
    its middleware never asked for payment on a `HEAD`.
  - **The gateway** answered a `HEAD` with the `GET` handler's own answers: 503
    while the facilitator was down, and 402 with a price quote once it was up.
    A `HEAD` carrying a payment that matched the terms **reached the
    facilitator's `/verify`**. From there it would have been handled like a
    `GET`: claimed, forwarded to the seller and settled. The payer would be
    charged in full and receive headers alone. Only the `/verify` step could be
    observed: the offline facilitator always refuses it.

  **The fix.** A `HEAD` to a paid route answers **`405` with `Allow: GET`** and
  the body `{"error":"GET only"}`, ahead of everything else: the limiter, the
  endpoint lookup, the facilitator wait, the quote and every payment step.
  - **Why refuse, rather than quote it like a `GET`:** a payer who answered
    that quote would be charged for headers alone. The charge is the problem,
    not the quote.
  - **`src/gateway/route.ts`:** a `router.use` ahead of `router.get`. It has to
    be a `use`: a `router.head` registered after `router.get` would never run.
  - **`src/server.ts`:** a middleware ahead of the facilitator guard. It asks
    the library's own matcher whether the route is paid, as a `GET`, because
    that is how the table lists it. Case, trailing slashes and any route added
    later are covered without a second list.
  - **Same answer everywhere:** for every endpoint id, whether the payment
    network is up or down, and at no cost. It costs no database read and no
    limiter budget. Both refusals compare the method in upper case.

  **No payment decision moved.**
  - The gateway's whole `GET` handler is **byte-identical** to `main`
    (8,290 bytes, sha256 `c5cb276f…eb4a96`). So are `PAID_ROUTES`, the prices,
    recipient and network (867 bytes, `9c14c3d1…f13133`), and the guard, the
    payment middleware and both paid handlers (1,461 bytes, `bf40efb8…ef1bd6`).
  - `src/` changed by additions only: 59 lines added, none removed or edited.
  - **Empty diffs** for `src/payments`, `src/db`, `src/fireblocks`, the
    forwarder, limiter, probes, settlement evidence, signing, origin,
    `src/quickbooks`, `src/accounting`, `src/api.ts`, `auth.ts`, `safe-fetch.ts`,
    `money.ts` and `environment.ts`.
  - **GS-13 and GS-17:** the three `GET` quotes still equal, field by field,
    the fixture recorded from the code before 7A-8, after every `HEAD` above.

  **Proof.**
  - **The new checks were run against `main`'s code first.** 79 of the first
    version's 190 checks failed there: 19 in GS-15 and 60 in GS-16, none
    anywhere else. They include the `/paid-hello` `200`s and the two `HEAD`s
    that reached `/verify`. That count comes from a throwaway copy of the suite
    that records failures instead of stopping; the committed suite stops at the
    first, which on `main` is "while the facilitator is down, HEAD to the
    gateway is refused with 405" (it got 503). GS-17 is a set of controls that
    must hold before and after, so it passes on `main` by design. Its break
    test, BH7, is what shows it can fail.
  - **verify-startup**, now 197 checks (GS-1 to GS-17).
    - **GS-15, the gateway:** a `HEAD` with no header, an unreadable one, one
      matching the terms, and the same as `x-payment`, down and up. Each gets
      `405`, `Allow: GET`, no price quote and a `Content-Length` that is exactly
      the "GET only" body. None creates a receipt, changes a money table, looks
      up the seller or reaches `/verify` or `/settle`.
    - **GS-16, `/paid-hello`:** the same on `/paid-hello`, `/paid-hello-large`,
      `/PAID-HELLO` and `/paid-hello/`, with a payment built from each route's
      own quote. It also checks that the API's log holds no "headers already
      sent" error, and that the refusal is mounted ahead of the payment
      middleware.
    - **GS-17, the controls:** a real receipt claim moves the receipt count and
      the money hash. The very same payment header sent as a `GET` reaches
      `/verify` exactly once, on the gateway and on each `/paid-hello` route,
      so a `HEAD` reaching it zero times was stopped, not unable to get there.
      `HEAD /health` is still served.
    - **What does the work:** the status, `Allow`, `Content-Length`, the
      up-state `/verify` counters, the log check, the order check and those
      controls. The `/settle` counters, the up-state receipt, money-table and
      seller-lookup assertions and every down-state counter cannot fail while
      the offline facilitator refuses `/verify`. They pin the property for a
      harness that can drive a payment further, and are not counted as
      evidence (see the testing guide).
  - **14 break tests,** all rerun on the final code, each failing its own
    named check: the eight planned (BH1 to BH8); BH5b (both literal paths,
    which only the case variant catches); BH9 and BH10, empty-body breaks that
    show the body-length assertion is live; and, from the review, BH11 and BH12
    (a refusal that does not end the request, on each route) and BH13 (the
    refusal mounted after the payment middleware).
  - **`npm test` 10/10** on exactly the final code, in an isolated worktree,
    in 2m14s, and again with the network blocked by a macOS sandbox, in 2m10s.
    The first version passed both too.
  - **Live, on 2026-10-12.** The real API ran under that sandbox, re-proven
    first (outside it `x402.org` answers 200; inside, DNS fails and curl exits
    6). It used a throwaway generated database with no webhooks, on a spare
    port, and made no payments. Servers already running on ports 3000 and 3100
    were listening before and after and were not touched.
    - A `HEAD` to the gateway and to `/paid-hello`, `/paid-hello-large`,
      `/PAID-HELLO` and `/paid-hello/`, each with and without a payment header:
      all `405`, `Allow: GET`, 20 bytes, no quote.
    - `GET` was unchanged: `503` with `Retry-After: 30`. `/health` answered
      `200` to `GET` and `HEAD`.
    - The money tables were unchanged, and no unhandled error was logged.
  - **The commit's security review (Opus):** nothing blocking or high. One
    medium, which predates the slice and is carried forward below, and the
    rest applied.
    - **Low, applied:** GS-16's `/verify` and `/settle` counters for
      `/paid-hello` could not fail. The payment they used was built from the
      gateway's quote (50000 base units, the gateway's recipient), which the
      library rejects before verify on a $0.001 route, with or without a
      `HEAD`. Each route's payment now comes from its own quote, and a `GET`
      control per route shows it reaches `/verify` once.
    - **Low, applied:** nothing detected a handler running behind a refusal
      that did not end the request. The API's log is now checked for a
      "headers already sent" error, with a break test for each route.
    - **Notes, applied:** a source-order check pins the refusal ahead of the
      payment middleware; the method is compared in upper case; and the claim
      that a uniform `405` stops endpoint enumeration is dropped, because a
      `GET` already answers 402 for a known id and 404 for an unknown one.
    - **Notes, recorded:** the assertions that cannot fail in this harness are
      named in the testing guide and not counted as evidence. The 79-of-190
      figure came from a failure-collecting copy of the suite.
    - **What a read-only reviewer could not verify:** byte-identity, diff
      emptiness and the run outcomes. The author checked those by script, and
      the PR lists them.

  **Known gaps carried forward:**
  - **Follow-up, medium, and before any outside tester: a paid `GET` can be
    settled and then answered `304 Not Modified` with no body.** Found by this
    slice's security review. It predates the slice, and it is the same harm
    this slice closes for `HEAD`: a payer charged in full and given nothing.
    - **Why:** Express's `res.send` turns a 2xx into an empty `304` when the
      request counts as fresh, and the gateway's step 9 ends in
      `res.status(...).send(...)` after the receipt is marked settled. A
      request carrying `If-None-Match: *`, or an ETag the payer was given
      earlier, is fresh. The gateway passes the origin's `etag` and
      `last-modified` through to the payer, so a caching HTTP client
      revalidating a paid response can trigger it by itself. The library's
      middleware settles any status below 400, and `304` is below 400, so
      `/paid-hello` has the same shape.
    - **What was shown here:** Express's half, in isolation. A handler that
      sends a `200` with a body answers `304` with zero body bytes to
      `If-None-Match: *` and to a matching ETag. The rest was read in source,
      not driven end to end, because the offline facilitator refuses `/verify`.
    - **Only the payer's own request headers can trigger it,** so it is medium
      and not high.
    - **The fix touches the `GET` path,** so it is its own slice with a check
      that fails first: refuse or drop `if-none-match`, `if-modified-since`,
      `if-match`, `if-unmodified-since` and `if-range` on the paid routes
      before anything is claimed, or write step 9 so Express's freshness logic
      is skipped. The next small slice, 7A-10, should pair it with the `500`
      below.
  - **Accepted limit, the same as the settle one.** The test facilitator
    always refuses `/verify`, so a `HEAD` that would claim, forward and settle
    cannot be driven end to end. What is shown is that a `HEAD` never reaches
    `/verify`, which is the step before every one of those.
  - **Follow-up: a decodable payment header that is not a payment gets `500`
    on the gateway.** Found while reading the failures. A `GET` with
    `payment-signature` set to the base64 of `{"x402Version":2}` makes
    `findMatchingRequirements` destructure an absent `accepted` (a `TypeError`
    in the library's `paymentRequirementsMatchAccepted`), and the error handler
    answers `500`. It fails closed: before verify, before any
    claim, with no receipt, no money change and no seller contact. It is a
    robustness gap, not a money one, and it should be `400`. It was not fixed
    here because the handler is deliberately byte-identical to `main`; it is
    7A-10's, with a check that fails first.
  - **Express's automatic `OPTIONS` answer still lists `HEAD` in `Allow`.**
    Nothing runs on an `OPTIONS`, so it was left alone.
  - **For the hosted beta (B6): uptime monitors must `GET` a paid route,** and
    may `HEAD` only `/health`. A `HEAD` monitor pointed at a paid route now
    reads `405`, correctly.

### Slice 7A-11 — the testnet guards are under test — done (hosted-beta step B3-1)

  Commits `9348ce8` (the suite and its registration), `4764b6c` (the security
  review's findings) and the commit that carries this entry and the testing
  guide. The guide is [docs/testing.md](./testing.md#the-testnet-guards). The
  number 7A-10 is held for the paid-response fix below.

  **The finding.** Fuel moves no real money because of a handful of pinned
  constants and refusals, and `CLAUDE.md` says enabling any of them is a
  reviewed code change. Nothing checked that. No script imported the Fireblocks
  signer, and "all four verified refused" in Phase 1 was a manual check. A guard
  edited or deleted in a refactor would have passed `npm test`. The hosted beta
  edits files beside these guards, so they go under test first.

  **What was added.** `scripts/verify-pins.ts`, 90 checks, the eleventh `npm
  test` step. It is placed fifth, by the step list's own "fastest first" rule:
  it takes a few seconds, and an edited guard should fail within seconds.
  - **PIN-1:** the Fireblocks workspace is the sandbox and written as a
    literal; the gas, USDC and signing assets and the signer's chain id are
    Base Sepolia's; the Fireblocks files never touch `process.env`. **The
    client itself is built on the sandbox:** with a production workspace named
    in `FIREBLOCKS_BASE_PATH`, which the SDK falls back to if Fuel leaves its
    own base path out, the client still comes up on the sandbox. There is one
    `new Fireblocks(` in `src/`.
  - **PIN-2:** network, asset, scheme, facilitator and the $0.01 ceiling; the
    payment files read no environment.
  - **PIN-3, by behaviour:** the signer refuses a `Permit`, Base mainnet's USDC
    contract, chain id 8453 or none, and an authorization from another
    address. A correct Base Sepolia authorization is shown to pass all four and
    stop only at the missing credentials, so a signer that refused everything
    would fail. The signer exposes exactly an address and `signTypedData`, and
    `src/` creates a Fireblocks transaction in one place.
  - **PIN-4:** the environment report is sandbox on all five surfaces, the
    gateway origin is loopback, and **the API starts listening in one place, on
    loopback only**, which is what makes "Receiving: sandbox" true. The table
    holds exactly eight values and calls each mainnet one production.
  - **PIN-5:** the QuickBooks origin is the sandbox, and a production address
    is refused.
  - **PIN-6:** no file in `src/` outside the environment table names a mainnet
    network, asset, host, workspace or Fireblocks asset id, however spaced or
    bracketed, and `src/` imports nothing from `viem/chains` but Base Sepolia.
  - **Source is read with the parser, not a regex.** See the review below.
  - **It cannot sign.** The credentials are removed from the process before
    the signer is called, and checked absent. A broken guard stops at
    "FIREBLOCKS_API_KEY is not set", even in a shell holding real sandbox keys.
    The one group that supplies stand-in credentials only constructs the
    client, which does no I/O, and removes them again.

  **No behaviour moved.** `git diff main -- src` is **empty**. Only
  `scripts/`, `package.json` and the docs changed.

  **Proof.**
  - **38 break tests,** each failing its own named PIN check. They flip each
    pin; delete each of the signer's four guards, one at a time; make the
    signer refuse everything (to show the control is live); flip the
    environment table three ways; read the workspace and a limit from the
    environment, directly and by destructuring; drop the client's base path;
    listen on every interface; add a member to the signer and a second place
    that creates a transaction; and add mainnet spellings to `src/` files,
    including one hidden after a `"*/*"` string in `forward.ts`. All 38 ran on
    the suite before the last rename; the 13 that touch the renamed file's
    check, and a sample, were rerun on the final file.
  - **Two things the breaks taught.** The first version's `Permit` case was
    caught by the signer's *library* ("Invalid primary type"), not by Fuel's
    guard, so deleting the guard did not show. The case is now a well-formed
    `Permit`, and then Fuel's `from` guard also stopped it, because a `Permit`
    has no `from`. So the case carries a `from`, and only the primaryType guard
    stands in its way. The signer's guards are two layers deep, and each is
    tested alone.
  - **`npm test` 11/11** on exactly the final commit, in an isolated worktree
    (2m14s), and again with the network blocked by a macOS sandbox (2m17s). The
    blocked run caught a mistake in the first version of the review's fix: the
    sandbox refuses any `*.pem` on purpose, and the stand-in key file was named
    that. It now has a neutral name.
  - **No live run,** because nothing at runtime changed.
  - **The commit's security review (Opus):** nothing blocking. It confirmed the
    suite cannot sign, spend or contact a provider, that nothing in its import
    graph loads `.env` or opens a connection, and that the registration is
    right. Its findings were blind spots in the checks, all closed in
    `4764b6c` except the one recorded below.
    - **Medium, closed:** the client's real base path was not pinned, and the
      SDK reads `FIREBLOCKS_BASE_PATH` when given none, so a dropped
      `basePath:` would have left every check green and made custody a config
      flag.
    - **Medium, closed:** "Receiving: sandbox" is true only while the API
      listens on loopback, and nothing checked that line, just before the beta
      changes it.
    - **Low, closed:** the comment-stripping regex took `accept: "*/*"` in
      `forward.ts` for the start of a comment and hid real code from PIN-6.
      Source is now read with the TypeScript parser.
    - **Low, closed:** the environment scan saw only literal reads, and
      nothing checked the signer's shape or that a transaction is created in
      one place.
    - **Low, closed:** PIN-6 now covers a spaced network id, a wildcard, a
      bracketed `BasePath` lookup, the base-path variable and other `viem`
      chains.
    - **Notes, recorded:** `localSigner` (`src/payments/signer.ts`) has no
      callers and a stale comment, and could be deleted. The manual scripts
      that read `TEST_PAYER_PRIVATE_KEY` sign with a raw account and no guards;
      it is a testnet throwaway key.

  **Known gaps carried forward:**
  - **No suite calls `payForAgent`. This is the main one.** The constants are
    pinned and the signer's refusals are exercised, but the payer's own
    enforcement in `src/payments/pay.ts` is tested only by hand on testnet:
    the per-payment ceiling comparison, the choice of acceptable terms, the
    refusal of a non-positive amount or a short time limit, the order of
    reserve before sign, and the checks that the signed amount and the selected
    terms match what was reserved. The signer backstops the network, asset,
    primary type and payer, but **nothing catches the amount, the payee or the
    validity window**: changing the ceiling comparison to ten times the limit
    would pass all eleven steps. It needs a suite of its own, with a loopback
    stub seller and a recording fake signer that never reaches Fireblocks.
  - **PIN-6 is a text match over `src/` only.** A deliberately constructed
    spelling evades it. The behavioural checks stand behind it.
  - **The sandbox signing path itself** (a real signature through Fireblocks)
    is exercised by hand, not by `npm test`.
  - **The next hosting steps edit PIN-4 on purpose.** Hosting the gateway
    moves its public origin and the listening address, and those edits belong
    in the same reviewed commit as the matching check.
