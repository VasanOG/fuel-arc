# Fuel, from first principles

**Purpose:** an honest, code-grounded answer to "what is Fuel, actually, right now" — for deciding what to build next and who to sell to. Every claim below is checked against the running code (`src/`), not against what the ADRs intended or the roadmap narrates. Where a claim comes only from a doc, that is stated explicitly. Overstating readiness is treated as worse than understating it, per the brief.

Read in full for this document: `CLAUDE.md`, `docs/roadmap.md`, `docs/architecture.md`, all of `docs/decisions/`, `src/api.ts`, `src/db/index.ts`, `src/db/payments.ts`, `src/payments/pay.ts`, `src/db/postings.ts`, `src/quickbooks/*.ts`, plus (needed to trace signing/custody/the inbound direction accurately) `src/fireblocks/*.ts`, `src/gateway/*.ts`, `src/accounting/rollup.ts`. `graphify-out/graph.json` was not used for anything in this document — every claim traces to a direct read.

> **Written 2026-09-13. What has changed since — read this before trusting a
> bucket below.** This is a point-in-time snapshot, kept as written rather than
> silently edited, because a research document that quietly updates itself
> stops being evidence of what was true when a decision was made. Known drift:
>
> - **The revenue side is no longer unexercised.** Bucket B's "implemented but
>   never run with real data" entries for the earning gateway and revenue
>   posting are now false: 6B-1's live walkthrough (2026-09-13) put a real
>   payer through the gateway and two real JournalEntry documents (148, and
>   149 reversing it) into the Intuit sandbox. Three gateway bugs were found
>   and fixed in the process.
> - **Slice numbering moved.** "Slice 6B-2 — the interface" is now 6B-3; a new
>   6B-2 (the operator's triage loop) was inserted ahead of it.
> - **ADR 0013 now exists**, settling where the earned balance sits — an item
>   this document listed as an open question under 0011.
>
> Everything else below, in particular §2 (Fuel never custodies funds) and §4
> (no route creates a second company), was still accurate at the last check.

---

## 1. Where Fuel sits in the payment flow — one real payment, traced

Entry point: `POST /api/agents/:id/pay`, [src/api.ts:2022](../../src/api.ts#L2022). Guarded to the `agent` role only — the operator credential is barred from this route by design ([src/api.ts:2019-2021](../../src/api.ts#L2019)).

The route resolves the agent, builds a Fireblocks-backed signer, and calls `payForAgent` ([src/api.ts:2038](../../src/api.ts#L2038) → [src/payments/pay.ts:106](../../src/payments/pay.ts#L106)). Inside `payForAgent`:

1. **Frozen check** ([pay.ts:125](../../src/payments/pay.ts#L125)) — a containment check; the authoritative one is later.
2. **Unpaid fetch** ([pay.ts:147](../../src/payments/pay.ts#L147)) — `safeFetch` (SSRF-guarded) hits the caller-supplied URL to learn the x402 terms from the 402 response. Nothing reserved or signed yet.
3. **Term selection** ([pay.ts:170](../../src/payments/pay.ts#L170)) — filters on scheme + network + asset, and separately caps the amount at `MAX_PER_PAYMENT_BASE_UNITS` ([pay.ts:47](../../src/payments/pay.ts#L47)).
4. **The decision** — `reserveIfUnderCap` ([pay.ts:203](../../src/payments/pay.ts#L203) → [src/db/payments.ts:252](../../src/db/payments.ts#L252)). This is the actual authority in the system. Inside one `BEGIN IMMEDIATE` SQLite transaction it: checks frozen state (db/payments.ts:352), validates any redeemed approval (373), checks the agent's own cap (419-427), the team's and company's caps (441-469), the velocity limiter (483-494), and the anomaly detector (508-521) — in that order, for stated reasons at each step — then inserts a `'pending'` payment row (524-527) and commits. **No signature exists yet at any point in this function.** This is the whole of Fuel's authority over the payment: a database transaction that decides yes/no and reserves an accounting entry before anything is cryptographically committed.
5. **Signing** — `markSigningStarted` ([pay.ts:338](../../src/payments/pay.ts#L338) → db/payments.ts:586, written *before* the signing call so a crash mid-flight is provable) — then `http.createPaymentPayload(paymentRequired)` ([pay.ts:340](../../src/payments/pay.ts#L340)), which invokes the registered `PaymentSigner.signTypedData`. That signer is `fireblocksSigner` ([src/fireblocks/signer.ts:98-223](../../src/fireblocks/signer.ts#L98)). It calls Fireblocks' `transactions.createTransaction` (signer.ts:161) naming the agent's own vault as the source, polls for a terminal state (`awaitSignature`, signer.ts:236), and — because Fireblocks does not validate the EIP-712 payload itself — locally recomputes the digest and recovers the signing address before trusting the result (signer.ts:202). **This is the only step where a private key is touched, and Fuel's own process never touches it** — the MPC key shares live inside Fireblocks' sandbox "Communal Test Co-signer," which auto-approves (signer.ts:9-17).
6. **Delivery** — `safeFetch` again, now carrying the signed payment header, to the same URL ([pay.ts:362](../../src/payments/pay.ts#L362)).
7. **Settlement evidence** — the merchant's response carries a `PAYMENT-RESPONSE` header; Fuel decodes it and requires a `txHash` before calling anything settled (pay.ts:376-383). If there's no tx hash, the payment is marked `unreconciled`, not settled — an explicit refusal to assume.
8. **Recording** — `markSettled` ([pay.ts:385](../../src/payments/pay.ts#L385) → db/payments.ts:634) writes the final status and the tx hash.

**Who actually executes the on-chain movement is none of the above.** The signed EIP-3009 authorization is broadcast and confirmed by the **x402 facilitator** — an external service at `https://x402.org/facilitator` (`FACILITATOR_URL`, [pay.ts:38](../../src/payments/pay.ts#L38)) — not by Fuel, and not by Fireblocks acting as a transaction submitter. `docs/roadmap.md` Phase 0 records this was verified directly: *"the payer needs no gas, ever... the facilitator broadcasts and pays"* and, more pointedly, *"Fireblocks' policy engine will not see x402 payments... Fuel's own cap is the only control that will exist."* Fireblocks here is purely a signer.

So the full chain for one payment is: **agent → Fuel's cap decision (SQLite transaction) → Fireblocks (signs) → x402 facilitator (broadcasts and settles on Base Sepolia) → Fuel reads back the tx hash and records it.** Fuel sits at exactly two points: before the money moves (the only point where it has any authority) and after (reading evidence).

The inbound direction (an agent *being paid*, `GET /earn/:publicId`, [src/gateway/route.ts](../../src/gateway/route.ts)) is architecturally the mirror: Fuel verifies a signed x402 payload, claims a replay-defense row, forwards to the customer's origin, and only then calls `resourceServer.settlePayment` (route.ts:264) — again the facilitator, not Fuel, executes settlement.

## 2. Does money ever pass through Fuel? Does Fuel custody funds?

**No, on both counts — verified from the code, not assumed from the ADRs' stated intent.**

- Fuel's server process never holds a private key. `src/fireblocks/signer.ts` and `src/fireblocks/provision.ts` are the entire custody-adjacent surface, and both are thin wrappers around Fireblocks' SDK (`@fireblocks/ts-sdk`) — every signing operation is an API call to Fireblocks, which holds the MPC key shares (`src/fireblocks/signer.ts:9-17`).
- Fuel's server never constructs, holds, or broadcasts a blockchain transaction. The signed authorization is handed to the x402 facilitator; USDC moves peer-to-peer on Base Sepolia between the payer's Fireblocks-vault address and the merchant's address.
- Fuel's own server binds `127.0.0.1` ([noted directly in ADR 0011](../decisions/0011-the-earning-side.md), citing `src/server.ts`) and has no deployment or funds-holding role of any kind.

This matches what ADR 0001 states as intent (*"We do not build our own key-management or custody system... transactions are signed via Fireblocks' sandbox API"*) and what `docs/architecture.md` says plainly: *"Each agent gets its own Fuel wallet, backed by a custody provider under the hood."* The code bears this out exactly — Fuel is a **policy and bookkeeping layer over Fireblocks-custodied wallets**, not a money-holding entity. This is true for both directions (spend and the 6A-2 earning gateway) and is not a partial or soon-to-change property — it's structural: no code path anywhere writes Fuel's own address into a payment, receives funds into an account Fuel controls, or moves funds without going through Fireblocks (signing) and the x402 facilitator (settlement).

## 3. Four buckets, honestly

### A. Implemented AND verified against real transactions
- Spend-cap enforcement, atomically reserved before signing (Phase 1 Slice 1) — verified on Base Sepolia: 5 payments against a cap settle, the 6th is blocked, concurrent overspend attempts correctly serialize.
- Per-agent Fireblocks custody, the vault as payer (Phase 1 Slice 2) — verified on-chain (`0x5a69ce67...`).
- Cascading agent/team/company caps (Phase 2 Slice 1) — verified on-chain (`0x27dc518b...`) plus concurrency tests across teams.
- Two-party approval flow: request → human approval → single-use redemption (Phase 2 Slices 2-3) — verified end to end with real settlement tx hashes.
- Anomaly detection, spend-velocity limiting, agent freeze (Phase 3) — verified against real Base Sepolia payments including the false-positive and true-positive cases.
- **QuickBooks posting for spend** (Phase 4 Slice 2b) — not merely code-complete: *"three JournalEntry documents exist in a real Intuit sandbox company, posted by Fuel"* (`docs/roadmap.md`, current-phase banner).
- CSV exports and the operator dashboard (Phase 5) — live-walked via `scripts/qa-dashboard.ts` and `scripts/walk-accounting.ts`, including a scan of actual delivered HTML for leaked crypto identifiers.
- The accounting-status/no-provider-leak boundary (ADR 0010, Phase 5C-2 series) — verified live against real HTTP responses, not just unit-tested.

### B. Implemented but never exercised with real data
- **Revenue reaching Intuit.** Slice 6B-1 is recorded as *"done (headless; live walkthrough pending)"* (`docs/roadmap.md`). `scripts/walk-revenue.ts` does not exist. Direct quote: *"Intuit has never seen a revenue document from Fuel."* Everything about revenue posting — the rollup, the direction-aware JournalEntry builder, the reversal logic — has been proved with in-process tests and a fresh-vs-migrated-schema check, never against the live Intuit sandbox.
- **A real inbound payment through the earning gateway, end to end.** The roadmap is explicit that `verify-earning` (73 checks) does not cover *"a real signed authorization, verify, and on-chain settle end to end. That needs a funded sandbox wallet and the live facilitator, and is a walkthrough to run separately."* This means `src/gateway/route.ts` — the literal code path a paying customer's traffic would run through — has, as far as this codebase's own verification record shows, never processed a real payer.
- The gateway's ownership-proof and bypass-probe mechanism (`src/gateway/probes.ts`) exists and is logically sound, but nothing in what was read evidences it being run against a real, independently operated customer origin server (as opposed to Fuel's own test fixtures).

### C. Designed in an ADR but not built
- **Xero.** ADR 0007 explicitly left "QuickBooks vs. Xero, or both" as an open choice; only QuickBooks was ever implemented, and `docs/roadmap.md` states plainly: *"Xero remains deferred."*
- **Per-vendor / per-endpoint QuickBooks category mapping.** ADR 0007: one default expense account for the first version, "not a mapping UI" — deliberately deferred, not built.
- **A take-rate/fee on revenue.** ADR 0011, "No fee, this phase" — a real decision against building it now, zero code.
- **Revenue suspense.** Not merely unbuilt — *refused by design* (ADR 0012): there is no revenue-suspense account and the architecture is built around that absence.
- **Multi-currency / FX.** Explicitly out of scope (ADR 0008); the only code path is a hard USD-only refusal, checked twice (at setup and immediately before every post).
- **Real per-agent and per-operator credentials.** Named as an open gap since Phase 2 Slice 3 and restated in ADR 0009: *"per-agent credentials are the fix"* for the fact that one shared agent key can act as any agent, and one shared operator key means no individual attribution. Not built.
- **Tenant isolation / multi-company.** ADR 0009's central claim: the `company_id` predicate that scopes every query *"is a seam, not tenant isolation."* Concretely, `createCompany` exists in `src/db/companies.ts` with **no route exposing it** — `src/api.ts:251` says so directly: *"createCompany already exists in the db layer for that day, deliberately without a route yet."* Every route in the system resolves `getDefaultCompany()`. There is exactly one company, hardcoded.
- **Withdrawal mechanics for an earned balance.** ADR 0011 states the *policy* (bank transfer) but explicitly leaves the mechanism undecided: *"the bank-transfer path by which a customer takes earned money out... beyond the decision that this is how it leaves"* is unbuilt.
- **What freeze means for an earning endpoint.** ADR 0011: "a genuine product question with a defensible answer either way, and it is not settled here." No code branches on it.
- **Refunds, chargebacks, or disputes on receipts.** ADR 0011: explicitly undecided, zero code.
- **A real deployment/availability story for the gateway.** ADR 0011 states the gateway takes on a production-infrastructure obligation the codebase is not built to keep: *"the server binds 127.0.0.1, there is no deployment story, no health checking beyond a /health route, and no notion of an SLA anywhere."*

### D. Product hypothesis only, nowhere in code
- **A displayed "One P&L" / per-agent profitability figure.** Slice 6B-2 — the Earning page, a direction column, combined P&L on Overview and Agents — is an unchecked item in `docs/roadmap.md` (*"Slice 6B-2 — the interface... [ ]"*). No UI code for this exists yet.
- **Agents "funding themselves" from what they earn.** ADR 0011 names this explicitly as a story the product *rejects*: earning never raises a spend cap, by schema-level design (separate tables, no shared column). This is not a missing feature; it's a decision the product deliberately does not implement, stated in the ADR's own words: *"The product loses a nice story... and keeps an invariant that is worth more than the story."*
- **Fuel as a governance-only layer over someone else's wallet.** ADR 0003 rejects this shape outright as the reason Fuel exists at all. Not in code, on purpose — worth naming because it's the most obvious "simpler" pivot and the codebase has already argued against it.
- **True multi-tenant SaaS** (more than one customer's data, isolated). Nothing in the running system supports this; see bucket C above.
- **Any production/mainnet operation.** Barred by `CLAUDE.md`'s non-negotiable rule and enforced structurally: Fireblocks is pinned to `BasePath.Sandbox` (`src/fireblocks/provision.ts:15`), QuickBooks is pinned to `sandbox-quickbooks.api.intuit.com` compared by parsed origin, never prefix (`src/quickbooks/config.ts:71-79`), and the payment network is pinned to Base Sepolia throughout. Fuel has never moved real money or posted to a real company's books, and nothing in the code is one config flag away from doing so — enabling either is a reviewed code change.

One more thing worth flagging in this bucket: `docs/architecture.md` itself is partly stale as a spec. It names Postgres (superseded by ADR 0004's move to SQLite, which is what the code actually runs), and describes a generic `Transaction`/`ApprovalRequest` model that undersells what's actually built (the three-level cap hierarchy, `receipts`, `posting_lines`, the whole QuickBooks schema). Anyone reading `architecture.md` as current truth would both overestimate the storage engine and underestimate the accounting machinery.

## 4. What a company would actually have to do to integrate today

Everything below is a real, existing route in `src/api.ts` unless marked **NOT BUILT**. Auth throughout is one of two shared bearer secrets (`operator` or `agent` role, resolved in `src/lib/auth.ts`) — there is no per-customer credential (see bucket C, tenant isolation).

**To let an agent spend:**
1. `POST /api/agents` (operator) — provisions a real Fireblocks vault.
2. `PATCH /api/agents/:id` (operator) — set a spend cap; defaults to $0 (deny by default).
3. `POST /api/agents/:id/pay {url}` (agent) — the whole payment happens synchronously in this one call: cap check, sign, deliver, settle. Response codes are meaningful: 200 settled, 402 over a cap, 202 queued for human approval, 429 rate-limited, 423 the agent is frozen.
4. If 202: `GET/POST /api/approvals...` (operator) to approve or deny.
5. `POST /api/agents/:id/freeze` / `.../unfreeze` (operator) — the stop button.

**To let an agent earn** (routes exist; the end-to-end path is unverified with real traffic — see bucket B):
1. `POST /api/earning-endpoints {agentId, originUrl, priceUsd, label}` (operator) — returns a `forwardSecret` **exactly once**, in the create response only.
2. The customer's own origin server must independently implement HMAC signature verification (a reference implementation ships in `src/gateway/signing.ts::verifySignature`) and serve a well-known file at `/.well-known/fuel-origin-verification` echoing a Fuel-issued nonce.
3. `POST /api/earning-endpoints/:id/verify` (operator) — Fuel probes the origin (ownership proof + two bypass probes) and will not enable the endpoint until all pass.
4. `PATCH /api/earning-endpoints/:id {enabled:true}` (operator).
5. Public payers then call `GET /earn/:publicId` with an x402 payment header — no Fuel credential involved; this is Fuel's only unauthenticated, public-internet-facing route.

**To connect QuickBooks and post real spend (and, once walked-through, revenue):**
1. `POST /api/integrations/quickbooks/connect` (operator) → operator completes OAuth in a browser.
2. Callback lands at `/integrations/quickbooks/callback`, mounted outside `/api` (unauthenticated — a browser redirect carries no bearer token).
3. `POST /api/integrations/quickbooks/setup-accounts` (operator) — verifies the company's books are USD, creates/reuses four accounts.
4. `PATCH /api/integrations/quickbooks/config` (operator) — contra account kind, rollup grain.
5. `POST /api/postings/run` (operator) — runs the rollup engine (safe to call repeatedly).
6. `POST /api/integrations/quickbooks/preview {day, direction, counterparty}` (operator) — freezes a draft; direction is required, no default.
7. `POST /api/integrations/quickbooks/post {draftId}` (operator) — sends the frozen payload to Intuit.
8. `.../postings/:id/trace` (operator) — the full drill-down back to underlying payments/receipts and, where one existed, the human approval.
9. `.../postings/:id/reverse` (operator) — a correction, never an edit.

**Exports:** `GET /api/exports/transactions.csv` and `GET /api/exports/postings.csv` (operator).

**NOT BUILT, and worth saying plainly since it changes what "integrate" even means:** there is no way to onboard a *second* real customer today. The single-company assumption (`getDefaultCompany()`) is load-bearing throughout the API, `createCompany` has no route, and there is no per-customer credential. "Integrating a company" right now means configuring the one Fuel deployment that exists, not signing up as a tenant of a multi-customer product.

## 5. What integration model does the code imply?

**A gateway/proxy, in both directions — not a REST API that hands back primitives, not an SDK, and not an MCP tool.** There is no MCP surface anywhere in the codebase (checked: no references in `package.json` or `src/`), and no client SDK package exists in this repo.

- **Outbound (spend):** `POST /agents/:id/pay {url}` does the *entire* payment inside one call — decide, sign, deliver, settle, return the merchant's response body. A calling agent never handles a signature, a facilitator call, or a settlement check itself; Fuel is a synchronous proxy that happens to also apply policy.
- **Inbound (earn, 6A-2):** ADR 0011 records this as a deliberate choice among three shapes — a fronting gateway, an SDK the customer mounts in their own server, or a receiving-account-only model — and picks the gateway specifically because the alternative would make Fuel's ledger "half evidence and half hearsay": an SDK reports what happened from the customer's own server, while a gateway means *Fuel itself* is the thing that witnessed the payment. The concrete shape this produces: the customer's origin keeps running, but a payer never reaches it directly — `GET /earn/:publicId` is Fuel sitting in front of it, verifying payment, forwarding the request, and relaying the response, the same shape as a reverse proxy or a CDN, with billing built in. The customer's own server is expected to *reject* any request that didn't come through Fuel's signature.

So directionally: Fuel is **the payment-proxy an agent spends through**, and (once its live path is actually walked) **the reverse-proxy a customer's paid API sits behind**. Both are infrastructure-in-the-request-path models, which is also why ADR 0011 is explicit that this "makes Fuel production infrastructure in a customer's request path" and takes on an availability obligation ("if Fuel is down, the customer's paid API is down") that nothing in the current deployment (loopback-bound, no health story beyond `/health`, no SLA) is built to meet yet.
