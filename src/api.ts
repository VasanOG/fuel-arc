/**
 * Fuel's own API: create agents, set caps, and make cap-checked payments.
 *
 * Speaks dollars, not base units or chain names — CLAUDE.md's no-crypto-surface
 * rule. Conversion happens here at the edge and nowhere else.
 */
import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  freezeAgent,
  getAgentInCompany,
  listAgentsByTeam,
  listAgentsInCompany,
  setSpendCap,
  unfreezeAgent,
  type Agent,
} from "./db/agents.js";
import {
  decideRequest,
  SharedKeyCannotDecideError,
  getApprovalRequestInCompany,
  listApprovalRequests,
  type ApprovalRequestWithContext,
  type ApprovalStatus,
} from "./db/approvals.js";
import {
  setCompanySpendCap,
  type Company,
} from "./db/companies.js";
import {
  companySpentBaseUnits,
  companyLedgerSpentBaseUnits,
  ledgerSpentBaseUnits,
  listPaymentsForExport,
  spentBaseUnits,
  teamSpentBaseUnits,
  listRecentPayments,
  agentInCompany,
  teamInCompany,
  paymentsNeedingAttention,
  reconcileUnreconciledPayment,
  getPaymentStatusInCompany,
  PAYMENT_STATUSES,
  type PaymentStatus,
} from "./db/payments.js";
import {
  listLedgerPage,
  type LedgerCursor,
  type LedgerDirection,
  type LedgerOrder,
  type LedgerEarnRow,
  type LedgerRow,
  type LedgerSpendRow,
} from "./db/ledger.js";
import {
  companyEarnedBaseUnits,
  earnedBaseUnits,
  earnedByEndpoint,
  getReceiptInCompany,
  listReceiptsForCompany,
  receiptsNeedingAttention,
  reconcileReceipt,
  stuckCountByEndpoint,
  RECEIPT_STATUSES,
  type Receipt,
  type ReceiptStatus,
} from "./db/receipts.js";
import {
  authorizationUsed,
  UnreadableAuthorizationError,
} from "./gateway/settlement-evidence.js";
import { describeEnvironment } from "./lib/environment.js";
import { describe } from "./lib/env.js";
import {
  presentApprovalStatus,
  presentReceiptStatus,
  presentRefusal,
  presentScope,
  presentStatus,
  ledgerStatusFilters,
  LEDGER_BASIS_NOTE,
} from "./lib/payment-presentation.js";
import {
  computeBuckets,
  drillDown,
  listPostingLines,
  runPosting,
  type PostingLine,
} from "./db/postings.js";
import {
  createOAuthState,
  currencyBlocker,
  deleteConnection,
  UnresolvedPostingsError,
  getConfig,
  getConnection,
  missingAccounts,
  missingRevenueAccounts,
  saveConfig,
  saveConfigByHand,
  AccountsNeedConnectionError,
  AccountsFromOtherBooksError,
  OAUTH_STATE_TTL_MS,
  type ContraAccountKind,
  type RollupGrain,
} from "./db/qbo.js";
import {
  draftReadiness,
  getDraftInCompany,
  getPostingInCompany,
  listDrafts,
  listPostings,
  pendingPostings,
  type PostingDraft,
  type QboPosting,
  DocumentInFlightError,
} from "./db/qbo-postings.js";
import { authorizeUrl, newState } from "./quickbooks/oauth.js";
import { companyProfile, setUpAccounts, verifyAccountingCurrency } from "./quickbooks/accounts.js";
import { NotConnectedError, QboApiError, RealmMismatchError, realmFor } from "./quickbooks/client.js";
import { UnsupportedCurrencyError } from "./quickbooks/journal.js";
import {
  CurrencyScopeError,
  DraftNotPostableError,
  NotConfiguredError,
  NothingToPostError,
  post,
  postReversal,
  preview,
  reconcilePending,
  AnsweredButNotRecordedError,
  QuickBooksAnsweredError,
  WriteOffRefusedError,
  writeOffPending,
} from "./quickbooks/posting.js";
import {
  createTeam,
  getTeamInCompany,
  listTeams,
  setTeamSpendCap,
  type Team,
} from "./db/teams.js";
import { ASSET_LABEL, getVaultUsdcBalance, NETWORK_LABEL } from "./fireblocks/provision.js";
import {
  AgentNameTakenError,
  VaultAlreadyHeldError,
  createAgentWithCustody,
} from "./agents/create.js";
import { fireblocksSigner } from "./fireblocks/signer.js";
import { arcDemoSigner, isArcDemoAgent } from "./payments/arc-demo.js";
import { companyFor, companyOf, requireOwner, requireRole, sessionOf, userOf } from "./lib/auth.js";
import { Buckets } from "./lib/buckets.js";
import { attentionFor, collapse, type AttentionGroup } from "./alerts/attention.js";
import { fromPayload } from "./alerts/dispatch.js";
import { LABEL } from "./alerts/events.js";
import { alertDispatcher } from "./alerts/runtime.js";
import { sweepCompany } from "./alerts/sweeper.js";
import {
  assertWebhookUrl,
  openWebhook,
  sealWebhook,
  WEBHOOK_URL_MESSAGES,
  WebhookUrlError,
} from "./alerts/webhook-url.js";
import {
  DEGRADED_AFTER,
  getWebhookRow,
  lastSweepAt,
  recentAlerts,
  removeWebhook,
  setWebhook,
  type AlertOutcome,
} from "./db/alerts.js";
import { createInvite, listInvites, revokeInvite, type Invite } from "./db/invites.js";
import { disableUser, getUserInCompany, listUsers, type User } from "./db/users.js";
import { revokeSessionsForUser } from "./db/sessions.js";
import { handleLogout, handleMe } from "./auth/routes.js";
import { toCsv } from "./lib/csv.js";
import {
  POSTING_DIRECTIONS,
  directionOf,
  type LedgerClass,
  type PostingDirection,
} from "./accounting/rollup.js";
import {
  DuplicateLabelError,
  EndpointNotVerifiedError,
  enablementBlocker,
  getEndpointInCompany,
  linesCarryingLabel,
  listEndpointsForCompany,
  registerEndpoint,
  setEnabled,
  setLabel,
  type EarningEndpoint,
} from "./db/earning-endpoints.js";
import { verifyEndpoint, OWNERSHIP_PATH } from "./gateway/probes.js";
import { GATEWAY_PREFIX } from "./gateway/origin.js";
import {
  descriptionFromResourceUrl,
  ledgerAccount,
  ledgerDay,
  ledgerStatus,
  ledgerStatusFor,
  vendorFromResourceUrl,
} from "./lib/export-presentation.js";
import {
  baseUnitsToDollars,
  baseUnitsToDollarsFixed,
  baseUnitsToWholeCents,
  dollarsToBaseUnits,
} from "./lib/money.js";
import { payForAgent } from "./payments/pay.js";

export const api = Router();

/**
 * Every route below declares a role, including the reads that both roles
 * share. That is a convention with teeth: a route with no `requireRole` is
 * reachable by any authenticated caller, so an omission fails OPEN. Declaring
 * it everywhere makes a missing one the single odd route out in review.
 *
 * The split that matters: the credential that can spend (`agent`) cannot
 * approve, and the credential that can approve or move a cap (`operator`)
 * cannot spend. Neither alone can push money past a ceiling.
 */
/**
 * Who you are, and signing out.
 *
 * On the AUTHENTICATED router, unlike `/api/auth/login`, because both need a
 * resolved session — there is nothing to report or to revoke without one. Both
 * answer a shared-key caller honestly rather than pretending: a key has no
 * session to describe or end.
 *
 * No role guard: any authenticated caller may ask about itself.
 */
api.get("/auth/me", handleMe);
api.post("/auth/logout", handleLogout);

/**
 * Managing who else exists — OWNER ONLY, AND THEREFORE NEVER A SHARED KEY.
 *
 * `requireOwner` refuses the legacy credentials outright, which is deliberate
 * and is the sharpest line this slice draws: a secret that names nobody must
 * not decide who else gets an account. Every route below either mints an
 * identity or ends one.
 *
 * None of them can name a company. The invite route writes `companyOf(req)`
 * itself and has no parameter for it, so an owner cannot invite someone into a
 * company they do not belong to, and cannot create one — a founding invite
 * (`company_id IS NULL`) is expressible only by scripts/mint-invite.ts.
 */
const OWNER = requireOwner();

api.post("/invites", OWNER, (req, res) => {
  const { email, role } = req.body ?? {};
  if (typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "email is required" });
  }
  if (role !== "owner" && role !== "operator") {
    return res.status(400).json({ error: "role must be owner or operator" });
  }

  /*
   * NO CHECK ON THE ADDRESS, DELIBERATELY (ADR 0018). Whether it has an account
   * at another company is not this company's business, and since addresses are
   * unique per company it cannot get in the way either. Every invite is
   * answered the same, whatever the address.
   */
  const { invite, token } = createInvite({ companyId: companyOf(req), email, role });
  // THE ONLY TIME THE TOKEN IS EVER RETURNED. The row holds a hash, so this
  // cannot be re-read later — losing it means minting another, which is the
  // intended tradeoff for a stolen database being worthless.
  //
  // The handle goes with it: the invitee needs both, the code to sign up and
  // the handle to sign in afterwards.
  res.status(201).json({ ...presentInvite(invite), token, companyHandle: companyFor(req).handle });
});

api.get("/invites", OWNER, (req, res) => {
  res.json({ invites: listInvites(companyOf(req)).map(presentInvite) });
});

api.post("/invites/:id/revoke", OWNER, (req, res) => {
  if (!revokeInvite(req.params.id, companyOf(req))) {
    // One answer for "no such invite in your company" and "already used or
    // withdrawn". An owner has the list; an attacker would learn which ids
    // exist.
    return res.status(409).json({ error: "that invitation cannot be withdrawn" });
  }
  res.json({ revoked: true });
});

api.get("/users", OWNER, (req, res) => {
  res.json({ users: listUsers(companyOf(req)).map(presentUserRow) });
});

api.post("/users/:id/disable", OWNER, (req, res) => {
  const companyId = companyOf(req);
  const self = userOf(req);
  if (req.params.id === self) {
    // An owner disabling themselves could leave a company with no owner and no
    // way to make one — a locked room whose only key is a script.
    return res.status(409).json({ error: "you cannot disable your own account" });
  }
  if (!disableUser(req.params.id, companyId)) {
    return res.status(409).json({ error: "that account cannot be disabled" });
  }
  // Disabling has to end the access they are ALREADY holding, not just future
  // sign-ins. `resolveSession` checks this too; both, because a live session
  // row for a disabled person should not sit around waiting for one of them to
  // be forgotten.
  const ended = revokeSessionsForUser(req.params.id);
  res.json({ disabled: true, sessionsEnded: ended });
});

const OPERATOR = requireRole("operator");
const AGENT = requireRole("agent");
const ANY = requireRole("operator", "agent");

/**
 * Each agent's payments are signed by that agent's own Fireblocks vault.
 *
 * Both fields are already on the agent record from provisioning, so the signer
 * is cheap to build per request and needs no async setup — `PaymentSigner`
 * exposes `address` synchronously.
 *
 * The one exception is the Arc founder-demo agent named in
 * src/payments/arc-chain.ts, which signs with its own demo key and only for
 * the demo payment. Fireblocks' signer refuses Arc for everyone else.
 */
function signerForAgent(agent: Agent) {
  if (isArcDemoAgent(agent)) return arcDemoSigner();
  return fireblocksSigner({
    vaultId: agent.fireblocksVaultId,
    address: agent.address as `0x${string}`,
  });
}

/**
 * Earned, spent and net on the LEDGER basis, nested and labelled.
 *
 * NESTED RATHER THAN FLAT, and that is the whole point of the shape. A flat
 * `ledgerSpent` beside the existing `spent` would put two differently-defined
 * figures at the same level under near-identical names, and the one that gets
 * picked would be whichever a caller's eye landed on. Inside an object carrying
 * its own note, a consumer has to walk past the explanation to reach the number.
 *
 * `net` is `earned - spent` and is NEGATIVE for every agent that has ever spent
 * more than it earned, which today is all of them. Emitted as a signed decimal
 * string like every other amount here — a JSON number is an IEEE-754 double,
 * and money that survives a round trip by luck is money that will eventually
 * not.
 */
function presentLedgerTotals(earned: bigint, spent: bigint) {
  return {
    earned: baseUnitsToDollars(earned),
    spent: baseUnitsToDollars(spent),
    net: baseUnitsToDollars(earned - spent),
    note: LEDGER_BASIS_NOTE,
  };
}

/**
 * An agent, as every route that returns one presents it.
 *
 * `walletAddress: agent.address` was removed here in 5B-2, which is where
 * docs/decisions/0005 actually finishes. Phase 5A-1 took the address off the
 * dashboard and 5B-1 stopped it being transmitted to the browser, but the API
 * kept emitting it to any caller — and GET /agents was reachable with the
 * shared AGENT credential, so every agent could read every other agent's
 * custody address. Nothing consumed the field: the dashboard had already
 * dropped it and Fuel's own scripts read custody directly. The row still holds
 * the address; it simply stops leaving.
 */
function present(agent: Agent) {
  const spent = spentBaseUnits(agent.id);
  const remaining = agent.spendCapBaseUnits - spent;
  return {
    id: agent.id,
    name: agent.name,
    teamId: agent.teamId,
    spendCap: baseUnitsToDollars(agent.spendCapBaseUnits),
    spent: baseUnitsToDollars(spent),
    remaining: baseUnitsToDollars(remaining > 0n ? remaining : 0n),
    createdAt: agent.createdAt,
    // Reported separately from the budget figures on purpose: a frozen agent
    // can have plenty of remaining budget and still be unable to spend a cent.
    frozen: agent.frozenAt !== null,
    frozenAt: agent.frozenAt,
    frozenReason: agent.frozenReason,
    // How hard it has pushed against the current freeze. A non-trivial count
    // here is the operator's cue that something is retrying a stop order
    // rather than having quietly accepted it.
    frozenAttempts: agent.frozenAttemptCount,
    lastFrozenAttemptAt: agent.lastFrozenAttemptAt,
    /*
     * The P&L, which is NOT `spent` above with a different name.
     *
     * `spent` is the cap basis and includes payments still in flight, because a
     * ceiling has to count money that might move. `ledger.spent` is what
     * actually moved. An agent with a pending payment shows two different
     * numbers here, correctly, and the note says why.
     */
    ledger: presentLedgerTotals(earnedBaseUnits(agent.id), ledgerSpentBaseUnits(agent.id)),
  };
}

/**
 * `present` plus on-chain balance, for the two read routes the dashboard
 * uses. Kept separate from `present` so create/patch responses — which
 * shouldn't need a Fireblocks round trip to return — are unaffected.
 */
async function presentWithBalance(agent: Agent) {
  return { ...present(agent), balance: await getVaultUsdcBalance(agent.fireblocksVaultId) };
}

/**
 * Where and how a person can fund this agent, for the one route allowed to
 * say so (ADR 0019, narrowing 0005's now-closed exception).
 *
 * DELIBERATELY NOT ON `present()`. That function backs `GET /agents` (a list,
 * so no funding instructions belong on it) as well as every other reader of
 * an agent — and 5B-2 removed `agent.address` from `present()` specifically
 * because the shared AGENT credential could reach it there and enumerate
 * every agent's custody address. Adding it back onto `present()` would
 * reopen exactly that. This is called only from the single-agent `GET`
 * route, which is OPERATOR-only, company-scoped, and returns one agent.
 */
function presentFunding(agent: Agent) {
  return {
    address: agent.address,
    network: NETWORK_LABEL,
    asset: ASSET_LABEL,
  };
}

/**
 * The ceiling on total spend across every team and agent beneath it. Starts
 * at $0 on a fresh install — nothing can be paid until an operator raises it
 * deliberately.
 */
/**
 * An invite as an owner sees it. NO TOKEN and no hash — the token appears once,
 * in the response that mints it, and never again.
 */
function presentInvite(invite: Invite) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    status: invite.redeemedAt ? "redeemed" : invite.revokedAt ? "revoked" : "pending",
  };
}

/** A user as an owner sees it. Built field by field; no password hash exists here to leak. */
function presentUserRow(user: User) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    active: user.disabledAt === null,
  };
}

function presentCompany(company: Company) {
  const spent = companySpentBaseUnits(company.id);
  const remaining = company.spendCapBaseUnits - spent;
  return {
    id: company.id,
    name: company.name,
    // How a person names this company at sign-in (ADR 0018). The caller's own.
    handle: company.handle,
    spendCap: baseUnitsToDollars(company.spendCapBaseUnits),
    spent: baseUnitsToDollars(spent),
    remaining: baseUnitsToDollars(remaining > 0n ? remaining : 0n),
    // Same relationship as on an agent: the three above are the cap basis, the
    // three inside are what moved.
    ledger: presentLedgerTotals(
      companyEarnedBaseUnits(company.id),
      companyLedgerSpentBaseUnits(company.id),
    ),
  };
}

function presentTeam(team: Team) {
  const spent = teamSpentBaseUnits(team.id);
  const remaining = team.spendCapBaseUnits - spent;
  return {
    id: team.id,
    name: team.name,
    companyId: team.companyId,
    spendCap: baseUnitsToDollars(team.spendCapBaseUnits),
    spent: baseUnitsToDollars(spent),
    remaining: baseUnitsToDollars(remaining > 0n ? remaining : 0n),
    createdAt: team.createdAt,
  };
}

// Singular, with no id in the path, and now for a real reason rather than a
// provisional one: the company is not something a caller names, it is
// something their credential already is. A /companies/:id route would be a
// second, request-supplied source of the tenant — the thing this slice removes.
api.get("/company", OPERATOR, (req, res) => {
  res.json(presentCompany(companyFor(req)));
});

api.patch("/company", OPERATOR, (req, res) => {
  try {
    const cap = dollarsToBaseUnits(req.body?.spendCapUsd);
    res.json(presentCompany(setCompanySpendCap(companyOf(req), cap)!));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

api.post("/teams", OPERATOR, (req, res) => {
  const { name, spendCapUsd } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const team = createTeam({
      companyId: companyOf(req),
      name: name.trim(),
      // Defaults to $0 — deny until an operator grants budget, the same
      // default a new agent gets below.
      spendCapBaseUnits: dollarsToBaseUnits(spendCapUsd ?? "0"),
    });
    res.status(201).json(presentTeam(team));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

/* ---------------------------------------------------------------------------
 * Earning endpoints (Phase 6, slice 6A-2)
 *
 * OPERATOR ONLY, WITHOUT EXCEPTION. Registering an endpoint sets a price and
 * names a host Fuel will send traffic to — an agent doing either would be an
 * agent setting its own money policy, which is the thing the role split exists
 * to prevent. It is the same reason an agent may pay but may not change a cap.
 * ------------------------------------------------------------------------- */

/**
 * What an operator is allowed to see about their own endpoint.
 *
 * A picked allowlist, not a spread. `forward_secret` is not on the row type at
 * all, and the ownership nonce is included deliberately — the operator has to
 * publish it — but nothing else about Fuel's internals is. Closing ADR 0005
 * needed two attempts because a TypeScript annotation is erased at build time
 * and stops a field being rendered without stopping it being transmitted; this
 * is the shape that lesson produced.
 */
/**
 * Both totals for one endpoint, or for a whole list in two queries.
 *
 * REQUIRED AT EVERY CALL SITE, not optional with a zero default. An optional
 * parameter yielding `earned: "0"` would have made a renamed endpoint that has
 * genuinely earned money report nothing on the PATCH response — a figure
 * asserted without being computed, which is the same class of mistake as
 * `ledgerAccount`'s `?? "Unknown"` that 0012 diagnosed: a gap producing a
 * confident wrong answer rather than a complaint. The single-endpoint routes
 * run the same two grouped queries; at this scale that is cheaper than a second
 * definition of what "earned" means.
 */
function endpointTotals(companyId: string): (id: string) => {
  earnedBaseUnits: bigint;
  stuck: number;
} {
  const earned = earnedByEndpoint(companyId);
  const stuck = stuckCountByEndpoint(companyId);
  return (id) => ({ earnedBaseUnits: earned.get(id) ?? 0n, stuck: stuck.get(id) ?? 0 });
}

function presentEndpoint(
  e: EarningEndpoint,
  totals: { earnedBaseUnits: bigint; stuck: number },
) {
  return {
    id: e.id,
    agentId: e.agentId,
    url: `${GATEWAY_PREFIX}/${e.publicId}`,
    originUrl: e.originUrl,
    // What this endpoint is called in the books. On the allowlist because an
    // operator has to be able to see the name their accountant will read.
    label: e.label,
    priceUsd: baseUnitsToDollars(e.priceBaseUnits),
    enabled: e.enabled,
    blocker: enablementBlocker(e),
    /*
     * CONFIRMED RECEIPTS ONLY, and `stuck` beside it for the reason the
     * Earning page exists at all. APPEARS_IN_RECEIPT_LEDGER is ('settled'), so
     * `earned` deliberately excludes the two states where a customer's origin
     * may have done work that was never paid for. A revenue figure alone would
     * therefore look healthiest exactly when those rows are piling up, which is
     * why the count travels with it rather than living on another screen.
     */
    earned: baseUnitsToDollars(totals.earnedBaseUnits),
    stuck: totals.stuck,
    ownership: {
      // The operator must serve this value at this path to prove the origin is
      // theirs. Both halves are needed for that to be actionable.
      path: OWNERSHIP_PATH,
      expectedBody: e.ownershipNonce,
      provedAt: e.ownershipProvedAt,
    },
    probes: {
      refusesUnsignedAt: e.probeUnsignedAt,
      refusesInvalidSignatureAt: e.probeBadSigAt,
    },
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

api.post("/earning-endpoints", OPERATOR, (req, res) => {
  const { agentId, originUrl, priceUsd, label } = req.body ?? {};
  if (typeof agentId !== "string" || !agentId.trim()) {
    return res.status(400).json({ error: "agentId is required" });
  }
  if (typeof originUrl !== "string" || !originUrl.trim()) {
    return res.status(400).json({ error: "originUrl is required" });
  }
  // Optional: omitted means "derive one from the origin". The shape is checked
  // here, the content in assertUsableLabel at the write path.
  if (label !== undefined && typeof label !== "string") {
    return res.status(400).json({ error: "label must be a string" });
  }

  // Company-scoped through the same helper every other agent lookup uses, so a
  // caller cannot register an endpoint against an agent that is not theirs.
  const agent = getAgentInCompany(agentId, companyOf(req));
  if (!agent) return res.status(404).json({ error: "no such agent" });

  let parsed: URL;
  try {
    parsed = new URL(originUrl.trim());
  } catch {
    return res.status(400).json({ error: "originUrl is not a valid URL" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "originUrl must be http or https" });
  }

  try {
    const { endpoint, forwardSecret } = registerEndpoint({
      agentId: agent.id,
      originUrl: parsed.href,
      priceBaseUnits: dollarsToBaseUnits(priceUsd ?? "0"),
      label,
    });
    // Created disabled. It cannot be enabled until the checks pass, and that
    // gate lives at the single write path, not here.
    //
    // THE FORWARD SECRET APPEARS HERE AND NOWHERE ELSE, EVER. The customer's
    // origin has to verify Fuel's signature, and verifying needs this value —
    // an anti-bypass mechanism whose secret the customer never receives is not
    // a mechanism. It is not on `presentEndpoint`, so no later read can return
    // it; if it is lost, the endpoint is re-registered.
    res.status(201).json({
      ...presentEndpoint(endpoint, endpointTotals(companyOf(req))(endpoint.id)),
      forwardSecret,
      forwardSecretNote:
        "Shown once. Your origin must verify Fuel's X-Fuel-Signature header with this " +
        "value and refuse any request that fails, including one whose signature header " +
        "is present but wrong. Fuel checks both before it will enable this endpoint.",
    });
  } catch (error) {
    // 409 for a name already in use: the request is well formed, the name is
    // simply taken. Same distinction the enable route draws.
    if (error instanceof DuplicateLabelError) {
      return res.status(409).json({ error: error.message });
    }
    res.status(400).json({ error: (error as Error).message });
  }
});

api.get("/earning-endpoints", OPERATOR, (req, res) => {
  const companyId = companyOf(req);
  // Two grouped queries for the whole list, not two per endpoint.
  const totals = endpointTotals(companyId);
  res.json(listEndpointsForCompany(companyId).map((e) => presentEndpoint(e, totals(e.id))));
});

/**
 * Runs the ownership proof and both bypass probes, and records what they found.
 *
 * Separate from registration on purpose: an operator registers, is told what to
 * publish, publishes it, and then asks Fuel to look again. Running the checks
 * inside registration would fail every first attempt by construction.
 */
api.post("/earning-endpoints/:id/verify", OPERATOR, async (req, res) => {
  // Scoped in the query: another company's endpoint is the same 404 as none.
  const endpoint = getEndpointInCompany(req.params.id, companyOf(req));
  if (!endpoint) return res.status(404).json({ error: "no such endpoint" });

  try {
    await verifyEndpoint(endpoint);
    const fresh = getEndpointInCompany(endpoint.id, companyOf(req))!;
    res.json(presentEndpoint(fresh, endpointTotals(companyOf(req))(fresh.id)));
  } catch (error) {
    res.status(502).json({ error: (error as Error).message });
  }
});

api.patch("/earning-endpoints/:id", OPERATOR, (req, res) => {
  // Scoped in the query: another company's endpoint is the same 404 as none.
  const endpoint = getEndpointInCompany(req.params.id, companyOf(req));
  if (!endpoint) return res.status(404).json({ error: "no such endpoint" });

  const { enabled, label } = req.body ?? {};
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be true or false" });
  }
  if (label !== undefined && typeof label !== "string") {
    return res.status(400).json({ error: "label must be a string" });
  }
  if (enabled === undefined && label === undefined) {
    return res.status(400).json({ error: "nothing to change: send enabled, label, or both" });
  }

  // Read BEFORE the rename, because afterwards there is nothing to count: the
  // lines still carry the old name and that is the whole point of reporting it.
  const splitFrom = label === undefined ? 0 : linesCarryingLabel(endpoint.agentId, endpoint.label);

  try {
    let current = endpoint;
    if (label !== undefined) current = setLabel(current.id, label);
    if (enabled !== undefined) current = setEnabled(current.id, enabled);

    // A rename does not move money — buckets key on the endpoint id — but it
    // does split the counterparty text, so revenue for one day can land in two
    // documents under two names. Reported rather than left to be noticed.
    const renamedAway =
      label !== undefined && splitFrom > 0 && current.label !== endpoint.label
        ? {
            previousLabel: endpoint.label,
            linesKeepingPreviousLabel: splitFrom,
            note:
              `${splitFrom} already-rolled-up revenue line(s) keep the name ` +
              `"${endpoint.label}". Nothing is lost or double-booked, but a day that ` +
              `spans the rename will post as two documents under the two names.`,
          }
        : undefined;

    res.json({
      ...presentEndpoint(current, endpointTotals(companyOf(req))(current.id)),
      ...(renamedAway ? { renamedAway } : {}),
    });
  } catch (error) {
    if (error instanceof EndpointNotVerifiedError) {
      // 409, not 400: the request is well formed and the endpoint exists — it
      // is the endpoint's state that forbids this, and that state is fixable.
      return res.status(409).json({ error: error.message });
    }
    // Also 409, and for the same reason: the name is well formed, another
    // endpoint simply has it.
    if (error instanceof DuplicateLabelError) {
      return res.status(409).json({ error: error.message });
    }
    res.status(400).json({ error: (error as Error).message });
  }
});

api.get("/teams", OPERATOR, (req, res) => {
  res.json(listTeams(companyOf(req)).map(presentTeam));
});

api.get("/teams/:id", OPERATOR, (req, res) => {
  const team = getTeamInCompany(req.params.id, companyOf(req));
  if (!team) return res.status(404).json({ error: "no such team" });
  // listAgentsByTeam needs no company predicate of its own: the team it is
  // given has already been proven to be in this company, and agents.team_id is
  // NOT NULL, so the roster cannot reach outside it.
  res.json({ ...presentTeam(team), agents: listAgentsByTeam(team.id).map(present) });
});

api.patch("/teams/:id", OPERATOR, (req, res) => {
  const team = getTeamInCompany(req.params.id, companyOf(req));
  if (!team) return res.status(404).json({ error: "no such team" });

  try {
    const cap = dollarsToBaseUnits(req.body?.spendCapUsd);
    res.json(presentTeam(setTeamSpendCap(team.id, cap)!));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * Payments held for a human decision, because a ceiling above the agent
 * refused them. Approving does not move money by itself — it grants the agent
 * a one-time, expiring exemption which its next payment attempt redeems.
 *
 * A CLOSED ALLOWLIST, built field by field. Nothing is spread, so a column a
 * later migration adds cannot arrive on this surface by inheritance — the same
 * discipline presentActivityPayment follows, for the same reason.
 *
 * Two fields left on purpose:
 *
 *   resourceUrl  The full paid URL, which can carry a credential in its query
 *                string or its path (`?api_key=…`, `/services/T000/xoxb-…`).
 *                The vendor host is what a person deciding this actually needs
 *                — "who is being paid" — and it is all that goes out. Same
 *                call the CSV export made in 5B-2 and for the same reason.
 *
 *   detail       Free prose. Fuel writes every approval's detail itself today,
 *                unlike a payment's, so this is not a third-party-text leak —
 *                it is a shape problem. The anomaly baseline, threshold and
 *                sample size exist ONLY inside that sentence, in base units,
 *                and a surface rendering it would be publishing an internal
 *                unit and an agent's behavioural baseline as a side effect of
 *                showing an operator a number. Structuring those into columns
 *                is a schema slice; until then the honest answer is that they
 *                are not available, not a string that half looks like data.
 */
function presentApproval(
  request: ApprovalRequestWithContext,
  /**
   * Whether the caller may be told WHO decided it.
   *
   * REQUIRED, NOT DEFAULTED. A default would mean a new call site discloses
   * addresses by forgetting something, and the whole reason this parameter
   * exists is that the previous version did exactly that everywhere.
   */
  opts: { namesDecider: boolean },
) {
  const presented = presentApprovalStatus(request.status);
  return {
    id: request.id,
    agentId: request.agentId,
    agentName: request.agentName,
    teamId: request.teamId,
    teamName: request.teamName,
    // Host only. Never the path, never the query.
    vendor: vendorFromResourceUrl(request.resourceUrl),
    // Strings, always — a JSON number is an IEEE-754 double.
    amount: baseUnitsToDollars(request.amountBaseUnits),
    amountBaseUnits: request.amountBaseUnits.toString(),
    blockedScope: request.blockedScope,
    scopeLabel: presentScope(request.blockedScope),
    status: request.status,
    statusLabel: presented.label,
    statusTone: presented.tone,
    statusMeaning: presented.meaning,
    approvalExpiresAt: request.approvalExpiresAt,
    paymentId: request.paymentId,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt,
    /*
     * WHO DECIDED IT — an address, never the user id.
     *
     * The id answers no question an operator has and would be a second
     * identifier to correlate people by. The address is what they already know
     * each other as, it is scoped to their own company by the join that
     * produces it, and it is the same field the signed-in caller sees for
     * themselves on /auth/me.
     *
     * NULL IS LOAD-BEARING AND IS NOT SOFTENED. Every approval decided before
     * Stage 3 was decided by a shared key and has no answer; presenting "system"
     * or the owner's address would be fabricating an audit trail. A surface that
     * wants words for the blank can say so itself — what crosses the wire is the
     * absence.
     */
    /*
     * WITHHELD FROM A SHARED KEY, and security review is why.
     *
     * The first version of this returned the address to every operator caller —
     * and the legacy key resolves to `operator`. So the credential this whole
     * commit declares untrustworthy to ATTACH a name to a decision could
     * enumerate the address of everybody who has ever made one. That sits badly
     * next to the commit's own argument, and nothing legitimate wants it: the
     * dashboard carries sessions now, and no script reads this field.
     *
     * A key caller therefore sees null here, always. That does overload null —
     * for a key it no longer distinguishes "a key decided this" from "you may
     * not be told" — and the overload is acceptable precisely because both mean
     * the same thing to that caller: no identity is available to you. A signed-in
     * person still gets the two-way reading `status` disambiguates.
     *
     * The real fix is retiring the legacy key, which ADR 0014 names as future
     * work rather than pretending this closes it.
     */
    decidedBy: opts.namesDecider ? request.decidedByEmail : null,
    isDemo: request.isDemo,
  };
}

const APPROVAL_STATUSES: ApprovalStatus[] = [
  "pending",
  "approved",
  "denied",
  "consumed",
  "expired",
];

const APPROVALS_QUERY_KEYS = ["status"] as const;

/**
 * The approvals queue.
 *
 * OPERATOR since 5B-3, and the reasoning is worth keeping because the comment
 * that used to sit here argued the opposite. It said both roles could read
 * this "on purpose: an agent has to be able to see whether its own paused
 * payment was approved before it retries". The need is real. This route was
 * never how it is met:
 *
 *   - The agent credential is SHARED by every agent (src/lib/auth.ts resolves
 *     a role, never an identity), so "its own" is not a question this route can
 *     answer. It returned every approval for every agent in the company to any
 *     holder of a key that lives wherever an agent runs.
 *   - An agent never needed the list anyway. The 202 that holds its payment
 *     hands it `approvalRequestId` directly, so it already knows the one id it
 *     cares about, and GET /approvals/:id — still readable by both roles —
 *     answers exactly that question and nothing else.
 *
 * So the capability survives and the bulk read does not. Same shape of
 * argument the transactions export settled: an agent credential does not get a
 * view of what every other agent has been refused.
 */
api.get("/approvals", OPERATOR, (req, res) => {
  // An unknown parameter is refused, never ignored — a misspelled filter must
  // not return an unfiltered list that looks right.
  for (const key of Object.keys(req.query)) {
    if (!(APPROVALS_QUERY_KEYS as readonly string[]).includes(key)) {
      return res.status(400).json({
        error: `unknown query parameter: ${key}. Allowed: ${APPROVALS_QUERY_KEYS.join(", ")}`,
      });
    }
  }

  const status = req.query.status;
  if (status !== undefined) {
    if (typeof status !== "string" || !APPROVAL_STATUSES.includes(status as ApprovalStatus)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${APPROVAL_STATUSES.join(", ")}` });
    }
  }

  res.json(
    listApprovalRequests({
      companyId: companyOf(req),
      status: status as ApprovalStatus | undefined,
    }).map((row) => presentApproval(row, { namesDecider: sessionOf(req) !== null })),
  );
});

/**
 * One approval, still readable by both roles.
 *
 * This is the agent's retry check, and the only reason the agent credential
 * reads anything here at all. It is a single row by unguessable id rather than
 * a listing, and what comes back is now the same allowlist the operator sees —
 * no vendor path, no query string, no prose.
 *
 * The limitation, stated rather than papered over: because one credential is
 * shared by every agent, Fuel cannot tell whether the caller owns this
 * approval. An agent that learns another agent's id can read it. That is a
 * property of the shared credential, not of this route, and it is fixed by
 * per-agent credentials — see ADR 0009. The allowlist above is what bounds the
 * damage in the meantime.
 */
api.get("/approvals/:id", ANY, (req, res) => {
  const request = getApprovalRequestInCompany(req.params.id, companyOf(req));
  if (!request) return res.status(404).json({ error: "no such approval request" });
  // ANY, so this is the one approval read an AGENT credential can reach. It is
  // a shared machine credential and names nobody, so it is on the wrong side of
  // this line for the same reason the operator key is.
  res.json(presentApproval(request, { namesDecider: sessionOf(req) !== null }));
});

// 409 rather than 200 when the decision changed nothing: a request that was
// already denied, consumed or expired must not report back as freshly
// approved. The guard lives in the UPDATE itself, so this also covers a
// second operator racing the first.
//
// Both decisions re-read through the scoped getter so an id outside this
// company is a 404 before any UPDATE is prepared, and so the response is built
// from the same allowlist as every other approval read.
/**
 * ONE HANDLER FOR BOTH VERBS, for the same reason the data layer has one
 * function: approve and deny now share a precondition, and a refusal that
 * exists in two places is a refusal that will eventually exist in one.
 *
 * THE SHARED KEY LOSES THIS POWER ONCE A COMPANY HAS PEOPLE. That is the point
 * of the whole stage in one rule. Two-party control whose parties are both
 * anonymous is one party — anybody holding FUEL_API_KEY could request a payment
 * with the agent key and approve it with the operator key, and the audit trail
 * would honestly record nobody. `decided_by` on a key-made decision is NULL
 * forever, so allowing it would mean deliberately writing rows we already know
 * we can never answer questions about.
 *
 * IT IS SCOPED TO COMPANIES THAT HAVE ACCOUNTS, not applied everywhere, and
 * that is deliberate rather than timid. A company nobody can sign in to still
 * needs its payments decidable, and the scripts in scripts/ have no browser to
 * sign in from. The refusal turns on the one fact that makes it fair: somebody
 * CAN decide this as themselves.
 *
 * It also un-refuses itself. `activeUserCount` counts accounts that are not
 * disabled, so a company whose every account has been disabled falls back to
 * the key rather than becoming undecidable — the failure mode of a lockout on
 * the approval queue is held payments nobody can release.
 */
function decide(decision: "approve" | "deny") {
  return function handler(req: Request<{ id: string }>, res: Response) {
    const companyId = companyOf(req);
    const request = getApprovalRequestInCompany(req.params.id, companyId);
    if (!request) return res.status(404).json({ error: "no such approval request" });

    let decided;
    try {
      decided = decideRequest({
        id: request.id,
        companyId,
        decision,
        // The ONLY source of the decider's identity. Never a body field, never
        // a header — a self-declared author is not an audit trail.
        decidedBy: userOf(req),
      });
    } catch (error) {
      if (error instanceof SharedKeyCannotDecideError) {
        /*
         * 403 AND NOT 401, because the credential is valid and understood — it
         * simply may not do this. 401 would send an operator to check their key
         * for a problem that is not there.
         *
         * The plan floated a 423-style code to avoid a bare 403 reading as "your
         * key is misconfigured". A 403 with a message that names the reason AND
         * the fix does that job without inventing a use for a WebDAV status, and
         * every other refusal on this router is already a 403. The message is
         * what carries the meaning here, so the message says what to do.
         */
        return res.status(403).json({ error: error.message });
      }
      throw error;
    }

    if (!decided) {
      return res.status(409).json({ error: `cannot ${decision} a request that is ${request.status}` });
    }
    // Always a session by this point — a key cannot reach a successful decision
    // for a company with people, and a company without people has no address to
    // disclose. Written as the same expression as every other call site rather
    // than hardcoded true, so the rule stays in one shape.
    res.json(
      presentApproval(getApprovalRequestInCompany(request.id, companyId)!, {
        namesDecider: sessionOf(req) !== null,
      }),
    );
  };
}

api.post("/approvals/:id/approve", OPERATOR, decide("approve"));
api.post("/approvals/:id/deny", OPERATOR, decide("deny"));

/**
 * The accounting export.
 *
 * OPERATOR, and it is the first read on this router that is not ANY. The other
 * reads are shared for a stated reason — an agent must be able to see whether
 * its own paused payment was approved. Nothing equivalent applies to a file
 * containing every payment every agent in the company has made, and an agent
 * credential lives wherever the agent runs. The narrower role is the default
 * this route earns, not an inconsistency.
 *
 * What is deliberately absent from the output: transaction hashes, wallet
 * addresses, asset and network names, and `payments.detail`. See
 * /docs/decisions/0006. The reconciliation handle is the Fuel payment id,
 * which support can resolve to an on-chain record internally without that
 * record ever reaching an accountant's books.
 */
const EXPORT_INCLUDE = ["ledger", "all"];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/*
 * THESE HEADERS ARE A CONTRACT. 0008's reasoning is that they "leave the system
 * permanently", so anyone with a saved import mapping re-maps a column when one
 * changes. Two change here, both deliberately and both now:
 *
 *   Vendor -> Counterparty, because the other party is a vendor only on the
 *   spend side. A column headed "Vendor" standing over a row whose counterparty
 *   is a paying customer is a false statement in a file an accountant reads.
 *
 *   + Direction, so a reader never has to infer which way money moved from the
 *   sign of an amount or the name of an account.
 *
 * 0012's argument for doing it NOW rather than later: changing a header before
 * any revenue row exists costs a version note; changing it afterwards costs a
 * reconciliation.
 */
const EXPORT_HEADER = [
  "Date",
  "Reference",
  "Agent",
  "Counterparty",
  "Direction",
  "Description",
  "Amount",
  "Currency",
  "Category",
  "Status",
];


/* -------------------------------------------------------------------------
 * The Activity Ledger data contract, and the environment badge's source.
 *
 * Both are operator-only, read-only, and neither calls a provider.
 * ---------------------------------------------------------------------- */

/**
 * Which environment Fuel is running against.
 *
 * A verdict, never the evidence: the constants it reduces are origins, network
 * identifiers and provider base paths, and none of them appears in the
 * response. It makes no network call, no provider call and no database read —
 * see src/lib/environment.ts for why the fail direction is "unknown" rather
 * than "sandbox".
 */
api.get("/environment", OPERATOR, (_req, res) => {
  res.json(describeEnvironment());
});

const ACTIVITY_QUERY_KEYS = [
  "limit",
  "order",
  "cursor",
  "direction",
  "agentId",
  "teamId",
  "status",
  "from",
  "to",
  "demo",
] as const;

const LEDGER_ORDERS: LedgerOrder[] = ["newest", "oldest"];
const LEDGER_DIRECTIONS: LedgerDirection[] = ["spend", "earn"];

/**
 * Every status word the ledger accepts, both directions at once.
 *
 * The two vocabularies OVERLAP ON EXACTLY ONE WORD, `settled`, and there it
 * means the same event on both sides: the money moved. Every other word belongs
 * to one direction only, because receipts.ts reasoned its set from the inbound
 * direction rather than mirroring the outbound one. So one `status` parameter
 * carries either vocabulary without ambiguity — `settled` genuinely asks the
 * question of both arms, and db/ledger.ts splits the rest back apart to decide
 * which arm each word constrains.
 *
 * A Set, because that single overlap would otherwise list `settled` twice in
 * the error message a caller reads. Built from the two exported arrays rather
 * than restated, so a new status in either direction is accepted the moment it
 * exists.
 */
const LEDGER_STATUSES: string[] = [...new Set([...PAYMENT_STATUSES, ...RECEIPT_STATUSES])];

const PAGE_LIMIT_MAX = 100;
const PAGE_LIMIT_DEFAULT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Exactly what toISOString() produces. Nothing else is a valid cursor time. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A real day, not merely a well-shaped one.
 *
 * ISO_DAY matches the shape `\d{4}-\d{2}-\d{2}` and so accepts 2026-13-01 and
 * 2026-02-31. Neither is a date, and neither fails loudly: compared as strings,
 * "2026-13-01" sorts after every real day in 2026, so a typo silently widens a
 * range instead of narrowing it.
 *
 * The round trip is the check. Date parsing rolls an impossible day over into
 * the next month, so a value that survives being parsed and re-formatted is
 * exactly a value that named a real day.
 */
function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Repeatable parameters arrive as a string or an array; normalise both. */
function asList(value: unknown): string[] | null {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return null;
    for (const part of entry.split(",")) {
      const trimmed = part.trim();
      if (trimmed !== "") out.push(trimmed);
    }
  }
  return out;
}

/**
 * Binds a cursor to the exact filters and order it was issued under.
 *
 * Without this, a caller could carry a cursor from one filter set into another
 * and get a page that is neither the first nor a continuation — silently wrong
 * rather than refused. Not a secret and not signed: the cursor is not a
 * capability. Company scoping and the role check run server-side on every
 * request regardless of what a cursor says, so a forged one can at most
 * reposition a caller inside a result set they were already entitled to page
 * through.
 */
function filterFingerprint(applied: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(applied, Object.keys(applied).sort()))
    .digest("hex")
    .slice(0, 16);
}

function encodeCursor(
  row: { createdAt: string; id: string },
  order: LedgerOrder,
  fingerprint: string,
): string {
  return Buffer.from(
    JSON.stringify({ ca: row.createdAt, id: row.id, o: order, f: fingerprint }),
  ).toString("base64url");
}

/**
 * Decodes and fully validates a cursor, or explains why it is refused.
 *
 * Every field is checked for type AND shape before it can reach a query
 * parameter. Well-formed JSON of the wrong shape ({"ca": {}}) would otherwise
 * fail at the driver, which is a 500 wearing a 400's clothes.
 */
function decodeCursor(
  raw: string,
  order: LedgerOrder,
  fingerprint: string,
): { cursor: LedgerCursor } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return { error: "cursor is not valid — start again without one" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: "cursor is not valid — start again without one" };
  }
  const { ca, id, o, f } = parsed as Record<string, unknown>;
  if (typeof ca !== "string" || !ISO_INSTANT.test(ca)) {
    return { error: "cursor is not valid — start again without one" };
  }
  if (typeof id !== "string" || !UUID.test(id)) {
    return { error: "cursor is not valid — start again without one" };
  }
  if (o !== order) {
    return { error: "cursor was issued for a different order — start again without one" };
  }
  if (f !== fingerprint) {
    return { error: "cursor was issued for different filters — start again without one" };
  }
  return { cursor: { createdAt: ca, id } };
}

/**
 * One ledger line, as the Activity Ledger is allowed to see it.
 *
 * TWO PICKS BEHIND ONE SHAPE, dispatched on `direction`. Not one pick over a
 * flattened row: the fields that differ between the directions are the exact
 * fields that must not leak, so a shared builder reading optional properties
 * would be one `??` away from emitting an inbound payer where an outbound
 * vendor belongs. The discriminated union makes reading `resourceUrl` off an
 * earn row a compile error instead of an empty string.
 *
 * Built field by field, never spread from a row. That is the difference
 * between a contract and a leak: a spread would carry `tx_hash`, `detail` and
 * every column a future migration adds, and nobody would notice until the
 * column existed. Closing ADR 0005 took two attempts for exactly this reason —
 * a TypeScript annotation is erased at build time, so it stops a field being
 * RENDERED without stopping it being TRANSMITTED.
 *
 * NO SIGNED AMOUNT FIELD. `direction` plus a magnitude is enough to render a
 * signed figure, and a second money string beside the first is a second
 * representation of one number that can drift from it. The sign is typography
 * and belongs where the typography is.
 */
function presentLedgerRow(row: LedgerRow) {
  return row.direction === "spend" ? presentSpendRow(row) : presentEarnRow(row);
}

/**
 * Money leaving.
 *
 * Absent on purpose:
 *  - txHash — a settlement identifier from the payment rail (0006).
 *  - resourceUrl, and any path or query from it. A paid endpoint can carry a
 *    credential in either. The counterparty host is the safe part and the only
 *    part returned; anyone needing the exact resource opens the payment in Fuel.
 *  - detail — free internal prose, written in BASE UNITS, and on failures it
 *    can contain a string a third-party merchant chose.
 *  - the approval's own detail, which carries an agent's anomaly baseline.
 */
function presentSpendRow(row: LedgerSpendRow) {
  const presented = presentStatus(row.status);
  return {
    id: row.id,
    direction: row.direction,
    agentId: row.agentId,
    agentName: row.agentName,
    teamId: row.teamId,
    teamName: row.teamName,
    /*
     * `counterparty`, not `vendor`, and the rename is the same one 6B-1 already
     * took through the CSV export. A merged ledger has two kinds of other
     * party — a merchant Fuel paid, and an endpoint that was paid — and
     * "vendor" is only true of one of them. One column heading that is right
     * for half its rows is worse than a duller one that is right for all.
     */
    counterparty: vendorFromResourceUrl(row.resourceUrl),
    // Strings, always. A JSON number is an IEEE-754 double, and money that
    // survives a round trip by luck is money that will eventually not.
    amount: baseUnitsToDollars(row.amountBaseUnits),
    amountBaseUnits: row.amountBaseUnits.toString(),
    status: row.status,
    statusLabel: presented.label,
    statusTone: presented.tone,
    statusMeaning: presented.meaning,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
    // Display only. Never the sort key — see listLedgerPage.
    ledgerDate: row.ledgerDate,
    isDemo: row.isDemo,
    refusal: presentRefusal(row.refusalCode),
    approval: row.approval
      ? { id: row.approval.id, scope: row.approval.blockedScope, decidedAt: row.approval.decidedAt }
      : null,
  };
}

/**
 * Money arriving.
 *
 * The same shape, so one table can render both, and every difference between
 * them is a true statement rather than a padding value:
 *
 *  - `isDemo` is always false because no path writes a demo receipt. This is a
 *    fact about the data, not a default — scripts/seed-demo-day.ts marks
 *    payments and approval_requests, and `receipts` has no such column.
 *  - `refusal` is always null because Fuel does not refuse inbound money;
 *    there is no inbound cap, so there is no refusal to report.
 *  - `approval` is always null for the same reason: nothing inbound is held for
 *    a person to approve.
 *
 * Absent on purpose, beyond what db/ledger.ts already declines to load:
 *  - payerAddress and authorizationNonce — a third party's wallet address and
 *    half the replay key. Neither is loaded onto the row at all, so this is the
 *    second lock rather than the only one (0005, 0006).
 *  - endpointId — an internal id with no use on a ledger line. The label is the
 *    part that means something to a reader.
 */
function presentEarnRow(row: LedgerEarnRow) {
  const presented = presentReceiptStatus(row.status);
  return {
    id: row.id,
    direction: row.direction,
    agentId: row.agentId,
    agentName: row.agentName,
    teamId: row.teamId,
    teamName: row.teamName,
    counterparty: row.counterparty,
    amount: baseUnitsToDollars(row.amountBaseUnits),
    amountBaseUnits: row.amountBaseUnits.toString(),
    status: row.status,
    statusLabel: presented.label,
    statusTone: presented.tone,
    statusMeaning: presented.meaning,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
    ledgerDate: row.ledgerDate,
    isDemo: false,
    refusal: null,
    approval: null,
  };
}

/**
 * The Activity Ledger's data source: both directions, one page, one cursor.
 *
 * Read-only and operator-only. Every query is company-scoped in SQL; see
 * listLedgerPage for why that is a seam rather than tenant isolation.
 *
 * NAMED /activity RATHER THAN /payments SINCE 6B-3. It returns receipts too, so
 * the old path had become a route whose name was false about half its rows —
 * the same reason the CSV's "Vendor" column became "Counterparty". The rename
 * moves across the wire, the dashboard and this file in one change, because a
 * compatibility alias would have left the misleading name in service.
 */
api.get("/activity", OPERATOR, (req, res) => {
  // An unknown parameter is refused, never ignored. A caller who misspells a
  // filter should be told, not handed an unfiltered page that looks right.
  for (const key of Object.keys(req.query)) {
    if (!(ACTIVITY_QUERY_KEYS as readonly string[]).includes(key)) {
      return res.status(400).json({
        error: `unknown query parameter: ${key}. Allowed: ${ACTIVITY_QUERY_KEYS.join(", ")}`,
      });
    }
  }

  const { limit, order, cursor, from, to, demo } = req.query;

  let pageLimit = PAGE_LIMIT_DEFAULT;
  if (limit !== undefined) {
    if (typeof limit !== "string" || !/^\d+$/.test(limit)) {
      return res.status(400).json({ error: "limit must be a whole number" });
    }
    pageLimit = Number(limit);
    if (pageLimit < 1 || pageLimit > PAGE_LIMIT_MAX) {
      return res.status(400).json({ error: `limit must be between 1 and ${PAGE_LIMIT_MAX}` });
    }
  }

  let pageOrder: LedgerOrder = "newest";
  if (order !== undefined) {
    if (typeof order !== "string" || !(LEDGER_ORDERS as string[]).includes(order)) {
      return res.status(400).json({ error: `order must be one of: ${LEDGER_ORDERS.join(", ")}` });
    }
    pageOrder = order as LedgerOrder;
  }

  const agentIds = asList(req.query.agentId);
  const teamIds = asList(req.query.teamId);
  const statusList = asList(req.query.status);
  const directionList = asList(req.query.direction);
  if (agentIds === null || teamIds === null || statusList === null || directionList === null) {
    return res
      .status(400)
      .json({ error: "agentId, teamId, status and direction must be text values" });
  }

  const companyId = companyOf(req);

  /*
   * These messages name WHICH value was rejected, but only when the value is a
   * well-formed id. Anything else is described rather than quoted.
   *
   * The reason changed in 5B-5. Until then this error only ever reached a
   * caller reading JSON; now the Activity Ledger renders it beside the filter
   * form, so the string is displayed to a person. React escapes it and the API
   * sends `application/json`, so this was never an injection — but reflecting
   * arbitrary caller text into a rendered page is a habit worth not having, and
   * the diagnostic value is entirely in "which of my ids was wrong", which a
   * UUID still answers.
   */
  for (const id of agentIds) {
    if (!UUID.test(id)) {
      return res.status(400).json({ error: "agentId must be an id" });
    }
    if (!agentInCompany(id, companyId)) {
      return res.status(400).json({ error: `unknown agentId: ${id}` });
    }
  }
  for (const id of teamIds) {
    if (!UUID.test(id)) {
      return res.status(400).json({ error: "teamId must be an id" });
    }
    if (!teamInCompany(id, companyId)) {
      return res.status(400).json({ error: `unknown teamId: ${id}` });
    }
  }
  for (const direction of directionList) {
    if (!(LEDGER_DIRECTIONS as string[]).includes(direction)) {
      return res
        .status(400)
        .json({ error: `direction must be one of: ${LEDGER_DIRECTIONS.join(", ")}` });
    }
  }
  /*
   * Validated against BOTH vocabularies at once, and deliberately not against
   * whichever direction was also asked for.
   *
   * `?direction=earn&status=blocked` names two real things that cannot both be
   * true, and the honest answer is an empty page rather than a 400: the caller
   * asked a well-formed question with no rows in it. Refusing it would make the
   * ledger's filter form behave differently from every other pair of filters,
   * where narrowing to nothing is allowed. db/ledger.ts drops the arm whose
   * half of the split came back empty, which is that empty page.
   */
  for (const status of statusList) {
    if (!LEDGER_STATUSES.includes(status)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${LEDGER_STATUSES.join(", ")}` });
    }
  }

  for (const [name, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !isCalendarDay(value))) {
      return res.status(400).json({ error: `${name} must be a real date in YYYY-MM-DD form` });
    }
  }
  if (typeof from === "string" && typeof to === "string" && from > to) {
    return res.status(400).json({ error: "from must not be later than to" });
  }

  let demoFilter: boolean | undefined;
  if (demo !== undefined) {
    if (demo !== "true" && demo !== "false") {
      return res.status(400).json({ error: "demo must be true or false" });
    }
    demoFilter = demo === "true";
  }

  const applied = {
    direction: directionList,
    agentId: agentIds,
    teamId: teamIds,
    status: statusList,
    from: typeof from === "string" ? from : null,
    to: typeof to === "string" ? to : null,
    demo: demoFilter ?? null,
  };
  const fingerprint = filterFingerprint(applied);

  let pageCursor: LedgerCursor | undefined;
  if (cursor !== undefined) {
    if (typeof cursor !== "string") {
      return res.status(400).json({ error: "cursor must be text" });
    }
    const decoded = decodeCursor(cursor, pageOrder, fingerprint);
    if ("error" in decoded) return res.status(400).json({ error: decoded.error });
    pageCursor = decoded.cursor;
  }

  const { rows, hasMore } = listLedgerPage({
    companyId: companyId,
    limit: pageLimit,
    order: pageOrder,
    cursor: pageCursor,
    directions: directionList as LedgerDirection[],
    agentIds,
    teamIds,
    statuses: statusList,
    from: typeof from === "string" ? from : undefined,
    to: typeof to === "string" ? to : undefined,
    demo: demoFilter,
  });

  const last = rows[rows.length - 1];
  res.json({
    activity: rows.map(presentLedgerRow),
    page: {
      limit: pageLimit,
      order: pageOrder,
      hasMore,
      // No total: counting is a second scan at a different instant, and a
      // total that disagrees with the pages is worse than no total.
      nextCursor: hasMore && last ? encodeCursor(last, pageOrder, fingerprint) : null,
    },
    applied,
    /*
     * What a surface may offer as a filter, in this API's own words.
     *
     * Here rather than restated in the dashboard for the reason 5B-2 gave when
     * it deleted the dashboard's copy of the status table: two copies of a
     * vocabulary drift silently. A filter menu is vocabulary — it decides which
     * distinctions an operator is even offered — so the server names them.
     *
     * ONE status menu spanning both directions, not one per direction. Two
     * menus would offer two different options that issue the identical query —
     * `settled` is in both vocabularies, labelled "Paid" on one side and
     * "Received" on the other — and several more that look unrelated while
     * asking the same question of opposite directions. `ledgerStatusFilters`
     * merges them into one option per question a person would actually ask.
     */
    filters: {
      directions: [
        { value: "spend", label: "Spend" },
        { value: "earn", label: "Earn" },
      ],
      statuses: ledgerStatusFilters(),
    },
  });
});

/* -------------------------------------------------------------------------
 * Receipts — money arriving, and the two states Fuel could not resolve alone.
 *
 * Added in 6B-2. Before it, `src/api.ts` did not import `db/receipts` at all:
 * `listReceiptsForCompany` had zero callers, and the only receipt an operator
 * could see anywhere was one already absorbed into a posted QuickBooks
 * document, which by construction filters to `('settled')`. So the two states
 * that mean something went wrong were the two states nobody could look at.
 * ---------------------------------------------------------------------- */

/**
 * One receipt, as an operator is allowed to see it.
 *
 * BUILT FIELD BY FIELD, NEVER SPREAD FROM A ROW — the same rule
 * `presentActivityPayment` follows, and here it is load-bearing in a way that
 * has already gone wrong once in this codebase. Closing ADR 0005 took two
 * attempts because a TypeScript annotation is erased at build time: it stops a
 * field being RENDERED without stopping it being TRANSMITTED. An allowlist pick
 * at the network edge is the only version of this that is true at runtime.
 *
 * Absent on purpose, and each one is a separate reason:
 *  - payerAddress — a wallet address, and someone else's. 0006 keeps chain
 *    identifiers out of anything a customer surface reads, and this one also
 *    identifies a third party who never agreed to appear in a dashboard.
 *  - authorizationNonce — half the replay key. Publishing it tells a reader
 *    exactly which authorization to look for on-chain, which reconstructs the
 *    payer address even if the address itself is withheld.
 *  - txHash — a settlement identifier from the payment rail (0006), and the
 *    same reconstruction risk.
 *  - detail — free internal prose. On failures it can quote an origin's own
 *    error, which may name the customer's host.
 */
function presentReceipt(receipt: Receipt) {
  const presented = presentReceiptStatus(receipt.status);
  return {
    id: receipt.id,
    agentId: receipt.agentId,
    endpointId: receipt.endpointId,
    // Strings, always — a JSON number is an IEEE-754 double.
    amount: baseUnitsToDollars(receipt.amountBaseUnits),
    amountBaseUnits: receipt.amountBaseUnits.toString(),
    status: receipt.status,
    statusLabel: presented.label,
    statusTone: presented.tone,
    statusMeaning: presented.meaning,
    createdAt: receipt.createdAt,
    settledAt: receipt.settledAt,
  };
}

api.get("/receipts", OPERATOR, (req, res) => {
  for (const key of Object.keys(req.query)) {
    if (key !== "status") {
      return res.status(400).json({ error: `unknown query parameter: ${key}. Allowed: status` });
    }
  }

  const statusList = asList(req.query.status);
  if (statusList === null) {
    return res.status(400).json({ error: "status must be text values" });
  }
  for (const status of statusList) {
    if (!(RECEIPT_STATUSES as string[]).includes(status)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${RECEIPT_STATUSES.join(", ")}` });
    }
  }

  const companyId = companyOf(req);
  const all = listReceiptsForCompany(companyId);
  const wanted = statusList.length === 0
    ? all
    : all.filter((r) => (statusList as ReceiptStatus[]).includes(r.status));

  res.json({
    receipts: wanted.map(presentReceipt),
    /*
     * Surfaced separately, exactly as the QuickBooks route surfaces
     * `needsReconciliation`. An operator should not have to already know that
     * `settle_unknown` exists in order to discover that money may be missing.
     */
    needsAttention: receiptsNeedingAttention(companyId).map(presentReceipt),
    /*
     * The OUTBOUND rows that need the same human, surfaced on the same screen.
     *
     * Put here rather than on GET /api/activity deliberately: this route is
     * "what needs an operator's attention about money", and an unreconciled
     * payment is the outbound half of exactly that question. It also keeps the
     * Activity Ledger's paginated contract untouched, which has its own cursor
     * and filter semantics that an unpaginated side-list would sit awkwardly
     * beside.
     *
     * Same allowlist discipline: id, who, how much, when. No resource URL (it
     * can carry a credential), no tx hash, no detail.
     */
    paymentsNeedingAttention: paymentsNeedingAttention(companyId).map((p) => ({
      id: p.id,
      agentId: p.agentId,
      agentName: p.agentName,
      amount: baseUnitsToDollars(p.amountBaseUnits),
      amountBaseUnits: p.amountBaseUnits.toString(),
      createdAt: p.createdAt,
      statusLabel: presentStatus("unreconciled").label,
      statusMeaning: presentStatus("unreconciled").meaning,
    })),
    applied: { status: statusList },
  });
});

/**
 * Resolves a receipt whose outcome was never confirmed, by asking the chain.
 *
 * THE AUTHORITY IS THE TOKEN CONTRACT, NOT THIS CODE AND NOT THE OPERATOR.
 * EIP-3009 records whether an authorization nonce has been consumed, and a
 * receipt stores both halves of that key because they are its replay key. So
 * the question "did this money actually arrive" has an exact answer that stays
 * answerable at any distance in time — the same property that makes a
 * deterministic DocNumber the right key for reconciling a QuickBooks posting.
 *
 * Fails closed in the only direction that matters: if the chain cannot be
 * reached, the row is left exactly as it was found. A reconciler that read a
 * network timeout as "no money arrived" would take a real settlement out of a
 * customer's books.
 */
api.post("/receipts/:id/reconcile", OPERATOR, async (req, res) => {
  const companyId = companyOf(req);
  // A receipt in another company is indistinguishable from one that does not
  // exist, so this route cannot be used to probe for real ids — and since 7A-1
  // that is a property of the query rather than of a check after it.
  const receipt = getReceiptInCompany(req.params.id, companyId);
  if (!receipt) {
    return res.status(404).json({ error: "no such receipt" });
  }
  if (receipt.status !== "settle_unknown" && receipt.status !== "served_unsettled") {
    return res.status(409).json({
      error: `this receipt is ${receipt.status}, so there is nothing to reconcile`,
    });
  }

  let used: boolean;
  try {
    used = await authorizationUsed({
      payerAddress: receipt.payerAddress,
      authorizationNonce: receipt.authorizationNonce,
    });
  } catch (error) {
    if (error instanceof UnreadableAuthorizationError) {
      // 503, not 500: nothing is wrong with the request and retrying later is
      // the correct response. The row is untouched.
      return res.status(503).json({ error: error.message });
    }
    throw error;
  }

  const changed = reconcileReceipt(
    receipt.id,
    used ? "settled" : "served_unsettled",
    {
      // No tx hash. The contract answers WHETHER the authorization was used,
      // not in which transaction, and inventing a hash we did not observe would
      // put a fabricated settlement reference in an audit record. The detail
      // says how this was established instead.
      txHash: receipt.txHash,
      detail: used
        ? "reconciled: the payment authorization is recorded as used, so the money arrived"
        : "reconciled: the payment authorization was never used, so no money arrived",
    },
  );

  if (!changed) {
    // Lost a race with another reconcile, or the reaper. Either way the row is
    // no longer in a reconcilable state and this attempt must not claim it acted.
    return res.status(409).json({ error: "this receipt was already resolved" });
  }

  res.json(presentReceipt(getReceiptInCompany(receipt.id, companyId)!));
});

/**
 * Records an operator's finding about a payment Fuel could not confirm.
 *
 * DELIBERATELY NOT THE SAME SHAPE AS THE RECEIPT ROUTE ABOVE, and the asymmetry
 * is the honest part rather than an inconsistency. A receipt stores the
 * authorization nonce, so the chain can be asked. A payment stores no nonce and
 * no payee, so it cannot — see `reconcileUnreconciledPayment` for why the
 * available heuristics were rejected. The operator establishes what happened
 * and Fuel records that a person asserted it.
 */
api.post("/payments/:id/reconcile", OPERATOR, (req, res) => {
  const companyId = companyOf(req);
  const status = getPaymentStatusInCompany(req.params.id, companyId);

  if (status === null) return res.status(404).json({ error: "no such payment" });
  if (status !== "unreconciled") {
    return res
      .status(409)
      .json({ error: `this payment is ${status}, so there is nothing to reconcile` });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const { outcome, note, txHash } = body;

  if (outcome !== "settled" && outcome !== "failed") {
    return res.status(400).json({
      error:
        "outcome is required and must be 'settled' (the money moved) or " +
        "'failed' (the authorization died unused, so the budget is released)",
    });
  }
  // REQUIRED, and not a formality. This row is about to change on a human's
  // say-so rather than on anything Fuel observed, and a record that cannot
  // distinguish those two is the failure 0008 named for currency: an
  // assumption stored wearing a verification's clothes.
  if (typeof note !== "string" || note.trim().length < 3) {
    return res.status(400).json({
      error: "note is required — say what established this outcome, since Fuel did not observe it",
    });
  }
  if (txHash !== undefined && txHash !== null && typeof txHash !== "string") {
    return res.status(400).json({ error: "txHash must be a string when given" });
  }
  // A settlement reference on a payment being recorded as never settled is a
  // contradiction, and storing it would leave a row whose own fields disagree.
  if (typeof txHash === "string" && outcome !== "settled") {
    return res
      .status(400)
      .json({ error: "txHash is only meaningful with outcome 'settled'" });
  }

  const result = reconcileUnreconciledPayment({
    paymentId: req.params.id,
    outcome,
    detail: `reconciled by operator: ${note.trim()}`,
    txHash: typeof txHash === "string" ? txHash : null,
  });

  if (!result.ok) {
    /*
     * REFUSED BECAUSE THE MONEY CAN STILL MOVE, which is not something an
     * operator may override. Releasing budget against a live authorization
     * would let the agent spend again while the facilitator can still settle
     * the original — and nothing revisits a `failed` row, so the overspend
     * would be silent and permanent. Wait for the window to close, or record
     * it as settled.
     */
    if (result.refusal === "authorization-still-live") {
      return res.status(409).json({
        // Worded without naming the payment rail: ADR 0006 keeps that
        // vocabulary off anything that leaves Fuel, and an error body leaves
        // Fuel. Caught by verify-api's own no-crypto check on this response.
        error:
          "this payment has not expired yet, so its budget cannot be released — the money can " +
          "still move. Retry once it expires, or record it as settled if it already did.",
        // A timestamp, not an address or a hash: it says when, not what.
        authorizationExpiresAt: new Date((result.validBefore ?? 0) * 1000).toISOString(),
      });
    }
    return res.status(409).json({ error: "this payment was already resolved" });
  }

  res.json({
    id: req.params.id,
    status: outcome,
    statusLabel: presentStatus(outcome).label,
    /*
     * Stated back so a caller cannot mistake "recorded" for "verified", and
     * distinguishing the two things that are NOT the same: a release Fuel
     * checked the expiry for, and one where no expiry was ever recorded
     * (every payment signed before 6B-2). The same distinction 0008 forced for
     * currency — an assumption must never be stored wearing a verification's
     * clothes.
     */
    basis: result.basis,
  });
});

api.get("/exports/transactions.csv", OPERATOR, (req, res) => {
  const { from, to, include } = req.query;

  for (const [name, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !ISO_DAY.test(value))) {
      return res.status(400).json({ error: `${name} must be a date in YYYY-MM-DD form` });
    }
  }

  // Checked as strings, not as Dates: `new Date("2026-02-31")` does not throw,
  // it rolls over to March, and a silently shifted range in an accounting
  // export is a wrong answer that looks like a right one.
  if (typeof from === "string" && typeof to === "string" && from > to) {
    return res.status(400).json({ error: "from must not be later than to" });
  }

  if (include !== undefined && (typeof include !== "string" || !EXPORT_INCLUDE.includes(include))) {
    return res.status(400).json({ error: `include must be one of: ${EXPORT_INCLUDE.join(", ")}` });
  }

  const rows = listPaymentsForExport({
    companyId: companyOf(req),
    from: typeof from === "string" ? from : undefined,
    to: typeof to === "string" ? to : undefined,
    includeAll: include === "all",
  });

  const csv = toCsv(
    EXPORT_HEADER,
    rows.map((row) => [
      ledgerDay(row.ledgerDate),
      row.id,
      row.agentName,
      vendorFromResourceUrl(row.resourceUrl),
      // Constant for now, and honestly so: this file lists `payments`, which
      // are all outbound. Whether receipts join it is a content decision for
      // the Earning slice, not something to pre-empt by shipping a column that
      // implies they already have.
      "Spend",
      descriptionFromResourceUrl(row.resourceUrl),
      // Fixed 6dp. These amounts are genuinely sub-cent, and rounding them to
      // the two places accounting software stores would report every payment
      // in the current data as $0.00.
      baseUnitsToDollarsFixed(row.amountBaseUnits),
      "USD",
      // Reserved. A chart-of-accounts mapping is a per-customer decision that
      // does not exist yet; the column ships empty so the file's shape does not
      // change under anyone when it does.
      "",
      ledgerStatus(row.status),
    ]),
  );

  const filename = `fuel-transactions-${from ?? "start"}-to-${to ?? "today"}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  // The filename is built from values already matched against ISO_DAY, so it
  // cannot carry a quote or newline into this header.
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

/**
 * The accounting rollup: sub-cent payments gathered into postable lines.
 *
 * Why this exists beside the transactions export rather than replacing it:
 * every payment Fuel has made is $0.001, and QuickBooks and Xero store two
 * decimal places, so posting them one-to-one books $0.00 each. The CSV above
 * stays honest by shipping six decimals to a human; these routes do the other
 * half of the job, accumulating spend per (agent, vendor, account) until it
 * crosses a whole cent. See
 * docs/decisions/0007-accounting-integration-posting-model.md.
 *
 * All four routes are OPERATOR, following the precedent the transactions export
 * set: a rollup spans every agent in the company, and nothing justifies handing
 * an agent credential a view of what every other agent has spent. Reads
 * elsewhere are open to both roles because an agent must be able to see whether
 * its own paused payment was approved; there is no equivalent argument here.
 *
 * None of these move money. The engine reads `payments` and writes only its own
 * two tables — it cannot cause a payment, sign anything, or reach Fireblocks.
 */
function presentPostingLine(line: PostingLine) {
  return {
    id: line.id,
    runId: line.runId,
    date: line.postingDay,
    agentId: line.agentId,
    agent: line.agentName,
    counterparty: line.counterparty,
    direction: directionOf(line.ledgerClass),
    account: ledgerAccount(line.ledgerClass),
    amount: baseUnitsToDollars(line.amountBaseUnits),
    sourceCount: line.sourceCount,
    createdAt: line.createdAt,
  };
}

/**
 * Runs the engine. On demand only, and operator-only.
 *
 * Deliberately not wired into the 60s reaper loop that resolves stale payments.
 * That loop repairs state the system already knows is wrong; this one computes
 * new financial values, and a brand-new engine doing that should not advance
 * unattended — an arithmetic mistake compounding silently across unwatched runs
 * is a worse failure than books that are a few hours stale. Every run stays
 * attributable to a deliberate operator action until this has real traffic
 * behind it.
 *
 * Safe to call repeatedly: a run posts only what has cleared a cent since the
 * last one, so a second call immediately after the first creates nothing.
 */
api.post("/postings/run", OPERATOR, (req, res) => {
  /*
   * THE CALLER'S COMPANY, AND ONLY IT. Until 7A-3 this ran every company's
   * books in one transaction, so pressing the button here created other
   * tenants' ledger lines and a failure in their books failed this request. The
   * 7A-1 audit stopped the response from REPORTING other companies' totals; the
   * run itself is now scoped, so there is no one else's share to withhold.
   *
   * Reported rather than merely counted: an operator who sees "0 lines" needs
   * to know whether that means nothing was owed or that everything owed is
   * still under a cent, and those call for different reactions.
   */
  const result = runPosting(companyOf(req));
  res.json({
    runId: result.runId,
    linesCreated: result.linesCreated,
    posted: baseUnitsToDollars(result.baseUnitsPosted),
    bucketsCarried: result.bucketsCarried,
  });
});

/**
 * Posted lines, and what has not cleared yet.
 *
 * The carried figure is included because it is the number most likely to be
 * misread as an error: a vendor whose payments all sit under a cent shows no
 * posted lines at all, and without seeing the residual an operator would
 * reasonably conclude the export was broken rather than waiting.
 */
api.get("/postings", OPERATOR, (req, res) => {
  const { from, to } = req.query;

  for (const [name, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !ISO_DAY.test(value))) {
      return res.status(400).json({ error: `${name} must be a date in YYYY-MM-DD form` });
    }
  }

  if (typeof from === "string" && typeof to === "string" && from > to) {
    return res.status(400).json({ error: "from must not be later than to" });
  }

  /*
   * COMPANY-SCOPED SINCE 7A-1. Both of these swept every company until then,
   * and the residual buckets below were the worse of the two: no date range
   * narrows them, so another tenant's agent name and counterparty host sat in
   * `notYetPosted` on every call to this route. scripts/verify-api.ts now
   * asserts against exactly that, using the second company the suite has seeded
   * since 5B-3 — the leak was live in the test fixture and nothing looked.
   */
  const scope = companyOf(req);
  const lines = listPostingLines({
    companyId: scope,
    from: typeof from === "string" ? from : undefined,
    to: typeof to === "string" ? to : undefined,
  });

  // Not filtered by the date range: a residual is a present-tense fact about
  // what has not been posted, not something that happened on a day.
  const carried = computeBuckets(scope);

  res.json({
    lines: lines.map(presentPostingLine),
    posted: baseUnitsToDollars(lines.reduce((sum, line) => sum + line.amountBaseUnits, 0n)),
    notYetPosted: {
      total: baseUnitsToDollars(carried.reduce((sum, bucket) => sum + bucket.residual, 0n)),
      buckets: carried.map((bucket) => ({
        agent: bucket.agentName,
        counterparty: bucket.counterparty,
        direction: directionOf(bucket.ledgerClass),
        account: ledgerAccount(bucket.ledgerClass),
        amount: baseUnitsToDollars(bucket.residual),
        sourceCount: bucket.candidates.length,
      })),
    },
  });
});

/**
 * One line, resolved into the payments beneath it and the decisions that
 * authorized them.
 *
 * This is the route that makes the rollup a ledger rather than a total. A
 * posted $0.03 is otherwise an assertion; here it resolves to the exact
 * payments, each to the agent that made it, and each — where one was needed —
 * to the named, single-use approval a human granted and when they granted it.
 * A billing pipeline reconciling charges after the fact cannot reconstruct that
 * last part, because it never saw the decision.
 */
api.get("/postings/:id", OPERATOR, (req, res) => {
  // Scoped in the query, so a line in another company is indistinguishable from
  // one that does not exist — the same property `getAgentInCompany` gives, and
  // the reason this route needs no separate ownership branch.
  const detail = drillDown(req.params.id, companyOf(req));
  if (!detail) return res.status(404).json({ error: "no such posting line" });

  res.json({
    ...presentPostingLine(detail),
    constituents: detail.constituents.map((c) => ({
      sourceId: c.sourceId,
      sourceKind: c.sourceKind,
      agent: c.agentName,
      // Both are shown because they differ whenever a payment is split across
      // two lines, and a reader comparing the line total against the payments
      // beneath it needs to know which number they are looking at.
      amount: baseUnitsToDollars(c.amountBaseUnits),
      appliedToThisLine: baseUnitsToDollars(c.absorbedBaseUnits),
      date: c.ledgerDate,
      status: ledgerStatusFor(c.sourceKind, c.status),
      // null means the payment fit inside every cap — itself an authorization
      // decision, just not one that needed a human.
      authorizedBy: c.authorizedBy,
    })),
  });
});

/**
 * The QuickBooks Online integration.
 *
 * Operator-only throughout, for the same reason the exports are: this reaches
 * an external accounting system holding every agent's spend, and nothing
 * justifies handing an agent credential the ability to connect, configure or
 * post to it.
 *
 * The OAuth CALLBACK is not here — it lives in src/server.ts, mounted outside
 * the /api router, because a browser redirect arriving from Intuit carries no
 * bearer token and so cannot pass `authenticate`.
 *
 * Nothing in this file posts to QuickBooks on a timer. Posting is an explicit
 * operator action, always.
 */
function presentQboStatus(companyId: string) {
  const connection = getConnection(companyId);
  const config = getConfig(companyId);
  // The account ids are all set, but were read from different books than the
  // ones connected now (or from books Fuel cannot name). Preview refuses in
  // this state, so status must not claim it is ready. 7A-3.
  const accountsForOtherBooks =
    connection !== null &&
    missingAccounts(config).length === 0 &&
    config.accountsRealmId !== connection.realmId;

  return {
    // Never a token, an encrypted blob, or any prefix of either — see the
    // reasoning on redactSecret in src/lib/secrets.ts.
    connected: connection !== null,
    environment: "sandbox" as const,
    realmId: connection?.realmId ?? null,
    connectedAt: connection?.connectedAt ?? null,
    accessExpiresAt: connection?.accessExpiresAt ?? null,
    refreshExpiresAt: connection?.refreshExpiresAt ?? null,
    config: {
      expenseAccountId: config.expenseAccountId,
      suspenseAccountId: config.suspenseAccountId,
      contraAccountId: config.contraAccountId,
      contraAccountKind: config.contraAccountKind,
      rollupGrain: config.rollupGrain,
    },
    // The currency claim, always carrying HOW Fuel knows it. `verified` is
    // reserved for a reading of QuickBooks' own Preferences; an unchecked
    // company reports null rather than a hopeful "USD". A caller can therefore
    // never mistake an assumption for a verification. See ADR 0008.
    accountingCurrency: {
      currency: config.accountingCurrency,
      source: config.currencySource,
      checkedAt: config.currencyCheckedAt,
      verified: config.currencySource === "quickbooks_preferences" && config.accountingCurrency === "USD",
    },
    // Surfaced rather than left for a failed post to reveal: an operator
    // setting this up needs to know what is still missing before they try.
    readyToPost:
      connection !== null &&
      missingAccounts(config).length === 0 &&
      !accountsForOtherBooks &&
      currencyBlocker(config) === null,
    missing:
      connection === null
        ? ["connection"]
        : [
            ...missingAccounts(config),
            ...(accountsForOtherBooks ? ["account setup for the connected QuickBooks company"] : []),
            ...(currencyBlocker(config) ? ["USD verification"] : []),
          ],
    /*
     * REVENUE READINESS, REPORTED SEPARATELY FROM SPEND READINESS.
     *
     * The income account is deliberately absent from `missing`, because adding
     * it would have turned the earning side into an immediate outage for every
     * company connected before it existed — nothing would post until someone
     * re-ran account setup. 0012's answer was to degrade rather than stop:
     * spend keeps posting and revenue waits.
     *
     * That answer is only honest if a surface can SAY so, and until 6B-3
     * nothing carried it. A company with no income account was
     * indistinguishable from one with nothing to post, so the Accounting page
     * could offer an operator a revenue preview that was always going to
     * refuse. Now it can say "spend is posting, revenue is waiting on one
     * account" — which is the true statement 0012 assumed someone would make.
     */
    readyToPostRevenue:
      connection !== null &&
      missingAccounts(config).length === 0 &&
      !accountsForOtherBooks &&
      missingRevenueAccounts(config).length === 0 &&
      currencyBlocker(config) === null,
    missingForRevenue:
      connection === null ? ["connection"] : missingRevenueAccounts(config),
  };
}

api.get("/integrations/quickbooks/status", OPERATOR, (req, res) => {
  res.json(presentQboStatus(companyOf(req)));
});

/**
 * Begins the OAuth handshake.
 *
 * Returns the consent URL rather than redirecting, because the caller is an
 * API client or the dashboard, not the browser being sent to Intuit. The
 * operator opens it themselves.
 *
 * A SIGNED-IN PERSON ONLY (7A-3 item 4, ADR 0017). The link records who
 * started it, and the callback lets only that person, in that browser, finish
 * it. Otherwise one company's operator could hand the link to someone at
 * another company and receive that person's books. A shared key names nobody,
 * so a link it started could be finished by anybody. It is refused, the same
 * stance requireOwner takes. The dashboard always calls this with the viewer's
 * own session.
 */
api.post("/integrations/quickbooks/connect", OPERATOR, (req, res) => {
  const companyId = companyOf(req);
  const userId = userOf(req);
  if (userId === null) {
    return res.status(403).json({
      error: "connecting QuickBooks must be started by a signed-in person; a shared API key cannot start it",
    });
  }
  const state = newState();
  createOAuthState({ state, companyId, userId });

  res.json({
    authorizeUrl: authorizeUrl(state),
    expiresInSeconds: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    environment: "sandbox",
  });
});

/** Forgets the connection and its tokens. Posted entries are untouched. */
api.post("/integrations/quickbooks/disconnect", OPERATOR, (req, res) => {
  let removed: boolean;
  try {
    removed = deleteConnection(companyOf(req));
  } catch (error) {
    // Refused while postings are unresolved: reconciling them needs this
    // connection, and a disconnect would let the next connect go anywhere.
    if (error instanceof UnresolvedPostingsError) {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
  if (!removed) return res.status(409).json({ error: "not connected" });
  res.json({ disconnected: true });
});

const CONTRA_KINDS = ["prepaid_asset", "cash", "clearing"];
const ROLLUP_GRAINS = ["daily", "counterparty_day"];

/**
 * Sets the account ids and posting preferences.
 *
 * Account ids are supplied, never discovered: Fuel does not invent a chart of
 * accounts for a customer, and it does not create QuickBooks Classes per agent
 * or Vendors per merchant host. Agent and merchant attribution live in Fuel,
 * which is the only place with the full picture. See ADR 0008.
 */
api.patch("/integrations/quickbooks/config", OPERATOR, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Parameters<typeof saveConfig>[1] = {};

  for (const field of ["expenseAccountId", "suspenseAccountId", "contraAccountId"] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") {
      return res.status(400).json({ error: `${field} must be a string or null` });
    }
    patch[field] = value;
  }

  if (body.contraAccountKind !== undefined) {
    if (typeof body.contraAccountKind !== "string" || !CONTRA_KINDS.includes(body.contraAccountKind)) {
      return res
        .status(400)
        .json({ error: `contraAccountKind must be one of: ${CONTRA_KINDS.join(", ")}` });
    }
    patch.contraAccountKind = body.contraAccountKind as ContraAccountKind;
  }

  if (body.rollupGrain !== undefined) {
    if (typeof body.rollupGrain !== "string" || !ROLLUP_GRAINS.includes(body.rollupGrain)) {
      return res.status(400).json({ error: `rollupGrain must be one of: ${ROLLUP_GRAINS.join(", ")}` });
    }
    patch.rollupGrain = body.rollupGrain as RollupGrain;
  }

  // Account ids typed in here are stamped with the books connected now, and
  // refused where that stamp would vouch for ids nobody read there. The rule
  // and its reasoning live in saveConfigByHand, inside one write transaction.
  const companyId = companyOf(req);
  try {
    saveConfigByHand(companyId, patch);
  } catch (error) {
    if (error instanceof AccountsNeedConnectionError || error instanceof AccountsFromOtherBooksError) {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
  res.json(presentQboStatus(companyId));
});

/**
 * Creates the three accounts, on an explicit operator action only.
 *
 * Never triggered implicitly by a post that finds something missing: creating
 * an account edits a customer's chart of accounts, which is their document.
 * Also checks the company profile, so a mismatch is found during setup rather
 * than half way through building a document.
 */
api.post("/integrations/quickbooks/setup-accounts", OPERATOR, async (req, res) => {
  const companyId = companyOf(req);
  try {
    // Before anything is created. Refusing after the accounts exist would
    // leave a customer's chart of accounts edited for a company Fuel then
    // declines to post to. Throws UnsupportedCurrencyError -> 422, and records
    // the verified currency so preview and post can gate on it without a
    // network call. See ADR 0008.
    //
    // ONE SET OF BOOKS FOR ALL THREE STEPS (7A-3). The realm is read once and
    // every request below is pinned to it, so the currency recorded, the
    // company named in the reply and the four account ids saved cannot come
    // from different companies if a reconnect lands part-way through.
    const realmId = realmFor(companyId);
    const currency = await verifyAccountingCurrency(companyId, realmId);
    const profile = await companyProfile(companyId, realmId);
    const result = await setUpAccounts(companyId, realmId);
    saveConfig(companyId, {
      expenseAccountId: result.expenseAccountId,
      suspenseAccountId: result.suspenseAccountId,
      contraAccountId: result.contraAccountId,
      revenueAccountId: result.revenueAccountId,
      // All four ids replaced at once, with the books they were read from.
      accountsRealmId: result.realmId,
    });
    res.json({
      quickBooksCompany: profile.name,
      homeCurrency: currency.currency,
      currencySource: currency.source,
      currencyCheckedAt: currency.checkedAt,
      multiCurrencyEnabled: profile.multiCurrencyEnabled,
      created: result.created,
      reused: result.reused,
      ...presentQboStatus(companyId),
    });
  } catch (error) {
    return respondQboError(res, error);
  }
});

/**
 * Translates an integration failure into a response.
 *
 * Intuit's own prose is surfaced for a validation problem, because that is the
 * operator's to fix. Nothing about the request is ever included: it carries a
 * bearer token for a customer's books.
 */
function respondQboError(res: Response, error: unknown) {
  if (error instanceof NotConnectedError) {
    return res.status(409).json({ error: error.message });
  }
  if (
    error instanceof NotConfiguredError ||
    error instanceof NothingToPostError ||
    error instanceof AccountsFromOtherBooksError
  ) {
    return res.status(409).json({ error: error.message });
  }
  if (error instanceof DocumentInFlightError) {
    // Refused before anything reached Intuit. The other attempt has to settle
    // first; sending this one could only end in adopting its document.
    return res.status(409).json({ error: error.message });
  }
  if (error instanceof RealmMismatchError) {
    // Refused before anything was sent. 409: the request was well formed; the
    // connection points at different books from the ones this belongs to.
    return res.status(409).json({ error: error.message });
  }
  if (error instanceof DraftNotPostableError) {
    // 409, not 400: the request was well formed and was correct when it was
    // made. The world moved, and the fix is to preview again.
    return res.status(409).json({ error: error.message });
  }
  if (error instanceof UnsupportedCurrencyError || error instanceof CurrencyScopeError) {
    // 422, not 400: the request is well formed and the operator cannot fix it
    // by sending different fields. The company is out of this slice's scope.
    return res.status(422).json({ error: error.message });
  }
  if (error instanceof AnsweredButNotRecordedError) {
    // Fuel's fault, not the request's and not QuickBooks'. Its message names no
    // cause beyond that; the detail was logged where it happened.
    return res.status(500).json({ error: error.message });
  }
  if (error instanceof QboApiError) {
    console.error(`[quickbooks] ${error.status} ${error.code ?? ""}: ${error.message}`);
    return res.status(502).json({
      error: error.message,
      quickBooksCode: error.code,
      // Tells an operator whether retrying is safe or whether the posting needs
      // reconciling first — the difference between "nothing happened" and "we
      // do not know".
      mayHavePosted: !error.definitelyNoEffect,
    });
  }
  console.error(`[quickbooks] unexpected: ${(error as Error).message}`);
  return res.status(500).json({ error: "QuickBooks request failed" });
}

const ISO_DAY_QBO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Re-reads the company's accounting currency from QuickBooks.
 *
 * Separate from account setup because the two answer different questions and
 * age differently: the accounts are created once, but "is this still a USD
 * company?" is a fact about someone else's system that can change. This is the
 * way to re-answer it without touching a chart of accounts.
 */
api.post("/integrations/quickbooks/verify-currency", OPERATOR, async (req, res) => {
  const companyId = companyOf(req);
  try {
    const currency = await verifyAccountingCurrency(companyId);
    res.json({ ...currency, ...presentQboStatus(companyId) });
  } catch (error) {
    return respondQboError(res, error);
  }
});

/**
 * Builds and freezes a draft. SENDS NOTHING to QuickBooks.
 *
 * A separate route from `post` rather than a `dryRun` flag, so that "did that
 * reach Intuit?" is never a question about which parameters were passed.
 */
api.post("/integrations/quickbooks/preview", OPERATOR, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // `counterparty` was `vendorHost`, renamed with the grain and the column.
  //
  // A SCOPED CLAIM, AND THE SCOPE MATTERS. The dashboard never sent `grain` or
  // `vendorHost` — checked. An earlier version of this comment said so and
  // stopped there, right above the code that added a required `direction`,
  // which the dashboard DOES have to send. It read as reassurance about the
  // whole contract change and it was reassurance about two thirds of it: the
  // Preview button 400d on every click until a review caught it.
  //
  // So: renaming these two broke no consumer. Requiring `direction` broke one,
  // and verify-api now checks the request body the component actually sends,
  // not only the response shape it declares.
  const { day, counterparty, direction } = body;

  if (typeof day !== "string" || !ISO_DAY_QBO.test(day)) {
    return res.status(400).json({ error: "day must be a date in YYYY-MM-DD form" });
  }
  if (counterparty !== undefined && counterparty !== null && typeof counterparty !== "string") {
    return res.status(400).json({ error: "counterparty must be a string" });
  }
  // REQUIRED, WITH NO DEFAULT, and that is the contract decision rather than an
  // oversight. Defaulting to "spend" would make every un-updated caller silently
  // keep working while never being able to post revenue at all — a integration
  // that looks fine and books half the money. An explicit 400 says what changed.
  if (!POSTING_DIRECTIONS.includes(direction as PostingDirection)) {
    return res.status(400).json({
      error: `direction is required and must be one of: ${POSTING_DIRECTIONS.join(", ")}`,
    });
  }

  try {
    const draft = preview(companyOf(req), {
      direction: direction as PostingDirection,
      postingDay: day,
      counterparty: typeof counterparty === "string" ? counterparty : null,
    });
    res.status(201).json(presentDraft(draft));
  } catch (error) {
    return respondQboError(res, error);
  }
});

function presentDraft(draft: PostingDraft) {
  return {
    draftId: draft.id,
    status: draft.status,
    grain: draft.grain,
    day: draft.postingDay,
    direction: draft.direction,
    counterparty: draft.counterparty,
    docNumber: draft.docNumber,
    payloadHash: draft.payloadHash,
    lineCount: draft.lineIds.length,
    lineIds: draft.lineIds,
    // The exact bytes that would be sent. Shown in full because the whole point
    // of a preview is that an operator sees the document, not a summary of it.
    payload: draft.payload,
    createdAt: draft.createdAt,
    readiness: draftReadiness(draft),
  };
}

api.get("/integrations/quickbooks/drafts", OPERATOR, (req, res) => {
  res.json({ drafts: listDrafts(companyOf(req)).map(presentDraft) });
});

/**
 * Posts one reviewed draft.
 *
 * Takes a draft id, never a scope: the thing that gets posted is the thing that
 * was reviewed, and re-deriving it here would quietly break that promise.
 */
api.post("/integrations/quickbooks/post", OPERATOR, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.draftId !== "string") {
    return res.status(400).json({ error: "draftId is required" });
  }

  const companyId = companyOf(req);
  const draft = getDraftInCompany(body.draftId, companyId);
  if (!draft) {
    return res.status(404).json({ error: "no such draft" });
  }

  try {
    const posting = await post(companyId, draft);
    res.json(presentPosting(posting, sessionOf(req) !== null));
  } catch (error) {
    return respondQboError(res, error);
  }
});

/**
 * A posting as a caller sees it.
 *
 * `namesPeople`: whether this caller may be told WHO wrote a posting off. The
 * rule approvals follow for `decidedBy` (ADR 0014's review finding): a signed-in
 * person may; a shared key sees null, always, because the credential that names
 * nobody should not be able to enumerate everybody who has acted.
 *
 * The write-off's EVIDENCE is not presented at all. It is whatever error Fuel
 * met when it tried QuickBooks -- sometimes Intuit's own prose, whose content
 * Fuel does not control and cannot promise names no realm (ADR 0010). It stays
 * in the database for audit.
 */
function presentPosting(posting: QboPosting, namesPeople: boolean) {
  return {
    postingId: posting.id,
    status: posting.status,
    docNumber: posting.docNumber,
    quickBooksId: posting.qboEntityId,
    draftId: posting.draftId,
    correctsPostingId: posting.correctsPostingId,
    postedPayloadHash: posting.postedPayloadHash,
    detail: posting.detail,
    createdAt: posting.createdAt,
    postedAt: posting.postedAt,
    // Written off by an owner because its books could not be asked (7A-3 item
    // 3). The status above is still "pending": that stays the true statement.
    abandonedAt: posting.abandonedAt,
    abandonReason: posting.abandonReason,
    abandonedBy:
      namesPeople && posting.abandonedBy !== null
        ? (getUserInCompany(posting.abandonedBy, posting.companyId)?.email ?? null)
        : null,
  };
}

api.get("/integrations/quickbooks/postings", OPERATOR, (req, res) => {
  const companyId = companyOf(req);
  const namesPeople = sessionOf(req) !== null;
  res.json({
    postings: listPostings(companyId).map((p) => presentPosting(p, namesPeople)),
    // Surfaced separately because these are the ones that need a human: each
    // may or may not have created a document, and only reconciling tells.
    // Written-off postings are not among them -- see pendingPostings.
    needsReconciliation: pendingPostings(companyId).map((p) => presentPosting(p, namesPeople)),
  });
});

/**
 * Resolves an attempt whose outcome was never confirmed, by asking QuickBooks
 * whether the document exists. The only safe way out of `pending`.
 */
api.post("/integrations/quickbooks/postings/:id/reconcile", OPERATOR, async (req, res) => {
  const companyId = companyOf(req);
  const attempt = getPostingInCompany(req.params.id, companyId);
  if (!attempt) {
    return res.status(404).json({ error: "no such posting" });
  }
  if (attempt.status !== "pending") {
    return res.status(409).json({ error: `posting is ${attempt.status}, nothing to reconcile` });
  }

  try {
    res.json(presentPosting(await reconcilePending(companyId, attempt), sessionOf(req) !== null));
  } catch (error) {
    return respondQboError(res, error);
  }
});

/**
 * Reverses a posted entry with a NEW, linked entry.
 *
 * There is deliberately no route that edits or deletes a posted document. A
 * correction is an equal and opposite entry that leaves both visible, which is
 * what makes the history auditable rather than merely current.
 */
api.post("/integrations/quickbooks/postings/:id/reverse", OPERATOR, async (req, res) => {
  const companyId = companyOf(req);
  const original = getPostingInCompany(req.params.id, companyId);
  if (!original) {
    return res.status(404).json({ error: "no such posting" });
  }
  if (original.status !== "posted") {
    return res.status(409).json({ error: `posting is ${original.status}, so there is nothing to reverse` });
  }

  try {
    const posting = await postReversal(companyId, original);
    res.status(201).json(presentPosting(posting, sessionOf(req) !== null));
  } catch (error) {
    return respondQboError(res, error);
  }
});

/**
 * Writes off a pending posting whose QuickBooks books cannot be asked about it.
 * OWNER ONLY, and never a shared key. 7A-3 item 3, ADR 0016.
 *
 * The way out for a company whose books are gone for good. While a posting is
 * pending the company cannot disconnect or move to other books, and only a
 * reconcile clears pending -- which needs those books. A write-off removes this
 * one posting from that block. It does NOT release its lines: the document may
 * already be in the lost books, so its spend is never re-posted automatically.
 *
 * OWNER, NOT OPERATOR. This is money policy, not routine work -- 7A-1 recorded
 * that it needed "a role above a plain operator". A shared key names nobody and
 * is refused outright (requireOwner), so every write-off has a person on it.
 *
 * TWO THINGS THE OWNER MUST SUPPLY. A reason, which is kept. And the document
 * number, typed back: the owner has to have looked at exactly what they are
 * writing off, not clicked the wrong row.
 *
 * QuickBooks is tried first, inside writeOffPending. If it answers, that
 * answer stands and nothing is written off.
 */
api.post("/integrations/quickbooks/postings/:id/abandon", OWNER, async (req, res) => {
  const companyId = companyOf(req);
  const userId = userOf(req);
  // requireOwner admits only a signed-in person; this can only fire if that
  // guard is ever removed, and then it refuses rather than writing off
  // anonymously.
  if (userId === null) {
    return res.status(403).json({ error: "a write-off needs a signed-in owner" });
  }
  const attempt = getPostingInCompany(req.params.id, companyId);
  if (!attempt) {
    return res.status(404).json({ error: "no such posting" });
  }
  if (attempt.status !== "pending") {
    return res
      .status(409)
      .json({ error: `posting is ${attempt.status}; only a posting whose outcome is unknown can be written off` });
  }
  if (attempt.abandonedAt !== null) {
    return res.status(409).json({ error: "this posting has already been written off" });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10 || reason.length > 500) {
    return res.status(400).json({
      error: "a reason of 10 to 500 characters is required: it is kept with the write-off",
    });
  }
  if (typeof body.confirmDocNumber !== "string" || body.confirmDocNumber.trim() !== attempt.docNumber) {
    return res.status(400).json({
      error: "type this posting's document number into confirmDocNumber to confirm which one you mean",
    });
  }

  try {
    const posting = await writeOffPending(companyId, attempt, { userId, reason });
    res.json(presentPosting(posting, true));
  } catch (error) {
    if (error instanceof QuickBooksAnsweredError) {
      return res.status(409).json({ error: error.message, posting: presentPosting(error.posting, true) });
    }
    if (error instanceof WriteOffRefusedError) {
      return res.status(409).json({ error: error.message });
    }
    return respondQboError(res, error);
  }
});

/**
 * The whole chain, from a QuickBooks document back to the decisions beneath it.
 *
 * This is the route the product argument rests on. An accounting integration
 * that only pushes totals is a rollup tool; what makes this different is that
 * every dollar in a posted entry resolves to the payments that made it, and
 * each of those to the authorisation that allowed it — a cap it fit inside, or
 * a named approval a human granted at a particular moment. A billing pipeline
 * reconciling charges after the fact cannot reconstruct that, because it never
 * saw the decision.
 *
 * QuickBooks doc -> posting -> draft -> posting lines -> payments -> approval.
 */
/**
 * The drill-down, by posting id OR by draft id.
 *
 * A DRAFT MUST BE TRACEABLE TOO. Provenance that only appears after posting is
 * provenance arriving too late to inform the decision — the operator's review
 * is the one human control on this path, and "what is this 0.09 made of?" is
 * the question it exists to answer. The dashboard's drill-down on a preview
 * passed a draft id here and got a silent 404, so the reviewable half of the
 * chain was the half that did not work.
 *
 * A draft has no posted document, so `posting` is null and `document` is the
 * frozen payload. Everything below that is identical, because it is the same
 * chain either way: lines -> export_postings -> payments -> approvals.
 */
api.get("/integrations/quickbooks/postings/:id/trace", OPERATOR, (req, res) => {
  const companyId = companyOf(req);
  /*
   * Both lookups scoped, so an id belonging to another company falls through
   * exactly as an unknown id does. That changes one observable thing, on
   * purpose: another company's POSTING id used to answer "no such posting",
   * while an unknown one answered "no such posting or draft" — two messages
   * that told a caller whether the id existed somewhere. Now both reach the
   * same 404.
   */
  const posting = getPostingInCompany(req.params.id, companyId);
  const draft = posting
    ? getDraftInCompany(posting.draftId, companyId)
    : getDraftInCompany(req.params.id, companyId);
  if (!draft) {
    return res.status(404).json({ error: "no such posting or draft" });
  }

  // The QuickBooks account each line landed in, so a reader can join a ledger
  // row to its provenance by id rather than by matching label text — which
  // looks like it works right up until two accounts share a first word.
  const config = getConfig(companyId);
  const accountIdFor: Record<LedgerClass, string | null> = {
    expense: config.expenseAccountId,
    suspense: config.suspenseAccountId,
    revenue: config.revenueAccountId,
  };

  const lines = draft.lineIds.map((lineId) => {
    // The draft was already proven to belong to this company above, so this was
    // transitively safe. Scoped anyway: it costs one already-joined predicate,
    // and it means the safety is a property of the call rather than of the
    // twelve lines above it staying in that order.
    const detail = drillDown(lineId, companyId);
    if (!detail) return null;
    return {
      lineId: detail.id,
      agent: detail.agentName,
      counterparty: detail.counterparty,
      // So a renderer can label its columns without inferring direction from
      // the account name. A revenue line's sources are receipts, and a column
      // headed "Payment" over one is the CSV's old "Vendor" problem in HTML.
      direction: directionOf(detail.ledgerClass),
      account: ledgerAccount(detail.ledgerClass),
      accountId: accountIdFor[detail.ledgerClass],
      ledgerClass: detail.ledgerClass,
      amount: baseUnitsToDollars(detail.amountBaseUnits),
      day: detail.postingDay,
      sources: detail.constituents.map((c) => ({
        sourceId: c.sourceId,
        sourceKind: c.sourceKind,
        agent: c.agentName,
        amount: baseUnitsToDollars(c.amountBaseUnits),
        appliedToThisLine: baseUnitsToDollars(c.absorbedBaseUnits),
        date: c.ledgerDate,
        status: ledgerStatusFor(c.sourceKind, c.status),
        // null means it fit inside every cap — itself an authorisation
        // decision, just not one that needed a human.
        authorizedBy: c.authorizedBy,
      })),
    };
  });

  const present = lines.filter((l): l is NonNullable<typeof l> => l !== null);
  const sources = present.flatMap((l) => l.sources);

  res.json({
    posting: posting ? presentPosting(posting, sessionOf(req) !== null) : null,
    document: posting?.postedPayload ?? draft.payload,
    reverses:
      posting?.correctsPostingId != null
        ? (() => {
            // A correction and its original always share a company; scoped
            // anyway, and absent rather than a crash if that ever stops holding.
            const original = getPostingInCompany(posting.correctsPostingId, companyId);
            return original ? presentPosting(original, sessionOf(req) !== null) : null;
          })()
        : null,
    summary: {
      lines: present.length,
      sources: sources.length,
      // Only a payment can carry one. A receipt never needed authorising:
      // money arriving was nobody at Fuel's decision, so this counts what it
      // has always counted and the denominator simply grew.
      requiredHumanApproval: sources.filter((s) => s.authorizedBy !== null).length,
      agents: [...new Set(present.map((l) => l.agent))].length,
      counterparties: [...new Set(present.map((l) => l.counterparty))].length,
    },
    lines: present,
  });
});

/*
 * The same two changes as above, plus one this file needs on its own.
 *
 * Payments -> Sources. The column counts what a line was made of, and for a
 * revenue line that is receipts, not payments. Leaving the old header would put
 * a number of receipts under a column headed "Payments" -- the same false
 * statement as "Vendor", one column over.
 */
const POSTINGS_HEADER = [
  "Date",
  "Reference",
  "Agent",
  "Counterparty",
  "Direction",
  "Account",
  "Amount",
  "Currency",
  "Sources",
];

/**
 * The rollup as a file an accountant can actually post from.
 *
 * Unlike transactions.csv this carries two-decimal amounts, because every row
 * is a whole number of cents by construction — that is the entire point of the
 * rollup. Six decimals here would imply a precision the accounting system
 * cannot store and invite someone to re-round it.
 */
api.get("/exports/postings.csv", OPERATOR, (req, res) => {
  const { from, to } = req.query;

  for (const [name, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !ISO_DAY.test(value))) {
      return res.status(400).json({ error: `${name} must be a date in YYYY-MM-DD form` });
    }
  }

  if (typeof from === "string" && typeof to === "string" && from > to) {
    return res.status(400).json({ error: "from must not be later than to" });
  }

  const lines = listPostingLines({
    companyId: companyOf(req),
    from: typeof from === "string" ? from : undefined,
    to: typeof to === "string" ? to : undefined,
  });

  const csv = toCsv(
    POSTINGS_HEADER,
    lines.map((line) => [
      line.postingDay,
      // The line id, not a payment id: this row IS the transaction as far as
      // the accounting system is concerned, and it is the idempotency key a
      // later integration needs to avoid double-posting on a re-import.
      line.id,
      line.agentName,
      line.counterparty,
      // Derived from the class rather than stored, so it cannot disagree with
      // the account beside it.
      directionOf(line.ledgerClass) === "earn" ? "Earn" : "Spend",
      ledgerAccount(line.ledgerClass),
      baseUnitsToWholeCents(line.amountBaseUnits),
      "USD",
      String(line.sourceCount),
    ]),
  );

  const filename = `fuel-postings-${from ?? "start"}-to-${to ?? "today"}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

api.post("/agents", OPERATOR, async (req, res) => {
  const { name, teamId, spendCapUsd } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  if (typeof teamId !== "string" || !teamId) {
    return res.status(400).json({ error: "teamId is required" });
  }

  // Resolved before provisioning: the call below creates a real Fireblocks
  // vault, so a request that was always going to 400 must not leave one
  // orphaned behind it. Company-scoped as of 5B-4, and the ORDER is the point —
  // a foreign teamId is refused here, before any custody resource exists.
  const team = getTeamInCompany(teamId, companyOf(req));
  if (!team) return res.status(400).json({ error: "no such team" });

  let cap: bigint;
  try {
    cap = dollarsToBaseUnits(spendCapUsd ?? "0");
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }

  // The name check, the in-flight reservation and the vault naming all live in
  // createAgentWithCustody, in that order, so that a clashing name is refused
  // before a vault exists rather than after -- see src/agents/create.ts.
  try {
    const agent = await createAgentWithCustody({
      name: name.trim(),
      teamId: team.id,
      spendCapBaseUnits: cap,
    });
    res.status(201).json(present(agent));
  } catch (error) {
    if (error instanceof AgentNameTakenError) {
      return res.status(409).json({ error: error.message });
    }
    if (error instanceof VaultAlreadyHeldError) {
      // Detail is in the server log; the response names no custody identifier.
      return res.status(500).json({ error: "the agent could not be created; an operator has been alerted" });
    }
    // Anything else came out of provisioning or the write. Fireblocks error
    // text can carry account ids and provider detail, so it goes to the server
    // log only; the caller gets a fixed sentence.
    console.error(`[agents] agent creation failed: ${describe(error)}`);
    res.status(500).json({ error: "the agent could not be created; try again or contact support" });
  }
});

/**
 * Every agent in the company.
 *
 * HARDENED IN 5B-4, and it was the worst remaining instance of what 5B-3 fixed
 * for approvals: mounted ANY, and `listAgents()` beneath it was a bare
 * `SELECT * FROM agents` with no company predicate at all — not a seam,
 * nothing. Since one agent key is issued to every agent, that handed any
 * agent's integration every other agent's cap, spend, frozen state and reason,
 * and a live custody balance. Operator-only and company-scoped now.
 */
api.get("/agents", OPERATOR, async (req, res) => {
  res.json(
    await Promise.all(listAgentsInCompany(companyOf(req)).map(presentWithBalance)),
  );
});

/** How much of an agent's history this route returns. See below. */
const AGENT_PAYMENT_LIMIT = 25;

/**
 * One agent, and a bounded slice of what it has spent.
 *
 * HARDENED IN 5B-2, and it needed it on three counts.
 *
 * It was mounted ANY, so the shared AGENT credential could read it. Since one
 * agent key is issued to every agent, that meant any agent's integration could
 * read every other agent's full payment history, including settlement
 * identifiers. It is operator-only now. An agent that needs to know how its own
 * held payment fared still learns that from the response to its own /pay call.
 *
 * It returned txHash, the full resourceUrl (query string included) and the raw
 * detail — a settlement identifier, a URL that can carry a credential, and free
 * internal prose written in base units that on failures can contain a string a
 * third-party merchant chose.
 *
 * It returned every payment an agent had ever made, unbounded — 220 rows for
 * the busiest agent here. It now returns the most recent 25 and says how many
 * there are, so a caller can tell a page from the whole.
 *
 * Built field by field, deliberately. A spread would carry whatever the next
 * migration adds.
 */
api.get("/agents/:id", OPERATOR, async (req, res) => {
  const agent = getAgentInCompany(req.params.id, companyOf(req));
  if (!agent) return res.status(404).json({ error: "no such agent" });

  const { rows, total } = listRecentPayments(agent.id, AGENT_PAYMENT_LIMIT);

  res.json({
    ...(await presentWithBalance(agent)),
    funding: presentFunding(agent),
    payments: rows.map((p) => {
      const presented = presentStatus(p.status);
      return {
        id: p.id,
        amount: baseUnitsToDollars(p.amountBaseUnits),
        vendor: vendorFromResourceUrl(p.resourceUrl),
        status: p.status,
        statusLabel: presented.label,
        statusTone: presented.tone,
        createdAt: p.createdAt,
        settledAt: p.settledAt,
        isDemo: p.isDemo,
        refusal: presentRefusal(p.refusalCode),
      };
    }),
    paymentsShown: rows.length,
    paymentsTotal: total,
  });
});

api.patch("/agents/:id", OPERATOR, (req, res) => {
  const agent = getAgentInCompany(req.params.id, companyOf(req));
  if (!agent) return res.status(404).json({ error: "no such agent" });

  try {
    const cap = dollarsToBaseUnits(req.body?.spendCapUsd);
    const updated = setSpendCap(agent.id, cap);
    res.json(present(updated!));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * The operator's stop button, and the way back.
 *
 * Verbs rather than a `frozen` field on PATCH /agents/:id, following the
 * closest precedent in this file — POST /approvals/:id/approve|deny. These are
 * guarded state transitions, not field edits, and 409 means the transition did
 * not apply: the agent was already in the state being asked for.
 *
 * Freezing is not "set the cap to $0". A cap is a budget statement; setting it
 * to zero destroys the real value and has to be remembered and restored by
 * hand. Freezing leaves every budget untouched.
 */
api.post("/agents/:id/freeze", OPERATOR, (req, res) => {
  const agent = getAgentInCompany(req.params.id, companyOf(req));
  if (!agent) return res.status(404).json({ error: "no such agent" });

  const reason = req.body?.reason;
  if (reason !== undefined && typeof reason !== "string") {
    return res.status(400).json({ error: "reason must be a string" });
  }

  const frozen = freezeAgent(agent.id, reason);
  if (!frozen) {
    return res.status(409).json({ error: "agent is already frozen" });
  }
  res.json(present(frozen));
});

api.post("/agents/:id/unfreeze", OPERATOR, (req, res) => {
  const agent = getAgentInCompany(req.params.id, companyOf(req));
  if (!agent) return res.status(404).json({ error: "no such agent" });

  const thawed = unfreezeAgent(agent.id);
  if (!thawed) {
    return res.status(409).json({ error: "agent is not frozen" });
  }
  res.json(present(thawed));
});

// The only route that spends, and the only one the operator credential is
// barred from. That bar is what makes approval two-party: if the operator key
// could also pay, one holder would still be doing both halves.
api.post("/agents/:id/pay", AGENT, async (req, res) => {
  // Scoped like every other agent lookup. This one is on the money path, so
  // the direction of the change matters: it can only ever REFUSE a payment
  // that would previously have been attempted, never permit one. With a single
  // company every agent resolves exactly as before.
  const agent = getAgentInCompany(req.params.id, companyOf(req));
  if (!agent) return res.status(404).json({ error: "no such agent" });

  const { url, approvalRequestId } = req.body ?? {};
  if (typeof url !== "string" || !url) {
    return res.status(400).json({ error: "url is required" });
  }
  if (approvalRequestId !== undefined && typeof approvalRequestId !== "string") {
    return res.status(400).json({ error: "approvalRequestId must be a string" });
  }

  const result = await payForAgent({
    agent,
    signer: signerForAgent(agent),
    url,
    approvalRequestId,
  });

  // 423 Locked: an operator deliberately stopped this agent. Distinct from all
  // three other refusals because the fix is distinct — 402 raise a cap, 202 ask
  // a human, 429 wait, 423 an operator has to let it run again. Nothing the
  // caller can do resolves this on its own.
  if (result.outcome === "frozen") {
    return res.status(423).json({
      error: result.reason,
      frozenAt: result.frozenAt,
      frozenReason: result.frozenReason,
    });
  }

  // 402 for a cap block: the agent asked to spend and was refused on budget,
  // which is exactly what 402 means to the caller.
  if (result.outcome === "blocked") {
    return res.status(402).json({
      error: result.reason,
      // Which limit tripped: the agent's own cap, its team's, or its
      // company's. Without this the three are indistinguishable to the
      // caller, and the fix for each is different.
      scope: result.scope,
      spent: result.spentUsd,
      spendCap: result.capUsd,
    });
  }

  // 202, not 402: the request was understood and is queued for a human, which
  // is a different thing from being refused. The caller retries with this id
  // once it is approved.
  //
  // Two shapes, because the two reasons are answered differently. A ceiling
  // block reports spend against a cap — the fix might be to raise it. An
  // anomaly reports the agent's own recent baseline, where there is no limit to
  // raise and the only question is whether the payment was intended.
  if (result.outcome === "awaiting_approval") {
    const common = {
      status: "awaiting_approval",
      message: result.reason,
      approvalRequestId: result.approvalRequestId,
      scope: result.scope,
      amount: result.amountUsd,
    };
    return res.status(202).json(
      result.scope === "anomaly"
        ? {
            ...common,
            typical: result.baselineUsd,
            threshold: result.thresholdUsd,
            comparedWith: result.sampleSize,
          }
        : { ...common, spent: result.spentUsd, spendCap: result.capUsd },
    );
  }

  // 429, not 402: this is the one refusal that is neither a budget problem nor
  // a question for a human. Retry-After is a real HTTP header that retrying
  // clients already understand, so an agent can back off correctly without
  // knowing anything about Fuel. Three refusals, three status codes, three
  // different fixes: 402 raise a cap, 202 ask a human, 429 wait.
  if (result.outcome === "rate_limited") {
    res.set("Retry-After", String(result.retryAfterSeconds));
    return res.status(429).json({
      error: result.reason,
      spentInWindow: result.spentInWindowUsd,
      limit: result.limitUsd,
      windowSeconds: result.windowSeconds,
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }

  // The approval was not valid for this payment (wrong agent, wrong resource,
  // expired, already used, or the price went up since it was granted). Still a
  // refusal to spend, so still 402 — but there is no cap to raise.
  if (result.outcome === "approval_invalid") {
    return res.status(402).json({ error: result.reason, scope: "approval" });
  }
  if (result.outcome === "failed") {
    // The reason can contain arbitrary text from a third-party server, and
    // once FireblocksSigner lands it could carry provider error detail. Log it,
    // return something generic. The full reason is on the payment record.
    console.error(`payment failed for agent ${agent.id}: ${result.reason}`);
    return res.status(502).json({ error: "Payment could not be completed." });
  }

  res.json({
    paid: result.amountUsd,
    transaction: result.txHash,
    resource: safeJson(result.body),
  });
});

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/* -------------------------------------------------------------------------
 * Alerting (ADR 0021).
 *
 * `GET /attention` is what the Overview renders and what the sweeper alerts
 * on: one definition (src/alerts/attention.ts), so the screen and an alert
 * cannot disagree. OPERATOR, like every other read of these facts.
 *
 * Everything under `/alerts` is OWNER-only. Where a company's alerts go is a
 * decision about sending its data to a third party, which is an owner's call,
 * and the shared key, which names nobody, cannot make it (requireOwner).
 *
 * THE WEBHOOK URL IS NEVER IN A RESPONSE. The routes return whether one is set,
 * its host, and how it is doing. Refusals are fixed sentences that do not
 * echo what was sent, and delivery outcomes are shown to the owner in a
 * collapsed vocabulary: "unreachable" covers both a refused private address
 * and a network failure, so the test button cannot be used to learn which
 * internal-only names exist (security review, F5).
 * ---------------------------------------------------------------------- */

/** Test alerts per company per minute. It reaches a third party's server. */
const testAlertLimiter = new Buckets(5, 60_000);

/**
 * Webhook changes per company per minute (review of commit 1, F-2). Each
 * replace or remove sends a notice to the old destination, so an unthrottled
 * change route would be a way to make Fuel post to hosts of an owner's choosing
 * as fast as they could loop it.
 */
const webhookChangeLimiter = new Buckets(6, 60_000);

/** The URL inside a sealed webhook, or null if it cannot be read. */
function sealedUrl(companyId: string, sealed: string): string | null {
  try {
    return openWebhook(companyId, sealed).url;
  } catch {
    return null;
  }
}

const OWNER_OUTCOME: Record<AlertOutcome, string> = {
  ok: "delivered",
  blocked_address: "unreachable",
  network_error: "unreachable",
  redirect_refused: "redirected",
  timeout: "timed_out",
  http_4xx: "rejected",
  http_5xx: "receiver_error",
  invalid_url: "invalid_address",
  secret_unreadable: "unreadable",
};

/** The sweeper is "stale" past this, so a dead one never looks like a quiet one. */
const SWEEPER_STALE_MS = 3 * 60 * 1000;

function presentWebhook(companyId: string) {
  const lastSweep = lastSweepAt();
  const sweeperStale = lastSweep === null || Date.now() - new Date(lastSweep).getTime() > SWEEPER_STALE_MS;
  const row = getWebhookRow(companyId);
  if (row === null) {
    return {
      configured: false,
      host: null,
      setAt: null,
      state: "not_configured",
      lastOutcome: null,
      lastAttemptAt: null,
      sweeperLastRunAt: lastSweep,
      sweeperStale,
    };
  }
  let host: string | null = null;
  let readable = true;
  try {
    host = openWebhook(companyId, row.secretEnc).host;
  } catch {
    readable = false;
  }
  return {
    configured: true,
    // The host only: an owner needs to know WHERE alerts go, and a Slack
    // webhook's secret is its path, which never leaves the ciphertext.
    host,
    setAt: row.setAt,
    state: !readable
      ? "unreadable"
      : row.consecutiveFailures >= DEGRADED_AFTER
        ? "degraded"
        : row.lastOutcome === null
          ? "not_yet_used"
          : "healthy",
    lastOutcome: row.lastOutcome === null ? null : OWNER_OUTCOME[row.lastOutcome],
    lastAttemptAt: row.lastAttemptAt,
    sweeperLastRunAt: lastSweep,
    sweeperStale,
  };
}

/** Raw names and dollar strings: escaping is for the webhook boundary only. */
function presentAttentionGroup(g: AttentionGroup) {
  const usd = (n: bigint | null) => (n === null ? null : baseUnitsToDollars(n));
  return {
    event: g.event,
    label: LABEL[g.event].one,
    severity: g.severity,
    items: g.items,
    agentId: g.agentId,
    agentName: g.agentName,
    teamName: g.teamName,
    amount: usd(g.amountBaseUnits),
    spent: usd(g.spentBaseUnits),
    cap: usd(g.capBaseUnits),
    count: g.count,
    since: g.since,
    until: g.until,
    scope: g.scope,
    frozenReason: g.frozenReason,
    href: g.href,
  };
}

/** At most this many lines on the Overview; the rest are counted, not dropped. */
const ATTENTION_LIMIT = 100;

api.get("/attention", OPERATOR, (req, res) => {
  const groups = collapse(attentionFor(companyOf(req), new Date()));
  const shown = groups.slice(0, ATTENTION_LIMIT);
  const totals: Record<string, number> = {};
  for (const g of groups) totals[g.event] = (totals[g.event] ?? 0) + g.items;
  res.json({
    items: shown.map(presentAttentionGroup),
    total: groups.length,
    truncated: groups.length > shown.length,
    totalsByEvent: totals,
  });
});

api.get("/alerts/webhook", OWNER, (req, res) => {
  res.json(presentWebhook(companyOf(req)));
});

api.put("/alerts/webhook", OWNER, (req, res) => {
  const companyId = companyOf(req);
  const userId = userOf(req);
  if (userId === null) return res.status(403).json({ error: "this endpoint requires a signed-in owner" });

  let href: string;
  try {
    href = assertWebhookUrl((req.body ?? {}).url);
  } catch (error) {
    // Caught by class and answered with a fixed sentence. The message of
    // anything else is never read: it could contain the URL.
    const problem = error instanceof WebhookUrlError ? error.problem : "not_a_url";
    return res.status(400).json({ error: WEBHOOK_URL_MESSAGES[problem], code: problem });
  }

  let sealed: string;
  try {
    sealed = sealWebhook(companyId, href);
  } catch {
    return res.status(500).json({
      error: "The webhook could not be stored securely. Whoever runs Fuel needs to check its encryption key.",
      code: "unreadable",
    });
  }
  // Counted only once the URL is valid and sealed: a refused URL sends nothing,
  // so it should not use up an owner's allowance of real changes.
  if (webhookChangeLimiter.exceeded(companyId)) {
    return res.status(429).json({ error: "Too many webhook changes. Wait a minute and try again.", code: "throttled" });
  }

  // Swept first, so a condition that exists but had not been swept yet is
  // already an event when a first set baselines (review of commit 1, F-4).
  // Without a webhook the sweep sends nothing; a failure here only means the
  // baseline is as old as the last sweep, so it never blocks the change.
  try {
    sweepCompany(companyId, new Date());
  } catch {
    console.error(`[alerts] pre-set sweep failed for company ${companyId}`);
  }
  const { replacedSecretEnc } = setWebhook({ companyId, secretEnc: sealed, userId, now: new Date() });
  // The old destination is told, once, that it has been replaced: a hijacked
  // destination is then visible to whoever was reading the old one. Not when
  // the "new" URL is the same one, which is a re-save, not a change.
  if (replacedSecretEnc !== null && sealedUrl(companyId, replacedSecretEnc) !== href) {
    alertDispatcher.notifyChanged(companyId, replacedSecretEnc);
  }
  res.json(presentWebhook(companyId));
});

api.delete("/alerts/webhook", OWNER, (req, res) => {
  const companyId = companyOf(req);
  const userId = userOf(req);
  if (userId === null) return res.status(403).json({ error: "this endpoint requires a signed-in owner" });
  if (webhookChangeLimiter.exceeded(companyId)) {
    return res.status(429).json({ error: "Too many webhook changes. Wait a minute and try again.", code: "throttled" });
  }
  const removed = removeWebhook({ companyId, userId, now: new Date() });
  if (removed !== null) alertDispatcher.notifyChanged(companyId, removed);
  res.json(presentWebhook(companyId));
});

api.post("/alerts/webhook/test", OWNER, async (req, res) => {
  const companyId = companyOf(req);
  if (testAlertLimiter.exceeded(companyId)) {
    return res.status(429).json({ error: "Too many test alerts. Wait a minute and try again.", code: "throttled" });
  }
  const result = await alertDispatcher.sendTest(companyId);
  if (result === "not_configured") {
    return res.status(409).json({ error: "Set a webhook first.", code: "not_configured" });
  }
  if (result === "busy") {
    return res.status(409).json({ error: "An alert is being sent right now. Try again in a few seconds.", code: "busy" });
  }
  // The outcome word, never the receiver's body or status line.
  res.json({ delivered: result.outcome === "ok", outcome: OWNER_OUTCOME[result.outcome] });
});

api.get("/alerts", OWNER, (req, res) => {
  const companyId = companyOf(req);
  const requested = Number(req.query.limit ?? 50);
  const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 100) : 50;
  let unreadableRows = 0;
  const alerts = recentAlerts(companyId, limit).map((a) => {
    // One row that will not parse (a kind a later version removed, say)
    // shows as its kind with no detail, rather than failing the whole list:
    // the same per-row guard delivery uses (review of commit 1).
    let p: { agentName: string | null; teamName: string | null; amountBaseUnits: bigint | null; count: number | null };
    let unreadable = false;
    try {
      p = fromPayload(a.payloadJson);
    } catch {
      // Marked, so the panel says "details unavailable" rather than guessing
      // a subject. Counted, and logged once below in a fixed line with no
      // payload content, so a fault that blanks every row is not silent.
      unreadable = true;
      unreadableRows += 1;
      p = { agentName: null, teamName: null, amountBaseUnits: null, count: null };
    }
    return {
      event: a.event,
      label: (LABEL as Record<string, { one: string }>)[a.event]?.one ?? a.event,
      severity: a.severity,
      agentName: p.agentName,
      teamName: p.teamName,
      amount: p.amountBaseUnits === null ? null : baseUnitsToDollars(p.amountBaseUnits),
      count: p.count,
      openedAt: a.openedAt,
      resolvedAt: a.resolvedAt,
      notice: a.notifyState,
      delivery:
        a.deliveryOutcome !== null ? OWNER_OUTCOME[a.deliveryOutcome] : (a.deliveryStatus ?? null),
      unreadable,
    };
  });
  // One line per request, not per row: an owner reloading the page should not
  // be able to fill the log (re-check of commit 2).
  if (unreadableRows > 0) {
    console.error(`[alerts] ${unreadableRows} alert row(s) for company ${companyId} could not be read; listed without detail`);
  }
  res.json({ webhook: presentWebhook(companyId), alerts });
});
