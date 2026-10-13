---
name: money-safety
description: Safety rules for any code touching wallets, payments, budgets, or custody. Applies automatically whenever working on payment-related, wallet-related, or financial logic in this project.
---

# Money safety rules

This project will eventually move real money. Until the user explicitly says
otherwise:

- All wallet and payment operations run against Fireblocks SANDBOX/TESTNET
  only.
- Never write code that could execute a real, mainnet transaction without an
  explicit, in-the-moment confirmation from the user — an actual
  conversation confirmation, not just a config flag.
- Never commit real API keys or secrets. Sandbox keys go in `.env`, which is
  gitignored.
- Any change to budget-cap or approval-check logic should be checked by the
  security-reviewer subagent before being considered done.
- If you are ever unsure whether an action could touch real funds, stop and
  ask the user before proceeding.
