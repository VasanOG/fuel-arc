# Two agent names carry custody vocabulary — a proposal, not a change

**Nothing has been renamed. `fuel.db` is untouched. This is a mapping for
approval.**

## The problem

CLAUDE.md: *"no crypto terms (wallet addresses, chain names, token names) ever
appear in the product."* Two agents are named after the Fireblocks vaults they
were created to exercise, and the dashboard renders those names — on the Agents
roster, on the agent record, in the Activity Ledger, and in the Approvals queue.
`vault` is custody vocabulary, and it is on a customer-facing surface.

This is a **data** problem, not a code one. The dashboard is rendering the name
the operator gave the agent, which is exactly what it should do. Nothing in the
UI should paper over it — a display-name override would leave the real name in
the database, in exports, and in every future surface that reads it, while
making the problem invisible to the person who could fix it.

## What these two agents actually are

Traced before proposing anything.

| | `vault1-signing-test` | `vault4-empty-test` |
|---|---|---|
| id | `dc66929c-dca3-42a5-832e-e36fe6bf583d` | `d6f29943-241d-4874-a0a2-9a21f7c7ebb0` |
| team | Team B | Default Team |
| created | 2026-08-01T19:10:45.888Z | 2026-08-01T19:12:29.159Z |
| frozen | no | no |
| payments | 8 (4 settled, 4 refused) | 2 (1 unconfirmed, 1 refused) |
| **demo payments** | **0** | **0** |
| approval requests | 0 | 0 |
| accounting postings | 0 | 0 |
| posting lines | 0 | 0 |

**Both are real test records, not demonstration data.** Their payments are
genuine sandbox payments from Phase 3 — real settlements, real refusals — and
none is marked `is_demo`. They are not candidates for the demo marker and must
not be swept up with it.

Neither has ever reached the accounting pipeline: zero postings, zero posting
lines, so no QuickBooks document names either of them.

## Proposed mapping

The names should say what the agent was for, in product language. What each one
was actually testing is recorded in `docs/roadmap.md`:

| id | current | proposed | why |
|---|---|---|---|
| `dc66929c-…` | `vault1-signing-test` | `signing-test-agent` | It exists to exercise the signing path end to end. Drop the custody noun; keep the purpose. |
| `d6f29943-…` | `vault4-empty-test` | `empty-balance-test-agent` | It exists to prove Fuel fails closed on an agent with no funds. "Empty balance" is the product-language version of "empty vault". |

Both are unique, both fit `agents.name`'s UNIQUE constraint, and neither
contains custody, chain or token vocabulary.

## What a rename would and would not touch

- **Would not** affect custody. `agents.fireblocks_vault_id` is what every
  custody call uses (`getVaultUsdcBalance`, `signerForAgent`); the name is not
  a key into anything at Fireblocks. The vault created at provisioning time is
  named `fuel-agent-<name>`, so after a rename the Fireblocks-side vault name
  and the Fuel-side agent name would differ — cosmetic, and only visible inside
  the Fireblocks console.
- **Would not** affect payments, approvals, budgets or accounting. Every one of
  those references the agent by `id`.
- **Would not** affect the seed script, which looks up `research-bot` and
  `race-bot` by name and neither of these.
- **Would** require updating one comment in `scripts/verify-api.ts`, which cites
  these names as the reason its terminology scan strips operator-chosen names
  before scanning. The check itself is name-agnostic and would keep working.
- **`docs/roadmap.md` should NOT be rewritten.** It is a record of what
  happened, and these names are what those agents were called at the time.

## The statement to run, if approved

Not run. Recorded so the change is reviewable before it is made, and so it can
be applied exactly as proposed rather than retyped.

```sql
-- Back up first: cp fuel.db fuel.db.bak-rename-$(date +%Y%m%d-%H%M%S)
UPDATE agents SET name = 'signing-test-agent'
  WHERE id = 'dc66929c-dca3-42a5-832e-e36fe6bf583d' AND name = 'vault1-signing-test';
UPDATE agents SET name = 'empty-balance-test-agent'
  WHERE id = 'd6f29943-241d-4874-a0a2-9a21f7c7ebb0' AND name = 'vault4-empty-test';
```

Both statements are guarded on the current name as well as the id, so re-running
them changes nothing and a row that has already been renamed by someone else is
left alone rather than overwritten.

## A related finding, out of scope for this slice

`dashboard/app/accounting/page.tsx` renders `Sandbox · {status.realmId}` — the
QuickBooks realm id, a provider identifier, on a customer-facing surface. It is
not custody vocabulary and it predates this slice, but it is the same class of
thing: an internal identifier that reached a screen because it was available.
Worth deciding on separately.
