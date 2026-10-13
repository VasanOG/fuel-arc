# 0018 — An account belongs to one company, and signing in names it

**Status:** accepted
**Date:** 2026-09-26
**Closes:** the invite email-existence oracle 7A-2 recorded and deferred "to
whoever decides whether company-scoped addresses are wanted". The owner
decided they are.
**Reverses:** the `users` table's recorded choice of one account per address
across the platform (see "The reversed decision" below).
**Builds on:** [0014](./0014-a-decision-has-a-name-on-it.md) (a decision
names a person), [0017](./0017-a-quickbooks-connection-is-proved-by-who-and-by-intuit.md)
(which names this signup-form gap, now also a handle gap).

## Decision

**An account belongs to one company, and an email address is unique only
within it. Nothing Fuel says to anyone depends on whether an address has an
account at another company.**

1. **`users` is `UNIQUE (company_id, email)`**, replacing `email UNIQUE`.
   - SQLite cannot drop a column constraint, so a one-time rebuild makes the
     change, and every id is kept.
   - The five tables that reference users still resolve: `sessions`,
     `invites.redeemed_by`, `approval_requests.decided_by`,
     `qbo_postings.abandoned_by` and `qbo_oauth_states.created_by`.
2. **Every company has a handle** (`companies.handle`, unique): a slug of its
   name, at most 24 characters, then `-` and four random characters, for
   example `default-company-33kj`.
   - A handle is an address, not a secret. It is shown to everyone in the
     company, on the viewer badge, `GET /api/company`, `/api/auth/me` and the
     invite's 201.
   - On the rare clash, only the random part is drawn again. There is never a
     numeric suffix.
3. **Signing in names the company.** `POST /api/auth/login` takes
   `{ company, email, password }`, where `company` is the handle, typed by the
   person.
   - Fuel never lists which companies an address belongs to.
   - An unknown handle, a value that isn't handle-shaped, an unknown address,
     a wrong password and a disabled account all get one refusal: "that
     company, email and password do not match an account". They all cost the
     same hashing time.
   - A missing field is a 400.
   - The per-account rate limit is keyed on handle plus address.
4. **`companies.name` is no longer unique.** Nothing looks a company up by
   name; the handle identifies it.
5. **The API has a catch-all error handler** (`src/lib/errors.ts`, mounted
   last). Any unexpected error answers 500 `{ "error": "internal error" }` and
   is logged as `name: message`. Only the JSON body parser's own errors,
   recognised by their `type`, keep their 4xx, answered as "malformed
   request".
6. **The invite endpoint is unchanged.** It never checked the address, it
   always answers 201, and it is deliberately not given an "already a member"
   check. That check would be harmless, but it isn't needed.

## Why

### Where the leak actually was

Not in the invite's response, which never looked at the address. It took two
steps:
1. An owner at company B mints an invite for `victim@elsewhere.com`. Fuel
   sends no email, so the 201 hands the token to whoever minted it.
2. The owner redeems their own token with that address. The answer was
   **409 `email_taken`** if the address had an account at *any* company,
   because `users.email` was unique across the platform, and **201** if it
   didn't.

### Why no response shape could close it

The obvious fix is to flatten `email_taken` into a generic refusal. That
still leaves success against failure, and a created account can't be made to
look like a refused one.

This was tested rather than argued. Break test C2 flattened the refusal and
kept global uniqueness, and the oracle test O1 still failed: the two paths
answered 201 and 400. The oracle comes from "one address, one account, on the
whole platform", so that is what changed.

### The same cause was a second, worse problem

When the address was free, the owner's probe *claimed it for the whole
platform*. The real person could then never be invited into their own
employer's company. Test O2 shows that can no longer happen: after B creates
the address in B, company A can still invite it and create it in A.

### The reversed decision

The users table chose global uniqueness on purpose. A per-company design
means the form "would have to ask 'which company?', which is a question the
person signing in should not have to answer and an attacker would enjoy
being asked".

- **It was right about sign-in and wrong about invites.** It didn't account
  for an inviter holding the token.
- **What an attacker enjoys is the answer, not the question.** The person
  *types* their handle; Fuel never offers a list. An unknown handle is refused
  exactly as a wrong password is, in the same words and at the same cost. So
  asking yields nothing.

The table's comment now records the reversal and this reasoning.

### Why a random suffix, never "-2"

The usual scheme, `acme` and then `acme-2` on a clash, would tell whoever got
`acme-2` that a company called Acme already exists. That is a new
cross-company leak of exactly the kind this closes. A random suffix on every
handle says nothing. The alphabet leaves out 0/o and 1/l/i because a handle is
read aloud and retyped.

### Why company names stopped being unique

Security review of the first version found this, and it was worse than
recorded:
- A founder choosing a name another company already had got no refusal.
  Instead the SQLite constraint error escaped the signup handler.
- Express's default handler answers with the error itself unless `NODE_ENV` is
  `production`, which it isn't here. So the response was an HTML page with the
  SQLite message, the stack and absolute paths.
- That was a company-name existence oracle and a leak in one. Once the handle
  identifies a company, uniqueness on the name protects nothing, so it was
  dropped.

**The companies rebuild holds every company's spend cap**, so it is
guarded:
- Rows are copied verbatim.
- It refuses to commit unless every row (id, name, cap, created_at and
  handle) reads back identical.
- Break test C14 copied every cap as 0, and the guard stopped the boot.

### Why a catch-all error handler, and why it trusts almost nothing

The name clash was the first route found reaching Express's default handler,
but it wouldn't be the last. So the next unexpected error anywhere says only
"internal error".

- **Only body-parser errors keep a 4xx.** Malformed JSON is the caller's
  mistake, so it stays a 400.
- **They're recognised by `type`, not by having a numeric `status`.** A second
  review pointed out that other errors carry one; `QboApiError` does, although
  it is caught before it gets that far. Trusting any `status` would relabel a
  server fault as the caller's, and let a status chosen deep in a library
  reach the response. E5 now throws exactly such an error and expects a 500.

## Consequences

- **Everyone signs in with a handle.** Whoever invites someone passes on the
  handle with the invitation code, and the signed-in person sees it on their
  badge. The form doesn't remember it, and turns off browser autofill for
  it: the "organization" autofill would fill in a company *name*, which is
  never the handle.
- **Two accounts with one address are two people.** They have separate
  passwords, sessions and roles. Nothing identifies a person across companies
  by email.
- **`email_taken` now means "already in this company".** That's the only case
  left that can raise it, and an inviter can already see their own members.
- **`scripts/set-password.ts` takes `--company <handle>`.**
- **Existing sessions survive the migration**, because they reference user
  ids, which didn't change. The sessions table hashed the same before and
  after.

## Proof

- **Tests:**
  - verify-api:
    - O1–O8: the oracle, squatting, separate accounts, one refusal, a missing
      company, per-account throttling, a same-company 409, and each caller
      sees only their own handle.
    - F1: a founding invite is single-use.
    - N1–N2: a shared company name gets a 201 with no stack.
    - E1–E5: the catch-all.
    - D1–D5: the dashboard's sign-in and badge.
  - verify-migration:
    - both rebuilds, with every reference resolving and every cap identical;
    - the handles' format, including no "-2";
    - a second boot changes nothing;
    - a founding invite redeemed by two OS processes at once creates one
      company.
  - **Checked against the old code first:** O1 and O2 failed with 409
    `email_taken`, N1 with a 500, and E1 with a stack in the body.
- **Break tests:** 25, and each fails its own named check.
  - C1–C20 for the API (no C10, plus C15b). C2 was isolated with a
    diagnostic, and C14 was stopped by the rebuild's own guard.
  - B10 and B10b–e for the dashboard.
- **Security review:** three rounds, with no vulnerability. The first found
  the name leak (decision 4) and the missing handler (decision 5). The second
  narrowed the handler to the parser's own errors, and widened the check that
  it is mounted last to catch every way of registering a route. The dashboard
  review's autofill note was taken.
- **Suites:** migration 231, api 4404, rollup 211, quickbooks 357, earning
  132, both typechecks, and the dashboard production build.
- **Live, 2026-09-26:**
  - **Backup:** the API was stopped, and the backup is
    `fuel.db.bak-adr0018-20260926T113246Z` (SHA-256 `4e74e04f…8dad54`,
    identical to `fuel.db`).
  - **Rehearsal:** the migration ran on a copy, booted twice (the second boot
    was a no-op). All 19 tables had identical content.
  - **Migration:** it ran on `fuel.db` when the API restarted.
    - All 19 tables hashed the same, companies without the new column.
    - Both companies are unchanged on id, name, cap and created_at. The caps
      are still 5000000 and 0.
    - The unique indexes are now `handle` and `(company_id, email)`.
    - Integrity ok, 0 FK violations.
  - **Handles:** Default Company is `default-company-33kj`. Company B is
    `owner-example-com-evg7`.
  - **Probes, with no real password:**
    - A missing company got a 400.
    - An unknown handle, a value that isn't handle-shaped, and an unknown
      address at a real handle each got the identical 401.
    - Malformed JSON got 400 "malformed request".
  - **The owner** signed out of their pre-migration session, then back in with
    `default-company-33kj` on the rebuilt dashboard. The badge showed the
    handle, and the data was intact.

## What this does not cover

- **The oracle was not run live.** It was offered as a separate step:
  company B's owner invites A's operator address and redeems it, which would
  add one user to B permanently. It is proven by O1, its check against the old
  code, and C1 and C2.
- **A handle made from a default name carries part of an email.** The signup
  form can't name a founding company (0017), so company B is named after its
  owner's address, and its handle starts `owner-example-com-`.
  - It is not a cross-company leak. Only B's members and invitees see the
    handle, and they can already see the name.
  - Every company founded without a name will get a handle like it. The fix
    belongs with letting the signup form name the company.
- **The rate-limit key joins handle and address with a NUL character**, and
  the handle is checked for shape only after the limit. This is not
  exploitable:
  - the limit is checked before the handle's shape, so a crafted value
    containing a NUL can make two keys collide;
  - but a colliding key only lands in a bucket that already exists for some
    account, and anyone can already fill that bucket by typing that account's
    real handle and address. So a collision reaches nothing new.
  - Recorded, not changed.
- **Some checks read the source, not the running code.**
  - The dashboard checks (D1–D5), and E4's check that `server.ts` mounts the
    handler last, show the code is *written* correctly. The dashboard can't be
    imported by `verify-api` (the `@/` alias), and `server.ts` listens as soon
    as it is imported.
  - For the sign-in path, the owner's live sign-in closes that gap.
- **The per-address sign-in limit is unchanged**, including 7A-2's recorded
  residual that it means little behind a proxy.
