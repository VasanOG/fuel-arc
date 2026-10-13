import "server-only";

import { cookies } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";

import { SESSION_COOKIE } from "./session-cookie";

import type { Tone } from "./presentation";
import { toAccountingStatus, type AccountingStatus } from "./accounting-status";
import { toAttentionList, type FuelAttentionList } from "./attention";
import { toAlertSettings, type FuelAlertSettings } from "./alerts";

/**
 * THE DASHBOARD NO LONGER HOLDS A CREDENTIAL OF ITS OWN.
 *
 * Until Stage 3 this module read FUEL_API_KEY and put it on every request, so
 * the dashboard WAS the operator — every viewer of the page acted as the same
 * anonymous key holder, and an approval could only ever record that "a human"
 * decided. The key is gone from this file and from .env.local.example, and
 * nothing here falls back to it: if a surface stops working without one, that
 * is a finding to fix rather than a reason to put the key back.
 *
 * What replaces it is the viewer's own session cookie, forwarded. The Fuel API
 * stays the single security boundary — it validates the session, resolves the
 * company from the USER'S row, and decides what that person may do. The
 * dashboard's job is only to carry the credential it was given, never to mint
 * or hold one.
 *
 * ONE NARROW EXCEPTION, ADR 0020: `FUEL_RELAY_KEY`. It is not an API
 * credential. Fuel's `roleFor` does not know it, and as a Bearer token it gets
 * 401. Its one power is to say which browser a sign-in or signup came from, so
 * the API can rate-limit per browser instead of per dashboard. It is read in
 * `relayHeaders` only, and sent by `startSession` and `redeemInvite` only:
 * never by `fuelFetch`, so no page, read or decision ever carries it.
 *
 * This module is still `server-only`, which now protects two things: the
 * assumption that `cookies()` is callable, which is only true inside a request
 * on the server, and the relay key above.
 */
function fuelApiUrl(path: string): string {
  const base = process.env.FUEL_API_URL;
  if (!base) throw new Error("FUEL_API_URL is not set. Copy .env.local.example to .env.local.");
  return `${base.replace(/\/$/, "")}${path}`;
}

/** Re-exported so a page or route handler needs only this module. */
export { SESSION_COOKIE } from "./session-cookie";

/**
 * The viewer's session, as a header to send onward.
 *
 * ONLY THE ONE COOKIE, rebuilt by name, never `headers().get("cookie")` passed
 * through whole. A blanket forward would hand Fuel every unrelated cookie the
 * browser happens to hold for this host — and because cookies ignore the port,
 * on a developer's machine that is every cookie set by anything else listening
 * on localhost. Naming the one cookie keeps this a credential relay rather than
 * an ambient header pipe.
 *
 * An absent cookie sends no Authorization and no Cookie at all, and the API
 * answers 401. That is the correct outcome: the dashboard has nothing to fall
 * back to, and pretending otherwise is what the shared key used to do.
 */
async function forwardSession(): Promise<Record<string, string>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } : {};
}

/** Where a request that is no longer signed in ends up. */
const SIGN_IN = "/login?e=expired";

/**
 * Every call to Fuel goes through here, and 401 means one specific thing.
 *
 * WHY A REDIRECT RATHER THAN AN ERROR. Before this, a 401 became
 * `Fuel API returned 401 listing approvals`, which pages render as "Fuel could
 * not be reached". That sentence would now be a lie in the most common case:
 * Fuel was reached, answered immediately, and said the session has ended. An
 * operator told the service is down will go and check the service. Sending
 * them to the sign-in page tells them the truth and fixes it in one click.
 *
 * middleware.ts catches the ordinary version of this — no cookie at all — so
 * what reaches here is the narrower case of a cookie that stopped being valid
 * (expired, idle, signed out elsewhere, or the account disabled). Both paths
 * land on the same page.
 *
 * In a route handler this returns a 307 instead of an HTML page, which is why
 * the client components that call those routes use `redirect: "manual"` and
 * treat a redirect as "sign in again" rather than trying to parse it as JSON.
 */
async function fuelFetch(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  const res = await fetch(fuelApiUrl(path), {
    method: init.method,
    headers: { ...(await forwardSession()), ...(init.headers ?? {}) },
    body: init.body,
    cache: "no-store",
  });
  if (res.status === 401) redirect(SIGN_IN);
  return res;
}

/**
 * An agent as the dashboard sees it.
 *
 * The API also returns the agent's custody address. It is deliberately absent
 * here: ADR 0005 permitted the dashboard to show addresses as a temporary
 * exception whose stated revisit trigger was "before anything resembling a
 * customer-facing version of the dashboard exists", and Phase 5 is that thing.
 *
 * The type alone is not enough, and assuming it was is a mistake worth
 * recording. A TypeScript return annotation is erased at build time — it stops
 * a field being *rendered*, because reading it fails the build, but it does not
 * stop it being *transmitted*. `return res.json()` handed the whole upstream
 * object to a Server Component, which passed it as a prop to a Client
 * Component, and Next.js serialises the object it is actually given into the
 * page. Five addresses were still arriving in the browser with nothing on
 * screen showing them. See `toAgent` below: the field list is what enforces
 * this, and the type only describes it.
 */
export interface FuelAgent {
  id: string;
  name: string;
  teamId: string;
  spendCap: string;
  spent: string;
  remaining: string;
  createdAt: string;
  /** Stored state, not derived. `frozen_at IS NULL` is the source of truth. */
  frozen: boolean;
  frozenAt: string | null;
  /** Operator-written, optional — the API accepts freeze with no reason. */
  frozenReason: string | null;
  /** Payments this agent attempted while frozen. Evidence the freeze holds. */
  frozenAttempts: number;
  lastFrozenAttemptAt: string | null;
  /** Earned, spent and net — the P&L basis, NOT the cap basis above. */
  ledger: FuelLedgerTotals;
  /** The agent's available balance in dollars. null means Fuel could not read
   * it just now. */
  balance: string | null;
}

/**
 * Earned, spent and net on the LEDGER basis.
 *
 * A DIFFERENT QUESTION FROM `spendCap`/`spent`/`remaining`, which sit beside it
 * on the same objects. Those are the cap basis and count money that MIGHT move,
 * so a payment in flight is in them; these count money that DID move. The two
 * "spent" figures are supposed to disagree, and `note` is the server's own
 * sentence saying so — carried rather than restated here for the reason 5B-2
 * deleted the dashboard's copy of the status table.
 *
 * Every figure is a string. `net` is signed and routinely negative: an agent
 * that has spent more than it earned is the ordinary case, not an error.
 */
export interface FuelLedgerTotals {
  earned: string;
  spent: string;
  net: string;
  note: string;
}

function toLedgerTotals(raw: unknown): FuelLedgerTotals {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    earned: String(o.earned ?? "0"),
    spent: String(o.spent ?? "0"),
    net: String(o.net ?? "0"),
    note: String(o.note ?? ""),
  };
}

/**
 * An agent without its balance.
 *
 * Not every agent response carries one: the Fuel API returns a balance on the
 * list and detail reads, which fan out to custody, but deliberately not on a
 * PATCH. The distinction is load-bearing — see setAgentCap.
 */
export type FuelAgentCore = Omit<FuelAgent, "balance">;

/**
 * Copies across exactly the fields the dashboard is allowed to have.
 *
 * Explicitly a pick and not a delete: a field the API adds later has to be
 * named here before it can reach the browser, which is the safe default. The
 * API currently also returns the custody address, the team id and the freeze
 * columns; none of them belong to this surface yet.
 */
function toAgentCore(raw: Record<string, unknown>): FuelAgentCore {
  return {
    id: String(raw.id),
    name: String(raw.name),
    teamId: String(raw.teamId),
    spendCap: String(raw.spendCap),
    spent: String(raw.spent),
    remaining: String(raw.remaining),
    createdAt: String(raw.createdAt),
    frozen: raw.frozen === true,
    frozenAt: raw.frozenAt == null ? null : String(raw.frozenAt),
    frozenReason: raw.frozenReason == null ? null : String(raw.frozenReason),
    frozenAttempts: Number(raw.frozenAttempts ?? 0),
    lastFrozenAttemptAt:
      raw.lastFrozenAttemptAt == null ? null : String(raw.lastFrozenAttemptAt),
    ledger: toLedgerTotals(raw.ledger),
  };
}

function toAgent(raw: Record<string, unknown>): FuelAgent {
  return {
    ...toAgentCore(raw),
    balance: raw.balance === null || raw.balance === undefined ? null : String(raw.balance),
  };
}

export async function listAgents(): Promise<FuelAgent[]> {
  const res = await fuelFetch("/api/agents");
  if (!res.ok) throw new Error(`Fuel API returned ${res.status} listing agents`);
  const raw = (await res.json()) as Record<string, unknown>[];
  return raw.map(toAgent);
}

/**
 * Fetches the accounting export.
 *
 * Returns the raw Response rather than parsed data: this is a file being
 * relayed, and buffering it into a string here would serve no purpose beyond
 * doubling it in memory. The caller streams the body straight through.
 */
export async function fetchTransactionsCsv(query: URLSearchParams): Promise<Response> {
  const suffix = query.toString();
  return fuelFetch(`/api/exports/transactions.csv${suffix ? `?${suffix}` : ""}`);
}

/**
 * The QuickBooks integration surface.
 *
 * One passthrough rather than a typed function per route: these are all
 * operator-only reads and actions on the same resource, and the dashboard adds
 * nothing to them but the credential. The allowlist that decides what may be
 * called lives in the route handler, not here — keeping it at the HTTP boundary
 * means a new function in this file cannot widen it by accident.
 */
export async function callQuickBooks(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const res = await fuelFetch(`/api/integrations/quickbooks${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "Content-Type": "application/json" } : {},
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * Returns the agent WITHOUT a balance, because the PATCH response has none.
 *
 * AgentsTable merges this into the row it already has. Emitting `balance: null`
 * here would spread a null over a balance the page had successfully read a
 * moment earlier, blanking a good number on every save.
 */
export async function setAgentCap(
  agentId: string,
  spendCapUsd: string,
): Promise<FuelAgentCore> {
  const res = await fuelFetch(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spendCapUsd }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Fuel API returned ${res.status} setting the cap`);
  }
  return toAgentCore(await res.json());
}


/* -------------------------------------------------------------------------
 * Budgets, payments and approvals.
 *
 * All of this reads routes that already exist. Phase 5B-1 adds no API surface;
 * what it adds is the field list that decides which parts of those responses
 * are allowed to leave the server.
 * ---------------------------------------------------------------------- */

export interface FuelBudget {
  id: string;
  name: string;
  spendCap: string;
  spent: string;
  remaining: string;
}

/**
 * A company budget plus its P&L.
 *
 * Teams deliberately do NOT carry one. A team has a cap, so the cap figures
 * mean something there, but Fuel has no per-team revenue: an endpoint belongs
 * to an agent, and rolling receipts up to a team would invent a number the
 * accounting side does not post. An empty P&L block on every team row would be
 * worse than its absence — it would read as "this team earned nothing" rather
 * than "Fuel does not answer that question".
 */
export interface FuelCompanyBudget extends FuelBudget {
  ledger: FuelLedgerTotals;
}

function toBudget(raw: Record<string, unknown>): FuelBudget {
  return {
    id: String(raw.id),
    name: String(raw.name),
    spendCap: String(raw.spendCap),
    spent: String(raw.spent),
    remaining: String(raw.remaining),
  };
}

export async function getCompany(): Promise<FuelCompanyBudget> {
  const res = await fuelFetch("/api/company");
  if (!res.ok) throw new Error(`Fuel API returned ${res.status} reading the company budget`);
  const raw = (await res.json()) as Record<string, unknown>;
  return { ...toBudget(raw), ledger: toLedgerTotals(raw.ledger) };
}

export async function listTeams(): Promise<FuelBudget[]> {
  const res = await fuelFetch("/api/teams");
  if (!res.ok) throw new Error(`Fuel API returned ${res.status} listing teams`);
  const raw = (await res.json()) as Record<string, unknown>[];
  return raw.map(toBudget);
}

/**
 * One payment, as the dashboard is allowed to see it.
 *
 * Two fields the API returns are deliberately absent, and both would be real
 * leaks rather than untidiness:
 *
 * `txHash` is a settlement identifier from the payment rail — exactly what
 * docs/decisions/0006 keeps off every surface that leaves the system. It is
 * also 64 hex characters, which is why the delivered-bytes check in
 * scripts/qa-dashboard.ts had to be widened past the 40 of an address.
 *
 * `detail` is free internal text. It carries refusal reasons written in BASE
 * UNITS ("5000 base units is above the threshold of 3000"), which is the
 * storage representation and not something an operator should ever read, and
 * it doubles as the demo marker. So it is reduced here to the one bit the UI
 * can honestly use and then dropped.
 */
export interface FuelPayment {
  id: string;
  amount: string;
  /** The vendor host. The API no longer returns a URL at all. */
  vendor: string;
  status: string;
  /** Decided by the backend — see src/lib/payment-presentation.ts. */
  statusLabel: string;
  statusTone: Tone;
  createdAt: string;
  settledAt: string | null;
  /** Structural, from payments.is_demo. Never inferred from free text. */
  isDemo: boolean;
  /** Null for refusals recorded before codes existed: reason unavailable. */
  refusal: { code: string; label: string } | null;
}

function toPayment(raw: Record<string, unknown>): FuelPayment {
  return {
    id: String(raw.id),
    amount: String(raw.amount),
    vendor: String(raw.vendor),
    status: String(raw.status),
    statusLabel: String(raw.statusLabel),
    statusTone: (raw.statusTone ?? "quiet") as Tone,
    createdAt: String(raw.createdAt),
    settledAt: raw.settledAt == null ? null : String(raw.settledAt),
    isDemo: raw.isDemo === true,
    refusal:
      raw.refusal && typeof raw.refusal === "object"
        ? {
            code: String((raw.refusal as Record<string, unknown>).code),
            label: String((raw.refusal as Record<string, unknown>).label),
          }
        : null,
  };
}

/**
 * Where and how to fund this agent, and only this agent (ADR 0019, narrowing
 * 0005's now-closed exception).
 *
 * ON `FuelAgentDetail` ONLY — never on `FuelAgent`/`FuelAgentCore`, which
 * back the roster. `GET /api/agents` (the list this dashboard's roster
 * reads) never sends this field at all, so there is nothing here for a list
 * row to accidentally pick up; the type boundary matches a boundary the API
 * itself already draws, not a new one invented at this layer.
 */
export interface FuelFunding {
  address: string;
  network: string;
  asset: string;
}

function toFunding(raw: unknown): FuelFunding | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.address !== "string" || typeof o.network !== "string" || typeof o.asset !== "string") {
    return null;
  }
  return { address: o.address, network: o.network, asset: o.asset };
}

export interface FuelAgentDetail extends FuelAgent {
  payments: FuelPayment[];
  /** How many of the agent's payments this response carried. */
  paymentsShown: number;
  /** How many exist. The API bounds the list; the page says so. */
  paymentsTotal: number;
  /**
   * Null for a viewer the API didn't include it for (today, only an
   * OPERATOR-role read gets one at all) — never rendered as if absent meant
   * "no funding exists". `FundingPanel` renders nothing when this is null.
   */
  funding: FuelFunding | null;
}

/** null when no such agent exists, so the page can render a 404 rather than throw. */
export async function getAgent(agentId: string): Promise<FuelAgentDetail | null> {
  const res = await fuelFetch(`/api/agents/${encodeURIComponent(agentId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fuel API returned ${res.status} reading the agent`);
  const raw = (await res.json()) as Record<string, unknown>;
  const payments = (raw.payments as Record<string, unknown>[] | undefined) ?? [];
  return {
    ...toAgent(raw),
    payments: payments.map(toPayment),
    paymentsShown: Number(raw.paymentsShown ?? payments.length),
    paymentsTotal: Number(raw.paymentsTotal ?? payments.length),
    funding: toFunding(raw.funding),
  };
}

/**
 * An approval, minus its `detail` for the same reason a payment loses one.
 *
 * The anomaly baseline, threshold and sample size live only inside that prose
 * string. They are not parsed back out into fields here: a display that looks
 * structured would imply a structure the database does not have. As of 5B-3
 * the API does not send `detail` at all, so this is no longer the dashboard
 * declining to render something it was handed — it is never handed it.
 *
 * `vendorUrl` is gone with it. It held the full paid URL, was picked at this
 * boundary, and was rendered nowhere — which is exactly the shape the wallet
 * address had in 5A-1 before it turned out a field nothing renders still
 * crosses the wire into a Client Component prop. The API now sends the vendor
 * host and nothing else; the dashboard picks only what it draws.
 */
export interface FuelApproval {
  id: string;
  agentId: string;
  agentName: string;
  teamId: string;
  teamName: string;
  /** Host only. The API does not return a URL. */
  vendor: string;
  amount: string;
  blockedScope: string;
  /** The server's words for which ceiling refused it. Never mapped here. */
  scopeLabel: string;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  /** One sentence the backend owns; see src/lib/payment-presentation.ts. */
  statusMeaning: string;
  paymentId: string | null;
  createdAt: string;
  decidedAt: string | null;
  /**
   * The address of whoever decided it, or null.
   *
   * NULL MEANS TWO DIFFERENT THINGS AND THE PAGE MUST NOT MERGE THEM: nobody
   * has decided this yet, or a shared API key decided it before people existed
   * and there is genuinely no name to give. `status` tells them apart.
   */
  decidedBy: string | null;
  approvalExpiresAt: string | null;
  /**
   * Structural, from approval_requests.is_demo.
   *
   * This used to be `raw.detail === "demo-seed"` — the dashboard inferring demo
   * status from free text, which is exactly the pattern 5B-2 removed
   * everywhere else. Not exploitable here (Fuel writes every approval detail
   * itself, unlike a payment's, which can carry a merchant's string) but
   * inconsistent, and inconsistency is how the unsafe version survives.
   */
  isDemo: boolean;
}

function toApproval(raw: Record<string, unknown>): FuelApproval {
  return {
    id: String(raw.id),
    agentId: String(raw.agentId),
    agentName: String(raw.agentName),
    teamId: String(raw.teamId),
    teamName: String(raw.teamName),
    vendor: String(raw.vendor),
    amount: String(raw.amount),
    blockedScope: String(raw.blockedScope),
    scopeLabel: String(raw.scopeLabel),
    status: String(raw.status),
    statusLabel: String(raw.statusLabel),
    statusTone: (raw.statusTone ?? "quiet") as Tone,
    statusMeaning: String(raw.statusMeaning ?? ""),
    paymentId: raw.paymentId == null ? null : String(raw.paymentId),
    createdAt: String(raw.createdAt),
    decidedAt: raw.decidedAt == null ? null : String(raw.decidedAt),
    decidedBy: raw.decidedBy == null ? null : String(raw.decidedBy),
    approvalExpiresAt: raw.approvalExpiresAt == null ? null : String(raw.approvalExpiresAt),
    isDemo: raw.isDemo === true,
  };
}

/**
 * The statuses GET /api/approvals accepts.
 *
 * The VALUES, which are the route's enum — not the words for them. Every label
 * a person reads comes off the row it belongs to, so this list can never put a
 * status into a sentence the server would have phrased differently. The route
 * validates the value again on arrival and 400s on anything else.
 */
export const APPROVAL_STATUS_VALUES = [
  "pending",
  "approved",
  "denied",
  "consumed",
  "expired",
] as const;

export async function listApprovals(status?: string): Promise<FuelApproval[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fuelFetch(`/api/approvals${query}`);
  if (!res.ok) throw new Error(`Fuel API returned ${res.status} listing approvals`);
  const raw = (await res.json()) as Record<string, unknown>[];
  return raw.map(toApproval);
}

/* -------------------------------------------------------------------------
 * The Activity Ledger.
 *
 * One page of money in BOTH directions across every agent, from
 * GET /api/activity. Picked field by field like everything else at this
 * boundary: the API's response is already an allowlist, and this is the second
 * one, because 5A-1 established that a field nothing renders still crosses the
 * wire into a Client Component prop if it is present on the object.
 *
 * The route was `/api/payments` until 6B-3. It returns receipts too now, so the
 * old name had become false about half its rows — the same reason the CSV's
 * "Vendor" column became "Counterparty".
 *
 * `amountBaseUnits` is dropped here. The API sends it so a surface never has to
 * do arithmetic on a decimal string, and this page does no arithmetic.
 * ---------------------------------------------------------------------- */

export interface FuelLedgerRow {
  id: string;
  /**
   * Which way the money went. The one field that changes what every other
   * field on the row means, so it is read first and never inferred.
   */
  direction: "spend" | "earn";
  agentId: string;
  agentName: string;
  teamId: string;
  teamName: string;
  /**
   * The other party. A merchant's HOST for spend, and for earn the endpoint's
   * label in the books — never the payer, who is a third party with no business
   * appearing in anyone's dashboard. The API does not return a URL either way.
   */
  counterparty: string;
  amount: string;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  /** One sentence the backend owns; see src/lib/payment-presentation.ts. */
  statusMeaning: string;
  createdAt: string;
  settledAt: string | null;
  /**
   * When this payment lands in the books — settled_at if it has one, otherwise
   * created_at. Display only. The API orders on (created_at, id) because this
   * expression mutates when a payment settles, and a mutating sort key means a
   * row can move past a cursor and never be seen.
   */
  ledgerDate: string;
  /**
   * Structural, from payments.is_demo. Never inferred from free text, and
   * always false on an earn row — no path writes a demo receipt.
   */
  isDemo: boolean;
  /**
   * Null for refusals recorded before codes existed: reason unavailable. Always
   * null on an earn row — Fuel does not refuse inbound money, because there is
   * no inbound cap.
   */
  refusal: { code: string; label: string } | null;
  /** Present when a person approved this payment past a ceiling. Always null on
   *  an earn row: nothing inbound is held for a person to approve. */
  approval: { id: string; scope: string; decidedAt: string | null } | null;
}

export interface FuelActivityPage {
  activity: FuelLedgerRow[];
  page: {
    limit: number;
    order: string;
    hasMore: boolean;
    /**
     * Forward only. The API issues a cursor for the row after the last one on
     * this page and nothing else, so there is no previous-page cursor to hand
     * back — the ledger offers Next and a reset rather than a dead Back.
     */
    nextCursor: string | null;
  };
  /**
   * The status filters this API says a surface may offer, in its words.
   *
   * Not restated here for the reason 5B-2 deleted the dashboard's copy of the
   * status table: two copies of a vocabulary drift silently. It also collapses
   * `pending` and `signing` into one option, because they read as one thing,
   * and that collapse is a decision the server makes rather than one a form
   * should reinvent.
   */
  statusOptions: { value: string; label: string }[];
  /** Spend or earn, named by the server for the same reason the statuses are. */
  directionOptions: { value: string; label: string }[];
}

/** Exactly the filters GET /api/activity accepts. Anything else is not sent. */
export interface ActivityQuery {
  direction?: string;
  agentId?: string;
  teamId?: string;
  status?: string;
  from?: string;
  to?: string;
  demo?: string;
  order?: string;
  cursor?: string;
  limit?: number;
}

export const ACTIVITY_FILTER_KEYS = [
  "direction",
  "agentId",
  "teamId",
  "status",
  "from",
  "to",
  "demo",
  "order",
] as const;

/**
 * A filter the operator got wrong, as opposed to Fuel being broken.
 *
 * A bad date or an unknown status is a 400, and blowing up the whole route for
 * one would send the operator to the error boundary with no way back to the
 * form they mistyped. The page catches this and renders the message beside the
 * filters instead.
 */
export class FuelQueryError extends Error {}

function toLedgerRow(raw: Record<string, unknown>): FuelLedgerRow {
  const refusal = raw.refusal as Record<string, unknown> | null | undefined;
  const approval = raw.approval as Record<string, unknown> | null | undefined;
  return {
    id: String(raw.id),
    /*
     * Anything that is not the literal "earn" reads as "spend".
     *
     * Not `String(raw.direction)`, which would let an unrecognised value through
     * as a third direction this page has no rendering for. Failing towards
     * "spend" is the safe side of that: a row wrongly shown as money leaving
     * overstates spend, and a row wrongly shown as money arriving overstates
     * revenue, which is the direction that misstates someone's books.
     */
    direction: raw.direction === "earn" ? "earn" : "spend",
    agentId: String(raw.agentId),
    agentName: String(raw.agentName),
    teamId: String(raw.teamId),
    teamName: String(raw.teamName),
    counterparty: String(raw.counterparty),
    amount: String(raw.amount),
    status: String(raw.status),
    statusLabel: String(raw.statusLabel),
    statusTone: (raw.statusTone ?? "quiet") as Tone,
    statusMeaning: String(raw.statusMeaning ?? ""),
    createdAt: String(raw.createdAt),
    settledAt: raw.settledAt == null ? null : String(raw.settledAt),
    ledgerDate: String(raw.ledgerDate),
    isDemo: raw.isDemo === true,
    refusal:
      refusal && typeof refusal === "object"
        ? { code: String(refusal.code), label: String(refusal.label) }
        : null,
    approval:
      approval && typeof approval === "object"
        ? {
            id: String(approval.id),
            scope: String(approval.scope),
            decidedAt: approval.decidedAt == null ? null : String(approval.decidedAt),
          }
        : null,
  };
}

export async function listActivity(query: ActivityQuery): Promise<FuelActivityPage> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }

  const res = await fuelFetch(`/api/activity?${search.toString()}`);

  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new FuelQueryError(
      typeof body.error === "string" ? body.error : "That filter is not valid.",
    );
  }
  if (!res.ok) throw new Error(`Fuel API returned ${res.status} listing activity`);

  const raw = (await res.json()) as Record<string, unknown>;
  const rows = (raw.activity as Record<string, unknown>[] | undefined) ?? [];
  const page = (raw.page ?? {}) as Record<string, unknown>;
  const filters = (raw.filters ?? {}) as Record<string, unknown>;
  const options = (key: string) =>
    ((filters[key] as Record<string, unknown>[] | undefined) ?? []).map((o) => ({
      value: String(o.value),
      label: String(o.label),
    }));
  return {
    activity: rows.map(toLedgerRow),
    page: {
      limit: Number(page.limit ?? 0),
      order: String(page.order ?? "newest"),
      hasMore: page.hasMore === true,
      nextCursor: page.nextCursor == null ? null : String(page.nextCursor),
    },
    statusOptions: options("statuses"),
    directionOptions: options("directions"),
  };
}

/* -------------------------------------------------------------------------
 * Which environment Fuel is running against.
 *
 * The whole point of the pinned constants behind GET /api/environment is that
 * the environment is a property of the DEPLOYED CODE. A badge that decided for
 * itself — from NODE_ENV, from a hostname, from a build-time literal — would
 * assert exactly the thing it is supposed to prove, and the one wrong answer
 * that matters is a page saying "Sandbox" while real money is moving.
 *
 * So: the verdict comes from the server or the badge does not appear.
 * ---------------------------------------------------------------------- */

export interface FuelEnvironment {
  /** "sandbox" | "production" | "unknown" — the server's word, not ours. */
  environment: string;
  /** The display string the server chose for it. */
  label: string;
  isProduction: boolean;
}

/**
 * Null when Fuel could not be asked, or answered in a shape this does not
 * recognise.
 *
 * Null means NO CLAIM, and the badge renders nothing. It deliberately does not
 * fall back to "unknown": "unknown" is a real verdict the server can reach
 * (a constant it does not recognise), and borrowing that word for "the API was
 * down" would make a network blip indistinguishable from a misconfiguration.
 *
 * The per-surface breakdown the endpoint also returns is dropped here. A badge
 * needs the verdict; a list of surfaces is a page, and an unused field that
 * crosses the wire is the mistake 5A-1 recorded.
 */
export async function getEnvironment(): Promise<FuelEnvironment | null> {
  try {
    const res = await fuelFetch("/api/environment");
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    if (typeof raw.environment !== "string" || typeof raw.label !== "string") return null;
    return {
      environment: raw.environment,
      label: raw.label,
      isProduction: raw.isProduction === true,
    };
  } catch (error) {
    /*
     * A SIGN-OUT IS NOT "FUEL COULD NOT BE ASKED", AND THIS CATCH WOULD SWALLOW
     * IT. `redirect()` works by throwing a sentinel that Next unwinds to; a
     * bare `catch` eats it and the person stays on a page that quietly renders
     * nothing instead of being sent to sign in. `unstable_rethrow` re-throws
     * exactly Next's own control-flow errors and nothing else, so the "no
     * claim" behaviour below still covers every real failure.
     */
    unstable_rethrow(error);
    // Unreachable API, DNS failure, missing configuration. All of them mean the
    // same thing here: Fuel cannot vouch for the environment, so it says nothing.
    return null;
  }
}

/* -------------------------------------------------------------------------
 * The dashboard's view of the QuickBooks connection.
 *
 * `callQuickBooks("/status")` returns the RAW response: the customer's realm
 * id, OAuth token lifetimes, and the ids of three accounts inside their chart
 * of accounts. None of that may reach a browser, and none of it is needed by
 * anything the dashboard draws.
 *
 * So no page reads that response directly. Both surfaces that show the
 * connection — /integrations, which reports it, and /accounting, which acts on
 * it — read this, and it hands back the contract in lib/accounting-status.ts
 * and nothing else. See ADR 0010.
 * ---------------------------------------------------------------------- */

/**
 * Null when Fuel could not be asked, or answered in a shape the contract does
 * not recognise — the same "no claim" discipline getEnvironment uses. A guess
 * here would be a guess about whether a real accounting connection exists.
 */
export async function getAccountingStatus(): Promise<AccountingStatus | null> {
  try {
    const { status, body } = await callQuickBooks("/status");
    if (status !== 200) return null;
    return toAccountingStatus(body);
  } catch (error) {
    /*
     * A SIGN-OUT IS NOT "FUEL COULD NOT BE ASKED", AND THIS CATCH WOULD SWALLOW
     * IT. `redirect()` works by throwing a sentinel that Next unwinds to; a
     * bare `catch` eats it and the person stays on a page that quietly renders
     * nothing instead of being sent to sign in. `unstable_rethrow` re-throws
     * exactly Next's own control-flow errors and nothing else, so the "no
     * claim" behaviour below still covers every real failure.
     */
    unstable_rethrow(error);
    return null;
  }
}

/* -------------------------------------------------------------------------
 * The earning side.
 *
 * Two reads behind one page: the endpoints a company has put behind a paywall,
 * and the receipts whose outcome Fuel could not establish alone.
 *
 * Both are picked field by field like everything else at this boundary. It
 * matters more here than anywhere else in this file, because the rows behind
 * these two responses carry the densest concentration of things that must never
 * reach a browser: an endpoint row holds the forward secret an origin verifies
 * Fuel's signature with, and a receipt row holds a third party's wallet address,
 * the authorization nonce that is half its replay key, and a settlement hash.
 *
 * The API withholds all of them already. This is the second lock, and it exists
 * because 5A-1 established that a field nothing renders still crosses the wire
 * into a Client Component prop if it is present on the object.
 * ---------------------------------------------------------------------- */

export interface FuelEarningEndpoint {
  id: string;
  agentId: string;
  /** The Fuel-side path customers call. Carries no credential. */
  url: string;
  /** The customer's own origin, which Fuel forwards to once paid. */
  originUrl: string;
  /** What this endpoint is called in the books. */
  label: string;
  priceUsd: string;
  enabled: boolean;
  /**
   * Why this endpoint may not be enabled yet, in the API's words, or null when
   * nothing stands in the way. Never recomputed here — the rule about what
   * makes an endpoint safe to switch on belongs with the checks that prove it.
   */
  blocker: string | null;
  ownership: { path: string; expectedBody: string; provedAt: string | null };
  probes: { refusesUnsignedAt: string | null; refusesInvalidSignatureAt: string | null };
  /** Confirmed receipts only. Never the unresolved ones — see `stuck`. */
  earned: string;
  /** How many receipts on this endpoint are waiting on an answer. */
  stuck: number;
  createdAt: string;
}

function toEarningEndpoint(raw: Record<string, unknown>): FuelEarningEndpoint {
  const ownership = (raw.ownership ?? {}) as Record<string, unknown>;
  const probes = (raw.probes ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id),
    agentId: String(raw.agentId),
    url: String(raw.url),
    originUrl: String(raw.originUrl),
    label: String(raw.label),
    priceUsd: String(raw.priceUsd),
    enabled: raw.enabled === true,
    blocker: raw.blocker == null ? null : String(raw.blocker),
    ownership: {
      path: String(ownership.path ?? ""),
      expectedBody: String(ownership.expectedBody ?? ""),
      provedAt: ownership.provedAt == null ? null : String(ownership.provedAt),
    },
    probes: {
      refusesUnsignedAt:
        probes.refusesUnsignedAt == null ? null : String(probes.refusesUnsignedAt),
      refusesInvalidSignatureAt:
        probes.refusesInvalidSignatureAt == null
          ? null
          : String(probes.refusesInvalidSignatureAt),
    },
    earned: String(raw.earned ?? "0"),
    stuck: Number(raw.stuck ?? 0),
    createdAt: String(raw.createdAt),
  };
}

export async function listEarningEndpoints(): Promise<FuelEarningEndpoint[]> {
  const res = await fuelFetch("/api/earning-endpoints");
  if (!res.ok) throw new Error(`Fuel API returned ${res.status} listing earning endpoints`);
  const raw = (await res.json()) as Record<string, unknown>[];
  return raw.map(toEarningEndpoint);
}

/**
 * A receipt, minus everything that identifies the payer or the settlement.
 *
 * `payerAddress`, `authorizationNonce` and `txHash` are absent from the API's
 * own response and absent again here. `detail` too: on a failure it can quote
 * an origin's error, which may name the customer's host.
 */
export interface FuelReceipt {
  id: string;
  agentId: string;
  endpointId: string | null;
  amount: string;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  statusMeaning: string;
  createdAt: string;
  settledAt: string | null;
}

function toReceipt(raw: Record<string, unknown>): FuelReceipt {
  return {
    id: String(raw.id),
    agentId: String(raw.agentId),
    endpointId: raw.endpointId == null ? null : String(raw.endpointId),
    amount: String(raw.amount),
    status: String(raw.status),
    statusLabel: String(raw.statusLabel),
    statusTone: (raw.statusTone ?? "quiet") as Tone,
    statusMeaning: String(raw.statusMeaning ?? ""),
    createdAt: String(raw.createdAt),
    settledAt: raw.settledAt == null ? null : String(raw.settledAt),
  };
}

/** An outbound payment Fuel could not confirm. The other half of the same question. */
export interface FuelStuckPayment {
  id: string;
  agentId: string;
  agentName: string;
  amount: string;
  createdAt: string;
  statusLabel: string;
  statusMeaning: string;
}

export interface FuelAttention {
  /** Inbound rows Fuel could not resolve: served and unpaid, or never confirmed. */
  receipts: FuelReceipt[];
  /** Outbound rows in the same position. Surfaced by the same API route. */
  payments: FuelStuckPayment[];
}

/**
 * Only the rows that need a person.
 *
 * The API also returns every receipt; this asks for neither more nor less than
 * the two unresolved states, because the Earning page shows endpoints rather
 * than a receipt history — the Activity Ledger is where a full inbound history
 * is read, and duplicating it here would be a second list to keep in step.
 */
export async function getAttention(): Promise<FuelAttention> {
  const res = await fuelFetch("/api/receipts");
  if (!res.ok) throw new Error(`Fuel API returned ${res.status} reading receipts`);
  const raw = (await res.json()) as Record<string, unknown>;
  const receipts = (raw.needsAttention as Record<string, unknown>[] | undefined) ?? [];
  const payments = (raw.paymentsNeedingAttention as Record<string, unknown>[] | undefined) ?? [];
  return {
    receipts: receipts.map(toReceipt),
    payments: payments.map((p) => ({
      id: String(p.id),
      agentId: String(p.agentId),
      agentName: String(p.agentName),
      amount: String(p.amount),
      createdAt: String(p.createdAt),
      statusLabel: String(p.statusLabel),
      statusMeaning: String(p.statusMeaning ?? ""),
    })),
  };
}

/* -------------------------------------------------------------------------
 * Alerting (ADR 0021).
 * ---------------------------------------------------------------------- */

/**
 * What needs a person, for the Overview: the API's list, which is also what
 * alerts are built from.
 *
 * NAMED APART FROM `getAttention` ABOVE on purpose. That one is the Earning
 * page's two unresolved-money lists; this is the Overview's whole list. Two
 * functions called getAttention would be one rename away from the wrong page
 * reading the wrong list.
 *
 * THROWS RATHER THAN RETURNING AN EMPTY LIST. The Overview turns a failure into
 * "could not be read". An empty list is a claim that nothing needs a person,
 * and a failed read is not evidence of that.
 */
export async function getAttentionItems(): Promise<FuelAttentionList> {
  const res = await fuelFetch("/api/attention");
  if (!res.ok) throw new Error(`Fuel API returned ${res.status} reading what needs attention`);
  const list = toAttentionList(await res.json().catch(() => null));
  if (list === null) throw new Error("Fuel returned a needs-attention list this dashboard does not recognise");
  return list;
}

/**
 * The owner's alert settings and the last 20 alerts, or null when Fuel could
 * not be asked. Owner-only at the API; the page asks only for an owner.
 */
export async function getAlertSettings(): Promise<FuelAlertSettings | null> {
  try {
    const res = await fuelFetch("/api/alerts?limit=20");
    if (!res.ok) return null;
    return toAlertSettings(await res.json().catch(() => null));
  } catch (error) {
    // A sign-out is not "Fuel could not be asked". See getAccountingStatus.
    unstable_rethrow(error);
    return null;
  }
}

/**
 * The three alert-webhook writes, for app/api/alerts/route.ts.
 *
 * THE URL PASSES THROUGH HERE AND IS NOT KEPT. It is put in the request body to
 * Fuel and nowhere else: not in a log line, not in an error message, and not
 * in the return value, which is Fuel's answer and never carries it.
 */
export async function callAlertWebhook(
  action: "set" | "remove" | "test",
  url?: string,
): Promise<{ status: number; body: unknown }> {
  const res =
    action === "set"
      ? await fuelFetch("/api/alerts/webhook", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        })
      : action === "remove"
        ? await fuelFetch("/api/alerts/webhook", { method: "DELETE" })
        : await fuelFetch("/api/alerts/webhook/test", { method: "POST" });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/* -------------------------------------------------------------------------
 * Who is signed in, and deciding a held payment.
 *
 * Both are new in Stage 3 Commit C, and both are only possible because the
 * dashboard now carries a person's session rather than a shared key.
 * ---------------------------------------------------------------------- */

export interface FuelViewer {
  email: string;
  /** "owner" or "operator" — the API's word, not one this file invents. */
  role: string;
  companyName: string;
  /**
   * How people name this company when they sign in (ADR 0018). Shown so a
   * signed-in person can pass it on; it is an address, not a secret.
   */
  companyHandle: string;
}

/**
 * The signed-in person, or null.
 *
 * THE ONE CALL IN THIS FILE THAT DOES NOT REDIRECT ON 401, and the exception is
 * deliberate rather than an oversight. Every other call is made BY a page that
 * assumes it is signed in, so a 401 means "you are not, go and sign in". This
 * call is the question itself — it is what the shell uses to decide whether to
 * draw navigation at all — and a probe that redirects when the answer is "no"
 * would send the sign-in page to the sign-in page. A stale cookie on /login is
 * an ordinary situation, not a loop to fall into.
 *
 * So it uses `fetch` directly with the forwarded session, and null means
 * exactly "nobody is signed in here".
 */
export async function getViewer(): Promise<FuelViewer | null> {
  try {
    const res = await fetch(fuelApiUrl("/api/auth/me"), {
      headers: await forwardSession(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, any>;
    if (typeof raw?.user?.email !== "string") return null;
    return {
      email: String(raw.user.email),
      role: String(raw.user.role ?? ""),
      companyName: String(raw.companyName ?? ""),
      companyHandle: String(raw.companyHandle ?? ""),
    };
  } catch {
    // No `unstable_rethrow`: this function never redirects, so there is no
    // control-flow error of Next's to preserve here.
    return null;
  }
}

/**
 * Approve or deny one held payment, AS THE PERSON VIEWING THE PAGE.
 *
 * The decision travels on the viewer's session cookie, which is the entire
 * point of this commit: until now the dashboard could not decide at all, and
 * the only credential it held named nobody. Commit D writes `decided_by` from
 * the session the API resolves here, which is only an honest column because
 * this call carries a person rather than a key.
 *
 * The decision word is not interpolated into the path from caller input — it is
 * narrowed to two literals by the type and then chosen, so no value from a
 * request body can ever steer which API route is called.
 */
export async function decideApproval(
  approvalId: string,
  decision: "approve" | "deny",
): Promise<FuelApproval> {
  const path = decision === "approve" ? "approve" : "deny";
  const res = await fuelFetch(
    `/api/approvals/${encodeURIComponent(approvalId)}/${path}`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `Fuel API returned ${res.status} recording the decision`,
    );
  }
  return toApproval((await res.json()) as Record<string, unknown>);
}

/* -------------------------------------------------------------------------
 * Starting and ending a session.
 *
 * Both talk to the Fuel API directly rather than through `fuelFetch`, and for
 * the same reason in each case: `fuelFetch` turns a 401 into "go and sign in",
 * which is exactly the wrong move for the two calls whose whole subject is
 * signing in and out.
 * ---------------------------------------------------------------------- */

export interface SessionResult {
  status: number;
  /** The API's `Set-Cookie` lines, to be relayed to the browser untouched. */
  setCookie: string[];
}

/**
 * Signs in, and hands back the API's own `Set-Cookie` lines VERBATIM.
 *
 * THE DASHBOARD DOES NOT DECIDE THE COOKIE'S ATTRIBUTES, and that is the point
 * of returning raw header lines instead of a token. `HttpOnly`, `SameSite`,
 * `Secure`, `Path` and `Max-Age` are decided once, in src/auth/routes.ts, by
 * the process that also knows whether it is behind TLS. If this file set the
 * cookie itself it would become a second place those attributes are chosen,
 * and the failure mode is silent: a dashboard that forgot `HttpOnly` would
 * look and behave identically right up until a script read the session.
 *
 * The password is passed straight through and is never logged, stored, or put
 * in a URL — which is why sign-in is a POST with a form body and the browser
 * never sees it again after the redirect.
 *
 * `company` is the handle the person typed, passed through as typed: the API
 * normalises it, so there is one rule for what matches and it lives there.
 */
export async function startSession(
  company: string,
  email: string,
  password: string,
  clientAddress: string,
): Promise<CodedResult> {
  const res = await fetch(fuelApiUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...relayHeaders(clientAddress) },
    body: JSON.stringify({ company, email, password }),
    cache: "no-store",
  });
  return { status: res.status, code: await codeOf(res), setCookie: res.headers.getSetCookie() };
}

/**
 * Redeems an invite, creating the account and signing the person in.
 *
 * `startSession`'s sibling, and a plain `fetch` for the same reason: there is
 * no session to forward yet, and a 401 here must not bounce somebody to a page
 * asking them to sign in to an account they are in the middle of creating.
 *
 * THE TOKEN IS A CREDENTIAL AND IS TREATED LIKE ONE. It arrives in a POST body,
 * is passed straight through in another POST body, and goes nowhere else — not
 * into a log line, not into the redirect this call's result produces, and not
 * into a URL at any point. That is why the signup page asks for it in a form
 * field rather than reading it from a link: a token in a URL survives in
 * browser history and in access logs long after the invite is spent.
 *
 * RETURNS THE REFUSAL CODE, NEVER THE MESSAGE. `code` is a closed vocabulary
 * declared in src/auth/codes.ts; the caller looks it up to choose one of ITS
 * OWN sentences. Relaying the server's prose onto a Fuel-origin page is the
 * phishing surface the sign-in page's NOTICES lookup exists to avoid, and this
 * deliberately does not return anything that would make it easy.
 */
export async function redeemInvite(
  token: string,
  email: string,
  password: string,
  clientAddress: string,
): Promise<CodedResult> {
  const res = await fetch(fuelApiUrl("/api/auth/signup"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...relayHeaders(clientAddress) },
    body: JSON.stringify({ token, email, password }),
    cache: "no-store",
  });
  return { status: res.status, code: await codeOf(res), setCookie: res.headers.getSetCookie() };
}

/** A sign-in or signup answer, with the refusal code when there is one. */
export interface CodedResult extends SessionResult {
  /** A member of SIGNUP_CODES or RELAY_CODES (src/auth/codes.ts), or null when
   * the API sent none. A successful sign-in sends none. */
  code: string | null;
}

/**
 * The refusal code from a response, or null.
 *
 * A body that is not JSON is not an error worth surfacing differently: the
 * caller already has the status, and every refusal these routes make is JSON.
 * A parse failure means something upstream answered instead of Fuel, which the
 * caller handles as a generic refusal.
 */
async function codeOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

/**
 * The two headers that let Fuel rate-limit per browser (ADR 0020).
 *
 * `clientAddress` comes from `verifiedClientAddress`, so it is what this
 * dashboard's own edge read off the socket, never something the browser
 * wrote. The key is what makes Fuel believe it: without the key, Fuel ignores
 * the address and counts the request against whoever sent it.
 *
 * A MISSING KEY THROWS, and the caller turns that into "Fuel could not be
 * reached". Sending the address without the key would get the request counted
 * against the dashboard itself, which is the shared bucket this replaced: one
 * browser could lock everyone out again, silently.
 *
 * Called from `startSession` and `redeemInvite` ONLY. verify-api checks that.
 */
function relayHeaders(clientAddress: string): Record<string, string> {
  const key = process.env.FUEL_RELAY_KEY;
  if (!key) throw new Error("FUEL_RELAY_KEY is not set. Sign-in cannot be relayed without it.");
  return { "X-Fuel-Relay-Key": key, "X-Fuel-Client-Address": clientAddress };
}

/**
 * Signs out, and relays the API's cookie-clearing header.
 *
 * A FAILURE HERE IS STILL A SIGN-OUT. If the session had already expired the
 * API answers 401 and clears nothing, and if Fuel is unreachable this throws —
 * in both cases the caller still sends the browser to the sign-in page. The
 * alternative is telling somebody who clicked "Sign out" that it did not work,
 * while the credential they wanted rid of stays in their browser.
 */
export async function endSession(): Promise<SessionResult> {
  const res = await fetch(fuelApiUrl("/api/auth/logout"), {
    method: "POST",
    headers: await forwardSession(),
    cache: "no-store",
  });
  return { status: res.status, setCookie: res.headers.getSetCookie() };
}
