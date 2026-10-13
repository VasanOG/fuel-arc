# 0008 — How Fuel posts to QuickBooks, and where attribution stops

**Status:** accepted
**Date:** 2026-08-25
**Amends:** [0007](./0007-accounting-integration-posting-model.md) — supersedes its
per-agent QuickBooks Class decision. Everything else in 0007 stands.
**Inherits:** [0006](./0006-accounting-export-omits-crypto-identifiers.md) — no
crypto identifiers cross into Intuit's records.

## Decisions

1. Fuel posts **JournalEntry** documents, not Purchases or Bills.
2. The **contra account is configurable per company** — prepaid/wallet asset,
   cash, or clearing.
3. **No QuickBooks Class per agent, and no auto-created Vendor per merchant
   host.** Fuel is the source of truth for agent and merchant attribution.
4. Preview and post are bound by an **immutable snapshot**.
5. A posted entry is **never edited**; corrections are new linked entries.
6. **USD only**, verified from `Preferences.CurrencyPrefs.HomeCurrency` and
   never inferred from country. No multi-currency, FX conversion, tax
   calculation or tax reporting. Preview refuses on the stored record; post
   re-reads and refuses on a fresh one, before creating any attempt.
7. **No PKCE**, because Intuit does not support it; a durable, single-use,
   company-bound `state` is the control instead.

## 1. JournalEntry, not Purchase

Fuel's rollup engine emits signed whole-cent amounts per account. A
JournalEntry is literally a set of signed amounts per account, so the mapping is
total: every line the engine can produce maps with no special case, including
the negative ones that release a suspense balance. QuickBooks carries direction
in `PostingType` and rejects a negative `Amount`, so a negative line simply
becomes a credit.

Purchase is the more familiar "we paid a vendor" document and was the tempting
choice — vendor sits at the transaction level, and it reads naturally to a
bookkeeper. It was rejected because it cannot express a suspense-to-expense
reclassification at all. That would have meant two entity types, two idempotency
stories and two failure modes in an integration that had never posted anything.

**The property that confirmed the choice:** for a group whose amounts net to
zero — which is exactly a pure reclassification — the mapper emits no contra
line, and the entry still balances. Moving money between two accounts does not
touch the funding account. That falls out of the model rather than being
special-cased, which is the strongest evidence available that the model is
right.

## 2. The contra account is per-company configuration

A JournalEntry must balance, so a debit to expenses needs a credit somewhere.
What that "somewhere" is depends on how the customer funds Fuel, and there is no
single correct answer: a prepaid balance they have already sent, a cash account,
or a clearing account settled separately. Picking one for everybody would
misrepresent the others, so it is configuration. The default is a prepaid asset,
because that matches how the product works today — agents hold pre-funded
wallets, so the money genuinely left the customer before the payment happened.

## 3. Attribution stops at Fuel's boundary — this supersedes 0007

0007 specified one line per agent, tagged with a QuickBooks Class. That is
reversed here.

- It pollutes a customer's chart of accounts, class list and vendor list with
  Fuel's internal entities. A customer with forty agents does not want forty
  QuickBooks classes they did not ask for, and cannot easily undo them.
- Class tracking **requires QuickBooks Plus or Advanced**. 0007's design carried
  a silent dependency on a subscription tier, which would have failed for
  customers on Simple Start or Essentials with no obvious cause.
- It is the weaker product position. The fine-grained record — which agent,
  which merchant, which approval — is the thing Fuel uniquely has. An accounting
  system is the wrong place to keep it, and putting it there invites the
  question of why you need Fuel at all.

So QuickBooks receives a clean accounting summary, and the detail is reached by
drilling back into Fuel. Class remains available as an **optional, explicitly
configured** mapping onto customer-defined teams or cost centres — a concept the
customer already has — and Vendor only for hosts an operator has deliberately
mapped.

**The obligation this creates.** If the detail is not in QuickBooks, the path
back to it has to be permanent and obvious. That is why every posted entry
carries a deterministic `DocNumber` and a `PrivateNote` naming its Fuel
reference, and why the chain
`qbo_postings → draft → posting_lines → export_postings → payments →
approval_requests` is preserved end to end. A rollup tool could produce the
totals; the traceable version of that chain is the product.

## 4. Preview and post are bound by an immutable snapshot

Preview does not merely render a payload — it writes a durable draft holding the
exact payload, a hash of it, the exact posting lines it covers, and a
fingerprint over the payments those lines were derived from. Post sends the
stored bytes.

Without this, preview and post are two clicks with a gap, and in that gap a
posting run can add lines or a payment can settle. Recomputing at post time
would mean the entry reviewed and the entry posted are different documents,
which makes the review — the only human control on this path — meaningless.

The fingerprint covers payment **status**, not just line ids. A payment moving
`unreconciled → settled` changes what a suspense line means without altering any
existing row, so a line-id comparison alone would miss it.

## 5. Corrections are new entries, never edits

Once a document is posted it is never updated, replaced or deleted. If
settlement later changes or a mapping was wrong, Fuel emits a new entry with its
own document number, linked to the original by `corrects_posting_id` and naming
it in `PrivateNote` so the link is legible inside QuickBooks as well as inside
Fuel.

An audit trail is a sequence of entries, not a mutable record — the same
instinct that already makes payment statuses terminal. A bookkeeper may have
reconciled against the original; silently rewriting it would be worse than
wrong, it would be invisible.

Two consequences worth stating. A posted correction **releases** the original's
lines, so the spend can be booked correctly — otherwise the only way to fix a
misposting would be to never book that spend at all. And a re-post after a
reversal takes a **new document number**, because the reversed entry keeps the
old one; without that, the duplicate-number path would adopt the reversed entry
as though it were the new one.

## 6. USD only

This slice refuses non-USD activity and attempts no multi-currency handling, FX
conversion, tax calculation or tax reporting. Enforced twice: the mapper refuses
a non-USD line, and connection setup reads the company profile so a mismatch is
found during setup rather than half way through building a document.

Those are each real features with their own decisions to make — which rate on
which date, which tax codes, which jurisdiction's rules — and guessing at them
would produce numbers that look authoritative and are not.

**Correction, 2026-08-25.** For a while this section was false. The setup-time
half did not exist: the function it named read `CompanyInfo.Country` and never
looked at a currency, so only the mapper enforced anything. The home currency is
not on `CompanyInfo` at all — it is `Preferences.CurrencyPrefs.HomeCurrency`, a
second call — which is why the check as originally described was not merely
unimplemented but unimplementable. A US-registered company keeping its books in
another currency would have passed setup and had every figure mis-stated at par.
Now genuinely enforced before any account is created, and failing closed when
Intuit reports no home currency rather than assuming USD.

**Amendment, 2026-08-25 (Slice 2c): where the currency claim comes from, and
what it is worth.** The correction above fixed the reading. This fixes the
*claim*, which was the deeper problem — the original text asserted enforcement
that did not exist, and nothing in the system distinguished a fact Fuel had
checked from one it had assumed.

*The source.* `Preferences.CurrencyPrefs.HomeCurrency` is the supported,
documented answer: Intuit's own Customer and Vendor references define a default
currency by pointing at it. Confirmed live against sandbox company
`9341457784003246`, which returns
`{"MultiCurrencyEnabled": false, "HomeCurrency": {"value": "USD"}}`. Because a
reliable field exists, Fuel verifies rather than asking an operator to assert.
There is no operator-confirmation path, deliberately: offering one would create
a way to declare USD without evidence, which is the failure this amendment
exists to close.

*Country is never consulted.* Not as a fallback, not as a hint. A US-registered
company can keep its books in any currency, so country carries no information
about this question, and a check that reads it produces confident wrong answers.
There is a regression test asserting the gate's source contains no reference to
a country.

*The claim always carries its evidence.* `qbo_config` stores the currency
alongside `currency_source` and `currency_checked_at`, and the API reports all
three. `verified: true` is reserved for `quickbooks_preferences`; any other
source is refused outright rather than downgraded, so "verified" and "asserted"
can never be read as the same word. An unchecked company reports `null`, not a
hopeful `"USD"`.

*The gate is on preview AND post, and it reads the record, not the network.*
Preview must send nothing to QuickBooks — that property is what makes "did that
reach Intuit?" answerable — so verification happens once at setup and is stored.
Post re-checks the same record, so a draft frozen while a company was in scope
cannot post after it leaves. Existing companies were migrated to `null`, not to
`USD`: they have never had their currency read, and manufacturing the answer for
them would recreate exactly the false confidence being removed.

**Amendment, 2026-08-25 (Slice 2d): the record is re-established at the moment
it has to be true.** The limitation recorded above — that a stored verification
goes stale — is now closed at the only point where staleness can do damage.

Immediately before any JournalEntry mutation, `post` re-reads
`Preferences.CurrencyPrefs.HomeCurrency`, records what it finds, and refuses
unless that fresh reading is USD.

*Preview still sends nothing.* The earlier objection to re-reading — that it
would put a network call inside preview — was correct, and the resolution is
that preview does not need one. Preview gates on the record; post re-establishes
the record. Preview's silence is what makes "did that reach Intuit?" answerable
without ambiguity, and it is why preview and post are separate routes rather
than one route with a `dryRun` flag. That property is preserved exactly.

*Ordering is the substance of this change, not a detail.* The check runs before
`beginPosting`, so a refusal creates no attempt row, mints no `requestid`, and
sends no JournalEntry. A refused post is indistinguishable from a post that
never happened. Were it ordered the other way, the fail-closed `pending` state —
which exists to mean "a document may exist" — would fill with attempts that
never had any chance of being sent, and the one state that must stay meaningful
would stop being so.

*A refusal records what it found.* The reading is written before it is judged,
so a company that has switched to CAD ends up with `CAD` stored rather than a
stale `USD`, and `status` afterwards reports the currency Fuel actually
observed. An earlier version saved only on success, which meant the system had
read the truth and kept disagreeing with it.

*What remains.* The window is now one QuickBooks round-trip wide: a company that
changes its home currency between Fuel's read and Intuit's write of the same
document would still be posted in USD. Closing that would require a transaction
across two systems, which QuickBooks does not offer. Corrections are the remedy
for that case, as they are for every other post-hoc discovery — see §5.

## 7. No PKCE, and why that is not a gap

Intuit's documented authorization parameters are `client_id`, `response_type`,
`scope`, `redirect_uri` and `state`. `code_challenge` is not among them, and the
developer community has asked about PKCE support without it materialising.

Sending it anyway was considered and rejected as worse than omitting it: a
server that ignores the challenge still issues the code, so the flow would
*appear* hardened while providing nothing, and the next person to read it would
reasonably assume the interception attack was covered.

What protects the flow instead:

- Fuel's backend is a **confidential client**. It holds `client_secret` server
  side and presents it at token exchange — which is the protection PKCE
  substitutes for in public clients that cannot keep a secret.
- The redirect URI is registered with Intuit and matched exactly, so a code
  cannot be delivered elsewhere.
- `state` is 32 CSPRNG bytes, stored durably (not in memory: it survives a
  restart mid-flow and is auditable), bound to one company, TTL'd to ten
  minutes, and consumed by a guarded `UPDATE ... WHERE consumed_at IS NULL` so a
  replay changes no rows.

**Revisit if Intuit ships PKCE support.** Recorded here rather than left as a
code comment because it is a security decision, and a security decision that
lives only in a comment is one nobody reviewed.

## Sandbox only

The API origin is a hardcoded constant and every outgoing URL is compared
against it **by parsed origin equality, never by prefix** — `startsWith` accepts
`https://sandbox-quickbooks.api.intuit.com.evil.example`, which is a different
host that merely begins with the right characters. No environment variable
selects sandbox versus production; reaching production is a reviewed code
change, exactly as enabling mainnet is. See CLAUDE.md's non-negotiable rule.

## Consequences

- A customer cannot slice spend by agent inside QuickBooks. That is deliberate;
  they slice it in Fuel, which is the system that knows. If a customer genuinely
  needs it in QuickBooks, the optional team/cost-centre Class mapping is the
  supported route.
- The drill-down chain is now load-bearing for the product argument, not just a
  convenience. If it breaks, the integration becomes an ordinary rollup export.
- Tokens live encrypted in `fuel.db`. The database and the environment together
  are the whole secret; an attacker with both has the tokens. This raises the
  bar from one artifact to two, which addresses the realistic risk (a copied
  database file) without claiming key-management sophistication.
- `pending` postings need a human to reconcile. That is the cost of never
  guessing whether a document was created, and it is the right cost.
