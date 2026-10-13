# Fuel

Fuel is a wallet and spend-control layer for AI agents. An agent asks Fuel to
pay for something; before anything is signed, Fuel checks the agent's own
spend cap, then its team's and its company's, whether the amount is unusual
for that agent (and if so, holds it for a person to approve), whether the
agent is spending too fast, and whether an operator has frozen it. Every
attempt — paid, held, or refused — lands in a ledger, which rolls up into
accounting exports.

This repository is a single-commit public snapshot of the branch built for
**Arc Microgrants**: Fuel's payment controls, running for real, on Arc
mainnet.

## What's real, and what isn't — read this first

- **Exactly one agent pays on Arc, and it's mine.** It's named by literal id
  in `src/payments/arc-chain.ts`. Every other agent and company in this
  codebase — the entire rest of the product — runs on Base Sepolia **test**
  money only, never anything real, and that stays true however many agents
  or companies someone creates with this code.
- **I (the founder) operate both sides of the Arc payment.** The agent's
  wallet and the shop's wallet are both mine. Every payment you see on the
  proof page moves my own USDC from one of my own wallets to the other. No
  customer, investor, or third party's money is involved anywhere in this
  repository.
- **The shop is a three-item demo**, priced at $0.001, $0.005 and $0.01, built
  so Fuel's controls have something real to pay for: an ordinary payment, a
  payment unusual enough to need approval, and the rate limit.
- **Hard limits, enforced in code, independent of anything above them:** at
  most $0.01 in any single payment, and at most $5.00 across that one agent's
  entire lifetime, checked against the ledger before every signature.
- **Everything else in this codebase — the dashboard, the QuickBooks
  integration, accounting exports, the rest of the API — talks to sandbox or
  testnet providers only.** None of it has ever moved real money or touched a
  real company's books. See `docs/roadmap.md` for exactly what's been built
  and verified versus what's designed-but-unbuilt; it doesn't round up.

## What it uses Arc for

Payments use **x402** (an HTTP 402 response carrying a signed EIP-3009 USDC
authorization). On Arc:

- **USDC is both the money and the gas.** The agent signs a
  `transferWithAuthorization` for Arc's native USDC (`0x3600…0000`); the shop
  submits it and pays Arc's network fee, also in USDC — no second token is
  ever involved.
- **No third-party facilitator exists yet for Arc mainnet that this project
  has vetted**, so the shop settles its own payments: it runs the x402
  library's facilitator code in-process, narrowed so it can submit nothing
  but that one transfer function, to nowhere but its own wallet's expected
  counterpart.
- **Settlement is fast enough to pay-per-call:** a $0.001 request is quoted,
  signed, settled and confirmed inside a single HTTP round trip.

## The proof page

`docs/arc/index.html` is a static, public, read-only page listing every
payment attempt the Arc agent made and what Fuel decided — paid, held for
approval, or refused — each with a link to its transaction on
[explorer.arc.io](https://explorer.arc.io). It's generated from Fuel's own
ledger (`scripts/arc-demo/publish-proof.ts`), not hand-written.

Two things to notice when reading it:

- **A payment held for a person to approve is labelled "held," not
  "refused."** It only becomes a refusal if nobody approves it.
- **One kind of refusal never reaches Fuel's ledger at all** — a frozen agent
  is turned away before anything is reserved, so Fuel only counts the
  attempt. Those rows are shown separately, from the log kept by the script
  that drove the demo, and the page says so.

Two CSVs sit alongside it: `docs/arc/ledger-export.csv` is Fuel's own
accounting export, unmodified — it deliberately never carries a transaction
hash, wallet address, or network name (see
`docs/decisions/0006-accounting-export-omits-crypto-identifiers.md`), because
that's what an export meant for a real company's books must never leak.
`docs/arc/proof.csv` is a second file, built only for this page, that does
carry the transaction hash and explorer link per row, so the claims above are
independently checkable.

Open `docs/arc/index.html` directly in a browser, locally or wherever this
repository is hosted. It re-checks both wallets' balances and every listed
transaction live against Arc mainnet, from your own browser, when it loads —
not from anything Fuel's server says.

## How to run the tests

Requires Node.js 24 (Fuel uses the built-in `node:sqlite`).

```
npm install
npm test
```

`npm test` runs twelve steps end to end, offline, against databases it builds
and discards itself — no network access, no real credentials, no real money.
The one most relevant here is `scripts/verify-arc-lock.ts`
(`npm run verify-arc-lock` on its own): 169 checks that the one Arc agent is
locked to its own id, company and wallet, that its signer will sign nothing
but that one bounded transfer, and that the shop's settler can submit nothing
else. Before the branch went live, each part of that lock was deliberately
broken, one way at a time, and each break was confirmed to fail its own named
check — see `docs/testing.md` for the full account.

To run the rest of the product locally (the dashboard, QuickBooks sandbox,
the earning gateway), see the setup steps in `docs/roadmap.md` and
`docs/testing.md`. All of it runs against sandbox or testnet providers only —
see `CLAUDE.md`'s non-negotiable rule.

## Code map

- `src/payments/arc-chain.ts` — every Arc constant, and the one agent allowed
  to use them, named by literal id.
- `src/payments/arc-demo.ts` — the lock and the signer: what the Arc agent can
  be made to sign, and the five checks that keep every other agent off Arc.
- `demo/arc-shop/` — the shop and its settler.
- `scripts/arc-demo/` — the runbook: generate keys, build the demo database,
  start/stop the demo, reconcile the ledger against the chain, publish the
  proof page.
- `scripts/verify-arc-lock.ts` — the suite described above.
- The rest of `src/`, `dashboard/`, and `scripts/` is the Fuel product this
  demo is built on top of — see `docs/architecture.md` and `docs/roadmap.md`.
