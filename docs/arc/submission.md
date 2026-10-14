# Arc Microgrants: submission text (draft)

**Project:** Fuel, spend controls for AI agents, live on Arc
**Link:** the proof page (`docs/arc/index.html`) via GitHub Pages — URL set once the repo is public
**Repository:** https://github.com/VasanOG/fuel-arc

## Short description

Fuel is a wallet and spend-control layer for AI agents. An agent asks Fuel to pay for something. Before anything is signed, Fuel checks:
- the agent's own spend cap, then its team's and its company's;
- whether the amount is unusual for this agent, in which case it holds the payment for a person to approve;
- whether the agent is spending too fast;
- whether an operator has frozen it.

Every attempt lands in a ledger that rolls up into accounting exports.

On Arc, one agent has made real, governed USDC payments on Arc mainnet: 9 payments, $0.022 total, each checked by every control above before it was signed — including two that were held for approval, then approved with the operator key and paid, and three that were refused outright. The public proof page lists all 13 attempts with Fuel's decision on each, and links the 9 that moved money to their transactions on Arc's explorer. When it opens, the page also re-checks both wallets and every transaction live, from the visitor's own browser, against Arc mainnet directly.

## What it uses Arc for

- **USDC as money and as gas.** Payments are USDC transfers on Arc. The shop pays the network fee in USDC too — about $0.0017 per settlement, measured — so nothing in the flow touches a second token.
- **EIP-3009 on Arc's native USDC** (`0x3600…0000`). The agent signs a `transferWithAuthorization` and the shop submits it, so the agent never needs to hold gas.
- **Fast, cheap settlement.** A $0.001–$0.01 payment is quoted, signed, settled and confirmed inside a single HTTP request, which is what pay-per-call agent spending needs — no facilitator existed for this on Arc mainnet, so the shop settles its own payments, using the x402 library's own code, narrowed so it can submit nothing but that one transfer.

## Who operates what (please read)

- **I operate the shop.** It is a three-item demo priced at $0.001, $0.005 and $0.01, so the controls have something real to pay for.
- **All four wallets are mine:** the agent, its wallet, the shop and the shop's wallet. Every payment moves my own USDC from my agent's wallet to my shop's wallet. No customer funds are involved.
- **Hard limits in code:** at most $0.01 per payment and $5.00 over the agent's life, with $5.50 funded into the agent's wallet, so the chain itself also bounds what it could ever spend.
- **Only this one agent pays on Arc.** It is named in code, by id, company and wallet address. Every other agent and company in Fuel stays on test money, with every testnet guard unchanged. A test suite (169 checks, `scripts/verify-arc-lock.ts`) holds that lock on every change, and before going live each part of it was deliberately broken, one way at a time, to confirm its own check catches the break.
- **Two sources on the proof page.** Most rows come from Fuel's ledger. One refusal happens before Fuel records anything at all — a frozen agent is turned away before any reservation exists — so that row comes from the demo runner's own log instead, and the page says so plainly.

## How to check it

1. Open the proof page. Each paid row links to its transaction on https://explorer.arc.io.
2. The agent and shop addresses link to their explorer pages, which show every transfer between them.
3. Download `proof.csv` (every attempt, with transaction hashes and explorer links) or `ledger-export.csv` (Fuel's real, unmodified accounting export for the same agent — no crypto identifiers, by design).
4. The code: `src/payments/arc-chain.ts` (the one Arc agent and its limits), `src/payments/arc-demo.ts` (the lock and the signer), `demo/arc-shop/` (the shop and its settler), and `scripts/verify-arc-lock.ts` (the checks, runnable with `npm run verify-arc-lock`).
