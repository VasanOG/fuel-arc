# 0009 — Activity data contracts, and how far company scoping actually goes

Status: accepted
Date: 2026-08-26

## Decision

Two read-only operator endpoints — `GET /api/payments` and
`GET /api/environment` — plus a canonical payment vocabulary owned by the
backend, structured refusal codes, and a structural demo marker. Every payment
response is an explicit field allowlist built field by field, never a spread of
a database row.

## The company predicate is a seam, not tenant isolation

**This is the most important sentence in this document.** Every query in
`listPaymentsPage` carries `t.company_id = ?`, joined through
`payments → agents → teams`. That predicate is real, unconditional and tested
against a second seeded company. It is still **not** tenant isolation, and
nothing in Fuel should be described as if it were.

Fuel has one company (`getDefaultCompany()` is `listCompanies()[0]`) and the
operator credential is not bound to it. `src/lib/auth.ts` resolves a *role* from
which of two shared secrets was presented; there is no principal and no tenant
claim. So the predicate cannot stop a credential holder from reading another
company's data — there is no second company, and no way to tell two operators
apart if there were.

What it buys is that the day a second company exists, this route does not
silently widen. That is worth having and it is all it is.

**Sufficient for:** Fuel's current single-company internal and sandbox phase.
**Not sufficient for:** an external beta, or any deployment with more than one
customer's data in one database. That needs a company-bound credential, which
is a separate slice and a prerequisite, not a nice-to-have.

Two other reads remained unscoped when this document was first written, and
were named here so they would not be forgotten. **Both were closed in 5B-3**:

- `listPaymentsForExport` now takes a required `companyId` and joins through
  `agents → teams`. Its absence was the worst placement of this bug in the
  codebase — an export is the one surface whose output *leaves* Fuel and lands
  in a third party's accounting system, so a foreign row there is not a read
  someone discards, it is a line in a customer's books.
- `GET /api/approvals` is OPERATOR-only and company-scoped. `GET
  /api/approvals/:id` stays readable by both roles, deliberately; see below.

The seam argument above is unchanged and still governs all of them. Scoping a
query is not the same as isolating a tenant, and none of these predicates can
tell two operators apart.

### Why `GET /api/approvals/:id` is still readable by an agent

The comment that used to sit above the approvals routes said both roles could
read them "on purpose: an agent has to be able to see whether its own paused
payment was approved before it retries". The *need* is real. The **list** was
never how it was met, and defending it that way was the mistake:

- The agent credential is shared by every agent — `src/lib/auth.ts` resolves a
  role, never an identity — so "its own" is not a question the route could
  answer. It returned every approval for every agent in the company to a key
  that lives wherever an agent runs.
- An agent never needed the list. The `202` that holds its payment hands back
  `approvalRequestId` directly (`src/payments/pay.ts`), so the agent already
  holds the one id it cares about.

So the single-row read keeps the capability, and the bulk read does not. What
comes back is the same allowlist an operator sees: no vendor path, no query
string, no prose.

The residual limitation, stated rather than papered over: because one
credential is shared, Fuel cannot tell whether the caller owns the approval it
is asking about. An agent that learns another agent's approval id can read its
status, amount and vendor host. That is a property of the shared credential,
not of the route, and **per-agent credentials are the fix** — the same
prerequisite as company-bound credentials above. The allowlist is what bounds
the damage until then.

### What an approval response deliberately does not carry

`resource_url` and `detail`, for the same reasons payments lose them, plus one
specific to approvals: the anomaly baseline, threshold and sample size exist
**only** inside that prose sentence, in base units. A surface rendering it
would publish an internal storage unit and an agent's behavioural baseline as
a side effect of showing an operator a number.

The cost is real and worth naming: an operator deciding an anomaly approval can
no longer see the numbers that made the payment look unusual. The blueprint
already refused to render them as structured fields for the same reason. The
fix is structured columns on `approval_requests`, which is a schema slice.
Until it happens, the honest answer is that those numbers are unavailable —
not a string that half looks like data.

## Sensitive fields never leave

Absent from every payment response, by construction rather than by filtering:

- `tx_hash` — a settlement identifier from the payment rail (0006).
- `resource_url`, and **any path or query derived from it**. A paid endpoint can
  carry a credential in either. Only the vendor host is returned.
- `detail`, on payments and on approvals. It is free internal prose written in
  BASE UNITS, and on a failure after signing it can contain a string a
  third-party merchant chose — `describeRejection` in `src/payments/pay.ts`
  writes `JSON.parse(header).error` verbatim.
- `agents.address`, `fireblocks_vault_id`, `qbo_postings.request_id`, encrypted
  token columns.

Money is always a string. A JSON number is an IEEE-754 double, and money that
survives a round trip by luck is money that will eventually not.

`present(agent)` no longer returns `walletAddress` at all. That is where 0005
actually finishes: 5A-1 took it off the dashboard and 5B-1 stopped transmitting
it to the browser, but the API kept emitting it, and `GET /agents` was reachable
with the shared agent credential — so every agent could read every other agent's
custody address. Nothing consumed the field.

## The export's description column is now generic

`descriptionFromResourceUrl` returned `${pathname}${search}`. The query string
was a real leak into a CSV that leaves Fuel permanently and lands in a third
party's books, and 0006 already settles that an export is a stronger surface
than a screen.

The path went too, and that is the harder call. `/v1/scrape` is useful and
harmless; `/services/T000/B000/xoxb-…` is a secret in path form, and nothing can
separate them without a heuristic that will eventually be wrong in the direction
that writes a credential into a customer's ledger. The column now reads
"Agent API payment". The Vendor column still names the counterparty and the
Reference column still carries the Fuel payment id, which 0006 names as the
reconciliation handle.

**Known limitation:** the dashboard cannot show which exact resource an agent
paid for, because Fuel will not hand a URL to a surface. Recovering that safely
needs a per-vendor mapping an operator configures, not a parsed URL.

## Refusals are coded; history is not invented

`payments.refusal_code` holds one of seven closed codes, set only by
`recordBlocked` inside `reserveIfUnderCap`. Rows recorded before it existed keep
NULL and report *reason unavailable*.

Their `detail` strings look parseable — "would exceed team spend cap" — and are
deliberately not parsed. Free text was never a contract, and deriving a code
from one would be inventing a record rather than reading it.

No CHECK constraint: adding one needs SQLite's full table rebuild, and
`payments` is referenced by `approval_requests.payment_id` and
`export_postings.payment_id` under `PRAGMA foreign_keys = ON`. Rebuilding the
money table to constrain a nullable annotation is a bad trade. The compensating
controls are one write path, a closed TypeScript union, and an assertion that
every stored value is known.

## The demo marker is structural, and the backfill is a human decision

`payments.is_demo` and `approval_requests.is_demo`, `NOT NULL DEFAULT 0`. No
production write path can set them — the INSERTs omit the column entirely, so
there is no parameter to pass.

The obvious move was to backfill in the migration:
`UPDATE payments SET is_demo = 1 WHERE detail = 'demo-seed'`. It is wrong, for
the reason above: `detail` is not ours on a failure after signing. A merchant
answering `{"error":"demo-seed"}` would have had a real payment silently
relabelled by a migration nobody watched run.

So `scripts/mark-demo-rows.ts` prints every candidate id and changes nothing
without `--confirm`. The free-text read happens once, in the open.

**The same string was a deletion hazard, and that is now closed.** The seed
script's delete predicate was `WHERE detail = 'demo-seed' AND created_at LIKE ?`
and its comment claimed a real payment could never be caught by it. That was
wrong. It is now `WHERE is_demo = 1 AND created_at LIKE ?`, and the script
refuses to run without the column rather than falling back.

## One vocabulary

`src/lib/payment-presentation.ts` owns payment status wording for every surface.
The CSV reads it; the API returns the label and tone with each payment; the
dashboard renders what the server says and no longer decides for itself. The six
CSV strings are pinned by a regression test, so a change made for a screen
cannot silently alter a customer's accounting file.

Tone lives in the backend because "which of these outcomes is alarming" is a
domain judgement, not a palette one — and a surface guessing severity from a
status it did not understand would eventually guess "this looks fine".

## Consequences

- Verification now includes an HTTP-level harness (`scripts/verify-api.ts`),
  the first in this codebase. Auth, tenancy, validation, pagination stability
  and the response allowlist cannot be observed from below the route.
- `GET /api/agents/:id` is operator-only and bounded at 25 payments. An agent
  credential no longer reads it.
- The CSV's Description column changed. That is a deliberate contract change to
  an accounting artifact, recorded here rather than discovered later.
