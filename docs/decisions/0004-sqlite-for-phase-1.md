# 0004 — SQLite for Phase 1, not Postgres

## Decision
Store agents, spend caps and payments in SQLite via Node's built-in
`node:sqlite`, rather than the Postgres named in `/docs/architecture.md`.

## Why
The dev machine has no Postgres, no Docker, and no Homebrew, so standing up
Postgres meant a manual installer download before a single line of Phase 1
could run. `node:sqlite` ships inside Node 24 — no install, no dependency, no
service to keep running.

Phase 1 is "one agent, one wallet, one cap". That workload has no need for
concurrent writers, replication, or anything else Postgres is for. Buying
those now would cost setup time and buy nothing.

SQLite is also a genuinely good fit for the one hard requirement in this
slice: the spend cap must be checked and reserved atomically, or two
concurrent payments can both pass the check and overspend. SQLite's
single-writer model with `BEGIN IMMEDIATE` makes that guarantee easy to reason
about.

## Cost, and how it is contained
Every query lives behind `src/db/*.ts`. Nothing outside that directory writes
SQL or knows what engine is underneath, so the swap is contained to those
files plus a connection change.

The dialect differences we would hit are small and known: SQLite has no native
`bigint` column type (we store base-unit integers, which stay well inside a
signed 64-bit range), and `BEGIN IMMEDIATE` becomes
`SELECT ... FOR UPDATE` or `SERIALIZABLE` under Postgres.

## Revisit when
Any of: more than one process needs to write; we deploy anywhere other than a
dev machine; or we start needing real concurrency around budgets. The first
two are near-certain before Phase 2's approval flows, so treat this as a
Phase 1 measure rather than a lasting choice.

## Ruled out
- **Hosted Postgres (Neon/Supabase)** — matches the architecture doc, but adds
  a signup, a network dependency on every local run, and a third credential to
  keep out of git.
- **Installing Postgres by hand** — with no brew or docker this is a manual
  installer and setup before any code runs, for a slice that does not need it.
