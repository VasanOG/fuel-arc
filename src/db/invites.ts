/**
 * Invites: the only door into the product.
 *
 * Two kinds, and the difference is the whole security story of this file:
 *
 *   - A JOINING invite carries a company id. An owner mints it for someone they
 *     want in THEIR company, and the route that does so writes its own
 *     `companyOf(req)` — the caller never names a company.
 *   - A FOUNDING invite carries NULL, and redeeming it creates a company. No
 *     route can mint one; only `scripts/mint-invite.ts`, behind an explicit
 *     flag. This is what keeps "a second real company exists" deliberate.
 *
 * REDEMPTION IS THE INTERESTING PART. It creates a user — and sometimes a
 * company — and marks the invite used, and all of that has to be one atomic
 * step. Two people racing the same token must not both get an account, and a
 * signup that fails on a taken email must leave the invite usable rather than
 * burning it on a failed attempt. Both fall out of doing the work inside one
 * `BEGIN IMMEDIATE` and letting a rollback undo the mark.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createCompany } from "./companies.js";
import { db } from "./index.js";
import { createUser, normaliseEmail, type User, type UserRole } from "./users.js";

/** How long an unredeemed invite stays good. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 CSPRNG bytes, the same strength as a session token and an OAuth state. */
const TOKEN_BYTES = 32;

export interface Invite {
  id: string;
  /** NULL means redeeming this creates a company. */
  companyId: string | null;
  email: string;
  role: UserRole;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
}

interface InviteRow {
  id: string;
  token_hash: string;
  company_id: string | null;
  email: string;
  role: UserRole;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  revoked_at: string | null;
}

function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    companyId: row.company_id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    revokedAt: row.revoked_at,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mints one, and returns the token — THE ONLY TIME IT EXISTS outside whoever
 * receives it. The row holds a hash, so nothing can hand it back later.
 *
 * `companyId: null` is the founding kind. This function does not police who may
 * ask for one; its callers do, and they are deliberately few — the route always
 * passes its own company, and only the script passes null.
 */
export function createInvite(params: {
  companyId: string | null;
  email: string;
  role: UserRole;
}): { invite: Invite; token: string } {
  if (params.companyId === null && params.role !== "owner") {
    // Also a CHECK in the schema. Both, because this one can say why.
    throw new Error("an invite that creates a company must make its first member an owner");
  }
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO invites (id, token_hash, company_id, email, role, created_at, expires_at,
                          redeemed_at, redeemed_by, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(
    id,
    hashToken(token),
    params.companyId,
    normaliseEmail(params.email),
    params.role,
    new Date(now).toISOString(),
    new Date(now + INVITE_TTL_MS).toISOString(),
  );
  return { invite: getInviteInCompany(id, params.companyId)!, token };
}

/**
 * An invite by id, scoped to the company that owns it. `null` matches the
 * founding kind, which no company owns — only the script reads those.
 */
export function getInviteInCompany(id: string, companyId: string | null): Invite | null {
  const row = (
    companyId === null
      ? db.prepare("SELECT * FROM invites WHERE id = ? AND company_id IS NULL").get(id)
      : db.prepare("SELECT * FROM invites WHERE id = ? AND company_id = ?").get(id, companyId)
  ) as InviteRow | undefined;
  return row ? toInvite(row) : null;
}

export function listInvites(companyId: string): Invite[] {
  const rows = db
    .prepare("SELECT * FROM invites WHERE company_id = ? ORDER BY created_at DESC")
    .all(companyId) as unknown as InviteRow[];
  return rows.map(toInvite);
}

/** Withdraws an unused invite. False if it does not exist, or was already used or withdrawn. */
export function revokeInvite(id: string, companyId: string): boolean {
  const result = db
    .prepare(
      `UPDATE invites SET revoked_at = ?
        WHERE id = ? AND company_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL`,
    )
    .run(new Date().toISOString(), id, companyId);
  return Number(result.changes) === 1;
}

/**
 * WHY EVERY FAILURE IS ONE TYPE WITH ONE MESSAGE.
 *
 * Signup is reachable with no credential at all. Telling a caller which part
 * was wrong — no such token, expired, wrong address — turns it into an oracle:
 * "expired" confirms a token was real, and "wrong address" confirms who an
 * invite was for. None of that helps the legitimate recipient, who has the
 * whole link in front of them.
 */
export class InviteNotUsableError extends Error {
  constructor() {
    super("that invitation is not valid, or has already been used");
    this.name = "InviteNotUsableError";
  }
}

/**
 * Redeems an invite: creates the user, creates the company if this is a
 * founding invite, and marks the invite used — atomically, or not at all.
 *
 * THE CALLER HASHES THE PASSWORD FIRST, deliberately. scrypt is async and this
 * connection is synchronous, so the hash cannot happen inside the transaction
 * without holding the write lock — and therefore every spend-cap check in the
 * process — for ~67ms.
 *
 * ORDER INSIDE THE TRANSACTION IS LOAD-BEARING. The invite is marked used LAST,
 * after the user exists. A failure before that point (a taken email, most
 * likely) rolls the whole thing back and leaves the invite usable, so a typo
 * does not cost somebody their only way in.
 *
 * WHAT THE TRANSACTION IS ACTUALLY FOR, stated precisely because break-testing
 * corrected the first version of this comment. There is no in-process race to
 * prevent: this function contains no `await`, so Node runs it to completion
 * before touching a second request, and two concurrent HTTP signups are
 * serialised by JavaScript rather than by SQLite. The transaction earns its
 * place twice over anyway — it makes the rollback above atomic, and it is the
 * ONLY thing standing between two PROCESSES holding this file. That second case
 * is tested for real, by two operating-system processes striking at one
 * timestamp, in scripts/verify-migration.ts.
 *
 * SINGLE-USE WAS REDUNDANT UNTIL ADR 0018, AND NOW CARRIES WEIGHT. Break-testing
 * once removed the `redeemed_at` check and the UPDATE's guard and the suite
 * kept passing, because `users.email` was unique across the whole platform: a
 * second redemption named an address that already had an account, and was
 * refused for that. Addresses are now unique per company. For a JOINING invite
 * that still holds (same company, same address), but a FOUNDING invite makes a
 * NEW company each time, where the address has no account yet. So without
 * these guards one founding invite could create company after company. They
 * are now the only thing preventing it, and verify-api tests exactly that: a
 * founding invite redeemed twice makes one company.
 *
 * What is also tested is the observable consequence: a redeemed invite records
 * who redeemed it, which fails if the UPDATE goes away.
 */
export function redeemInvite(params: {
  token: string;
  email: string;
  passwordHash: string;
  companyName?: string;
}): User {
  const email = normaliseEmail(params.email);
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(hashToken(params.token)) as
      | InviteRow
      | undefined;

    // Every reason to refuse, checked here and reported identically.
    if (
      !row ||
      row.redeemed_at !== null ||
      row.revoked_at !== null ||
      Date.parse(row.expires_at) <= Date.now() ||
      row.email !== email
    ) {
      throw new InviteNotUsableError();
    }

    const companyId =
      row.company_id ??
      createCompany({
        name: (params.companyName ?? "").trim() || `${email}'s company`,
        // No spending authority until a person sets one. A new company that
        // could spend the moment it existed would be a cap nobody chose.
        spendCapBaseUnits: 0n,
      }).id;

    const user = createUser({
      companyId,
      email,
      passwordHash: params.passwordHash,
      role: row.role,
    });

    const { changes } = db
      .prepare("UPDATE invites SET redeemed_at = ?, redeemed_by = ? WHERE id = ? AND redeemed_at IS NULL")
      .run(now, user.id, row.id);
    if (Number(changes) !== 1) {
      // Unreachable while BEGIN IMMEDIATE serialises writers. If it ever fires,
      // two redemptions overlapped and this one must not stand.
      throw new InviteNotUsableError();
    }

    db.exec("COMMIT");
    return user;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    /*
     * Everything propagates unchanged, including EmailTakenError from
     * `createUser`.
     *
     * THAT ONE IS DELIBERATELY NOT FLATTENED into the generic invite refusal,
     * even though every other reason here is. It is about the caller's OWN
     * address, which they already know and could learn just as easily by
     * trying to sign in — so hiding it would cost a real person a clear
     * message and tell an attacker nothing they could not get elsewhere. The
     * refusals that ARE flattened all disclose something about the invite,
     * which the caller may not be entitled to know.
     */
    throw error;
  }
}
