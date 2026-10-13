/**
 * The one condition alerting needs that no existing read already answers.
 *
 * READ-ONLY, AND IN ITS OWN FILE ON PURPOSE. Every other alert condition is
 * read through the function its own screen already uses (approvals, receipts,
 * postings, the cap figures), so the alert and the screen cannot disagree. This
 * is the exception, and putting it beside the cap sums in payments.ts would
 * mean editing a money module for an alert. It only reads `payments`.
 */
import { db } from "./index.js";

export interface ThrottledAgent {
  agentId: string;
  agentName: string;
  /** Rate-limit refusals inside the window. */
  refusals: number;
  /** The most recent one. */
  lastAt: string;
}

/**
 * Agents in this company that the rate limit refused since `sinceIso`.
 *
 * Read from the `blocked` row `reserveIfUnderCap` writes on every velocity
 * refusal, keyed on its closed `refusal_code`, never on the prose in `detail`.
 * Rows recorded before 5B-2 carry no code; the window here is minutes, so
 * they are never in it.
 */
export function throttledAgents(companyId: string, sinceIso: string): ThrottledAgent[] {
  const rows = db
    .prepare(
      `SELECT p.agent_id AS agent_id, a.name AS agent_name,
              COUNT(*) AS refusals, MAX(p.created_at) AS last_at
       FROM payments p
       JOIN agents a ON a.id = p.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE t.company_id = ?
         AND p.status = 'blocked'
         AND p.refusal_code = 'VELOCITY'
         AND p.created_at > ?
       GROUP BY p.agent_id, a.name
       ORDER BY last_at ASC`,
    )
    .all(companyId, sinceIso) as unknown as {
    agent_id: string;
    agent_name: string;
    refusals: number | bigint;
    last_at: string;
  }[];
  return rows.map((r) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    refusals: Number(r.refusals),
    lastAt: r.last_at,
  }));
}
