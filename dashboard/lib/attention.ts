import { day, type Tone } from "./presentation";

/**
 * The Overview's "Needs attention" list, as the dashboard receives and words it
 * (ADR 0021).
 *
 * THE DASHBOARD NO LONGER DECIDES WHAT NEEDS A PERSON. Until alerting, page.tsx
 * fetched agents, teams and pending approvals and ran its own arithmetic over
 * them. The API now owns that definition (src/alerts/attention.ts), the
 * sweeper alerts from it, and `GET /api/attention` returns it already
 * collapsed per agent and kind. What is left here is two jobs, both kept out
 * of page.tsx so a test can ask them questions:
 *
 *   1. `toAttentionList`, the field pick. Only the named fields cross into the
 *      page, so a field the API adds later cannot ride along into the browser.
 *   2. `attentionLine`, the words. One line per item the API sent, never
 *      fewer: nothing in this file filters, so the screen shows exactly the
 *      list an alert is built from.
 *
 * PLAIN MODULE, NO "server-only". Nothing here holds a credential, and
 * verify-api imports it to check the wording of the five kinds the Overview
 * already had is unchanged (AL-A2).
 */

/** One collapsed line, as `GET /api/attention` sends it. Dollar figures are strings. */
export interface FuelAttentionItem {
  event: string;
  /** The API's own label for the kind: the same closed lookup an alert uses. */
  label: string;
  severity: "money" | "watch";
  /** How many underlying items this line stands for. */
  items: number;
  agentId: string | null;
  agentName: string | null;
  teamName: string | null;
  amount: string | null;
  spent: string | null;
  cap: string | null;
  count: number | null;
  since: string | null;
  until: string | null;
  scope: string | null;
  /** The operator's own words for a freeze. Screen only; never in an alert. */
  frozenReason: string | null;
  href: string | null;
}

export interface FuelAttentionList {
  items: FuelAttentionItem[];
  /** Lines in the whole list, including any past the cap. */
  total: number;
  truncated: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A link the page may render: one of the dashboard's own paths, and nothing
 * that could leave it. The API builds these from fixed paths and ids; this is
 * the dashboard declining to trust that, since `<Link href>` would happily
 * follow `//elsewhere` or `javascript:`.
 */
const SAFE_HREF = /^\/[a-z]+(?:\/[A-Za-z0-9-]+)?$/;

/**
 * Picks the list out of an API response, field by field. Returns null for a
 * body that is not the list at all, so the page reports "could not be read"
 * rather than rendering a malformed answer as "nothing needs a person".
 */
export function toAttentionList(raw: unknown): FuelAttentionList | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.items) || typeof o.total !== "number") return null;
  const items: FuelAttentionItem[] = [];
  for (const entry of o.items) {
    if (entry === null || typeof entry !== "object") return null;
    const i = entry as Record<string, unknown>;
    const event = str(i.event);
    const label = str(i.label);
    if (event === null || label === null) return null;
    const href = str(i.href);
    items.push({
      event,
      label,
      severity: i.severity === "money" ? "money" : "watch",
      items: num(i.items) ?? 1,
      agentId: str(i.agentId),
      agentName: str(i.agentName),
      teamName: str(i.teamName),
      amount: str(i.amount),
      spent: str(i.spent),
      cap: str(i.cap),
      count: num(i.count),
      since: str(i.since),
      until: str(i.until),
      scope: str(i.scope),
      frozenReason: str(i.frozenReason),
      href: href !== null && SAFE_HREF.test(href) ? href : null,
    });
  }
  // A total that disagrees with the items is not the list: `{items: [], total: 5}`
  // would otherwise render as "nothing needs a person" (review of commit 2).
  // Truncation never explains an EMPTY page of a non-empty list.
  const truncated = o.truncated === true;
  if (o.total < items.length || (o.total > items.length && !truncated)) return null;
  if (items.length === 0 && o.total > 0) return null;
  return { items, total: o.total, truncated };
}

/** One rendered line. */
export interface AttentionLine {
  tone: Tone;
  kind: string;
  what: string;
  why: string;
  href: string | null;
  /** The link's words, named for where it goes. */
  go: string | null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "$5 for research-bot", or "3 payments, $12 in all, for research-bot". */
function money(i: FuelAttentionItem, preposition: string, who: string): string {
  return i.items === 1
    ? `$${i.amount} ${preposition} ${who}`
    : `${i.items} payments, $${i.amount} in all, ${preposition} ${who}`;
}

function goFor(href: string | null): string | null {
  if (href === null) return null;
  if (href.startsWith("/agents/")) return "View agent →";
  if (href === "/earning") return "Open Earning →";
  if (href === "/accounting") return "Open Accounting →";
  if (href === "/integrations") return "Open Integrations →";
  return "Open →";
}

/**
 * The words for one line.
 *
 * THE FIVE KINDS THE OVERVIEW ALREADY HAD KEEP THEIR EXACT SENTENCES for a
 * single item (frozen, awaiting approval, over authority, no authority left,
 * team at its ceiling). verify-api compares them to the old page.tsx templates
 * (AL-A2). A collapsed line of several approvals says how many and the total.
 *
 * Tone: money-severity kinds and a freeze are "bad", as the Overview always
 * showed a freeze; the rest are "watch".
 */
export function attentionLine(i: FuelAttentionItem): AttentionLine {
  const who = i.agentName ?? "an agent";
  const many = i.items > 1;
  const line = (tone: Tone, what: string, why: string): AttentionLine => ({
    tone,
    kind: i.label,
    what,
    why,
    href: i.href,
    go: goFor(i.href),
  });

  switch (i.event) {
    case "agent_frozen":
      return line("bad", who, i.frozenReason ?? "No reason was recorded.");
    case "approval_waiting":
      return line(
        "bad",
        money(i, "for", who),
        `${many ? "Oldest held" : "Held"} since ${day(i.since)} — blocked at the ${i.scope ?? "team or company"} ceiling.`,
      );
    case "anomaly_hold":
      return line(
        "bad",
        money(i, "for", who),
        `${many ? "Oldest held" : "Held"} since ${day(i.since)} — unusual for this agent, so a person decides.`,
      );
    case "agent_over_authority":
      return line("watch", who, `Spent $${i.spent} against a $${i.cap} cap.`);
    case "agent_no_authority":
      return line("watch", who, `Spent its full $${i.cap}. Its next payment will be refused.`);
    case "team_at_ceiling":
      return line(
        "watch",
        i.teamName ?? "A team",
        `Spent $${i.spent} against a $${i.cap} cap. Every agent under it is affected.`,
      );
    case "agent_near_cap":
      return line("watch", who, `Spent $${i.spent} of its $${i.cap} cap — most of its authority is used.`);
    case "frozen_still_paying": {
      const n = i.count ?? 0;
      return line(
        "bad",
        who,
        `Tried to pay ${n} ${plural(n, "time", "times")} since it was frozen, most recently ${day(i.since)}. Every attempt was refused.`,
      );
    }
    case "agent_throttled": {
      const n = i.count ?? 0;
      return line(
        "watch",
        who,
        `${n} ${plural(n, "payment", "payments")} refused by its rate limit in the last few minutes.`,
      );
    }
    case "payment_unreconciled":
      return line(
        "bad",
        money(i, "from", who),
        `${many ? "The oldest was authorised" : "Authorised"} ${day(i.since)} and never confirmed. Fuel counts it as spent because it cannot rule out that the money moved.`,
      );
    case "receipt_stuck":
      return line(
        "bad",
        money(i, "to", who),
        `${many ? "The oldest was recorded" : "Recorded"} ${day(i.since)} and is still unresolved. It is not counted as earned until it is.`,
      );
    case "posting_needs_reconciling":
      return line(
        "bad",
        `${i.items} QuickBooks ${plural(i.items, "entry", "entries")}`,
        `${many ? "The oldest was sent" : "Sent"} ${day(i.since)} and never confirmed. Reconcile ${plural(i.items, "it", "them")} on Accounting before posting again.`,
      );
    case "quickbooks_expired":
      return line("bad", "QuickBooks", `The connection expired ${day(i.until)}. Nothing posts until it is reconnected.`);
    case "quickbooks_expiring":
      return line("watch", "QuickBooks", `The connection expires ${day(i.until)}. Reconnect before then to keep posting.`);
    default:
      // A kind this dashboard does not know yet, from a newer API: shown with
      // the API's own label rather than dropped.
      return line(i.severity === "money" ? "bad" : "watch", i.agentName ?? i.teamName ?? "", "");
  }
}
