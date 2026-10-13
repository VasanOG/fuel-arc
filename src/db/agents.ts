import { db } from "./index.js";

export interface Agent {
  id: string;
  name: string;
  teamId: string;
  fireblocksVaultId: string;
  address: string;
  spendCapBaseUnits: bigint;
  createdAt: string;
  /** When an operator stopped this agent. null means it is running. */
  frozenAt: string | null;
  frozenReason: string | null;
  /** Payment attempts refused by the CURRENT freeze; reset each time it is frozen. */
  frozenAttemptCount: number;
  lastFrozenAttemptAt: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  team_id: string;
  fireblocks_vault_id: string;
  address: string;
  spend_cap_base_units: number | bigint;
  created_at: string;
  frozen_at: string | null;
  frozen_reason: string | null;
  frozen_attempt_count: number | bigint;
  last_frozen_attempt_at: string | null;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    teamId: row.team_id,
    fireblocksVaultId: row.fireblocks_vault_id,
    address: row.address,
    spendCapBaseUnits: BigInt(row.spend_cap_base_units),
    createdAt: row.created_at,
    frozenAt: row.frozen_at,
    frozenReason: row.frozen_reason,
    // A count of attempts, not money — Number is the right type here, and it
    // cannot realistically approach the safe-integer ceiling.
    frozenAttemptCount: Number(row.frozen_attempt_count),
    lastFrozenAttemptAt: row.last_frozen_attempt_at,
  };
}

/**
 * Writes an agent row.
 *
 * THE ID IS THE CALLER'S, not generated here, because it exists before the row
 * does: the agent's vault is named after it and provisioned first (see
 * src/agents/create.ts). Generating a second id here would name the vault after
 * one agent and store another.
 */
export function createAgent(params: {
  id: string;
  name: string;
  teamId: string;
  fireblocksVaultId: string;
  address: string;
  spendCapBaseUnits: bigint;
}): Agent {
  const { id } = params;
  db.prepare(
    `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address, spend_cap_base_units, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.name,
    params.teamId,
    params.fireblocksVaultId,
    params.address,
    params.spendCapBaseUnits,
    new Date().toISOString(),
  );
  return getAgentUnscoped(id)!;
}

/**
 * An agent by id, UNSCOPED.
 *
 * Internal only, and the name is the warning. Every caller in this file is a
 * re-read of a row it has just written by primary key, where scoping would
 * check a fact the write already established. No HTTP route may use it —
 * `getAgentInCompany` is the one routes reach for, and scripts/verify-api.ts
 * asserts that `src/api.ts` never calls this.
 */
export function getAgentUnscoped(id: string): Agent | null {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

/**
 * The agent that owns an earning endpoint — the gateway's lookup.
 *
 * THE GATEWAY HAS NO PRINCIPAL, and that is correct: a payer is an anonymous
 * stranger, and the public id they present is deliberately looked up across
 * every tenant. So there is no company to scope by. What there IS is an
 * endpoint, and the endpoint is the tenant anchor: whichever company owns it
 * is the company this payment is for.
 *
 * This replaces `getAgent(endpoint.agentId)`, which reached the same row
 * through the one accessor documented as "no HTTP route may use it" — while
 * the source guard only read src/api.ts, so nothing noticed. The join states
 * the relationship instead of trusting a column read off a row fetched
 * earlier, and gives the gateway a name that says what it is asking.
 */
export function getAgentOwningEndpoint(endpointId: string): Agent | null {
  const row = db
    .prepare(
      `SELECT a.* FROM agents a
         JOIN earning_endpoints e ON e.agent_id = a.id
        WHERE e.id = ?`,
    )
    .get(endpointId) as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

/* -------------------------------------------------------------------------
 * Company-scoped reads.
 *
 * An agent reaches a company through `agents.team_id -> teams.company_id`,
 * both NOT NULL, so the join is total and drops nothing.
 *
 * `listAgents()` used to live here as a bare `SELECT * FROM agents` with no
 * predicate at all, behind an ANY route. That is deleted rather than deprecated:
 * a function whose only correct use is "never" should not be callable. Same
 * standing caveat as everywhere else — this is a query seam, not tenant
 * isolation (ADR 0009).
 * ---------------------------------------------------------------------- */

export function listAgentsInCompany(companyId: string): Agent[] {
  const rows = db
    .prepare(
      `SELECT a.* FROM agents a JOIN teams t ON t.id = a.team_id
       WHERE t.company_id = ? ORDER BY a.created_at`,
    )
    .all(companyId) as unknown as AgentRow[];
  return rows.map(toAgent);
}

/**
 * One agent, but only if it belongs to this company.
 *
 * A scoped query rather than `getAgentUnscoped()` plus a check afterwards: an id that
 * exists elsewhere and an id that exists nowhere both have to answer 404, and
 * doing it in SQL makes that true by construction instead of by remembering to
 * write the second branch.
 */
export function getAgentInCompany(id: string, companyId: string): Agent | null {
  const row = db
    .prepare(
      `SELECT a.* FROM agents a JOIN teams t ON t.id = a.team_id
       WHERE a.id = ? AND t.company_id = ?`,
    )
    .get(id, companyId) as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

/**
 * An agent in a team, by exact name -- the "is this name taken?" question.
 *
 * Scoped by TEAM because that is the uniqueness rule: the same name in another
 * team, or another company, is a different agent and not a clash. Exact,
 * case-sensitive comparison, matching SQLite's default BINARY collation on the
 * UNIQUE (team_id, name) it stands in front of -- a looser check here would
 * refuse names the database accepts, a stricter one would let through names it
 * rejects after a vault already exists.
 */
export function getAgentInTeamByName(teamId: string, name: string): Agent | null {
  const row = db
    .prepare("SELECT * FROM agents WHERE team_id = ? AND name = ?")
    .get(teamId, name) as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

export function listAgentsByTeam(teamId: string): Agent[] {
  const rows = db
    .prepare("SELECT * FROM agents WHERE team_id = ? ORDER BY created_at")
    .all(teamId) as unknown as AgentRow[];
  return rows.map(toAgent);
}

export function setSpendCap(id: string, spendCapBaseUnits: bigint): Agent | null {
  db.prepare("UPDATE agents SET spend_cap_base_units = ? WHERE id = ?").run(spendCapBaseUnits, id);
  return getAgentUnscoped(id);
}

/**
 * Stops an agent until an operator says otherwise.
 *
 * Guarded on `frozen_at IS NULL` and returning null when nothing changed, the
 * same discipline approveRequest/denyRequest use: a second freeze must not
 * quietly overwrite the first one's timestamp and reason, which is the record
 * of when the agent was actually stopped and why.
 *
 * This is not a cap of $0. A cap is a budget statement that would have to be
 * remembered and restored by hand, and setting it to zero destroys the real
 * value; freezing leaves every budget exactly as it was.
 */
export function freezeAgent(id: string, reason?: string): Agent | null {
  const { changes } = db
    .prepare(
      `UPDATE agents
       SET frozen_at = ?, frozen_reason = ?,
           frozen_attempt_count = 0, last_frozen_attempt_at = NULL
       WHERE id = ? AND frozen_at IS NULL`,
    )
    .run(new Date().toISOString(), reason?.slice(0, 500) ?? null, id);
  return Number(changes) === 0 ? null : getAgentUnscoped(id);
}

/**
 * Notes that a frozen agent tried to pay anyway.
 *
 * A counter rather than a payment row per attempt: an agent in a retry loop
 * would otherwise write unbounded rows describing one fact its operator already
 * knows, and the point of freezing is that it stops doing work. What is worth
 * keeping is the shape — an agent hammering a stop order at high frequency is
 * itself a signal, and before this the entire signal was invisible.
 *
 * Guarded on `frozen_at IS NOT NULL` so an attempt that races an unfreeze
 * cannot increment a counter belonging to no freeze. The increment happens in
 * SQL (`= frozen_attempt_count + 1`), not read-modify-write, so concurrent
 * attempts cannot lose counts.
 *
 * Best-effort by design: it never throws into the payment path. Failing to
 * record an attempt must not change whether the payment was refused — the
 * refusal is the control, this is only the note about it.
 */
export function recordFrozenAttempt(id: string): void {
  try {
    db.prepare(
      `UPDATE agents
       SET frozen_attempt_count = frozen_attempt_count + 1, last_frozen_attempt_at = ?
       WHERE id = ? AND frozen_at IS NOT NULL`,
    ).run(new Date().toISOString(), id);
  } catch (error) {
    console.warn(`[agents] could not record frozen attempt for ${id}:`, (error as Error).message);
  }
}

/**
 * Lets it run again. Clears the reason too, so a later freeze cannot inherit
 * a stale explanation from a previous one.
 */
export function unfreezeAgent(id: string): Agent | null {
  const { changes } = db
    .prepare(
      `UPDATE agents SET frozen_at = NULL, frozen_reason = NULL
       WHERE id = ? AND frozen_at IS NOT NULL`,
    )
    .run(id);
  return Number(changes) === 0 ? null : getAgentUnscoped(id);
}
