/**
 * The middle of the budget hierarchy: a team belongs to a company and owns
 * some number of agents.
 *
 * Like the company cap above it, a team's cap is an independent ceiling on
 * money that actually moved beneath it — not an allocation carved out of its
 * company's budget, and not validated against the caps of the agents under
 * it. See src/db/companies.ts.
 */
import { randomUUID } from "node:crypto";
import { db } from "./index.js";

export interface Team {
  id: string;
  companyId: string;
  name: string;
  spendCapBaseUnits: bigint;
  createdAt: string;
}

interface TeamRow {
  id: string;
  company_id: string;
  name: string;
  spend_cap_base_units: number | bigint;
  created_at: string;
}

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    spendCapBaseUnits: BigInt(row.spend_cap_base_units),
    createdAt: row.created_at,
  };
}

export function createTeam(params: {
  companyId: string;
  name: string;
  spendCapBaseUnits: bigint;
}): Team {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, params.companyId, params.name, params.spendCapBaseUnits, new Date().toISOString());
  return getTeamUnscoped(id)!;
}

/**
 * A team by id, UNSCOPED. Internal only — see getAgentUnscoped() for the same warning.
 * Routes use `getTeamInCompany`, and verify-api asserts they do.
 */
export function getTeamUnscoped(id: string): Team | null {
  const row = db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as TeamRow | undefined;
  return row ? toTeam(row) : null;
}

export function getTeamInCompany(id: string, companyId: string): Team | null {
  const row = db.prepare("SELECT * FROM teams WHERE id = ? AND company_id = ?").get(id, companyId) as
    | TeamRow
    | undefined;
  return row ? toTeam(row) : null;
}

/**
 * `companyId` is REQUIRED. It used to be optional, and an optional scope
 * parameter is a trap: omitting it read every company's teams, and the unscoped
 * call was the shorter one to write.
 */
export function listTeams(companyId: string): Team[] {
  const rows = db
    .prepare("SELECT * FROM teams WHERE company_id = ? ORDER BY created_at")
    .all(companyId) as unknown as TeamRow[];
  return rows.map(toTeam);
}

export function setTeamSpendCap(id: string, spendCapBaseUnits: bigint): Team | null {
  db.prepare("UPDATE teams SET spend_cap_base_units = ? WHERE id = ?").run(spendCapBaseUnits, id);
  return getTeamUnscoped(id);
}
