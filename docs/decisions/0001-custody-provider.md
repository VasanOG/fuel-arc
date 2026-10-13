# 0001 — Custody provider: Fireblocks sandbox

## Decision
Use Fireblocks' embedded wallet infrastructure to create and secure agent
wallets, instead of building our own key-custody system.

## Why
Building custody and key security from scratch is a high-stakes,
security-critical engineering problem — one mistake risks real customer
funds. Fireblocks offers a free, self-serve developer sandbox, so we can
build and prove out the whole product without a sales relationship or real
money involved.

## Ruled out for now
- Building our own MPC/custody stack from scratch — too risky before the
  product itself is proven.
- Coinbase's own consumer wallet product — using it directly would make Fuel
  a thin layer on Coinbase's product rather than our own branded wallet.
