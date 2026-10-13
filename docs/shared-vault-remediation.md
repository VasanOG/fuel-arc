# Two agents share Fireblocks vault 4: the repair

**Status: dry run reviewed, waiting on explicit confirmation before the sandbox
call.** Nothing in `fuel.db` has changed yet.

## Why this blocks boot now

7A-1 makes agent names unique **per team** instead of globally, so two companies
can each have a `researcher`. That change exposed a custody hazard:
`provisionAgentWallet` is idempotent **by vault name**. When it's asked for a
name that already exists, it returns that existing vault. Vaults were named
`fuel-agent-<agent name>`, so without the global name constraint, a second
company's `researcher` would have received the first company's vault, with no
error.

The fix has two parts:

1. **Vaults are named after the agent's id**, which is minted fresh for one
   agent (`src/agents/create.ts`).
2. **`UNIQUE (fireblocks_vault_id)`** on `agents`, so two agents on one vault
   can't be written at all, whatever a provisioner returns.

The live database already violates part 2, so the migration refuses to boot it
and names the rows involved. It doesn't pick which agent keeps the vault,
because that choice decides who holds the money.

## The pair

| | `trap-bot` | `empty-balance-test-agent` |
|---|---|---|
| id | `80081c73-9426-4406-b7b2-8e11670f40d3` | `d6f29943-241d-4874-a0a2-9a21f7c7ebb0` |
| vault | 4 | 4 |
| payments | 5 settled, 2 blocked | 1 unreconciled, 1 blocked |
| **after the repair** | **keeps vault 4** | **new, empty vault** |

The sharing was deliberate in Phase 1 (`docs/roadmap.md`: "vault 4, no USDC,
used for the fail-closed test"). It stopped being harmless once trap-bot settled
payments from vault 4. From then on, two agents with separate spend caps drew
on one pool of money, and neither cap could see the other's spending.

**Why trap-bot keeps vault 4:** its settled history was signed by that vault.
The fixture has never settled anything, and a new empty vault fits its purpose,
which is proving Fuel fails closed on an agent with nothing to spend.

**The fixture's two payment rows stay as they are.** The unreconciled one was
signed by vault 4, failed at the facilitator for insufficient balance, and still
needs an operator to resolve it by hand (`POST /api/payments/:id/reconcile`).
Nothing reconciles a payment through the agent's current vault, so repointing
the agent doesn't change how that row is resolved. The blocked one was never
signed.

## The script

`scripts/remediate-shared-vault.ts` opens `fuel.db` with raw `node:sqlite`.
Importing `src/db/index.ts` would run the very migration that refuses this
database.

- **Default (dry run):** checks the exact known state, prints what it would do,
  opens the file read-only and makes no network call.
- **`--confirm`:** re-checks the state, backs up with `VACUUM INTO`, runs one
  provisioning operation against the Fireblocks **sandbox** (it refuses unless
  the base path is the sandbox), then runs one guarded update:

  ```sql
  UPDATE agents SET fireblocks_vault_id = <new id>, address = <new address>
   WHERE id = 'd6f29943-241d-4874-a0a2-9a21f7c7ebb0' AND fireblocks_vault_id = '4';
  ```

  The update must change exactly one row, and afterwards no vault may be shared,
  or the transaction rolls back.

The script refuses and changes nothing if any of these hold: the fixture has
settled payments, a payment in flight, a live approval, an earning endpoint or
receipts; the two agents' addresses differ; or sharing is anything other than
exactly this pair. A re-run after success reports nothing to do. A re-run after
a crash between the sandbox call and the update finds the same vault again by
name instead of creating a second one.

`scripts/verify-migration.ts` covers the dry run, both refusals, the no-op
re-run and the post-repair boot on scratch databases. No suite ever passes
`--confirm`.
