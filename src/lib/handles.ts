/**
 * A company's handle: how a person names their company when they sign in.
 *
 * WHY SIGN-IN NEEDS ONE AT ALL. An email address is unique within a company,
 * not across the platform (ADR 0018). While it was global, one company's owner
 * could learn whether an address had an account ANYWHERE, by inviting it and
 * redeeming their own invite, and could claim an address so its real owner
 * could never join their own company. With addresses per company, "which
 * account?" needs a company, and the person TYPES it. Fuel never lists which
 * companies an address belongs to, which is the only way a company question at
 * sign-in could leak.
 *
 * AN ADDRESS, NOT A SECRET. It is shown to everyone in the company and passed
 * on with an invite code.
 *
 * THE SUFFIX IS RANDOM, NEVER "-2". A readable slug plus four random
 * characters (`acme-7k2q`). The obvious scheme, `acme` and then `acme-2` on a
 * clash, would tell whoever received `acme-2` that a company called Acme is
 * already here: the same kind of cross-company leak this exists to close. On
 * the rare random clash, only the random part is drawn again, which shows
 * nobody anything.
 *
 * No database access here, so the schema file and `createCompany` can share it
 * without an import cycle.
 */
import { randomBytes } from "node:crypto";

/** No 0/o, 1/l/i: a handle is read aloud and retyped. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SUFFIX_LENGTH = 4;
const SLUG_MAX = 24;

/** The readable part: lowercase letters, digits and single hyphens. */
export function handleSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug || "company";
}

/** A fresh handle for a company with this name. Unique only with high probability; callers retry on a clash. */
export function newHandle(name: string): string {
  const bytes = randomBytes(SUFFIX_LENGTH);
  let suffix = "";
  for (const byte of bytes) suffix += ALPHABET[byte % ALPHABET.length];
  return `${handleSlug(name)}-${suffix}`;
}

/** What a handle looks like. Anything else is refused before it reaches a query. */
export const HANDLE_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A typed handle, as the sign-in lookup compares it: trimmed and lowercased. */
export function normaliseHandle(handle: string): string {
  return handle.trim().toLowerCase();
}
