# 0010 — Raw provider status objects never cross into the client

Status: accepted
Date: 2026-08-27

## Decision

**No page or component in the dashboard reads a raw provider response.** Every
browser-visible fact about an integration crosses an explicit presentation
contract: a named type, a pure function that builds a new object one key at a
time, and a test that feeds that function a poisoned input and asserts on what
comes out.

For QuickBooks the contracts live in `dashboard/lib/accounting-status.ts`.
A status read is exactly seven keys wide:

```
connected  connectedAt  readyToPost  missing
currency   currencyVerified  currencyCheckedAt
```

An action reply — `/setup-accounts`, `/verify-currency`, `PATCH /config`, which
all spread the same connection object into their answers — is those seven plus
three:

```
quickBooksCompany   created[]   reused[]
```

all of them **names**, never ids.

## What went wrong, concretely

`GET /api/integrations/quickbooks/status` is an operator-only route and its
response is correct for what it is: the API's own view of the connection. It
carries the customer's `realmId`, `accessExpiresAt` and `refreshExpiresAt`, and
a `config` block holding three QuickBooks account ids.

`/accounting` passed that object straight into `AccountingWorkbench` as a prop,
and printed the realm id into the page header and into the setup line. The
dashboard's browser proxy passed the same object back to the browser verbatim
on every refetch — which the workbench does after connect, account setup, post
and disconnect.

Three things made it easy to miss:

1. **Operator-only is not the same as browser-safe.** Both are true of this
   route and only the first was being checked. An operator is authorised to
   call the endpoint; that is not a decision that its whole body belongs in a
   page, in a network tab, or in a screenshot pasted into a ticket.
2. **The component declared its own copy of the shape.** `interface Status`
   inside `AccountingWorkbench.tsx` listed `realmId`, and declaring a field is
   what makes it available to render. Two descriptions of one thing is how they
   drift.
3. **A type is not a boundary.** TypeScript erases at build time. Narrowing the
   prop's *type* would have stopped the field being rendered while still
   serialising it into the flight payload — the same lesson 5B-1 recorded and
   the same fix: pick the keys at runtime.

## The rule

- A raw provider response may be read **on the server, by a presenter**, and
  nowhere else.
- The presenter **picks**. No spread, no `delete`, no denylist of known-bad
  field names — a denylist protects against today's fields and silently admits
  whatever the provider adds next.
- The contract lives in **one pure module**, imported by every surface that
  shows it. Pure so a Client Component can import it and a test can poison it.
- It is applied at **every door**, not the convenient one, and "every" means
  every route that answers with the object — not every route you happened to
  think of. `presentQboStatus` is spread into **four** replies:
  `GET /status`, `POST /setup-accounts`, `POST /verify-currency` and
  `PATCH /config`. The first version of this ADR narrowed `/status` alone and
  described it as "the boundary that actually matters", which was wrong: "Set
  up accounts" is a button an operator presses, and its reply carried the realm
  id, both OAuth expiry timestamps and three chart-of-accounts ids straight to
  the browser. The narrowing is now a **required field on each allowlist
  entry** in the proxy, so a new endpoint cannot be added without saying what
  happens to its body, and `"none"` has to be typed rather than fallen into.
- A route that adds its own fields gets its own contract, not an exemption.
  `ACCOUNTING_ACTION_KEYS` is the status contract plus `quickBooksCompany`,
  `created` and `reused` — a company **display name** and account **names**.
  Names are what an operator recognises; ids are the provider's handles.
- A response that will not narrow is reported as a **failure**, never as an
  empty object, and never as the last good answer. The UI carries three states
  — connected, not connected, and **unknown** — so "we could not find out" has
  somewhere honest to render. Without that third state a failed read has only
  two bad options: claim "not connected" about a live connection, or keep
  showing "Connected" about one that was just torn down.
- The presenter must be **idempotent**. Applied at two doors, it runs on its
  own output as a matter of course — the browser's refetch narrows a body the
  proxy already narrowed. A version that read the currency claim only under its
  upstream key silently reset a verified USD company to "not verified" on every
  refetch. It degraded in the safe direction, which is why nobody would have
  noticed.
- A **query parameter is not evidence.** `?connected=1` says where the operator
  came from; it does not establish that a connection exists, and anyone can type
  it. Claims are confirmed against the status Fuel actually reports.

## What this does not cover, and is therefore still open

- **The posting trace** at `/postings/{id}/trace` carries `accountId` on
  purpose: it is the key the workbench groups ledger lines by, and matching on
  the account name instead was tried and was silently broken. It is a
  QuickBooks identifier reaching a browser, it has not been narrowed, and the
  QA scan exempts that one path by name rather than pretending otherwise.
- ~~**The OAuth callback** redirects to `/accounting?connected=<realmId>`.~~
  **Closed.** It now redirects to `/accounting?connected=1`. The realm id is
  still *stored* — Fuel needs it to address the company's API — but it is
  stored server-side, which is where it belongs, and no longer written into
  the address bar, the browser's history, or any screenshot of the moment a
  connection succeeded. Its presence was the whole signal; its value was never
  read by the page.

  The handler moved to `src/quickbooks/callback.ts` to make that provable.
  It had lived inline in `src/server.ts`, which calls `listen()` at import
  time — so importing it to test it started a server, and **the one route in
  Fuel with no authentication was the one route no suite could drive.** It now
  has 33 checks covering the redirect, single-use state, the ordering that
  redeems state *before* spending a token exchange, token storage, and the
  absence of any path from here to a journal entry.
- **`/postings`** is still a passthrough. Those are Fuel's own rows — a doc
  number, a status, the QuickBooks journal-entry id that makes a posting
  reconcilable — and carry no credential or company identifier. The journal
  entry id is deliberately kept: it is the receipt.

## How it is enforced

- `scripts/verify-api.ts` — asserts the presenter is idempotent over two and
  three passes and over both the nested and flat spellings, and feeds
  `toAccountingStatus` an object carrying the
  realm id, both OAuth expiries, three account ids, tokens, a client id, a
  redirect URI, a provider URL, a raw nested provider payload and a field named
  for a quarter that has not happened, then asserts the output has **exactly**
  the seven declared keys. Also asserts every needed value survived, so the
  leak test cannot be passed by returning nothing.
- `scripts/qa-dashboard.ts` — scans every response body the browser receives,
  for the **live** realm id and account id values read from the API at start-up,
  not merely for their key names, and reads `/status` from inside the page to
  assert the closed key set over real HTTP — then compares every value in it
  against the API's own answer, because a closed-key check alone is passed by a
  contract returning the right key names holding nothing.
- `scripts/walk-accounting.ts` — presses the buttons, because the refetch after
  an action is the moment the old code leaked.

## Related

- 0005 — custody addresses leave customer-facing surfaces
- 0008 — the currency claim always carries how Fuel knows it
- 0009 — response allowlists are built field by field, never spread
