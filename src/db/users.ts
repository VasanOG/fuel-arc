/**
 * People, as opposed to credentials.
 *
 * A user belongs to exactly one company. That is the whole reason this table
 * exists: `companyOf(req)` has until now come from a key bound to the recorded
 * bootstrap company, which is a property of the SERVER. Reading it from the
 * user's own row makes it a property of WHO IS ASKING, which is what tenant
 * isolation actually requires (ADR 0009: "the company predicate is a seam, not
 * tenant isolation").
 */
import { randomUUID } from "node:crypto";
import { normaliseHandle } from "../lib/handles.js";
import { db } from "./index.js";

export type UserRole = "owner" | "operator";

export interface User {
  id: string;
  companyId: string;
  email: string;
  role: UserRole;
  createdAt: string;
  disabledAt: string | null;
}

interface UserRow {
  id: string;
  company_id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
  disabled_at: string | null;
}

/**
 * The ONE form an address is compared and stored in.
 *
 * Lowercased and trimmed, and nothing else. Deliberately NOT stripping `+tags`
 * or dots: `a+fuel@x.com` is a different mailbox from `a@x.com` at some
 * providers and the same at others, and guessing wrong in the direction of
 * "these are the same person" would let one invite be redeemed by an address it
 * was not issued to. Guessing wrong the other way merely means two accounts,
 * which is visible and fixable.
 *
 * Every comparison in this codebase — the UNIQUE index, the login lookup, the
 * invite check — goes through this function. A comparison that normalises only
 * one side is the bug this exists to prevent, and verify-api asserts it.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    companyId: row.company_id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

/**
 * Thrown when the address already has an account IN THIS COMPANY. The UNIQUE
 * (company_id, email) constraint is what detects it. An account at another
 * company never raises it: that is the whole of ADR 0018.
 */
export class EmailTakenError extends Error {
  constructor() {
    super("that email address already has an account in this company");
    this.name = "EmailTakenError";
  }
}

export function createUser(params: {
  companyId: string;
  email: string;
  passwordHash: string;
  role: UserRole;
}): User {
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO users (id, company_id, email, password_hash, role, created_at, disabled_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(id, params.companyId, normaliseEmail(params.email), params.passwordHash, params.role, new Date().toISOString());
  } catch (error) {
    // The index is the authority on uniqueness, not a prior SELECT: two signups
    // in the same instant both pass a check-then-insert, and only the constraint
    // is atomic with the write.
    if (/UNIQUE constraint failed: users\.(company_id, users\.)?email/.test((error as Error).message)) {
      throw new EmailTakenError();
    }
    throw error;
  }
  return getUserUnscoped(id)!;
}

/**
 * A user by id, UNSCOPED. Internal only — see `getAgentUnscoped` for the same
 * warning. Its one legitimate caller is session resolution, where the id came
 * from a session row and there is nothing to scope it BY. verify-api asserts no
 * route file calls it.
 */
export function getUserUnscoped(id: string): User | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

/**
 * The login lookup: a company handle and an address to one account and its
 * stored hash.
 *
 * THE COMPANY IS NAMED BY THE PERSON SIGNING IN (ADR 0018). An address is
 * unique within a company, not across the platform, so the handle is what makes
 * the answer one row. There is deliberately no lookup by address alone: "which
 * companies does this address belong to?" is the question Fuel must never
 * answer.
 *
 * Returns the hash, which is why this is the only accessor that does. A caller
 * that wants a user without a credential in hand uses the functions above.
 */
export function findUserForLogin(companyHandle: string, email: string): (User & { passwordHash: string }) | null {
  const row = db
    .prepare(
      `SELECT users.* FROM users JOIN companies ON companies.id = users.company_id
        WHERE companies.handle = ? AND users.email = ?`,
    )
    .get(normaliseHandle(companyHandle), normaliseEmail(email)) as UserRow | undefined;
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}

export function listUsers(companyId: string): User[] {
  const rows = db
    .prepare("SELECT * FROM users WHERE company_id = ? ORDER BY created_at")
    .all(companyId) as unknown as UserRow[];
  return rows.map(toUser);
}

/** Company-scoped: a user id from one company can never disable another's. */
export function getUserInCompany(id: string, companyId: string): User | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ? AND company_id = ?").get(id, companyId) as
    | UserRow
    | undefined;
  return row ? toUser(row) : null;
}

/**
 * How many people can still sign in for this company.
 *
 * Read by the rule that stops a shared key deciding approvals once real
 * identities exist: a company with nobody able to sign in has no better option
 * than the key, and refusing there would strand it.
 */
export function activeUserCount(companyId: string): number {
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND disabled_at IS NULL")
    .get(companyId) as { n: number };
  return n;
}

/** Returns false if the user was already disabled or does not exist. */
export function disableUser(id: string, companyId: string): boolean {
  const result = db
    .prepare("UPDATE users SET disabled_at = ? WHERE id = ? AND company_id = ? AND disabled_at IS NULL")
    .run(new Date().toISOString(), id, companyId);
  return Number(result.changes) === 1;
}
