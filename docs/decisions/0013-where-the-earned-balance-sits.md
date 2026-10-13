# 0013 — Where the earned balance sits: the cap is the authority, not the wallet

**Status:** accepted
**Date:** 2026-09-15
**Closes:** the "Where the earned balance actually sits" open item in
[0011](./0011-the-earning-side.md)
**Builds on:** [0001](./0001-custody-provider.md) (custody is Fireblocks),
[0011](./0011-the-earning-side.md) (money received never raises a spend cap)

## Decision

1. **Earnings land in the agent's own custodial wallet** — the same Fireblocks
   vault it signs outbound payments from. This is what the code already does;
   this document is where it stops being inherited and becomes chosen.

2. **The operator-set cap is the sole authority on what an agent may spend.**
   An agent may spend as much as the operator wants it to spend. Liquidity is
   not a control, was never a control, and must not be relied on as one.

3. **No segregated earned balance, and no second wallet.** There is no
   "earnings" pot distinct from the spending pot, because the distinction would
   buy nothing the cap does not already provide and would cost a custody
   arrangement, a transfer path between the two, and a second set of balances
   to keep honest.

4. **One obligation follows, and it is not optional:** every agent's cap is
   reviewed as a deliberate figure before its company is allowed to earn. See
   Consequences.

## Why

### 0011 asked for this to be chosen, not inherited

0011 listed it among the things it did not decide:

> **Where the earned balance actually sits.** "Accrues to a balance, withdrawn
> by bank transfer" settles the *policy*; it does not settle whether that
> balance is a segregated ledger figure or the same custodial wallet the agent
> signs outbound payments from. The distinction matters more than it looks. A
> cap is a policy ceiling and never rises either way — but an agent whose cap
> was previously academic for want of funds could, after earning into a shared
> wallet, have the liquidity to exercise a ceiling it already held. That does
> not violate the invariant above, and it is close enough to the self-funding
> story this document rejects that it should be chosen deliberately rather
> than inherited from whichever custody arrangement is easiest to build.

The gateway was built the easy way: `src/gateway/route.ts` passes
`agent.address` as `payTo`, and `provisionAgentWallet`
(`src/fireblocks/provision.ts`) gives each agent exactly one vault. So the
shared-wallet arrangement is live. 0011's warning has already arrived; what
was missing was the decision.

### The invariant holds literally, and that is not a technicality

0011's third decision is *"Money received never raises what an agent may
spend."* That remains true in the strict sense, and it is enforced structurally
rather than by convention. `reserveIfUnderCap` (`src/db/payments.ts`) reads the
three ceilings and compares them against **spend totals**:

```
const agentCap = BigInt(hierarchy.agent_cap);
const spent = spentBaseUnits(agentId);
if (spent + amountBaseUnits > agentCap) { … refuse … }
```

No balance is read anywhere in the cap path — not the agent's, not the team's,
not the company's. `getVaultUsdcBalance` exists, is best-effort, returns `null`
on failure, and its own comment says it "cannot move funds or affect a cap
decision, so it deliberately sits outside the money-safety-reviewed
cap/payment path." Earning changes a balance. It does not change a cap, and no
code path lets it.

### What earning actually changes, stated plainly

It changes an agent's *ability to reach* a ceiling the operator already
granted. That is the whole of the effect, and it is the right effect.

A cap is a statement of intent: *this is what I want this agent to be able to
spend.* It is not a prediction about funding. When an operator sets a $50 cap,
they have said the agent may spend up to $50 — not "up to $50, but I am
relying on it being broke." An agent that earns its way to solvency and then
spends within its granted ceiling is the system working exactly as designed.

0011 reached the same conclusion from the other direction when it rejected
self-funding:

> an operator who wants a productive agent to spend more raises its cap
> deliberately.

The mirror of that sentence is this document: an operator who does *not* want
an agent to spend more lowers its cap deliberately. In both directions the cap
is the instrument. Making liquidity a second, implicit ceiling would mean the
product had two controls where it documents one, and the undocumented one
would move on its own.

### Why not a segregated balance

The alternative is an earned pot the agent cannot spend from, with a transfer
into the spending pot as an operator action. It is superficially the safer
design, and it was rejected for three reasons.

**It does not add a control, it duplicates one.** The thing a segregated
balance would prevent is "agent spends more than the operator intended" — which
is precisely what the cap prevents, atomically, inside `BEGIN IMMEDIATE`, at
three levels, with an approval path and a freeze for the exceptions. A second
mechanism aimed at the same risk is not defence in depth when the first one is
already the authority; it is a second thing that can disagree with the first.

**It would make the cap a lie.** With two pots, the real spending limit becomes
`min(cap, transferred balance)` — a number that appears nowhere, that no
operator sets, and that the dashboard would have to either display or hide.
0011's whole argument against self-funding is that *"a self-raising cap is a
new class of risk with no corresponding guard."* A self-*lowering* effective
cap is the same defect wearing a safer-looking coat: the number a human set is
not the number the system enforces.

**It buys a custody problem.** Two pots means a second vault per agent, a
transfer path with its own authorization story, and two balances to reconcile
against one ledger. Under 0001 that is real Fireblocks surface area, and it
would be introduced to solve a problem the cap already solves.

### What this does not soften

The cascade is untouched. Agent, team and company ceilings all still apply, all
still come from one atomic snapshot inside the same transaction, and a payment
must pass every one of them. Freeze still stops an agent paying, ahead of every
cap and ahead of approval validation. The anomaly detector and velocity limiter
are unchanged. Nothing here removes a guard; it declines to add a redundant
one.

## What this document does not decide

- **Withdrawal mechanics.** Still 0011's open item. This document settles where
  the money sits, not the bank-transfer path by which it leaves. For a sandbox
  beta on testnet funds, nothing real needs to leave yet.
- **What freeze means for earning.** Still open, still 0011's. Freeze today
  stops an agent paying; whether it should also stop it being paid is a
  separate product question, and this document's answer to the balance question
  does not prejudge it.
- **Refunds, chargebacks or disputes.** Unchanged and still open.
- **Anything about mainnet.** Sandbox work on pinned constants, like
  everything else.

## Consequences

**Every cap in the system becomes binding, and some of them were never meant
to be.** This is the real cost of this decision and the reason decision 4
exists. A cap that has only ever been safe because the wallet behind it was
empty is now a live authorization. Any default value, any figure typed during a
Phase 1 test, any number picked when funding made it academic — each becomes
spendable the moment that agent earns.

So the cap table converts, all at once, from theoretical to binding. Before any
company is allowed to earn in the beta, its caps are reviewed as deliberate
figures at all three levels. This is a gate on the beta, not a follow-up task.

**The dashboard's spend-framed copy gets more wrong, not less.** 0011 already
flagged that an agent's row "is no longer only about spending." This decision
sharpens it: "Spend authority is the ceiling it cannot pass" stays accurate
about the cap and becomes an incomplete description of an agent that also
earns into the same wallet. Slice 6B-3 owns that rewrite.

**A productive agent's effective behaviour changes without any operator
action.** An agent that earns steadily will, over time, be able to exercise
more of its granted ceiling than it could before. That is intended and is not
a cap change — but it is a behaviour change an operator should not have to
deduce, which is an argument for the per-agent earned/spent/net figures that
slice 6B-3 puts on the Agents page.

**No code changes.** The implementation already matches this decision. What
changes is that it is now written down, so the next person to touch the
gateway's `payTo` knows the single-wallet arrangement is load-bearing and
chosen, not an accident to be tidied up.
