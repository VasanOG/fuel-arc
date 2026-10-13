/**
 * What needs a person, for one company: THE definition (ADR 0021).
 *
 * The Overview renders this through `GET /api/attention`, and the sweeper turns
 * it into alerts. Neither has a copy of these rules, which is the whole point:
 * "the alert said X but the screen says Y" cannot happen when both are reading
 * the same list. The first six rules are the ones dashboard/app/page.tsx used
 * to compute itself, moved here with their meaning unchanged.
 *
 * READ-ONLY. Every condition goes through the function its own screen already
 * uses, company-scoped through the usual agents -> teams seam. Nothing here
 * writes, and nothing in a money path was edited to make it possible.
 *
 * FIELDS ARE PICKED, NEVER SPREAD. The rows behind these items carry things
 * that must never leave Fuel in an alert: an agent's custody address, a
 * receipt's payer address, nonce and tx hash, a payment's resource URL (which
 * can carry a credential). An item copies the handful of fields it needs, one
 * by one, so a field a table gains tomorrow cannot ride along.
 */
import { listAgentsInCompany } from "../db/agents.js";
import { throttledAgents } from "../db/alert-conditions.js";
import { listApprovalRequests } from "../db/approvals.js";
import { paymentsNeedingAttention, spentBaseUnits, teamSpentBaseUnits } from "../db/payments.js";
import { getConnection } from "../db/qbo.js";
import { pendingPostings } from "../db/qbo-postings.js";
import { receiptsNeedingAttention } from "../db/receipts.js";
import { listTeams } from "../db/teams.js";
import {
  NEAR_CAP_PERCENT,
  POSTING_GRACE_MS,
  QUICKBOOKS_EXPIRING_MS,
  SEVERITY,
  THROTTLE_WINDOW_MS,
  type AlertEvent,
  type Severity,
} from "./events.js";

export interface AttentionItem {
  event: AlertEvent;
  severity: Severity;
  /** What this item is about, for dedupe: `approval:<id>`, `agent:<id>`, `company`. */
  subjectKey: string;
  agentId: string | null;
  agentName: string | null;
  teamName: string | null;
  /** The event's own money figure: an approval's amount, a payment's, a receipt's. */
  amountBaseUnits: bigint | null;
  /** The cap basis, for the cap kinds. */
  spentBaseUnits: bigint | null;
  capBaseUnits: bigint | null;
  /** Refusals, attempts: a count when the event is about repetition. */
  count: number | null;
  /** When the condition began, where that is known. */
  since: string | null;
  /** A deadline, for QuickBooks expiry. */
  until: string | null;
  /** Which ceiling an approval is about. */
  scope: "team" | "company" | "anomaly" | null;
  /**
   * SCREEN ONLY: the operator's own words for a freeze. Shown on the Overview
   * as it always was, and never copied into an alert (see ./text.ts), because
   * free text an operator typed is not something to send to a third party.
   */
  frozenReason: string | null;
  /** A dashboard path, never a full URL. */
  href: string | null;
}

function item(fields: Partial<AttentionItem> & Pick<AttentionItem, "event" | "subjectKey">): AttentionItem {
  return {
    severity: SEVERITY[fields.event],
    agentId: null,
    agentName: null,
    teamName: null,
    amountBaseUnits: null,
    spentBaseUnits: null,
    capBaseUnits: null,
    count: null,
    since: null,
    until: null,
    scope: null,
    frozenReason: null,
    href: null,
    ...fields,
  };
}

/**
 * Everything that needs a person in this company, right now.
 *
 * ORDER: the Overview's existing order first (frozen, approvals, over
 * authority, no authority left, team at its ceiling), then the kinds alerting
 * added. A person reading the screen sees the most deliberate state first.
 *
 * `now` is injected so the verification suite controls every window here.
 */
export function attentionFor(companyId: string, now: Date): AttentionItem[] {
  const items: AttentionItem[] = [];
  const nowMs = now.getTime();

  const agents = listAgentsInCompany(companyId).map((a) => ({
    id: a.id,
    name: a.name,
    teamId: a.teamId,
    capBaseUnits: a.spendCapBaseUnits,
    frozenAt: a.frozenAt,
    frozenReason: a.frozenReason,
    frozenAttemptCount: a.frozenAttemptCount,
    lastFrozenAttemptAt: a.lastFrozenAttemptAt,
    // The cap basis, through the same function the API's own agent figures use
    // (src/api.ts present()), so "spent" here is the number the screen shows.
    spentBaseUnits: spentBaseUnits(a.id),
  }));
  const teams = listTeams(companyId);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const agentName = new Map(agents.map((a) => [a.id, a.name]));

  // 1. Frozen: a person stopped this agent.
  for (const a of agents.filter((a) => a.frozenAt !== null)) {
    items.push(
      item({
        event: "agent_frozen",
        subjectKey: `agent:${a.id}`,
        agentId: a.id,
        agentName: a.name,
        teamName: teamName.get(a.teamId) ?? null,
        since: a.frozenAt,
        frozenReason: a.frozenReason,
        href: `/agents/${a.id}`,
      }),
    );
  }

  // 2. Held for a decision. Pending only; the reaper expires them after 24h.
  for (const r of listApprovalRequests({ companyId, status: "pending" })) {
    items.push(
      item({
        event: r.blockedScope === "anomaly" ? "anomaly_hold" : "approval_waiting",
        subjectKey: `approval:${r.id}`,
        agentId: r.agentId,
        agentName: r.agentName,
        teamName: r.teamName,
        amountBaseUnits: r.amountBaseUnits,
        since: r.createdAt,
        scope: r.blockedScope,
        href: `/agents/${r.agentId}`,
      }),
    );
  }

  // 3. Over authority: spend past the cap, which an approved payment allows.
  //    src/db/approvals.ts: "spent <= cap is not an invariant".
  for (const a of agents.filter((a) => a.frozenAt === null && a.spentBaseUnits > a.capBaseUnits)) {
    items.push(capItem("agent_over_authority", a, teamName));
  }

  // 4. No authority left: exactly at the cap, and the cap was ever used. A cap
  //    of zero with nothing spent is an agent never funded, not one that ran out.
  for (const a of agents.filter(
    (a) => a.frozenAt === null && a.spentBaseUnits === a.capBaseUnits && a.spentBaseUnits > 0n,
  )) {
    items.push(capItem("agent_no_authority", a, teamName));
  }

  // 5. A team at or past its ceiling. Every agent under it is affected.
  for (const t of teams) {
    const spent = teamSpentBaseUnits(t.id);
    if (spent > 0n && spent >= t.spendCapBaseUnits) {
      items.push(
        item({
          event: "team_at_ceiling",
          subjectKey: `team:${t.id}`,
          teamName: t.name,
          spentBaseUnits: spent,
          capBaseUnits: t.spendCapBaseUnits,
        }),
      );
    }
  }

  // --- added by alerting -------------------------------------------------

  // 6. Near the cap: at least 80% used, not yet at it. Never for a cap of 0.
  for (const a of agents.filter(
    (a) =>
      a.frozenAt === null &&
      a.capBaseUnits > 0n &&
      a.spentBaseUnits < a.capBaseUnits &&
      a.spentBaseUnits * 100n >= a.capBaseUnits * NEAR_CAP_PERCENT,
  )) {
    items.push(capItem("agent_near_cap", a, teamName));
  }

  // 7. A frozen agent that keeps trying to pay. One per freeze: the count
  //    rises, the item does not repeat.
  for (const a of agents.filter((a) => a.frozenAt !== null && a.frozenAttemptCount > 0)) {
    items.push(
      item({
        event: "frozen_still_paying",
        subjectKey: `agent:${a.id}`,
        agentId: a.id,
        agentName: a.name,
        teamName: teamName.get(a.teamId) ?? null,
        count: a.frozenAttemptCount,
        since: a.lastFrozenAttemptAt,
        href: `/agents/${a.id}`,
      }),
    );
  }

  // 8. Rate-limited recently.
  const throttleSince = new Date(nowMs - THROTTLE_WINDOW_MS).toISOString();
  for (const t of throttledAgents(companyId, throttleSince)) {
    items.push(
      item({
        event: "agent_throttled",
        subjectKey: `agent:${t.agentId}`,
        agentId: t.agentId,
        agentName: t.agentName,
        count: t.refusals,
        since: t.lastAt,
        href: `/agents/${t.agentId}`,
      }),
    );
  }

  // 9. Signed and never confirmed: Fuel assumes the money moved.
  for (const p of paymentsNeedingAttention(companyId)) {
    items.push(
      item({
        event: "payment_unreconciled",
        subjectKey: `payment:${p.id}`,
        agentId: p.agentId,
        agentName: p.agentName,
        amountBaseUnits: p.amountBaseUnits,
        since: p.createdAt,
        href: "/earning",
      }),
    );
  }

  // 10. Money that may have arrived and is in nobody's books. ONLY the id, the
  //     agent, the amount and the time are read: never the payer, nonce or hash.
  for (const r of receiptsNeedingAttention(companyId)) {
    items.push(
      item({
        event: "receipt_stuck",
        subjectKey: `receipt:${r.id}`,
        agentId: r.agentId,
        agentName: agentName.get(r.agentId) ?? null,
        amountBaseUnits: r.amountBaseUnits,
        since: r.createdAt,
        href: "/earning",
      }),
    );
  }

  // 11. A QuickBooks document that may exist and is unconfirmed, past the few
  //     seconds every ordinary post spends in `pending`.
  const postingCutoff = nowMs - POSTING_GRACE_MS;
  for (const p of pendingPostings(companyId)) {
    if (new Date(p.createdAt).getTime() > postingCutoff) continue;
    items.push(
      item({
        event: "posting_needs_reconciling",
        subjectKey: `posting:${p.id}`,
        since: p.createdAt,
        href: "/accounting",
      }),
    );
  }

  // 12. A QuickBooks grant that has run out, or is about to. Only the expiry is
  //     read: never the realm, never a token.
  const connection = getConnection(companyId);
  if (connection !== null) {
    const expiresMs = new Date(connection.refreshExpiresAt).getTime();
    if (expiresMs <= nowMs) {
      items.push(
        item({ event: "quickbooks_expired", subjectKey: "company", until: connection.refreshExpiresAt, href: "/integrations" }),
      );
    } else if (expiresMs - nowMs < QUICKBOOKS_EXPIRING_MS) {
      items.push(
        item({ event: "quickbooks_expiring", subjectKey: "company", until: connection.refreshExpiresAt, href: "/integrations" }),
      );
    }
  }

  return items;
}

function capItem(
  event: "agent_over_authority" | "agent_no_authority" | "agent_near_cap",
  a: { id: string; name: string; teamId: string; spentBaseUnits: bigint; capBaseUnits: bigint },
  teamName: Map<string, string>,
): AttentionItem {
  return item({
    event,
    subjectKey: `agent:${a.id}`,
    agentId: a.id,
    agentName: a.name,
    teamName: teamName.get(a.teamId) ?? null,
    spentBaseUnits: a.spentBaseUnits,
    capBaseUnits: a.capBaseUnits,
    href: `/agents/${a.id}`,
  });
}

/** One line of the collapsed list: several items of one kind about one agent. */
export interface AttentionGroup {
  event: AlertEvent;
  severity: Severity;
  agentId: string | null;
  agentName: string | null;
  teamName: string | null;
  /** How many items this line stands for. */
  items: number;
  /** Their money figures summed, where the kind has one. */
  amountBaseUnits: bigint | null;
  spentBaseUnits: bigint | null;
  capBaseUnits: bigint | null;
  count: number | null;
  since: string | null;
  until: string | null;
  scope: AttentionItem["scope"];
  frozenReason: string | null;
  href: string | null;
}

/**
 * Collapses repeated items per agent and event (the user's addition 3).
 *
 * WHY THIS IS IN THE API, BESIDE THE DEFINITION. An agent-key holder can mint
 * any number of distinct pending approvals by varying a URL (approvals dedupe
 * only on an identical agent, url, amount and scope), and each is a separate
 * item. Collapsed here, the Overview and the alert text both show one line,
 * "7 approvals waiting for research-bot", from the same function: a flood
 * cannot bury the screen, and cannot become seven separate alert lines either.
 *
 * Keyed on (event, agent). Items with no agent (postings, QuickBooks, teams)
 * keep their own line per subject, except postings, which share one.
 */
export function collapse(items: AttentionItem[]): AttentionGroup[] {
  const groups = new Map<string, AttentionGroup>();
  for (const i of items) {
    const key =
      i.agentId !== null
        ? `${i.event}|agent:${i.agentId}`
        : i.event === "posting_needs_reconciling"
          ? i.event
          : `${i.event}|${i.subjectKey}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        event: i.event,
        severity: i.severity,
        agentId: i.agentId,
        agentName: i.agentName,
        teamName: i.teamName,
        items: 1,
        amountBaseUnits: i.amountBaseUnits,
        spentBaseUnits: i.spentBaseUnits,
        capBaseUnits: i.capBaseUnits,
        count: i.count,
        since: i.since,
        until: i.until,
        scope: i.scope,
        frozenReason: i.frozenReason,
        href: i.href,
      });
      continue;
    }
    existing.items += 1;
    if (i.amountBaseUnits !== null) {
      existing.amountBaseUnits = (existing.amountBaseUnits ?? 0n) + i.amountBaseUnits;
    }
    // The oldest "since" is when the group started needing someone.
    if (i.since !== null && (existing.since === null || i.since < existing.since)) existing.since = i.since;
    // Mixed scopes in one approval group do not happen (anomaly is its own
    // event), but team and company can share one: say neither rather than one.
    if (existing.scope !== i.scope) existing.scope = null;
  }
  return [...groups.values()];
}
