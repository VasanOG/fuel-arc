# Architecture

## Overview
Fuel is a spend-management product for AI agents. Each agent gets its own
Fuel wallet, backed by a custody provider under the hood. Every payment an
agent tries to make passes through Fuel's budget and approval checks before
it's allowed through.

## Data model (v1)
- **Company** — the top-level budget owner.
- **Team** — belongs to a Company; has its own budget, cascading from the
  Company's budget.
- **Agent** — belongs to a Team; has its own budget, cascading from the
  Team's budget; has exactly one Fuel wallet.
- **Transaction** — a payment made by an Agent: amount, timestamp, endpoint
  paid, status.
- **ApprovalRequest** — created when an Agent's requested payment would
  exceed its remaining budget; approved or denied by a human.

## Payment flow (Phase 1 scope)
1. An Agent wants to pay a paid API endpoint.
2. Fuel checks the Agent's remaining budget.
3. If within budget: Fuel's wallet (via Fireblocks) signs and sends the x402
   payment; the transaction is logged.
4. If over budget: the payment is paused, an ApprovalRequest is created, and
   a human is notified.

## Custody
We do not build our own key-management or custody system. Wallets are
created and transactions are signed via Fireblocks' sandbox API. See
`/docs/decisions/0001-custody-provider.md` for why.

## No-crypto-surface rule
No wallet addresses, chain names, or token names appear anywhere in the
product. Funding and payouts happen via bank transfer in the UI, even though
the underlying rail is stablecoin/crypto.

**One narrow, explicit exception**, for as long as there is no card on-ramp:
an agent's own funding address, network and asset may appear on one panel on
its detail page, behind a click, to an operator or owner. See
`/docs/decisions/0019-a-funding-panel-may-show-the-agent-address.md` for the
scope and why it stays that narrow.
