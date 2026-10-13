/**
 * Storage for alerting (ADR 0021). Writes ONLY the alert_* tables.
 *
 * EVERY FUNCTION HERE IS SYNCHRONOUS, and every transaction is opened and
 * closed in one JavaScript turn, which is the rule every money path in this
 * codebase already keeps. `node:sqlite` is one connection: a transaction left
 * open across an `await` would capture whatever request ran next, and one left
 * open by an exception would make every later `BEGIN IMMEDIATE`, including
 * `reserveIfUnderCap`, fail until restart. So each transaction here is the
 * house pattern: BEGIN IMMEDIATE, work, COMMIT, and ROLLBACK then rethrow on
 * any error (security review, F3).
 *
 * EVERY STATEMENT NAMES ITS COMPANY, even where an id already implies one
 * (security review of commit 1, F-5). Correct by construction is not the same
 * as correct by statement, and the second survives the next edit.
 */
import { randomUUID } from "node:crypto";
import { MESSAGES_PER_HOUR, type Ceiling, type Severity } from "../alerts/events.js";
import { db } from "./index.js";

export type AlertOutcome =
  | "ok"
  | "blocked_address"
  | "redirect_refused"
  | "timeout"
  | "http_4xx"
  | "http_5xx"
  | "network_error"
  | "invalid_url"
  | "secret_unreadable";

export type NotifyState = "pending" | "batched" | "baseline" | "silent";

/**
 * Retry schedule after a failed attempt, in minutes: +1, +2, +4, +8, +16, then
 * the delivery is `failed`. Six attempts in about half an hour.
 */
export const BACKOFF_MINUTES = [1, 2, 4, 8, 16];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;

/** How long a claimed delivery may stay `sending` before it is claimable again. */
export const LEASE_MS = 2 * 60 * 1000;

/** Failures in a row before a webhook is shown as degraded. */
export const DEGRADED_AFTER = 3;

/**
 * A degraded webhook gets at most one new message this often: the light circuit
 * breaker. Its events wait as `pending` meanwhile, and go out together when it
 * answers again.
 */
export const DEGRADED_RETRY_MS = 15 * 60 * 1000;

function inWriteTransaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------
 * The webhook
 * ---------------------------------------------------------------------- */

export interface WebhookRow {
  companyId: string;
  secretEnc: string;
  setBy: string;
  setAt: string;
  baselineAt: string;
  consecutiveFailures: number;
  lastOutcome: AlertOutcome | null;
  lastAttemptAt: string | null;
}

interface WebhookDbRow {
  company_id: string;
  secret_enc: string;
  set_by: string;
  set_at: string;
  baseline_at: string;
  consecutive_failures: number | bigint;
  last_outcome: AlertOutcome | null;
  last_attempt_at: string | null;
}

export function getWebhookRow(companyId: string): WebhookRow | null {
  const row = db.prepare("SELECT * FROM alert_webhooks WHERE company_id = ?").get(companyId) as
    | WebhookDbRow
    | undefined;
  if (!row) return null;
  return {
    companyId: row.company_id,
    secretEnc: row.secret_enc,
    setBy: row.set_by,
    setAt: row.set_at,
    baselineAt: row.baseline_at,
    consecutiveFailures: Number(row.consecutive_failures),
    lastOutcome: row.last_outcome,
    lastAttemptAt: row.last_attempt_at,
  };
}

/**
 * Sets or replaces a company's webhook. Returns the sealed URL it replaced, so
 * the caller can tell the old destination it has been replaced, or null.
 *
 * THE BASELINE IS THE POINT OF DOING THIS IN ONE TRANSACTION (security review,
 * F1). On a FIRST set, every event already open is marked `baseline` and is
 * never sent. Without that, the first sweep after an owner pastes a URL would
 * send the company's whole backlog (old unreconciled test payments, agents
 * with custody-vocabulary names) to a third party in one go. Only conditions
 * that open after this moment alert. The route sweeps the company immediately
 * before calling this, so a condition that exists but had not been swept yet
 * is baselined too (security review of commit 1, F-4).
 *
 * A REPLACEMENT keeps the queue: anything still due goes to the NEW url, which
 * the dispatcher reads at send time, and never to the old one.
 */
export function setWebhook(params: {
  companyId: string;
  secretEnc: string;
  userId: string;
  now: Date;
}): { replacedSecretEnc: string | null } {
  const at = params.now.toISOString();
  return inWriteTransaction(() => {
    const existing = getWebhookRow(params.companyId);
    if (existing === null) {
      db.prepare(
        `INSERT INTO alert_webhooks
           (company_id, secret_enc, set_by, set_at, baseline_at, consecutive_failures, last_outcome, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)`,
      ).run(params.companyId, params.secretEnc, params.userId, at, at);
      db.prepare(
        `UPDATE alert_events SET notify_state = 'baseline'
          WHERE company_id = ? AND resolved_at IS NULL AND notify_state = 'pending'`,
      ).run(params.companyId);
    } else {
      db.prepare(
        `UPDATE alert_webhooks
            SET secret_enc = ?, set_by = ?, set_at = ?, consecutive_failures = 0,
                last_outcome = NULL, last_attempt_at = NULL
          WHERE company_id = ?`,
      ).run(params.secretEnc, params.userId, at, params.companyId);
    }
    db.prepare("INSERT INTO alert_webhook_changes (id, company_id, user_id, action, at) VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(),
      params.companyId,
      params.userId,
      existing === null ? "set" : "replaced",
      at,
    );
    return { replacedSecretEnc: existing?.secretEnc ?? null };
  });
}

/**
 * Removes a company's webhook and cancels what was queued for it. Returns the
 * sealed URL removed, or null if there was none.
 *
 * Queued AND in-flight deliveries are cancelled: they would otherwise go to
 * whatever URL is set next, which is a destination the events were never meant
 * for. One already `sending` finishes the request it has started, but its
 * outcome then moves nothing (`completeDelivery` only moves a `sending` row),
 * so it can neither retry nor hand its events back. Those events stay on the
 * dashboard; they are never sent anywhere else.
 */
export function removeWebhook(params: { companyId: string; userId: string; now: Date }): string | null {
  return inWriteTransaction(() => {
    const existing = getWebhookRow(params.companyId);
    if (existing === null) return null;
    db.prepare("DELETE FROM alert_webhooks WHERE company_id = ?").run(params.companyId);
    db.prepare(
      "UPDATE alert_deliveries SET status = 'cancelled', lease_until = NULL WHERE company_id = ? AND status IN ('due', 'sending')",
    ).run(params.companyId);
    db.prepare("INSERT INTO alert_webhook_changes (id, company_id, user_id, action, at) VALUES (?, ?, ?, 'removed', ?)").run(
      randomUUID(),
      params.companyId,
      params.userId,
      params.now.toISOString(),
    );
    return existing.secretEnc;
  });
}

/* -------------------------------------------------------------------------
 * Events
 * ---------------------------------------------------------------------- */

export interface OpenEvent {
  id: string;
  event: string;
  subjectKey: string;
  payloadJson: string;
}

export function openEvents(companyId: string): OpenEvent[] {
  const rows = db
    .prepare(
      `SELECT id, event, subject_key, payload_json FROM alert_events
        WHERE company_id = ? AND resolved_at IS NULL`,
    )
    .all(companyId) as unknown as { id: string; event: string; subject_key: string; payload_json: string }[];
  return rows.map((r) => ({ id: r.id, event: r.event, subjectKey: r.subject_key, payloadJson: r.payload_json }));
}

export interface WantedEvent {
  event: string;
  severity: Severity;
  ceiling: Ceiling;
  subjectKey: string;
  payloadJson: string;
}

export interface SweepChanges {
  open: WantedEvent[];
  resolve: string[];
  update: { id: string; payloadJson: string }[];
}

/**
 * Applies one company's diff in ONE short transaction.
 *
 * OPENING: a condition that cleared less than `cooldownMs` ago reopens its old
 * row SILENTLY (an agent bouncing off its rate limit pages nobody twice). Past
 * the cooldown, a fresh row is inserted with INSERT OR IGNORE, so the partial
 * unique index on open rows, not a read beforehand, is what makes the second
 * of two identical findings a no-op.
 */
export function applySweep(params: {
  companyId: string;
  now: Date;
  changes: SweepChanges;
  cooldownMs: number;
}): { opened: number; reopened: number; resolved: number } {
  const at = params.now.toISOString();
  const cooldownCutoff = new Date(params.now.getTime() - params.cooldownMs).toISOString();
  return inWriteTransaction(() => {
    let opened = 0;
    let reopened = 0;
    let resolved = 0;

    const resolve = db.prepare(
      "UPDATE alert_events SET resolved_at = ? WHERE id = ? AND company_id = ? AND resolved_at IS NULL",
    );
    for (const id of params.changes.resolve) resolved += Number(resolve.run(at, id, params.companyId).changes);

    const update = db.prepare(
      "UPDATE alert_events SET payload_json = ? WHERE id = ? AND company_id = ? AND resolved_at IS NULL",
    );
    for (const u of params.changes.update) update.run(u.payloadJson, u.id, params.companyId);

    const reopen = db.prepare(
      `UPDATE alert_events
          SET resolved_at = NULL,
              payload_json = ?,
              notify_state = CASE WHEN notify_state = 'pending' THEN 'pending' ELSE 'silent' END
        WHERE company_id = ?
          AND id = (SELECT id FROM alert_events
                     WHERE company_id = ? AND event = ? AND subject_key = ?
                       AND resolved_at IS NOT NULL AND resolved_at > ?
                     ORDER BY resolved_at DESC LIMIT 1)`,
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO alert_events
         (id, company_id, event, severity, ceiling, subject_key, payload_json, opened_at, resolved_at, notify_state, delivery_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL)`,
    );
    for (const w of params.changes.open) {
      const back = reopen.run(w.payloadJson, params.companyId, params.companyId, w.event, w.subjectKey, cooldownCutoff);
      if (Number(back.changes) > 0) {
        reopened += 1;
        continue;
      }
      opened += Number(
        insert.run(randomUUID(), params.companyId, w.event, w.severity, w.ceiling, w.subjectKey, w.payloadJson, at).changes,
      );
    }
    return { opened, reopened, resolved };
  });
}

/* -------------------------------------------------------------------------
 * Batching: turning pending events into at most one message per sweep
 * ---------------------------------------------------------------------- */

type BatchDecision = { kind: "join"; deliveryId: string } | { kind: "create"; ceiling: Ceiling };

/**
 * Whether, and how, this company's pending events should go out now. READ-ONLY,
 * so a sweep that would change nothing takes no write lock.
 *
 *   - Nothing pending: no.
 *   - A message is already waiting (`due`, a slow or failing webhook): join it.
 *     It is not a new message and spends no quota. When it finally goes, its
 *     text is built from everything still open in it, which is the recovery
 *     digest: one message, current, not a replay of stale ones.
 *   - The webhook is degraded and was tried in the last 15 minutes: wait (the
 *     light circuit breaker).
 *   - Otherwise a new message, IF some ceiling with pending events has room.
 *     It takes the most serious such ceiling (money, then approval, then watch)
 *     and carries every pending event, whatever its ceiling: the quotas count
 *     messages, and an event riding along costs nothing.
 *
 * WHAT A CEILING DOES TO AN EVENT: nothing but wait. It stays `pending` and
 * goes out with the next message any ceiling allows, or by itself when its own
 * hour frees, with nothing new needed to trigger it (security review of
 * commit 1, F-1). A ceiling is never a dead end. The only open events that are
 * never sent are ones Fuel decided not to send: baselined when a webhook was
 * first set, in a delivery cancelled because its webhook was removed, or in
 * one set aside because its message could not be built.
 */
function batchDecision(companyId: string, now: Date): BatchDecision | null {
  const pending = db
    .prepare(
      `SELECT ceiling, COUNT(*) AS n FROM alert_events
        WHERE company_id = ? AND resolved_at IS NULL AND notify_state = 'pending'
        GROUP BY ceiling`,
    )
    .all(companyId) as unknown as { ceiling: Ceiling; n: number | bigint }[];
  if (pending.length === 0) return null;

  const waiting = db
    .prepare(
      `SELECT id FROM alert_deliveries
        WHERE company_id = ? AND status = 'due' ORDER BY created_at LIMIT 1`,
    )
    .get(companyId) as { id: string } | undefined;
  if (waiting !== undefined) return { kind: "join", deliveryId: waiting.id };

  const hook = getWebhookRow(companyId);
  if (hook === null) return null;
  if (
    hook.consecutiveFailures >= DEGRADED_AFTER &&
    hook.lastAttemptAt !== null &&
    now.getTime() - new Date(hook.lastAttemptAt).getTime() < DEGRADED_RETRY_MS
  ) {
    return null;
  }

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const used = db
    .prepare(
      `SELECT ceiling, COUNT(*) AS n FROM alert_deliveries
        WHERE company_id = ? AND created_at > ? GROUP BY ceiling`,
    )
    .all(companyId, hourAgo) as unknown as { ceiling: Ceiling; n: number | bigint }[];
  const usedOf = (c: Ceiling) => Number(used.find((u) => u.ceiling === c)?.n ?? 0);
  const has = new Set(pending.map((p) => p.ceiling));
  for (const ceiling of ["money", "approval", "watch"] as const) {
    if (has.has(ceiling) && usedOf(ceiling) < MESSAGES_PER_HOUR[ceiling]) return { kind: "create", ceiling };
  }
  return null;
}

/**
 * Puts this company's pending events into a message, if they may go now.
 * Returns the delivery id, or null when nothing was written.
 *
 * Called after every sweep of a company that has a webhook, whether or not
 * anything changed: that is what lets a held event out once its hour frees.
 * The decision is read first, so the common "nothing to do" costs no lock.
 */
export function batchIfDue(companyId: string, now: Date): string | null {
  if (batchDecision(companyId, now) === null) return null;
  return inWriteTransaction(() => {
    // Decided again inside the lock: the read above was only a cheap filter.
    const decision = batchDecision(companyId, now);
    if (decision === null) return null;
    let deliveryId: string;
    if (decision.kind === "join") {
      deliveryId = decision.deliveryId;
    } else {
      deliveryId = randomUUID();
      db.prepare(
        `INSERT INTO alert_deliveries
           (id, company_id, ceiling, status, attempts, created_at, next_attempt_at, lease_until, last_attempt_at, outcome)
         VALUES (?, ?, ?, 'due', 0, ?, ?, NULL, NULL, NULL)`,
      ).run(deliveryId, companyId, decision.ceiling, now.toISOString(), now.toISOString());
    }
    db.prepare(
      `UPDATE alert_events SET notify_state = 'batched', delivery_id = ?
        WHERE company_id = ? AND resolved_at IS NULL AND notify_state = 'pending'`,
    ).run(deliveryId, companyId);
    return deliveryId;
  });
}

/* -------------------------------------------------------------------------
 * Deliveries
 * ---------------------------------------------------------------------- */

export interface ClaimedDelivery {
  id: string;
  companyId: string;
  attempts: number;
}

/**
 * Claims up to `limit` due deliveries, oldest due first, at most one per
 * company, skipping companies already sending.
 *
 * THE CLAIM IS A CONDITIONAL UPDATE, not a read followed by a write: only a row
 * that is due, or whose lease has run out, moves to `sending`, so two claimers
 * (a second process on the same file) cannot both send one message.
 *
 * A DELIVERY THAT KEEPS DYING IS GIVEN UP (security review of commit 1, F-7).
 * A lease that runs out means the attempt never recorded an outcome: a crash,
 * or something in building the message that throws every time. Without a
 * limit that would be retried every two minutes forever, and could send a
 * message more than once. At MAX_ATTEMPTS it is failed instead, and its events
 * go back to `pending` like any other failure.
 */
export function claimDue(now: Date, limit: number, busyCompanies: ReadonlySet<string>): ClaimedDelivery[] {
  if (limit <= 0) return [];
  const at = now.toISOString();

  const exhausted = db
    .prepare(
      `SELECT id, company_id FROM alert_deliveries
        WHERE status = 'sending' AND lease_until < ? AND attempts >= ?`,
    )
    .all(at, MAX_ATTEMPTS) as unknown as { id: string; company_id: string }[];
  for (const e of exhausted) {
    inWriteTransaction(() => {
      const failed = db
        .prepare(
          `UPDATE alert_deliveries SET status = 'failed', lease_until = NULL
            WHERE id = ? AND company_id = ? AND status = 'sending'`,
        )
        .run(e.id, e.company_id);
      if (Number(failed.changes) > 0) handBack(e.id, e.company_id);
    });
  }

  const candidates = db
    .prepare(
      `SELECT id, company_id, attempts FROM alert_deliveries
        WHERE (status = 'due' AND next_attempt_at <= ?)
           OR (status = 'sending' AND lease_until < ?)
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT 200`,
    )
    .all(at, at) as unknown as { id: string; company_id: string; attempts: number | bigint }[];

  const claim = db.prepare(
    `UPDATE alert_deliveries
        SET status = 'sending', lease_until = ?, attempts = attempts + 1, last_attempt_at = ?
      WHERE id = ? AND company_id = ?
        AND ((status = 'due' AND next_attempt_at <= ?) OR (status = 'sending' AND lease_until < ?))`,
  );
  const lease = new Date(now.getTime() + LEASE_MS).toISOString();
  const claimed: ClaimedDelivery[] = [];
  const taken = new Set(busyCompanies);
  for (const c of candidates) {
    if (claimed.length >= limit) break;
    if (taken.has(c.company_id)) continue;
    if (Number(claim.run(lease, at, c.id, c.company_id, at, at).changes) === 0) continue;
    taken.add(c.company_id);
    claimed.push({ id: c.id, companyId: c.company_id, attempts: Number(c.attempts) + 1 });
  }
  return claimed;
}

/**
 * The webhook a delivery goes to: ITS OWN COMPANY'S, by one join.
 *
 * The tenancy predicate for sending lives here and nowhere else: a delivery
 * belongs to a company, and the only webhook it can reach is the row with the
 * same company id. The dispatcher then opens the sealed URL with that company
 * id as well, so a row that somehow held another company's ciphertext is still
 * refused (webhook-url.ts). Two independent locks, and verify-api breaks each
 * on its own (B4a, B4b).
 */
export function webhookForDelivery(deliveryId: string): { companyId: string; secretEnc: string } | null {
  const row = db
    .prepare(
      `SELECT w.company_id AS company_id, w.secret_enc AS secret_enc
         FROM alert_deliveries d
         JOIN alert_webhooks w ON w.company_id = d.company_id
        WHERE d.id = ?`,
    )
    .get(deliveryId) as { company_id: string; secret_enc: string } | undefined;
  return row ? { companyId: row.company_id, secretEnc: row.secret_enc } : null;
}

/** The still-open events of a delivery, as stored. Read at send time. */
export function openEventsForDelivery(deliveryId: string, companyId: string): { payloadJson: string }[] {
  return (
    db
      .prepare(
        `SELECT payload_json FROM alert_events
          WHERE delivery_id = ? AND company_id = ? AND resolved_at IS NULL AND notify_state = 'batched'
          -- rowid breaks ties: events opened in one sweep share a timestamp,
          -- and their insertion order is attentionFor's deliberate order.
          ORDER BY opened_at ASC, rowid ASC`,
      )
      .all(deliveryId, companyId) as unknown as { payload_json: string }[]
  ).map((r) => ({ payloadJson: r.payload_json }));
}

/**
 * A failed delivery's still-open events go back to `pending` (security review
 * of commit 1, F-3). Without this, a webhook down for longer than the retry
 * schedule would lose them for good: they would sit `batched` into a delivery
 * that will never be tried again. Back in `pending`, they go out in the next
 * message the ceilings and the breaker allow.
 */
function handBack(deliveryId: string, companyId: string): void {
  db.prepare(
    `UPDATE alert_events SET notify_state = 'pending', delivery_id = NULL
      WHERE delivery_id = ? AND company_id = ? AND resolved_at IS NULL AND notify_state = 'batched'`,
  ).run(deliveryId, companyId);
}

/**
 * Records how an attempt went. Moves only a row that is still `sending`, so a
 * delivery cancelled meanwhile stays cancelled.
 *
 * The webhook's failure count is incremented IN SQL, never read and written
 * back, so two outcomes landing together cannot lose one.
 */
export function completeDelivery(params: {
  id: string;
  companyId: string;
  outcome: AlertOutcome;
  retryable: boolean;
  attempts: number;
  now: Date;
}): "sent" | "due" | "failed" {
  const at = params.now.toISOString();
  const next: "sent" | "due" | "failed" =
    params.outcome === "ok" ? "sent" : params.retryable && params.attempts < MAX_ATTEMPTS ? "due" : "failed";
  const delayMin = BACKOFF_MINUTES[Math.min(params.attempts, BACKOFF_MINUTES.length) - 1] ?? 0;
  const nextAttemptAt = new Date(params.now.getTime() + delayMin * 60_000).toISOString();
  inWriteTransaction(() => {
    const moved = db
      .prepare(
        `UPDATE alert_deliveries
            SET status = ?, outcome = ?, lease_until = NULL,
                next_attempt_at = CASE WHEN ? = 'due' THEN ? ELSE next_attempt_at END
          WHERE id = ? AND company_id = ? AND status = 'sending'`,
      )
      .run(next, params.outcome, next, nextAttemptAt, params.id, params.companyId);
    if (next === "failed" && Number(moved.changes) > 0) handBack(params.id, params.companyId);
    recordWebhookOutcome(params.companyId, params.outcome, at);
  });
  return next;
}

/** Notes an attempt's outcome on the webhook: reset on success, +1 in SQL on failure. */
export function recordWebhookOutcome(companyId: string, outcome: AlertOutcome, at: string): void {
  db.prepare(
    `UPDATE alert_webhooks
        SET last_outcome = ?, last_attempt_at = ?,
            consecutive_failures = CASE WHEN ? = 'ok' THEN 0 ELSE consecutive_failures + 1 END
      WHERE company_id = ?`,
  ).run(outcome, at, outcome, companyId);
}

/**
 * Gives up a claimed delivery without sending: everything in it has resolved,
 * there is no webhook any more, or building its message failed. Its events are
 * NOT handed back: a message that cannot be built would fail the same way
 * again, and is isolated rather than retried.
 */
export function cancelDelivery(id: string, companyId: string): void {
  db.prepare(
    "UPDATE alert_deliveries SET status = 'cancelled', lease_until = NULL WHERE id = ? AND company_id = ? AND status = 'sending'",
  ).run(id, companyId);
}

/* -------------------------------------------------------------------------
 * Reading, for the owner, and housekeeping
 * ---------------------------------------------------------------------- */

export interface RecentAlert {
  event: string;
  severity: Severity;
  payloadJson: string;
  openedAt: string;
  resolvedAt: string | null;
  notifyState: NotifyState;
  deliveryStatus: string | null;
  deliveryOutcome: AlertOutcome | null;
}

export function recentAlerts(companyId: string, limit: number): RecentAlert[] {
  const rows = db
    .prepare(
      `SELECT e.event, e.severity, e.payload_json, e.opened_at, e.resolved_at, e.notify_state,
              d.status AS delivery_status, d.outcome AS delivery_outcome
         FROM alert_events e
         LEFT JOIN alert_deliveries d ON d.id = e.delivery_id AND d.company_id = e.company_id
        WHERE e.company_id = ?
        ORDER BY e.opened_at DESC, e.id DESC
        LIMIT ?`,
    )
    .all(companyId, limit) as unknown as {
    event: string;
    severity: Severity;
    payload_json: string;
    opened_at: string;
    resolved_at: string | null;
    notify_state: NotifyState;
    delivery_status: string | null;
    delivery_outcome: AlertOutcome | null;
  }[];
  return rows.map((r) => ({
    event: r.event,
    severity: r.severity,
    payloadJson: r.payload_json,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    notifyState: r.notify_state,
    deliveryStatus: r.delivery_status,
    deliveryOutcome: r.delivery_outcome,
  }));
}

export function markSweepRan(now: Date): void {
  db.prepare(
    `INSERT INTO alert_state (id, last_sweep_at) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET last_sweep_at = excluded.last_sweep_at`,
  ).run(now.toISOString());
}

export function lastSweepAt(): string | null {
  const row = db.prepare("SELECT last_sweep_at FROM alert_state WHERE id = 1").get() as
    | { last_sweep_at: string | null }
    | undefined;
  return row?.last_sweep_at ?? null;
}

/**
 * Keeps the tables from growing without bound: resolved events after 30 days,
 * finished deliveries after 7 once nothing points at them, and webhook change
 * records after a year (security review of commit 1, F-10).
 */
export function pruneAlerts(now: Date): void {
  const day = 24 * 60 * 60 * 1000;
  const eventCutoff = new Date(now.getTime() - 30 * day).toISOString();
  const deliveryCutoff = new Date(now.getTime() - 7 * day).toISOString();
  const changeCutoff = new Date(now.getTime() - 365 * day).toISOString();
  inWriteTransaction(() => {
    db.prepare("DELETE FROM alert_events WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(eventCutoff);
    db.prepare(
      `DELETE FROM alert_deliveries
        WHERE status IN ('sent', 'failed', 'cancelled') AND created_at < ?
          AND NOT EXISTS (SELECT 1 FROM alert_events e WHERE e.delivery_id = alert_deliveries.id)`,
    ).run(deliveryCutoff);
    db.prepare("DELETE FROM alert_webhook_changes WHERE at < ?").run(changeCutoff);
  });
}
