# 0014 — A decision has a name on it: identities, and what a shared key may no longer do

**Status:** accepted
**Date:** 2026-09-21
**Closes:** the "a seam, not tenant isolation" limitation recorded in
[0009](./0009-activity-data-contracts-and-tenancy-scope.md), and the
"one credential shared by every agent" caveat it depends on
**Builds on:** [0009](./0009-activity-data-contracts-and-tenancy-scope.md)
(every route is company-scoped)

## Decision

1. **A login is an identity, not another shared secret.** A person signs in,
   gets an `HttpOnly` session cookie, and the company they act for comes from
   their own row in `users` — not from a binding baked into the server.

2. **Accounts exist only by redeeming an invite somebody deliberately minted.**
   There is no self-serve signup and no route that creates a company. The
   invite that creates one can be minted only by an operator script, behind an
   explicit flag.

3. **`approval_requests.decided_by` records which person decided.** It is
   nullable, and the nulls are not backfilled.

4. **Once a company has accounts that can sign in, a shared API key may no
   longer approve or deny that company's payments.** It is refused with a 403
   whose message names the reason and the fix.

5. **The legacy keys keep everything else**, and stay bound to the recorded
   bootstrap company. They are barred from the powers that *create identities*
   — minting an invite, managing users, creating a company.

6. **A shared key is not told who decided, either.** `decidedBy` is present in
   the response for every caller and is null unless the caller is a signed-in
   person.

## Why

### Two-party control whose parties are both anonymous is one party

Slice 2 split one credential into two: `FUEL_AGENT_KEY` may spend and may not
approve, `FUEL_API_KEY` may approve and may not spend. That split is real and it
still holds. What it never established is that *two different people* are
involved.

Both keys sit in the same `.env`. Anyone holding one almost certainly holds the
other. So the "two parties" in the two-party control were, in every deployment
that has ever existed, the same person — and Fuel could not tell, because
neither key names anybody. The control was structurally sound and
epistemically empty.

Decision 4 is what closes that, and it is the point of the whole stage
compressed into one rule. It is scoped rather than absolute for a reason given
below.

### A null is worth more than a plausible name

`decided_by` is nullable because every approval decided before this existed was
decided by a key that names nobody. There is no answer to backfill.

The tempting move is to write the bootstrap owner's id into those rows, so the
column is never null and every report is tidy. That would be fabricating an
audit trail. An auditor who reads a fabricated name is worse off than one who
reads a blank and asks a question — the blank is *true*, and it is the only
honest thing the database can say about a decision that genuinely had no author.

So null means exactly one thing from here on: a shared key decided this, and no
individual can be named. Decision 4 relies on that reading, which is why the
column must not be polluted with plausible-looking values.

### Why the refusal is scoped, not absolute

"A shared key may never decide" would be simpler to state and worse to live
with. A company nobody can sign in to still needs its held payments decidable,
and every operational script in this repository authenticates with a key and has
no browser to sign in from.

The refusal therefore turns on the one fact that makes it fair: somebody *can*
decide this as themselves. It also un-refuses itself — the check counts accounts
that are not disabled, so a company whose every account has been disabled falls
back to the key rather than becoming undecidable. A lockout on the approval
queue, where held payments pile up and nobody can release them, is a worse
outcome than a nameless decision.

### Why the check and the write are one transaction

The refusal is a check-then-act: read whether the company has accounts, then
write the decision. Split across two statements that has a real window — a
company could gain its first account between the check and the write, and a
shared key would slip a nameless decision in underneath it.

This stage has been bitten by that shape twice already, so `decideRequest` takes
the write lock up front with `BEGIN IMMEDIATE`, and signup uses the same
pattern, so the two serialise against each other rather than interleaving.

For the same reason `decided_by` is written in the *same* `UPDATE` as the
status, never a second one. With the write split in two, two operators deciding
at the same instant can produce a row whose status came from one of them and
whose name came from the other — an approval that reads perfectly normally while
crediting somebody who did not make the decision. The cross-process race test in
`scripts/verify-migration.ts` demonstrates exactly that when the split is
introduced deliberately.

### Why a key may not even READ who decided

Decision 6 was not in the plan. It came out of security review, and it is
decision 4's own argument pointed back at this document.

The legacy key resolves to the `operator` role, so the first version of
`decided_by` disclosed, to every operator caller, the address of everyone who
had ever decided anything. That hands the credential we have just declared
untrustworthy to *attach* a name to a decision the ability to *enumerate* the
names attached to all of them — and email addresses are a category of personal
data the approvals surface did not previously carry at all.

Nothing legitimate wanted it. The dashboard carries sessions now, and no script
in this repository reads the field.

The cost is that null is overloaded for a key caller: it can no longer tell "a
key decided this" from "you may not be told". That is acceptable because both
mean the same thing to that caller — no identity is available to you — and a
signed-in person still gets the two-way reading `status` disambiguates. The
response keeps the same shape for both, so nothing can be inferred from a
missing field either.

The real fix is retiring the legacy key. This narrows the disclosure; it does
not pretend to close it.

### Why the session is a cookie and the dashboard holds no key

The dashboard used to hold `FUEL_API_KEY` and put it on every request, which
made every viewer of the product the same anonymous operator. It now forwards
the session cookie of whoever is signed in, and holds no credential of its own.

The API stays the single security boundary: it validates the session, resolves
the company from the user's row, and decides what that person may do. The
dashboard's routing gate checks only that a cookie with the right *name* exists
and is explicitly not a boundary — anyone can set that in their own browser, and
what they reach is pages whose every byte comes from an API that refuses them.

`sessions.id` is the SHA-256 of the cookie value and the value itself is never
stored, so a copied `fuel.db` is not a set of live logins — the same argument
`src/lib/secrets.ts` makes about database files reaching laptops and bug
reports.

## Consequences

- **0009's "a seam, not tenant isolation" is closed for the routes swept.** A
  second company with its own signed-in person can now exist, which is what
  makes the distinction observable at all: with one company and one key bound to
  it, no test could tell a route that scopes correctly from a route that scopes
  to the only company there is. `scripts/verify-api.ts` reads every operator
  route as a person at a second company and asserts that no identifier belonging
  to the first appears, with the reverse direction and a positive control.

- **Scripts keep working, and that is deliberate.** `walk-accounting`,
  `walk-revenue`, `seed-demo-day` and the verification suites all authenticate
  with `FUEL_API_KEY`. None of them approves or denies, which is what made
  decision 4 shippable without breaking them. A script that needs to decide in
  future must sign in.

- **The suite's approval tests now decide as a person.** That is a gain rather
  than an accommodation: they exercise the path a real operator uses, and a
  suite that kept approving with a key would have gone on passing long after
  that path broke.

- **Retiring the legacy keys entirely is NOT decided here.** Its criteria —
  every script either has a service credential or is run by a person with a
  session — belong to the per-agent-credential work Phase 7 already lists.

- **A shared key can still decide for a company with no accounts, and that
  decision honestly records no author.** This is the residual the scoping buys,
  and it is stated rather than hidden: the only way to remove it is to make
  every company have an account before it can hold a payment, which is a
  product decision this does not take.

- **The agent credential reads `GET /approvals/:id` and is on the same side of
  decision 6 as the operator key.** It is a shared machine credential that names
  nobody, so it is told null too. This costs an agent nothing — it reads that
  route to learn whether its own held payment was released, and who released it
  was never part of the answer.

## What this does not decide

- **Per-agent credentials.** The agent key is still shared by every agent, so
  "which agent asked" is still not a question Fuel can answer from the
  credential. Unchanged by this document; see 0009.

- **Password reset by email.** Fuel sends no email. Recovery is
  `scripts/set-password.ts`, run by somebody with access to the machine.

- **Roles beyond owner and operator.** Two are enough for what exists. The
  escape hatch for a stranded QuickBooks posting, which 7A-1 said needed "a
  higher role than a plain operator", now has one to hang off but is still not
  built.
