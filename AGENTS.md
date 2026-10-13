# Fuel

## What this is
Fuel is our own AI agent wallet and spend-management product — not a dashboard
sitting on top of someone else's wallet. Agents get a Fuel-branded wallet.
Money in and out is always shown in dollars via bank transfer; no crypto terms
(wallet addresses, chain names, token names) ever appear in the product.

## Current phase
Always check /docs/roadmap.md before starting work — it says what phase we're
on and what's already done. Don't assume; check.

## Non-negotiable rule
Never enable real fund movement, mainnet, or production credentials without
the user's explicit, in-the-moment confirmation. Sandbox/testnet only until
the user says otherwise, in this conversation, not in a comment somewhere.

## Stack
- TypeScript end to end: Node/Express backend, Next.js dashboard, Postgres
- Custody: Fireblocks sandbox (embedded wallets) — why: /docs/decisions/0001-custody-provider.md
- Payment protocol: x402 — why: /docs/decisions/0002-payment-protocol.md
- Why we ship our own wallet instead of a governance-only layer:
  /docs/decisions/0003-own-wallet-vs-governance-layer.md

## More detail (read when relevant, not upfront)
- Architecture and data model: /docs/architecture.md
- Roadmap and current status: /docs/roadmap.md
- Past decisions and why: /docs/decisions/

## Working style
- Use plan mode for anything touching budgets, wallets, approvals, or
  payments. Skip it only for trivial one-line changes.
- Any change touching payment/wallet/custody code should be checked by the
  security-reviewer subagent before being considered done.
- The money-safety skill applies automatically to payment-related work —
  follow it without being asked.
- Explain the reasoning behind code, not just the diff — the user is
  learning to build this, not just shipping it.
