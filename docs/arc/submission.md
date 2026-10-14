# Arc Microgrants: submission text

**Project:** Fuel, spend controls for AI agents, live on Arc mainnet
**Try it:** https://vasanog.github.io/fuel-arc/arc/ (press Buy; Fuel decides, live, with real USDC on Arc)
**Fuel's dashboard:** https://fuel-arc-demo.fly.dev (company `default-company-neef`, email `judges@fuel.demo`, password `fuel-arc-judge-bb3ddd`)
**Repository:** https://github.com/VasanOG/fuel-arc (CI runs the full test suite, including the Arc lock checks, on every push)

## Try it yourself (two minutes)

1. Open the proof page and press **Buy basic ($0.001)**. Fuel checks the agent's caps, signs, and the shop settles on Arc mainnet. You get the explorer link a few seconds later.
2. Press **Buy unusual ($0.005)**. That amount is out of character for this agent, so Fuel **holds** it. Nothing is signed and no money moves.
3. Sign in to **Fuel's dashboard** with the judge login above and open **Approvals**. Approve the held payment; the approval is recorded under your account. The agent then completes the payment by itself within a few seconds, and it appears on the proof page and in the **Activity Ledger**.
4. Press **Buy ceiling ($0.01)** twice in a minute. The second is **refused** by Fuel's rate limit ($0.02 a minute), before anything is signed.

The dashboard's environment badge says "Live: real money on Arc" because it is: every paid row is a real USDC transfer on Arc mainnet.

## Short description

Fuel is a wallet and spend-control layer for AI agents. An agent asks Fuel to pay for something. Before anything is signed, Fuel checks:
- the agent's own spend cap, then its team's and its company's;
- whether the amount is unusual for this agent, in which case it holds the payment for a person to approve;
- whether the agent is spending too fast;
- whether an operator has frozen it.

Every payment Fuel reserves budget for lands in a ledger, paid, held or refused, and the ledger rolls up into accounting exports. (A few refusals happen before any reservation, such as a frozen agent; Fuel counts those rather than writing a row, and the proof page shows them separately.)

On Arc, one agent pays real USDC on Arc mainnet through all of those controls. As of submission it has made 11 payments ($0.028 in total), including payments that were held for approval and then approved by a person, and payments refused by the rate limit, the agent's cap and a freeze. The proof page lists every attempt with Fuel's decision and links each payment to its transaction on Arc's explorer. It also re-checks both wallets' balances live from the visitor's own browser, against Arc mainnet directly.

## What it uses Arc for

- **USDC as money and as gas.** Payments are USDC transfers on Arc, and the shop pays the network fee in USDC too: about $0.0017 per settlement, measured. Nothing in the flow touches a second token.
- **EIP-3009 on Arc's native USDC** (`0x3600…0000`). The agent signs a `transferWithAuthorization` and the shop submits it, so the agent never needs to hold gas.
- **Settlement fast enough to pay per call.** A $0.001 to $0.01 payment is quoted, signed, settled and confirmed within one paid request (x402: a quote, then the paid request). We found no third-party x402 facilitator for Arc mainnet that we could vet, so the shop settles its own payments with the x402 library's facilitator code, narrowed so it can submit nothing but that one transfer.

## Who operates what (please read)

- **I operate the shop.** It is a three-item demo priced at $0.001, $0.005 and $0.01, so the controls have something real to pay for.
- **All four wallets are mine:** the agent, its wallet, the shop and the shop's wallet. Every payment, including the ones judges trigger, moves my own USDC from my agent's wallet to my shop's wallet. No customer funds are involved.
- **Hard limits in code:** at most $0.01 per payment and $5.00 over the agent's life, with $5.50 funded into the agent's wallet, so the chain itself also bounds what it could ever spend. For judging, the agent's Fuel cap is set to $1 above what it had already spent.
- **The public "Try it" button has limits of its own,** checked before anything reaches Fuel: $0.20 a day in total, a few attempts per visitor, a pause switch, and it closes itself if either wallet runs low. It holds only the agent's Fuel credential; it cannot approve anything, change a cap, or name any other payee or amount.
- **The judge login is a shared operator account.** Judges can approve held payments and change the agent's cap. The hard limits above still apply whatever they change.
- **Only this one agent pays on Arc.** It is named in code by id, company and wallet address. Every other agent and company in Fuel stays on test money, with every testnet guard unchanged. `scripts/verify-arc-lock.ts` (278 checks) holds that lock, the Try-it door's limits and the dashboard's labels, and runs in CI on every push. Each part of the lock, and each of the door's stops, was also deliberately broken one way at a time to confirm its own check catches the break.

## How to check it

1. Press Buy on the proof page, or open any paid row's explorer link: https://explorer.arc.io.
2. The agent and shop addresses link to their explorer pages, which show every transfer between them.
3. Sign in to the dashboard and compare its Activity Ledger with the explorer.
4. Download `proof.csv` (attempts with transaction hashes and explorer links) or `ledger-export.csv` (Fuel's own accounting export for the same agent, with no crypto identifiers, by design).
5. The code: `src/payments/arc-chain.ts` (the one Arc agent and its limits), `src/payments/arc-demo.ts` (the lock and the signer), `demo/arc-shop/` (the shop and its settler), `demo/try-it/` (the public button and its limits), `deploy/fly/` (how the live demo runs), and `scripts/verify-arc-lock.ts` (the checks; `npm run verify-arc-lock`).
