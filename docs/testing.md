# Testing Fuel

One command runs every automated check:

```
npm test
```

It takes about two and a quarter minutes. It needs no `.env`, no `fuel.db` and no network, and never opens your real `fuel.db`. It sends no alerts, moves no money, and reaches no QuickBooks or Fireblocks sandbox, and no payment facilitator (see [Network](#network)).

## What it runs

The steps run in this order. The fastest come first, so most mistakes show up within seconds. The run stops at the first step that fails, and every step after it is reported as `NOT RUN`.

| Step | What it checks | Time |
|---|---|---|
| verify-runner | That `npm test` and the pre-push hook themselves fail when they should | 13 s |
| typecheck-api | `tsc` over `src/` and `scripts/` | 3 s |
| typecheck-dashboard | `tsc` over `dashboard/` | 1 s |
| qa-dashboard-source | The dashboard checks that only read source files (`qa-dashboard --source-only`) | 1 s |
| verify-pins | That every testnet guard is in place and still refuses: the Fireblocks sandbox, the payment rail, the signer's four refusals, the QuickBooks origin, and no mainnet name in `src/` | 5 s |
| verify-earning | The earning side: receipts, endpoints, the gateway's decisions | 1 s |
| verify-rollup | The rollup engine: cents, conservation, reclassification | 1 s |
| verify-quickbooks | Drafts, idempotency, corrections, realms; makes no network calls | 1 s |
| verify-migration | That every schema migration boots on old databases | 25 s |
| verify-api | Every HTTP route: auth, tenancy, field allowlists, alerting | 36 s |
| verify-startup | That the API starts and stays up with the payment network down, refuses paid requests until it is back, and refuses a `HEAD` on every paid route | 50 s |

A full run ends with one line:

```
npm test: PASS (11/11) in 2m10s
```

Or, for example:

```
npm test: FAIL at verify-rollup (5/10 passed) in 9s -- FAILED: conservation survives reclassification
```

The exit code is 0 for a pass, 1 for a failure or timeout, and 2 when the network is the problem. When something fails, the run prints where that step's full log is; after a pass, the logs are removed. Interrupting a run (Ctrl-C) stops the step that is running too, and exits 130.

## How a step passes

- **The exit code decides.** A suite that prints a success line and then exits 1 has failed.
- **Each suite has a check-count floor** in [`scripts/test-baseline.json`](../scripts/test-baseline.json).
  - A suite must print `All N checks passed.`, and N must be at or above its floor.
  - This is what catches a suite that exits 0 having quietly run fewer checks: a branch that skipped itself, or a loop over data that is no longer there.
  - When you add checks, raise the floor in the same commit.
  - Lower it only in a commit that deliberately removes checks, and say why in the commit message.
  - A suite must count the same in a fresh clone as in your checkout. A check that runs once per file must skip files git ignores, such as the `next-env.d.ts` a dashboard build writes. Otherwise a floor measured in your checkout fails in the pre-push hook's fresh worktree.
- **Each step gets a bare environment:** `PATH`, `HOME`, the temp directory, the user and the locale. No relay or encryption key, Fireblocks credential or proxy setting reaches it, whatever your shell holds.
- **`.env` isn't read either.** Some scripts a suite starts (`set-password`, `mint-invite`) load `dotenv/config`, which reads `./.env` from the repository. Every step runs with `DOTENV_CONFIG_PATH=/dev/null`, so each of those loads reads an empty file.
- **A step that runs longer than 5 minutes is killed** together with anything it started, and is reported as `TIMEOUT`.
- **On macOS the run keeps the Mac from idle-sleeping** for exactly as long as it lasts. A Mac that sleeps mid-run fails time-window checks for reasons unrelated to the code. Closing the lid still sleeps it.

## The test database

verify-api, verify-rollup and verify-quickbooks each build a fresh database in the temp directory, using [`scripts/lib/test-db.ts`](../scripts/lib/test-db.ts). They used to copy your real `fuel.db`, which had three problems:

- Clearing old test data could switch a check off without anyone noticing.
- A copy taken while the API was writing could be torn.
- A machine without your `fuel.db` couldn't run the suites at all.

[`scripts/lib/seed-test-db.ts`](../scripts/lib/seed-test-db.ts) builds the database so it has the same shape as real data:

- **The companies:** the main company with its five agents and two teams, plus an empty second sign-up and a QA company.
- **The main company's history:**
  - the same days of spend in the same statuses, and the same approval history;
  - an earning endpoint with a settled receipt;
  - a QuickBooks connection with posted documents and a reversal.
- **How it's made:**
  - History rows are written with fixed ids and fixed past dates.
  - Rollup lines, drafts and postings come from Fuel's own engines, run on a clock frozen to the day each event happened.
  - Nothing is sent to QuickBooks or Fireblocks.
  - Before handing the database over, the seeder checks its own ledger with Fuel's own integrity checker.

### Guards on the real database

Four guards keep the real database out of reach. verify-api checks each one, and each has a break test that removes it and confirms the named check fails.

| Guard | What it prevents |
|---|---|
| TD-1 | No test file copies or opens `fuel.db`, or points `FUEL_DB_PATH` at it. A pattern check that catches the plain mistake, not a proof: TD-4 is what makes the default unreachable. |
| TD-2 | Each suite confirms the database it actually opened is the one it built. |
| TD-3 | The seeder accepts only a new file in the temp directory. It refuses `fuel.db`, the repository, existing files and links. It claims the file before it imports any database code. |
| TD-4 | Loading `test-db.ts` points `FUEL_DB_PATH` at a temp file immediately, so the `fuel.db` default in `src/db/index.ts` can never be reached from a suite. |

When this was introduced, an assertion-by-assertion comparison against the old real-data runs found no check lost. It also found two checks that had never run on real data, and they now run:

- verify-quickbooks' settlement-staleness check;
- verify-api's approval demo-marker check.

## The testnet guards

Fuel moves no real money, and the reason is a handful of pinned constants and refusals. `CLAUDE.md` says enabling any of them is a reviewed code change, never a setting. `npm run verify-pins` is what makes that checkable: it fails if one is edited, or deleted in a refactor. Before it existed, no suite imported the Fireblocks signer at all, and "all four refusals verified" in the roadmap was a manual check from Phase 1.

| Group | What it holds |
|---|---|
| PIN-1 | The Fireblocks workspace is the sandbox and written as a literal, not computed. The gas, USDC and signing assets and the signer's chain id are Base Sepolia's. The Fireblocks files never touch `process.env`: the two credentials come through `requireEnv` and nothing else is read. **The client itself is built on the sandbox:** with a production workspace named in `FIREBLOCKS_BASE_PATH`, which the SDK would fall back to if Fuel left its own base path out, the client still comes up on the sandbox. There is exactly one `new Fireblocks(` in `src/`. |
| PIN-2 | The payment rail: network `eip155:84532`, Base Sepolia USDC, scheme `exact`, the `x402.org` facilitator, and a ceiling of $0.01 a payment. The payment files read no environment. |
| PIN-3 | **The signer's guards, by behaviour.** Each refusal is made to happen: a `Permit` instead of a transfer, Base mainnet's USDC contract, chain id 8453 or none, an authorization from another address. A correct Base Sepolia authorization is shown to pass all four and to stop only at the missing credentials, so a signer that refused everything would fail. The signer exposes exactly an address and `signTypedData`, and `src/` creates a Fireblocks transaction in exactly one place, the guarded one. |
| PIN-4 | The environment report says sandbox on all five surfaces. The gateway's public origin is loopback, and the API starts listening in exactly one place, on loopback only: that is what makes "Receiving: sandbox" true. The table that classifies the surfaces holds exactly eight values, calls each mainnet one production and each testnet one sandbox, is read in one place and written in none, and calls anything unknown "unknown". |
| PIN-5 | The QuickBooks origin is the Intuit sandbox, nothing in its config reads the environment, and a production address is refused. |
| PIN-6 | No file in `src/` outside the environment table names a mainnet network id (however spaced), a wildcard over every `eip155` network, the Base mainnet USDC contract, a production Fireblocks host, workspace or `BasePath[...]` lookup, the `FIREBLOCKS_BASE_PATH` variable, a production QuickBooks host or a mainnet Fireblocks asset id. `src/` imports nothing from `viem/chains` but Base Sepolia. Each pattern is checked against what it must and must not match. |

**Order.** PIN-4 summarises the pins the other groups hold, so it runs after them: flip any one constant and its own group fails first, not the summary. The client check, the last of PIN-1, runs after PIN-3 because it needs stand-in credentials and PIN-3 must run with none. The groups are therefore not printed in numeric order.

**Source is read with the parser, not a regular expression.** A first version stripped comments with a regex, and a string such as `accept: "*/*"` in `src/gateway/forward.ts` started a "comment" that swallowed real code, so a mainnet name placed after it would have passed. A pinned declaration is now read as a declaration, wherever it sits and however it is formatted, and every scan reads the parser's own comment-free output. A control checks exactly that case.

**It cannot sign.** The Fireblocks credentials are removed from the process before the signer is called, and checked absent. A broken guard reaches `fireblocks()` and stops on "FIREBLOCKS_API_KEY is not set", so the suite could not contact Fireblocks even in a shell that holds real sandbox keys. The one group that supplies stand-in credentials only constructs the client, which does no I/O, reads its base path, and removes them again. Adding it changed nothing in `src/`: the proof is that `git diff main -- src` is empty.

**To change a guard on purpose,** edit the matching check in the same reviewed commit. Hosting the gateway moves `GATEWAY_PUBLIC_ORIGIN`, which is one such edit, in PIN-4. That visibility is the point.

**Known limits.** PIN-6 is a text match over `src/` only: a deliberately constructed spelling (`"eip155:" + "8453"`) evades it, which is acceptable for a tripwire, because the behavioural checks in PIN-3 and PIN-5 stand behind it. Nothing here drives a signature through Fireblocks: that path is exercised only by hand, in the sandbox (`scripts/pay-test-endpoint.ts` and the walkthroughs), not by `npm test`.

**What this does not cover: the payer's own enforcement.** The constants are pinned and the signer's refusals are exercised, but no suite calls `payForAgent`. Its per-payment ceiling comparison, its choice of acceptable terms, its refusal of a non-positive amount or a short time limit, and its checks that the signed amount and the selected terms match what was reserved are read in review and tested by hand on testnet, not by `npm test`. The signer backstops the network, asset, primary type and payer, but nothing else catches the amount, the payee or the validity window. A suite for it is the recommended next step on this side.

## Network

`npm test` needs no network. No step reaches outside this machine, and TR-7 fails if a step starts needing a host without saying so.

### The payment network being down

Fuel's two x402 resource servers, the gateway's and the one behind `/paid-hello`, each need one handshake with the facilitator before they can quote a price. `src/payments/facilitator-sync.ts` owns both:

- **Nothing starts at import.** `src/server.ts` starts both handshakes at boot.
- **A failure is handled and retried in the background,** after 2, 4, 8, 16 and 32 s, then every 60 s. The timer never keeps a process alive.
- **Until a handshake succeeds,** that server's paid routes answer `503` with `Retry-After: 30`. Nothing is quoted, verified, claimed or settled, and the seller is not contacted. Everything else, including caps, approvals and the dashboard's API, serves as usual.
- **One attempt at a time, and never again after success.** The library clears its list of payment kinds at the start of each handshake, so a second one could fail requests in flight.
- **A request never starts a handshake.** It waits up to 5 s for one already under way, and is otherwise refused at once.

Before this, an unreachable facilitator ended the whole API process within a second of boot: an unhandled rejection. That is why verify-api used to need `x402.org`.

### How verify-startup tests it offline

**The setup.**
- **The real API:** it runs as a child, on a generated database, under `scripts/lib/offline-network.mjs`, a test-only preload.
- **The facilitator:** the preload answers it as `down`, `up`, `slow-up`, `hang` or `no-rail`. Its `/supported` reply is `scripts/fixtures/x402-supported.json`, recorded once with a bare request and dated.
- **Everything else is refused.** Any other host, name or address is refused at `fetch`, at DNS and at the socket. Every lookup is logged.

**What it checks while the facilitator is down.**
- A paid request gets `503`.
- No receipt row and no money-table change: payments, receipts, approvals and postings are all hashed.
- No lookup of the seller's hostname. A control shows that detector firing in the same process.

**What it checks once the facilitator is back.** The three price quotes are compared field by field with `scripts/fixtures/x402-quotes-main.json`, recorded by running the code from before the fix. To re-derive it, run `node --import tsx scripts/record-quote-fixture.ts d660535`, which checks out that commit and records its quotes offline.

**An accepted limit.** A facilitator that fails at **settle**, after the seller has answered, is not driven end to end. It would need a test-only redirect of the gateway's guarded outbound connection to a local seller, which was judged not worth building.
- That handler code was byte-identical to the version before this fix when the fix was merged.
- verify-earning checks the receipt rules it relies on: `settle_unknown` is kept out of the books.
- The gateway's own catch for it (`route.ts`, "8. Only now does money move") is exercised by no suite.

### A HEAD to a paid route

Express answers a `HEAD` with the route's `GET` handler and then drops the body. Nothing in either paid route asked which method it had been given, so:

- **`/paid-hello` ran its handler with no payment at all,** with the facilitator down as well as up. The library's route table says `GET` and compares the verb exactly, so it never asked for payment on a `HEAD`.
- **On the gateway, a `HEAD` carrying a payment that matched the terms** was verified, and from there handled like a `GET`: claimed, forwarded to the seller and settled. The payer was charged in full and received headers alone. A `HEAD` carrying none was quoted a price it could never get anything for.

Both now answer **`405` with `Allow: GET`** and the body `{"error":"GET only"}`, ahead of everything else: the limiter, the endpoint lookup, the facilitator wait, the quote and every payment step. A `HEAD` is refused the same way whether the payment network is up or down, and the same for every endpoint id.

**What verify-startup checks (GS-15 to GS-17).** The `HEAD` probes run in the same two API runs as GS-6 and GS-7, once with the facilitator down and once with it ready:
- **GS-15, the gateway.** With no header, an unreadable one, one that matches the terms, and the same as `x-payment`:
  - `405` with `Allow: GET`, no price quote, and a `Content-Length` that is exactly the length of the "GET only" body;
  - no receipt, no money-table change, no lookup of the seller's hostname;
  - no call to the facilitator's `/verify` or `/settle`.
- **GS-16, `/paid-hello`.** The same, on `/paid-hello`, `/paid-hello-large`, `/PAID-HELLO` and `/paid-hello/`, with a payment built from each route's own quote. Two more checks belong here:
  - nothing ran behind a refusal: the API's log holds no "headers already sent" error, which is the only trace of a handler running after a `405` was sent;
  - the refusal is mounted ahead of the payment middleware in `server.ts`. Today the order does not matter, because the middleware asks its matcher with the request's own method, which never matches a `HEAD`. A route-table entry with no verb would match one.
- **GS-17, the controls.**
  - A real receipt claim moves the receipt count and the money hash, so that detector is shown to fire.
  - The very same matching payment header, sent as a `GET`, reaches `/verify` exactly once, on the gateway and on each `/paid-hello` route. So a `HEAD` that reaches it zero times was stopped, not unable to get there.
  - `HEAD /health` is still served, so the refusal is for paid routes only.
  - After every `HEAD`, a `GET` to each of the three routes still quotes exactly the price in `scripts/fixtures/x402-quotes-main.json`.

**What does the work, and what only guards.** The preload always refuses `/verify`, so no request in this suite can pass verification. These assertions can fail today, and they are what the suite rests on: the status, `Allow` and `Content-Length`; the up-state `/verify` counters (a matching payment reaches `/verify` once as a `GET` and zero times as a `HEAD`); the log check; the source-order check; and the `HEAD /health` and `GET` quote controls. These cannot fail today and only pin the property for a harness that can drive a payment further: every `/settle` counter, the receipt, money-table and seller-lookup assertions in the up state, and every down-state counter, because the facilitator wait refuses before verify is reached. They stay because they cost nothing and say what must hold. Do not count them as evidence.

**An accepted limit, the same as the settle one above.** A `HEAD` that would claim, forward and settle cannot be driven end to end. What the suite shows instead is that a `HEAD` never reaches `/verify` at all, which is the step before every one of those. The refusal sits ahead of the gateway's `GET` handler, and that handler is byte-identical to the version before this change.

## What is not in `npm test`

These need a running dashboard, the API, the QA account's password, a browser or a real sandbox, so you run them deliberately:

- **`npm run qa-dashboard`:** the browser half of the dashboard QA, covering screenshots, accessibility, keyboard, leaks and vocabulary.
  - It needs a production build at `http://127.0.0.1:3100` and the API running.
  - It needs the QA account in `fuel.db` and its password in `.env`.
  - It writes sign-in sessions to `fuel.db` and rewrites the tracked screenshots in `docs/ui/shots/`.
- **`npm run walk-accounting` and `npm run walk-revenue`:** live walkthroughs against the QuickBooks and payment sandboxes.

## The pre-push hook

[`.githooks/pre-push`](../.githooks/pre-push) runs `npm test` before anything is pushed. Install it once per clone:

```
npm run hooks:install
```

That sets `core.hooksPath` to `.githooks`. Nothing installs it for you.

**It tests what you push, not your working tree.** The commit at the tip of each branch or tag being pushed is checked out on its own in a temporary worktree, and `npm test` runs there. Uncommitted changes in your working tree don't affect the result. Pushing a commit other than the one checked out tests that commit. Deleting a remote branch tests nothing.

Two limits, stated so nobody relies on more:
- In a push of several commits, only the tip is tested, not each commit underneath it.
- The worktree borrows this checkout's `node_modules`. A push that changes dependencies is tested against the ones installed here, not the ones in its lockfile.

Interrupting a push stops the test and removes the worktree.

**To skip it in an emergency:**

```
git push --no-verify
```

That's git's own flag, so it always works. The hook prints it whenever it blocks a push.

**To uninstall:** `git config --unset core.hooksPath`.

## Proving the runner

`npm run verify-runner` is the first step of `npm test`. It covers:
- **The runner (TR-1 to TR-14):** the real runner over stand-in steps that pass, fail, lie about passing, hang, die, hide from a timeout, are interrupted, read a `.env`, or need an unreachable host.
- **The hook (TH-1 to TH-10):** the real hook file, with its real permissions, in a throwaway repository pushing to a local bare one.

If the runner or the hook stops failing when it should, this step fails first.
