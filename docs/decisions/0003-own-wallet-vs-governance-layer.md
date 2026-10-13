# 0003 — Build our own wallet, not just a governance dashboard

## Decision
Fuel ships its own branded agent wallet with governance features (budgets,
approvals, alerts, accounting) built in from the start — not a dashboard
that only observes wallets from other providers.

## Why
A governance-only layer sitting on top of Coinbase's free wallet has little
to hold onto — anyone can switch dashboards. Building our own wallet, on top
of a neutral custody provider (see 0001), lets us own the whole product
experience while avoiding the risk of building custody security ourselves.

## Sequencing
Phase 1 ships on Fireblocks sandbox, branded as our own wallet. Bringing
custody in-house is a later-stage option once there's real demand — not a
Phase 1 requirement.
