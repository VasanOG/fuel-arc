# 0011 — The earning side: a Fuel-hosted gateway, and agent-owned endpoints

**Status:** accepted
**Date:** 2026-08-31
**Builds on:** [0002](./0002-payment-protocol.md),
[0003](./0003-own-wallet-vs-governance-layer.md),
[0009](./0009-activity-data-contracts-and-tenancy-scope.md)
**Companion:** [0012](./0012-revenue-in-the-ledger.md) settles how money
received becomes a posting. This document settles where it comes from and
where it is recorded.

## Decision

Phase 6 gives an agent a second capability: it can be paid.

1. **Fuel hosts the paywall.** An operator registers an origin URL their team
   already serves. Fuel fronts it — issues the 402, verifies payment through
   the facilitator, and only then forwards the request to the origin and
   returns its response.
2. **The agent owns the earning endpoint.** Not the team, not the company. An
   agent is the thing that spends and the thing that earns.
3. **Money received never raises what an agent may spend.** A spend cap stays
   a ceiling on outflow. There is no path by which earning relaxes it.
4. **Inbound payments live in a new `receipts` table.** Not a `direction`
   column on `payments`.
5. **Fuel takes no fee.** The customer receives the gross amount. Every
   revenue posting stays a two-party entry.

This document does not implement any of it, and deliberately sketches rather
than specifies the schema — the same posture [0007](./0007-accounting-integration-posting-model.md)
took before the QuickBooks integration existed, and for the same reason: so
that the slice which builds this does not open by re-deriving decisions
already made.

## Why

### The paywall goes in front, not in a library

Three shapes were available.

**A gateway.** The customer points Fuel at their origin. Fuel answers the
402, takes the payment, forwards the call.

**An SDK.** Fuel ships middleware the customer mounts in their own server.
Their server takes the payment and tells Fuel about it.

**A receiving account only.** Fuel issues somewhere for money to land and the
customer wires up x402 themselves.

The gateway wins on a single argument, and it is the same argument the
outbound side already rests on: **Fuel's ledger is worth something because
Fuel saw the thing it is reporting.** Every claim the product makes today —
that an agent spent $0.03, that a cap held, that a payment was refused — is
backed by Fuel having been in the path when it happened. That is why
`payments` is a record and not a feed.

An SDK inverts that. Revenue would arrive as a report from the customer's
server, and the ledger would become a summary of what Fuel was told. The
moment the two disagree — a dropped call, a retry, a bug in their handler,
or simply a payment their server took while ours was unreachable — Fuel has
no way to adjudicate, because it holds no independent record. "One P&L" made
of half evidence and half hearsay is not one P&L; it is a spend ledger
stapled to a revenue estimate. The receiving-account option is worse still:
it cannot attribute an inbound payment to an endpoint or an agent at all,
which is precisely the attribution [0007](./0007-accounting-integration-posting-model.md)
argued was the thing Fuel uniquely has.

**The cost, stated plainly.** This makes Fuel production infrastructure in a
customer's request path, and it takes on an availability obligation the
product does not have today. Right now, if Fuel is down, agents cannot spend
— annoying, contained, and arguably the safe failure. Under a gateway, if
Fuel is down, the customer's paid API is down and they lose revenue. That is
a materially different promise, and it is not one this codebase is currently
built to keep: the server binds `127.0.0.1` ([src/server.ts](../../src/server.ts)),
there is no deployment story, no health checking beyond a `/health` route,
and no notion of an SLA anywhere. Accepting the gateway means accepting that
those become real work, and the blueprint sequences them rather than
pretending they are free.

There is also a security consequence. Fuel would be fetching a URL a customer
supplied, which is exactly the shape [safe-fetch.ts](../../src/lib/safe-fetch.ts)
exists to defend. That guard is already good — it checks literal IPs up
front, re-validates every redirect hop, and validates names inside the DNS
lookup to defeat rebinding. But its loopback exemption is documented as a
deliberate trade for one reason only: *"Fuel pays its own /paid-hello test
merchant on localhost."* The comment names its own expiry condition —
*"revisit if Fuel ever fetches URLs from a less trusted source than an
authenticated operator"* — and a registered customer origin is that
condition arriving. The gateway slice must revisit it rather than inherit
it.

### Fronting is only real if the origin refuses direct traffic

A gateway enforces a paywall on **the path through the gateway**. It does
nothing whatsoever to the origin, which remains exactly as reachable as it
was before the customer registered it. If the origin still answers anyone who
calls it, then Fuel has not put a paywall in front of an API — it has added a
second, paid route to an API that is still free by its original address.

That is not a hardening detail to sweep into a later slice; it is the central
promise of decision 1 going unenforced at the only layer where enforcement
counts. And the origin URL is not a secret in any meaningful sense: it is a
normal API host, discoverable through DNS, a log line, a CORS header, a
referrer, or a lucky guess.

So the gateway is only half the mechanism. The other half is that **the origin
must be able to tell a Fuel-forwarded request from a direct one, and refuse
the direct one.** The design must therefore give the customer something to
check — a shared secret or a signature over the forwarded request that Fuel
holds and a direct caller cannot produce — and the instruction to require it
is part of the product, not an optional deployment note. An origin that has
not adopted it is not protected, and Fuel should be able to say so rather
than implying a paywall it is not delivering.

The exact mechanism is 6A-2's to choose. The requirement that there be one is
settled here, because a design that omits it produces a product whose headline
claim is false.

### The agent earns, because the agent is the unit the product is about

Fuel's whole claim ([0003](./0003-own-wallet-vs-governance-layer.md)) is that
an agent is an economic actor with its own wallet, its own cap, its own
approvals, its own stop button. Making the *company* the earner would say
something different: that agents spend and organisations earn, which is the
shape of a normal expense-management tool with a billing page bolted on.

Owning it at the agent level also makes the phase's headline question
answerable without inventing anything. "Is this agent profitable?" is a join
across two tables keyed by the same `agent_id`. Owned at company level, that
question has no answer at all — spend would be attributed per agent and
revenue would not, so the only P&L expressible would be the org-wide one,
and per-agent margin would be permanently out of reach. Team and company
P&L still roll up for free through the existing hierarchy; the reverse is
not true.

**An agent that only earns is a coherent thing.** Its spend cap is still
meaningful and can sit at zero — that is a serving agent that cannot spend,
which is a real configuration rather than a degenerate one. Nothing in the
existing model needs an exception for it: `spend_cap_base_units` of 0 already
means "may not spend," and freeze already means "may not pay." What freeze
means for an agent's *earning* is deliberately left open below.

### Earning does not fund spending, and the schema enforces it

This is the load-bearing money-safety decision in the phase.

The existing hierarchy docblock ([src/db/index.ts](../../src/db/index.ts))
is careful about what a cap is: the three caps are *"INDEPENDENT ceilings,
not an allocation,"* and what each one bounds is *"money that actually moved
beneath it."* A cap is a policy statement — what this agent is permitted to
spend — and it is deliberately not a function of what the agent holds. That
is why an agent with a funded wallet and a $0 cap cannot spend, and why the
system does not need to read a balance to decide whether a payment is
allowed.

Letting revenue raise a cap would quietly dissolve that. An agent's spending
limit would become a function of its own activity, which means an agent
could enlarge its own authority by doing more of what it does. There is no
existing control that contemplates this. Every guardrail in the codebase —
the cap check, the anomaly detector, the velocity limiter, the approval
queue, freeze — assumes the ceiling is set by a human and moves only when a
human moves it. A self-raising cap is a new class of risk with no
corresponding guard, and the honest way to add it would be to design that
guard first.

So: earnings accrue to a balance. Withdrawal is by bank transfer, an
operator action, and an operator who wants a productive agent to spend more
raises its cap deliberately. The product loses a nice story ("agents that
fund themselves") and keeps an invariant that is worth more than the story.

### `receipts`, not a direction column on `payments`

The tempting option is one money table with a `direction` column. Every
query, export, filter and presentation helper is reused untouched, and no
foreign key has to be rebuilt. It was rejected for two reasons, the first of
which is decisive.

**`payments.status` is defined around failing closed outward, and inbound
fails closed the other way.** The schema comment on `unreconciled` is
explicit: *"failed AFTER signing. An EIP-3009 authorization is spendable by
the facilitator until it expires, so we must assume the money moved and keep
the budget consumed."* The whole status vocabulary encodes one direction of
caution — when Fuel does not know, it assumes money **left**. For an inbound
payment the cautious assumption is the exact inverse: when Fuel does not
know whether money arrived, it must assume it did **not**, because counting
unconfirmed revenue overstates what a customer has earned and would flow
straight into their books.

Housing both in one table means one column whose values mean "assume yes" in
some rows and "assume no" in others, distinguished by a second column that
every reader must remember to check. This codebase's comments warn about
exactly this shape repeatedly, and the `unreconciled` bug named at
[src/db/index.ts](../../src/db/index.ts) — two copies of a status list that
drifted — is the same family. `receipts` gets its own status vocabulary,
reasoned from the inbound direction rather than copied from
`PAYMENT_STATUSES`, and the two never have to be read through a discriminator.

**Second: it makes the previous decision structural rather than remembered.**
`COUNTS_AGAINST_CAP` ([src/db/payments.ts](../../src/db/payments.ts)) is a
SQL fragment interpolated into the cap queries. Under a direction column,
every one of those queries would need a direction predicate, and a single
omission anywhere would let earnings consume — or worse, offset — budget,
silently and only under load. With a separate table there is no such
predicate to forget: a receipt is not in `payments`, so it cannot reach a
cap query at all. The invariant is enforced by the schema rather than by
vigilance.

The cost is real and worth naming: `export_postings.payment_id` is
`NOT NULL REFERENCES payments(id)`, so a second source table means that
table changes shape, and the conservation check that sums all `posting_lines`
against ledger-eligible `payments` has to be restated. [0012](./0012-revenue-in-the-ledger.md)
owns that problem and does not relax the invariant to solve it.

### Serving the request is a second decision, and it is not the booking decision

The fail-closed reasoning above governs what Fuel **books**. There is a
separate, earlier decision it does not govern: when Fuel **forwards** the
request to the origin and lets the payer have what they paid for.

x402 gives two moments to choose between. `verify` says the payment is
well-formed and the authorization is spendable. `settle` says the money
actually moved. Forwarding on `verify` is the fast path and is common,
because settlement is slower and is often done after serving.

The outbound side of this codebase has already ruled on the equivalent
question, and ruled against the fast path. `payForAgent` treats a resource
that unlocked without evidenced settlement as a **failure**, not a success:

```ts
if (!txHash) {
  markUnreconciled(reservation.paymentId, "unlocked without a settlement tx hash");
  return { outcome: "failed", reason: "Resource unlocked but settlement was not evidenced." };
}
```

Inbound is the same exposure with the loss pointed the other way. Forwarding
on `verify` alone means Fuel gives away the customer's paid API call before
knowing the money arrived — and if it never arrives, the customer served
traffic for free on Fuel's decision, not their own.

This document does not force the fast path closed, because the latency cost
is real and the right answer may differ per endpoint. What it does settle is
the accounting posture, and it is not negotiable: **a request forwarded
before settlement is confirmed is an exposure, and it is recorded as one.**
It is never treated as revenue on the strength of `verify`, and it is never
invisible. That is the same standard `unreconciled` holds outbound, which is
why the receipts vocabulary has to model this state explicitly rather than
collapsing "served" and "paid" into one status.

### Fuel drives the x402 primitives rather than using `paymentMiddleware`

Decided during implementation, and it changed the shape of the slice.

`@x402/express` ships a middleware that does the whole flow, and the ordering
it implements is the one this document wants: it buffers the handler's response
and flushes only after settlement confirms, and it skips settlement entirely
when the handler returns ≥400. Adopting that ordering was right. Adopting the
middleware was not.

Every lifecycle event it exposes is a hook, and `@x402/core` wraps each hook
invocation in a `try/catch` that only `console.warn`s
(`server/index.mjs:970-980`). A receipt write that threw inside `onAfterSettle`
— a transient SQLite busy, a bug, a full disk — would be swallowed: settlement
still succeeds, the payer still receives their response, the money still moves,
and the row stays `awaiting`, with nothing raised anywhere. **That is this
document's own premise failing**: Fuel's ledger is worth something because Fuel
witnessed what it reports, and a silently dropped write is exactly that claim
breaking.

`processHTTPRequest`, `verifyPayment` and `settlePayment` are public API — the
middleware consumes them, it does not gate them. Driving them directly puts
every state transition in ordinary control flow where a throw propagates, and
removes three further hazards: the middleware's buffering does not cover
`res.setHeader`, so handler headers survive onto its error responses; its
`await endPromise` hangs forever if a handler returns without ending; and its
route table is fixed at construction, which runtime-registered endpoints with
per-row prices have no clean way into.

**The ordering, stated once: verify → claim → fetch origin → settle → deliver.**
The payer receives nothing until settlement confirms, and an origin failure
means Fuel never settles — so the case with no remedy under x402, money taken
for something never delivered, cannot arise. The mirror exposure is real and
accepted: an origin can do work for a payment that later fails to settle. It is
bounded by the rate limiter and by the replay defence, and it is the cheaper of
the two.

### No fee, this phase

A take rate would make every revenue posting three-party — gross revenue, a
fee expense, a net — and would need a fourth QuickBooks account, a fee-rate
configuration surface, and a story for what happens when a rate changes
between a payment and its posting. None of that is required to make the
earning side *work*, and building it first would gate the whole phase on a
business-model decision that has not been made.

Nor is a zero-valued fee field carried "for later." A column fixed at zero
with dead code paths around it is design for a hypothetical, and this
codebase does not do that. Adding a fee later is a migration and some
posting work; it is not made meaningfully cheaper by a placeholder now, and
a placeholder invites the fee to be read as decided.

## The shape, sketched

Working names. Real schema design happens in the slice that builds this,
following the established migration patterns.

**`earning_endpoints`** — what an operator registered. Belongs to an agent.
Carries the origin URL Fuel forwards to, the price in base units, an enabled
flag, and timestamps. The public path Fuel serves it on must be an opaque
identifier Fuel issues, not the origin's own hostname: the origin URL is
infrastructure detail and there is no reason to leak it to payers.

**`receipts`** — one row per inbound payment Fuel witnessed. References the
endpoint and, through it, the agent. Carries the amount in base units, a
status, the settlement reference, and two distinct timestamps for the same
reason `payments` has two: when Fuel first saw the request, and when the
money was confirmed received.

Its **status vocabulary had to be reasoned out from the inbound direction** —
what Fuel knows, when it knows it, and what the cautious assumption is at
each point — rather than mirrored from `PAYMENT_STATUSES`, whose members were
each argued for a payer that had already signed something spendable. Symmetry
would have been the wrong instinct.

**Settled in 6A-1 rather than 6A-2, as this document originally deferred.**
The reason is mechanical: `export_postings.receipt_id` references `receipts`,
and adding a foreign key to an existing SQLite column means rebuilding the
table. Creating `receipts` one slice early costs an empty table; deferring it
would have cost a second rebuild of the absorption table — the one this
project's own notes call the most delicate migration it has attempted. The
vocabulary lives in `src/db/receipts.ts` with its reasoning:

| status | meaning | in the books? |
|---|---|---|
| `awaiting` | verified and claimed; the origin has not been called yet | no |
| `abandoned` | the origin failed, so **settlement was never attempted** | no |
| `served_unsettled` | the origin served; settlement then definitively failed | **no** |
| `settle_unknown` | the origin served; the settle call **threw** | **no** |
| `settled` | settlement confirmed, money arrived | yes |

`served_unsettled` is the state the design review demanded and the reason the
vocabulary could not be copied: it has no outbound analogue, because outbound
Fuel is the one who pays rather than the one who delivers first. It is
deliberately outside `APPEARS_IN_RECEIPT_LEDGER` — an exposure the operator
can see, not revenue the customer's accountant is told about.

**`settle_unknown` was added during implementation**, and it exists because
`HTTPFacilitatorClient.settle` raises a plain `Error` on a network failure —
indistinguishable from a settlement that landed. That is the inbound analogue
of `unreconciled`, and this codebase's own lesson is that "we do not know" must
never collapse into "it failed." It stays out of the books, per the fail-closed
direction above, and is reconcilable later against the chain.

`awaiting` doubles as the crash marker. A receipt is claimed *before* the
origin is called, so a process that dies in between leaves one behind — and
because the claim is what enforces replay protection, a stranded row would
permanently burn that payer's authorization nonce. A fourth reaper pass in
`src/server.ts` resolves them to `settle_unknown`, not `abandoned`: a crash
could have happened either side of the settle call.

There is no `blocked`. Fuel does not refuse inbound money on a policy basis,
because there is no inbound cap. If that changes it is a new status with its
own argument, not a reuse of one of these.

## What this document does not decide

- **Deployment.** Where the gateway runs, how it is reached from the public
  internet, what the availability target is, and what happens to a
  customer's endpoint when Fuel is degraded. Real work, sequenced in the
  blueprint, and the largest unknown in the phase.
- **Rate limiting and abuse of volume.** A public paid endpoint invites
  traffic Fuel has never had to absorb. Nothing here decides how that is
  bounded.
- **Abuse of destination, which is a different problem from SSRF.**
  `safe-fetch` exists to stop Fuel reaching private, link-local and metadata
  space. A correctly-fixed guard still allows every *public* address, by
  design — so a gateway forwarding to an operator-chosen origin is, in shape,
  a relay: Fuel's IP, pointed at a target of the registrant's choosing, for a
  fraction of a cent a call. Registration is operator-gated, so this is not
  anonymous, but an operator credential is not a strong enough control on its
  own for "which host may Fuel send traffic to." Whether the design requires
  proof that the registrant controls the origin — and what is forwarded at
  all, given that method, headers and body originate with an anonymous payer
  — is the gateway slice's to answer. It is called out separately here
  because folding it into "rate limiting" would lose the distinction: the
  concern is not how much traffic, it is where it is aimed.
- **How the origin's response is relayed back.** Whether response headers
  pass through verbatim (`Set-Cookie` and cache directives from a
  customer-controlled origin are the obvious hazards), and what bounds exist
  on response size and streaming.
- **How unguessable the public endpoint identifier must be.** The payment
  challenge is the gate, not path secrecy, so this is not load-bearing for
  payment — but a trivially enumerable identifier would let anyone map a
  customer's registered endpoints and their prices.
- ~~**Where the earned balance actually sits.**~~ **Settled by
  [0013](./0013-where-the-earned-balance-sits.md) (2026-09-15).** The original
  text is kept below because its warning was accurate and 0013 answers it
  directly rather than dissolving it.

  > "Accrues to a balance, withdrawn by bank transfer" settles the *policy*; it
  > does not settle whether that balance is a segregated ledger figure or the
  > same custodial wallet the agent signs outbound payments from. The
  > distinction matters more than it looks. A cap is a policy ceiling and never
  > rises either way — but an agent whose cap was previously academic for want
  > of funds could, after earning into a shared wallet, have the liquidity to
  > exercise a ceiling it already held. That does not violate the invariant
  > above, and it is close enough to the self-funding story this document
  > rejects that it should be chosen deliberately rather than inherited from
  > whichever custody arrangement is easiest to build.

  0013's answer: the shared wallet is accepted and chosen, because the
  operator-set cap is the authority on spending and liquidity never was one.
  The liquidity effect this bullet predicted is real, is intended, and carries
  one obligation — every cap must be reviewed as a deliberate figure before a
  company earns, since this is what converts the cap table from theoretical to
  binding.
- **What freeze means for earning.** Freeze today means "this agent may not
  pay." Whether freezing an agent should also stop it *being* paid is a
  genuine product question with a defensible answer either way, and it is not
  settled here.
- **Refunds, chargebacks, or disputes** on money received.
- **Withdrawal mechanics** — the bank-transfer path by which a customer takes
  earned money out, beyond the decision that this is how it leaves.
- **The safe-fetch loopback exemption's replacement.** Named as required
  above; the actual policy is the gateway slice's to write.
- **Anything about mainnet.** This is sandbox work, on the pinned constants,
  like everything else.

## Consequences

- **Fuel acquires an availability obligation it does not have today.** This
  is the real price of the gateway and it should be visible in planning, not
  discovered during it.
- **`safe-fetch`'s loopback exemption becomes a live issue.** It is correct
  today and stops being correct the moment a customer-supplied origin is
  fetched. The condition for revisiting it is already written in the file.
- **The `no-crypto-surface` rule now has a second frontier.** Registration
  must never return a receiving address, and the existing grep check has to
  cover the earning paths. A payer-facing 402 is protocol, not product
  surface, but anything a *customer* sees about their own endpoint is.
- **`export_postings` and the conservation check change shape**, because
  posted units will originate in two tables rather than one. [0012](./0012-revenue-in-the-ledger.md).
- **An agent's row is no longer only about spending**, and a good deal of
  spend-framed copy across the dashboard becomes half-true. That is a
  rewrite, not a find-and-replace, and the blueprint treats it as one.
- **Per-agent profitability becomes expressible**, which is the thing this
  phase is for. It also becomes the first number in the product computed by
  subtracting one real quantity from another, which raises a question the
  blueprint must answer explicitly: which set of statuses a P&L figure means,
  given that `COUNTS_AGAINST_CAP` and `APPEARS_IN_LEDGER` differ by design.
