/**
 * Sessions: the proof that a particular person is on the other end of a
 * request, and the only credential in Fuel that a browser holds.
 *
 * THE COOKIE VALUE IS NEVER WRITTEN DOWN. `sessions.id` is its SHA-256, so the
 * browser holds the only usable copy and a leaked database file is not a set of
 * live logins. See the table comment in src/db/index.ts, and src/lib/secrets.ts
 * for the same argument applied to OAuth tokens.
 *
 * WHY SQLITE AND NOT MEMORY. A session in a Map would vanish on every restart
 * and — more importantly — could not be REVOKED from anywhere but the process
 * holding it. "Disable this person now" is the feature this whole stage is for,
 * and it has to survive a deploy.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./index.js";
import { getUserUnscoped, type User } from "./users.js";

/**
 * Absolute lifetime. A session dies on this schedule no matter how active it
 * is, which bounds what a stolen cookie is worth. One working day: long enough
 * not to interrupt someone mid-task, short enough that a laptop left at a café
 * overnight is not a standing grant.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Idle timeout. Closes an unattended browser on a shared machine — a job the
 * absolute deadline cannot do, because it cannot tell "working" from "walked
 * away".
 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * How stale `last_seen_at` may get before we write it again.
 *
 * NOT ZERO, ON PURPOSE. Bumping on every request would put a disk write in
 * front of every page load, against the single synchronous connection that also
 * serialises every spend-cap check under `BEGIN IMMEDIATE` — a read-heavy
 * dashboard would be writing constantly and slowing down payments to do it. A
 * minute of imprecision on a thirty-minute timeout is not worth that.
 */
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

/** 32 CSPRNG bytes, the same strength as the OAuth `state` in src/db/qbo.ts. */
const TOKEN_BYTES = 32;

export interface SessionUser {
  sessionId: string;
  user: User;
}

/** The stored id for a cookie value. Hex SHA-256; not reversible. */
function idFor(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mints a session and returns the cookie value — THE ONLY TIME IT EXISTS
 * outside the browser. Nothing logs it, nothing stores it, and no accessor can
 * hand it back later, because the row does not contain it.
 */
export function createSession(userId: string): { token: string; expiresAt: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(idFor(token), userId, new Date(now).toISOString(), expiresAt, new Date(now).toISOString());
  return { token, expiresAt };
}

/**
 * A cookie value to the person holding it, or null.
 *
 * EVERY REASON TO REFUSE IS CHECKED HERE, not spread across callers: revoked,
 * past its absolute deadline, idle too long, or belonging to a user who has
 * been disabled. A caller that forgot one of those would be a silent
 * authentication bypass, so there is exactly one place to forget it.
 *
 * Returns null for every failure without distinguishing them. The caller has no
 * use for the difference and an attacker would.
 */
export function resolveSession(token: string, now = Date.now()): SessionUser | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(idFor(token)) as
    | { id: string; user_id: string; expires_at: string; last_seen_at: string; revoked_at: string | null }
    | undefined;
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (Date.parse(row.expires_at) <= now) return null;
  if (now - Date.parse(row.last_seen_at) >= SESSION_IDLE_MS) return null;

  const user = getUserUnscoped(row.user_id);
  // A disabled user's live sessions are revoked when they are disabled; this is
  // the second line, so a session that somehow outlives that still stops here.
  if (!user || user.disabledAt !== null) return null;

  if (now - Date.parse(row.last_seen_at) >= LAST_SEEN_WRITE_INTERVAL_MS) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
  }
  return { sessionId: row.id, user };
}

/** Sign-out. Idempotent: revoking an already-revoked session changes nothing. */
export function revokeSession(sessionId: string): void {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
    new Date().toISOString(),
    sessionId,
  );
}

/**
 * Ends every live session a user holds. Called when they are disabled — without
 * it, "disabled" would only mean "cannot sign in again", and someone already
 * signed in would keep their access for up to twelve hours.
 */
export function revokeSessionsForUser(userId: string): number {
  const result = db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), userId);
  return Number(result.changes);
}

/**
 * Exported for tests only: proves a stored id is the hash of a cookie value and
 * not the value itself. Constant-time out of habit rather than need.
 */
export function storedIdMatches(token: string, storedId: string): boolean {
  const a = Buffer.from(idFor(token));
  const b = Buffer.from(storedId);
  return a.length === b.length && timingSafeEqual(a, b);
}
