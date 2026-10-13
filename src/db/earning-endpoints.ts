/**
 * The APIs a customer has asked Fuel to front with a paywall.
 *
 * Data access only. The probes that decide whether an endpoint may be enabled
 * make network calls and live in src/gateway/probes.ts — this file records what
 * they found and enforces the rule that both must have passed.
 *
 * See docs/decisions/0011-the-earning-side.md.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "./index.js";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";
// The label rule lives in lib/ rather than here so db/index.ts's backfill can
// call it too. It could not import from this file: index.ts owns `db`, which
// this file imports, and the cycle is what let the backfill skip the gate.
import {
  LABEL_MAX_LENGTH,
  UNATTRIBUTED_COUNTERPARTY,
  assertUsableLabel,
  deriveLabel,
  InvalidLabelError,
} from "../lib/endpoint-label.js";

export {
  LABEL_MAX_LENGTH,
  UNATTRIBUTED_COUNTERPARTY,
  assertUsableLabel,
  InvalidLabelError,
} from "../lib/endpoint-label.js";


export class DuplicateLabelError extends Error {
  constructor(label: string) {
    super(`This agent already has an endpoint named "${label}".`);
    this.name = "DuplicateLabelError";
  }
}

export interface EarningEndpoint {
  id: string;
  agentId: string;
  publicId: string;
  originUrl: string;
  /** What this endpoint is called in the books. See assertUsableLabel. */
  label: string;
  priceBaseUnits: bigint;
  ownershipNonce: string;
  ownershipProvedAt: string | null;
  ownershipAddress: string | null;
  probeUnsignedAt: string | null;
  probeBadSigAt: string | null;
  blockedReason: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface EndpointRow {
  id: string;
  agent_id: string;
  public_id: string;
  origin_url: string;
  label: string;
  price_base_units: number | bigint;
  forward_secret: string;
  ownership_nonce: string;
  ownership_proved_at: string | null;
  ownership_address: string | null;
  probe_unsigned_at: string | null;
  probe_bad_sig_at: string | null;
  blocked_reason: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * NOTE WHAT IS ABSENT: `forward_secret` is not on this shape, so it cannot
 * reach a list, a re-read, or a browser through the ordinary path.
 *
 * IT IS RETURNED EXACTLY ONCE, at registration, and it has to be. An earlier
 * version of this comment claimed "an operator has no reason to read it back —
 * Fuel is the only party that signs with it." That was wrong, and wrong in a
 * way that made the whole anti-bypass mechanism unimplementable: Fuel signs,
 * but the ORIGIN is the party that has to verify, and verifying needs the same
 * secret. A shared secret the customer never receives protects nothing.
 *
 * So: shown once at creation, never again — the pattern an API key gets. After
 * that, `forwardSecretFor` is the single accessor and its one caller is the
 * forwarder.
 */
function toEndpoint(row: EndpointRow): EarningEndpoint {
  return {
    id: row.id,
    agentId: row.agent_id,
    publicId: row.public_id,
    originUrl: row.origin_url,
    label: row.label,
    priceBaseUnits: BigInt(row.price_base_units),
    ownershipNonce: row.ownership_nonce,
    ownershipProvedAt: row.ownership_proved_at,
    ownershipAddress: row.ownership_address,
    probeUnsignedAt: row.probe_unsigned_at,
    probeBadSigAt: row.probe_bad_sig_at,
    blockedReason: row.blocked_reason,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 32 bytes of CSPRNG, base64url.
 *
 * Used for the public id, the ownership nonce and the forward secret. The
 * public id does not carry the paywall — payment does — but a guessable one
 * would let anyone enumerate a customer's endpoints and their prices, so it is
 * generated the same way as the things that do.
 */
function token(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The one moment the forward secret exists in plaintext outside the forwarder.
 *
 * Returned alongside the endpoint rather than on it, so it cannot be carried
 * accidentally into a later read: every other accessor returns `EarningEndpoint`,
 * which has no field for it.
 */
export interface RegisteredEndpoint {
  endpoint: EarningEndpoint;
  /** Show this to the operator now. Fuel cannot show it again. */
  forwardSecret: string;
}

/**
 * Turns whatever the operator typed into a label, or supplies one.
 *
 * The derived form is a starting point, not a claim: an operator who does not
 * care what their books call this endpoint should not be forced to invent a
 * name, and an operator who does care can pass one. Same shape the migration's
 * backfill uses, so a registered endpoint and a migrated one read alike.
 */
function labelOrDerived(label: string | undefined, originUrl: string): string {
  if (label !== undefined && label.trim().length > 0) return assertUsableLabel(label);
  return deriveLabel(originUrl);
}

export function registerEndpoint(params: {
  agentId: string;
  originUrl: string;
  priceBaseUnits: bigint;
  label?: string;
}): RegisteredEndpoint {
  const id = randomUUID();
  const now = new Date().toISOString();
  const forwardSecret = token();
  const label = labelOrDerived(params.label, params.originUrl);
  try {
    db.prepare(
      `INSERT INTO earning_endpoints
         (id, agent_id, public_id, origin_url, label, price_base_units, forward_secret,
          ownership_nonce, blocked_reason, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      id,
      params.agentId,
      token(),
      params.originUrl,
      label,
      params.priceBaseUnits,
      encryptSecret(forwardSecret),
      token(),
      "not verified yet: run the checks",
      now,
      now,
    );
  } catch (error) {
    // The unique index is the authority, not a pre-read: checking first and
    // inserting after is a race, and this insert is the only thing that can
    // actually decide. Same reasoning claimReceipt gives for its own UNIQUE.
    if (isLabelCollision(error)) throw new DuplicateLabelError(label);
    throw error;
  }
  return { endpoint: getEndpointUnscoped(id)!, forwardSecret };
}

/**
 * Matches the constraint by name rather than by message text.
 *
 * `earning_endpoints` carries several unique constraints -- public_id is one --
 * so a bare "is this a UNIQUE violation?" would report a public_id collision as
 * a duplicate label and send an operator to rename something that was fine.
 */
function isLabelCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/i.test(error.message) &&
    /agent_id/.test(error.message) &&
    /label/.test(error.message)
  );
}

/**
 * Renames an endpoint.
 *
 * REVIEW: the claim to attack is that this is safe to do at any time. The
 * arithmetic half holds -- computeBuckets keys revenue buckets on endpoint_id,
 * posting_lines is append-only, and absorption is joined by source id, so no
 * residual moves and conservation cannot break. What a rename DOES do is split
 * the counterparty text: lines already posted keep the old name, lines rolled
 * up afterwards carry the new one, and eligibleLines scopes on that text. One
 * endpoint's revenue for one day can therefore end up in two documents under
 * two names. Nothing is lost and nothing is double-booked; it is untidy, and
 * the caller is told how much is affected rather than finding out later.
 */
export function setLabel(id: string, label: string): EarningEndpoint {
  const endpoint = getEndpointUnscoped(id);
  if (!endpoint) throw new Error(`No earning endpoint ${id}`);
  const next = assertUsableLabel(label);

  try {
    db.prepare("UPDATE earning_endpoints SET label = ?, updated_at = ? WHERE id = ?").run(
      next,
      new Date().toISOString(),
      id,
    );
  } catch (error) {
    if (isLabelCollision(error)) throw new DuplicateLabelError(next);
    throw error;
  }
  return getEndpointUnscoped(id)!;
}

/**
 * How many already-rolled-up lines still carry an endpoint's current name.
 *
 * Read before a rename so the answer can be reported. Counts lines, not
 * documents, because a line is the unit that would end up split.
 */
export function linesCarryingLabel(agentId: string, label: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM posting_lines
        WHERE agent_id = ? AND counterparty = ? AND ledger_class = 'revenue'`,
    )
    .get(agentId, label) as { n: number | bigint };
  return Number(row.n);
}

/** An endpoint, only if its agent belongs to this company. Scoped in the query, so another company's id and a nonexistent id both come back null — the route's 404 is produced by the SQL, not by a branch someone remembered to write. Same construction as getAgentInCompany. */
export function getEndpointInCompany(id: string, companyId: string): EarningEndpoint | null {
  const row = db
    .prepare(
      `SELECT e.* FROM earning_endpoints e
         JOIN agents a ON a.id = e.agent_id
         JOIN teams  t ON t.id = a.team_id
        WHERE e.id = ? AND t.company_id = ?`,
    )
    .get(id, companyId) as unknown as EndpointRow | undefined;
  return row ? toEndpoint(row) : null;
}

/**
 * An endpoint by id, UNSCOPED. Internal re-reads of a row this module just
 * wrote, only; see getAgentUnscoped for the same warning.
 */
export function getEndpointUnscoped(id: string): EarningEndpoint | null {
  const row = db.prepare("SELECT * FROM earning_endpoints WHERE id = ?").get(id) as
    | unknown as EndpointRow
    | undefined;
  return row ? toEndpoint(row) : null;
}

/**
 * The gateway's lookup: by public id, and only if enabled.
 *
 * ONE QUERY, NOT TWO. Looking the row up and then checking `enabled` in
 * JavaScript would make "exists but disabled" and "does not exist"
 * distinguishable by timing, and would invite a later refactor to report them
 * differently. The gateway answers both with the same 404.
 */
export function getEnabledEndpointByPublicId(publicId: string): EarningEndpoint | null {
  const row = db
    .prepare("SELECT * FROM earning_endpoints WHERE public_id = ? AND enabled = 1")
    .get(publicId) as unknown as EndpointRow | undefined;
  return row ? toEndpoint(row) : null;
}

export function listEndpointsForCompany(companyId: string): EarningEndpoint[] {
  const rows = db
    .prepare(
      `SELECT e.* FROM earning_endpoints e
       JOIN agents a ON a.id = e.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE t.company_id = ?
       ORDER BY e.created_at ASC, e.id ASC`,
    )
    .all(companyId) as unknown as EndpointRow[];
  return rows.map(toEndpoint);
}

/** The one place the forward secret is decrypted. Its only caller is the forwarder. */
export function forwardSecretFor(endpointId: string): string {
  const row = db
    .prepare("SELECT forward_secret FROM earning_endpoints WHERE id = ?")
    .get(endpointId) as unknown as { forward_secret: string } | undefined;
  if (!row) throw new Error(`No earning endpoint ${endpointId}`);
  return decryptSecret(row.forward_secret);
}

/** Records what the probes found. Called only by src/gateway/probes.ts. */
export function recordVerification(
  id: string,
  result: {
    ownershipProvedAt: string | null;
    ownershipAddress: string | null;
    probeUnsignedAt: string | null;
    probeBadSigAt: string | null;
    blockedReason: string | null;
  },
): void {
  db.prepare(
    `UPDATE earning_endpoints
        SET ownership_proved_at = ?, ownership_address = ?,
            probe_unsigned_at = ?, probe_bad_sig_at = ?,
            blocked_reason = ?, updated_at = ?,
            -- Any failed check disables immediately. A re-check that newly
            -- fails must be able to TAKE AWAY access, not merely decline to
            -- grant it — an origin that stops refusing unsigned traffic is
            -- exactly the case this re-runs to catch.
            enabled = CASE WHEN ? IS NULL THEN enabled ELSE 0 END
      WHERE id = ?`,
  ).run(
    result.ownershipProvedAt,
    result.ownershipAddress,
    result.probeUnsignedAt,
    result.probeBadSigAt,
    result.blockedReason,
    new Date().toISOString(),
    result.blockedReason,
    id,
  );
}

/** Why this endpoint may not be enabled, or null if every check has passed. */
export function enablementBlocker(e: EarningEndpoint): string | null {
  if (e.blockedReason) return e.blockedReason;
  if (!e.ownershipProvedAt) return "ownership of the origin has not been proved";
  if (!e.probeUnsignedAt) return "the origin has not been shown to refuse unsigned requests";
  if (!e.probeBadSigAt) {
    return "the origin has not been shown to refuse a request with an invalid signature";
  }
  return null;
}

/**
 * Turns an endpoint on, refusing unless every check has passed.
 *
 * THE GATE LIVES HERE, not in the route, because this is the only function that
 * can set the column. A check enforced at the routing layer is a check a second
 * caller can forget to perform; one enforced at the single write path cannot be
 * bypassed without deleting it.
 */
export class EndpointNotVerifiedError extends Error {
  constructor(reason: string) {
    super(`Refusing to enable this endpoint: ${reason}.`);
    this.name = "EndpointNotVerifiedError";
  }
}

export function setEnabled(id: string, enabled: boolean): EarningEndpoint {
  const endpoint = getEndpointUnscoped(id);
  if (!endpoint) throw new Error(`No earning endpoint ${id}`);

  if (enabled) {
    const blocker = enablementBlocker(endpoint);
    if (blocker) throw new EndpointNotVerifiedError(blocker);
  }

  db.prepare("UPDATE earning_endpoints SET enabled = ?, updated_at = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    new Date().toISOString(),
    id,
  );
  return getEndpointUnscoped(id)!;
}

/** Endpoints whose ownership proof is older than the re-check interval. */
export function endpointsNeedingRecheck(olderThanMs: number): EarningEndpoint[] {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM earning_endpoints
        WHERE enabled = 1 AND (ownership_proved_at IS NULL OR ownership_proved_at < ?)`,
    )
    .all(cutoff) as unknown as EndpointRow[];
  return rows.map(toEndpoint);
}
