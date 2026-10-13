# 0017 — A QuickBooks connection is proved twice: by who finishes it, and by Intuit's word on which books

**Status:** accepted
**Date:** 2026-09-25
**Closes:** 7A-3 item 4 ("a second Fuel company connecting its own QuickBooks
company is unproven"), and 7A-1's known gap (b) ("a token used against a
different company the same user owns")
**Builds on:** [0008](./0008-quickbooks-posting-and-attribution-boundary.md) (the
OAuth flow), [0014](./0014-a-decision-has-a-name-on-it.md) (a shared key names
nobody), [0015](./0015-a-quickbooks-document-is-pinned-to-its-books.md) (every
artifact is pinned to its books). **Corrects** one claim in 0015 (see below).

## Decision

1. **Only the person who started a connection can finish it.**
   - `qbo_oauth_states.created_by` records who pressed Connect.
   - The OAuth callback refuses unless the browser bringing the code back
     carries that person's live session, in that link's company.
   - The check runs before the code is exchanged, so a refused link spends
     nothing and reads nothing.
   - A state that names nobody (minted before the column existed) is refused.
2. **A shared API key cannot start a connection** (`POST /connect` → 403). A
   secret names nobody, so a link it started could be finished by anybody.
3. **The books saved are the ones Intuit says it granted.**
   - Fuel asks for `openid` alongside the accounting scope, and reads the ID
     token's `realmid` claim from the token response.
   - The connection is saved only if `realmid` equals the redirect's
     `realmId`.
     - No usable ID token → 502.
     - A different company → 400.
     - Both happen before any books are read.
   - `grantReachesRealm` (a read of the named company) stays, as a liveness
     check only.
4. **The ID token's signature is not checked**, and only one caller may read
   it: the callback, on the token response it just received. A source guard
   in `verify-api` enforces that.

## Why

### A link was bound to a company, not to a person

Until this item there was one company, so "which person in it finished the
link" changed nothing. With two companies it changes everything:
1. An operator at company B presses Connect, and gets someone at company A,
   which hasn't connected yet, to open the Intuit link.
2. That person consents for A's books, and the callback saves them under B.
3. B can then read A's books, and A can never connect them, because a
   QuickBooks company belongs to one Fuel company.

No realm proof can see this: the grant really is for those books, because
their holder consented. Only binding the link to its starter can. Against the
previous code the test connected (302), and a shared key could start a link
(200).

It is the person, not the company. A colleague finishing someone else's link
is refused too, which keeps "who connected these books" a single answer.

### The realm proof proved less than it claimed

The callback took `realmId` from the redirect, and "proved" it by reading
`companyinfo/<realmId>` with the new token. That rested on an assumption
about Intuit: a token only reads the company it was granted for. 7A-1 tested
that against a company nobody owns (refused), and recorded case (b), a company
the *same user* owns, as unproven.

Item 4 ran it, on 2026-09-23 and again on 2026-09-25 with new grants:
- **What Intuit did:** company B's token, sent to company A's books, got
  **HTTP 200, answered with B's own company**. The company name matched B's
  ("…e59f"), and the owner confirmed in Intuit's portal that A's is "…015d".
- **What still holds:** an ID nobody on the account owns is still refused
  (401, code 120).

So a successful read proves only that *the token's Intuit user can reach* the
named company. Someone with Intuit access to another business's books could
consent for their own, edit `realmId`, and pass. Fuel would then save the
other business's ID against a token served by the attacker's books, so every
later request "for" those books would land in the attacker's, and the real
owner would be locked out. Against the previous code the test connected
(302).

**The ID token is Intuit's own statement of the granted company.**
- Intuit's sandbox discovery document lists `realmid` among its claims.
- Live, every connection since the fix logged that the ID token named the
  company the redirect named.
- The consent screen showed nothing new ("Connecting Test App to Sandbox
  Company US e59f").

### Why no signature check

The ID token arrives in the direct response from Intuit's pinned token
endpoint, over TLS, to a request authenticated with our client secret. OpenID
Connect Core §3.1.3.7(6) allows TLS server validation in place of the
signature in exactly that case. Checking the signature would add a second
network dependency (Intuit's key set) to defend against someone who can
already forge Intuit's TLS.

The argument holds only for that token. So `grantedRealm` is called in one
place, on one value, and a source guard fails the suite if either changes. A
stored or browser-supplied ID token would inherit a trust it hasn't earned.

### Why before the exchange, and why after it

The person check needs nothing from Intuit, so it runs first: a hijacked
link spends no code and reads no books.

The ID token only exists after the exchange, so the realm check runs there.
It runs on values already in hand, before `grantReachesRealm` reads anything:
a refused realm is never read.

## Correction to 0015

0015 says "a token only reaches its own books" and "a token reaches nothing
else". More precisely: **a token is served only by its own books**, even when
a request names another company its user can reach. That request is answered,
but with the token's own company. 0015's decisions are unaffected, because
its pins compare Fuel's own records, and each company's token and realm come
from the same row.

What depended on the old claim was the callback's realm proof, fixed here.
Two earlier results still stand, for a reason 0015 did not state:
- **Company A's connection (2026-08-25)** was made when only one sandbox
  company existed on the account, so the only company its token could reach
  was the one saved.
- **0015's DocNumber lookups** were therefore made in the books those
  documents are stamped with.

## Consequences

- **The dashboard and API must share a cookie host** (both `localhost`
  today). Intuit's redirect is a top-level GET to the callback, and the
  `SameSite=Lax` session cookie is sent on exactly that. If they are ever
  split across hosts, the callback must be reached through the dashboard's
  host, or every connection is refused. It fails closed.
- **Reconnecting needs the same person, in the same browser.** Opening a
  Connect link in another browser, or after signing out, is refused.
- **Connecting via a script is no longer possible.** Nothing did.

## Proof

- **Tests:**
  - verify-api H1–H10 (the person) and R1–R8 (the books).
  - The Intuit stub now behaves as Intuit did live, not as it was assumed to.
  - verify-migration covers `created_by`; verify-quickbooks covers the writer
    and `grantedRealm`'s edges.
  - Ordering checks showed each hole against the previous code first.
- **Break tests:** 13 for the person binding and 11 for the realm proof, each
  failing its own named check.
- **Security review:** both commits, no vulnerability. It noted a stale
  comment (fixed) and suggested the single-caller guard (added).
- **Live, 2026-09-23 and 2026-09-25:**
  - **Migration:** backup `fuel.db.bak-7a3-item4-20260923T212051Z` (SHA-256
    `47f1fcd4…e000`), the migration rehearsed on a copy, then run on
    `fuel.db`. Every count and hash was unchanged.
  - **A second company:** created by a founding invite; it connected its own
    sandbox books.
  - **Company A:** its connection, account mapping and postings hashed the
    same until 2026-09-25.
    - That day the owner, by accident while switching between browser
      windows, connected A briefly to B's sandbox company (…2698, while B was
      disconnected), then back to its own (…3246), in a new row with new
      tokens. The owner confirmed it was their action.
    - Its mapping and postings were unchanged throughout, and nothing was
      pending.
    - The system allowed exactly what it should: A could switch books because
      nothing was pending, and could take …2698 only because no other Fuel
      company held it.
  - **The hijack:** a link started by B's owner and finished in a window
    signed in as A was refused, and no code was exchanged.
  - **The realm fix:** it connected three times, each confirmed by Intuit's
    ID token.
  - **The probe:** it passes against Intuit's measured behaviour.

## What this does not cover

- **The company-ID edit was not run against real Intuit.** It was offered
  and skipped. It is proven by R1, its ordering check and its break tests,
  against a stub modelled on the measured behaviour. Live, we have seen the ID
  token *agree* with the company picked; we have not seen it *disagree*.
- **A refused grant is not revoked at Intuit.** Fuel discards the tokens but
  does not call Intuit's revoke endpoint. The tokens reach only the consenting
  person's own books. The reviewer rates this hygiene.
- **The signup form cannot name a founding company**, so company B is called
  "owner@example.com's company". The API accepts `companyName`;
  the form never sends it.
- **Fuel's Disconnect does not revoke at Intuit** (existing behaviour). The
  grant stays live at Intuit until it expires or is revoked there.
