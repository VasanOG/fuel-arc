/**
 * The closed vocabulary of SIGNUP refusals.
 *
 * WHY THIS IS ITS OWN MODULE WITH NO IMPORTS. It is the same reason
 * `dashboard/lib/session-cookie.ts` exists: a value that both the server and
 * the browser build need has to live somewhere neither one drags the other
 * into. `src/auth/routes.ts` pulls in express, the session store and three
 * database modules, so importing this constant from there would invite a
 * bundler to follow those edges into the dashboard build — at best a broken
 * build, at worst server internals reachable from client-bundled code. Nothing
 * here imports anything, so nothing can come with it.
 *
 * A CODE, NOT THE MESSAGE. A browser signing somebody up has to tell a bad
 * invite from a short password, or it cannot say anything useful. What it must
 * never do is print a sentence the server sent: a page that renders
 * server-supplied text on Fuel's own origin is a phishing surface we would have
 * built ourselves, which is why `NOTICES` in the dashboard's sign-in page is a
 * closed lookup rather than a passthrough. A code gives that lookup a key, so
 * the wording stays the dashboard's and the meaning stays ours.
 *
 * ONE CODE FOR EVERY UNUSABLE INVITE, deliberately. Forged, expired, revoked
 * and addressed-to-somebody-else all answer `invite_unusable`, exactly as they
 * all answer one message — see InviteNotUsableError in src/db/invites.ts for
 * why. Splitting them here would rebuild the enumeration oracle that error
 * exists to prevent, in a field far easier to read than prose.
 *
 * `email_taken` is separate for the reason redeemInvite records: it is about
 * the caller's OWN address, which they already know and could learn by trying
 * to sign in, so hiding it costs a real person clarity and tells an attacker
 * nothing they could not get elsewhere.
 *
 * LOGIN IS DELIBERATELY NOT GIVEN CODES. Its single refusal is meant to be
 * indistinguishable, and a code there would be the first crack in that.
 */
export const SIGNUP_CODES = [
  "incomplete",
  "invite_unusable",
  "password_weak",
  "email_taken",
  "throttled",
  "busy",
] as const;

export type SignupCode = (typeof SIGNUP_CODES)[number];

/**
 * The closed vocabulary of RELAY refusals, on BOTH sign-in and signup (ADR 0020).
 *
 * These are not login refusals, and the rule above still holds: a sign-in that
 * fails on its credentials still gets the one code-less 401. These describe the
 * dashboard's relay to the API — a relay key that is wrong or from a peer not
 * allowed (`relay_rejected`, on the 403 and on the 429 once that peer is
 * throttled, so a relay fault never reads as a person's lockout), or a trusted
 * relay naming no usable client
 * address (`malformed_client_address`). They are identical for every account
 * and every password, so they say nothing about any account; they exist so the
 * dashboard can tell "the relay is misconfigured" from "wrong password" and
 * never show a person the second when the truth is the first.
 *
 * A browser never reaches them. The dashboard maps both to its own
 * "could not reach Fuel" notice and never renders the code.
 */
export const RELAY_CODES = ["relay_rejected", "malformed_client_address"] as const;

export type RelayCode = (typeof RELAY_CODES)[number];
