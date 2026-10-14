/**
 * Signing in, signing out, and asking who you are.
 *
 * WHY LOGIN IS MOUNTED OUTSIDE `authenticate`. It is the one route whose whole
 * purpose is to be reachable without a credential — the same structural
 * exception the QuickBooks OAuth callback already is (see src/server.ts). What
 * stands in for authentication here is a password check that costs ~67ms, a
 * rate limit in front of it, and a refusal that says nothing about which half
 * was wrong.
 *
 * Sign-out and `me` are NOT here structurally — they need a resolved session,
 * so they live on the authenticated router in src/api.ts and are exported from
 * this file as handlers.
 */
import type { Request, Response } from "express";
import { Router } from "express";
import { companyFor, SESSION_COOKIE, sessionOf } from "../lib/auth.js";
import { Buckets } from "../lib/buckets.js";
import { relayConfigFrom, resolveClient, type RelayConfig } from "../lib/client-key.js";
import { HANDLE_SHAPE, normaliseHandle } from "../lib/handles.js";
import {
  burnHashingTime,
  hashPassword,
  HashingBusyError,
  verifyPassword,
  WeakPasswordError,
} from "../lib/passwords.js";
import { createSession, revokeSession, SESSION_TTL_MS } from "../db/sessions.js";
import { EmailTakenError } from "../db/users.js";
import { findUserForLogin, getUserInCompany, normaliseEmail } from "../db/users.js";
import { InviteNotUsableError, redeemInvite } from "../db/invites.js";

/**
 * ONE MESSAGE FOR EVERY WAY TO FAIL.
 *
 * Unknown address, wrong password, disabled account — all the same sentence and
 * the same status. Distinguishing them would turn the login form into an
 * account-enumeration tool: "no such user" tells an attacker which of a leaked
 * address list is worth attacking, and "this account is disabled" tells them a
 * real person is behind it. The person who genuinely forgot which address they
 * used loses very little by comparison.
 */
const REFUSAL = "that company, email and password do not match an account";

/*
 * The refusal vocabulary lives in ./codes.ts, which imports nothing — so the
 * dashboard can read it without dragging express and the database layer into a
 * browser build. Re-exported here because this is where callers expect it.
 */
export { SIGNUP_CODES, type SignupCode } from "./codes.js";

/**
 * Two keyspaces, because they stop different attacks.
 *
 * Per email bounds guessing at ONE account from anywhere — the case a single
 * address-based limit misses entirely, since a distributed attempt arrives from
 * many addresses. Per address bounds one machine spraying MANY accounts, which
 * an email-only limit misses just as completely. Neither is redundant.
 *
 * The window is long (15 minutes) and the limits are low, because a person
 * signing in legitimately does it once or twice.
 */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Sign-in attempts allowed per account, and per client, in one window.
 *
 * DEFAULTS ARE THE LIMITS ABOVE (5 and 20) and almost every deployment should
 * keep them. They exist as settings for one case: a public demo where many
 * people share ONE published account and arrive through one proxy, so every
 * sign-in -- successful ones count too -- lands in the same two buckets and
 * the sixth judge in fifteen minutes would be refused. A published password
 * gains nothing from a low guess limit; it is the lockout that costs.
 *
 * Read once at load, like the relay config, and refused outright when not a
 * whole number from 1 to 1000, so a typo stops the server instead of
 * silently meaning "no limit".
 */
export function loginLimitsFrom(env: Record<string, string | undefined>): { perAccount: number; perClient: number } {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > 1000) {
      throw new Error(`${name} must be a whole number from 1 to 1000, not ${JSON.stringify(raw)}`);
    }
    return n;
  };
  return { perAccount: read("FUEL_LOGIN_PER_ACCOUNT", 5), perClient: read("FUEL_LOGIN_PER_CLIENT", 20) };
}
export const LOGIN_LIMITS = loginLimitsFrom(process.env);
/**
 * Keyed on the ACCOUNT, which since ADR 0018 is a company handle plus an
 * address. Keyed on the address alone, failures at one company would throttle
 * the same address at another: a person at company B could lock out, and
 * watch the 429s of, someone at company A.
 */
const byEmail = new Buckets(LOGIN_LIMITS.perAccount, ATTEMPT_WINDOW_MS);
const accountKey = (companyHandle: string, email: string) => `${companyHandle}\u0000${email}`;

/**
 * ONE BUCKET PER CLIENT, AND TWO ROUTES WITH SEPARATE BUCKETS.
 *
 * The dashboard calls Fuel SERVER-SIDE, so every browser request arrives from
 * the dashboard's own address. Keyed on that address, one shared bucket counted
 * every browser together: nineteen anonymous posts to the public signup page
 * made `/login` answer 429 to everybody (measured in 7A-2). 7A-2c split login
 * from signup, which contained the damage without fixing it.
 *
 * THE FIX IS WHO THE KEY NAMES (ADR 0020). `resolveClient` in
 * src/lib/client-key.ts keys a relayed attempt on the CLIENT the dashboard
 * vouches for (`client:...`), and anything else on its own socket peer
 * (`peer:...`). A direct caller can never choose its bucket: the address header
 * is read only from a request carrying the relay key from an allowed peer.
 *
 * The two routes still keep separate buckets, for the reason 7A-2c recorded: a
 * page anybody can post to should not share a counter with the product's door.
 */
const byLoginAddress = new Buckets(LOGIN_LIMITS.perClient, ATTEMPT_WINDOW_MS);
const bySignupAddress = new Buckets(20, ATTEMPT_WINDOW_MS);

/**
 * THE RELAYED CEILING: a limit that does not depend on the claimed address.
 *
 * Added after security review of the plan (F1, F2). Per-client buckets alone
 * leave two things open:
 *   - PASSWORD SPRAYING. One guess at each of many DIFFERENT accounts never
 *     trips the per-account limit, so the per-address bucket is the only thing
 *     in its way — and a leaked relay key, or a client with many addresses,
 *     gets a fresh one per attempt.
 *   - EVICTION. `Buckets` drops its oldest live keys past `MAX_TRACKED_KEYS`.
 *     Enough new account keys, from enough addresses, would evict a victim's
 *     per-account counter between guesses and reset it.
 *
 * So relayed attempts also count against one fixed key per route, checked only
 * AFTER the per-client bucket passes and BEFORE the per-account one. That bounds
 * spraying, scrypt work, and how many new account or token keys a window can
 * create — kept below `MAX_TRACKED_KEYS` by `relayConfigFrom`, which is what
 * makes eviction of a live counter unreachable THROUGH THE RELAY. Direct
 * callers are not under this ceiling; see `resolveClient` for why that is
 * acceptable today and ADR 0020 for when it stops being.
 *
 * THE PRICE, STATED: enough coordinated clients (25 at the default of 500) can
 * exhaust it and lock everyone out for the window. That is the shared-bucket
 * outage again, but it now takes a distributed attacker, not one browser.
 *
 * One pair per router, because the ceiling is part of the router's relay
 * config; the registry lets `resetLoginLimits` clear them all.
 */
const RELAYED = "relayed";
const ceilings = new Set<Buckets>();

/**
 * The relay configuration this process runs with, read once at module load so
 * a misconfiguration stops the server before it serves anything.
 */
export const RELAY_CONFIG: RelayConfig = relayConfigFrom(process.env);

/**
 * Signup is counted on the TOKEN, because the token is what an attacker would
 * be guessing. Counting the claimed email instead would let them vary the
 * address and grind tokens unbounded.
 *
 * This is the limit that actually bounds the attack that matters on signup, and
 * unlike the address buckets it does NOT collapse behind a proxy: a token key
 * is the same key no matter who relays the request.
 */
const byToken = new Buckets(5, ATTEMPT_WINDOW_MS);

/** Test seam, mirroring `resetLimiter` in the gateway. */
export function resetLoginLimits(): void {
  byEmail.clear();
  byLoginAddress.clear();
  bySignupAddress.clear();
  byToken.clear();
  for (const ceiling of ceilings) ceiling.clear();
}

/*
 * A RELAY PROBLEM IS NOT A WRONG PASSWORD. It answers 403 or 400 with a code
 * from RELAY_CODES (./codes.ts), never login's code-less 401, so the dashboard
 * can tell "the relay is misconfigured" from "those credentials do not match"
 * (security review, F7). The literals are written inline in each handler on
 * purpose: verify-api's closed-vocabulary check reads every `code:` a handler
 * emits, and a constant defined out here would walk straight past it.
 */

/**
 * Whether the session cookie is marked `Secure`, from the ENVIRONMENT and never
 * from the request.
 *
 * THE FIRST VERSION OF THIS READ `req.hostname`, AND SECURITY REVIEW WAS RIGHT
 * TO REJECT IT. `req.hostname` comes from the `Host` header. The reasoning was
 * that a wrong answer would fail safely — `Secure` set on a plain-http dev
 * server, which breaks visibly — but that only considered one direction. The
 * dangerous one is ordinary and quiet: a reverse proxy that forwards to the
 * app's loopback address WITHOUT passing the original host (an nginx or Caddy
 * config missing `proxy_set_header Host $host`) makes every real request arrive
 * saying `Host: localhost`. The app would then drop `Secure` from every
 * production session cookie, and nothing would look wrong.
 *
 * So it is an explicit deployment fact, resolved ONCE at module load like
 * `FUEL_API_KEY` and the token encryption key, and it cannot vary per request
 * no matter what a caller or a proxy sends.
 *
 * DEFAULTS TO ON. A missing variable in production has to be safe; a missing
 * variable in development costs one line in `.env`. Only the exact string
 * "false" turns it off, so a typo, an empty value or a stray "0" leaves the
 * protection in place rather than silently removing it.
 */
export function secureCookiesFrom(env: Record<string, string | undefined>): boolean {
  return env.FUEL_COOKIE_SECURE !== "false";
}

const SECURE_COOKIES = secureCookiesFrom(process.env);

/**
 * The attributes the cookie is set with, and cleared with.
 *
 * ONE OBJECT FOR BOTH, deliberately. `clearCookie` only works if its attributes
 * match the ones the cookie was set with; two literals that must agree are two
 * literals that will eventually disagree, and the symptom would be a sign-out
 * that appears to work while the browser quietly keeps the cookie.
 */
const COOKIE_ATTRIBUTES = {
  httpOnly: true, // JavaScript in the page can never read it, so an XSS cannot steal it
  sameSite: "lax", // not sent on cross-site POSTs; the first line against CSRF
  secure: SECURE_COOKIES,
  path: "/",
} as const;

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { ...COOKIE_ATTRIBUTES, maxAge: SESSION_TTL_MS });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, COOKIE_ATTRIBUTES);
}

/**
 * What a signed-in caller is told about itself. An explicit allowlist built
 * field by field, never a spread of a row — the same rule ADR 0009 sets for
 * payments, and the reason no password hash can ever fall out of here.
 *
 * NO COMPANY NAME. The first version of this looked the company up to include
 * it, which meant the login route — a route — performing an unscoped company
 * read. The source guard in verify-api caught it, and the guard was right: the
 * name is not login's to fetch. A signed-in caller reads it from
 * `GET /api/company`, which is scoped by the principal that now exists.
 */
function presentUser(user: { id: string; email: string; role: string }) {
  return { id: user.id, email: user.email, role: user.role };
}

export interface PublicAuthOptions {
  /** Defaults to the process's own `RELAY_CONFIG`. Tests pass others. */
  relay?: RelayConfig;
}

export function publicAuthRouter(options: PublicAuthOptions = {}): Router {
  const router = Router();
  const relay = options.relay ?? RELAY_CONFIG;
  const loginCeiling = new Buckets(relay.relayedCeiling, ATTEMPT_WINDOW_MS);
  const signupCeiling = new Buckets(relay.relayedCeiling, ATTEMPT_WINDOW_MS);
  ceilings.add(loginCeiling);
  ceilings.add(signupCeiling);

  /**
   * Signing in names the company, by its handle (ADR 0018). An address is
   * unique within a company, not across the platform, so without the company
   * there is no single account to check.
   *
   * ONE REFUSAL, ONE COST, FOR EVERY WAY TO BE WRONG: an unknown handle, an
   * unknown address at a real handle, a wrong password, a disabled account.
   * The handle adds a way to be wrong, and it gets no message and no timing of
   * its own. A handle that is not even handle-shaped is checked the same way
   * (the lookup simply finds nothing), so its shape cannot answer faster either.
   */
  router.post("/login", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { company?: unknown; email?: unknown; password?: unknown };
    const company = typeof body.company === "string" ? normaliseHandle(body.company) : "";
    const email = typeof body.email === "string" ? normaliseEmail(body.email) : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!company || !email || !password) {
      return res.status(400).json({ error: "company, email and password are required" });
    }

    const client = resolveClient(req, relay);
    if (client.kind === "rejected") {
      // Counted against the presenting peer, and THROTTLED once it is spent:
      // counting without refusing would let a peer guess at the relay key
      // forever at the cost of one hash a try (commit-1 review, F1).
      // Still `relay_rejected` when throttled: a 429 without it is
      // indistinguishable from a person's own lockout, and the dashboard would
      // tell somebody THEY had tried too often when its own key was wrong.
      if (byLoginAddress.exceeded(client.peerKey)) {
        return res.status(429).json({ error: "too many sign-in attempts; try again later", code: "relay_rejected" });
      }
      return res.status(403).json({ error: "relay credential rejected", code: "relay_rejected" });
    }
    if (client.kind === "malformed") {
      return res.status(400).json({ error: "malformed client address", code: "malformed_client_address" });
    }

    // Limits are checked BEFORE the hash, which is the expensive part. Checking
    // after would let a flood impose ~67ms and 32MB of work per attempt no
    // matter how low the limit was set. The ORDER of these three matters:
    // client, then the relayed ceiling, then the account — so an attempt the
    // client limit refuses spends nothing of the ceiling, and nothing past the
    // ceiling ever creates a per-account key.
    if (
      byLoginAddress.exceeded(client.key) ||
      (client.kind === "relayed" && loginCeiling.exceeded(RELAYED)) ||
      byEmail.exceeded(accountKey(company, email))
    ) {
      return res.status(429).json({ error: "too many sign-in attempts; try again later" });
    }

    try {
      const found = HANDLE_SHAPE.test(company) ? findUserForLogin(company, email) : null;
      if (!found) {
        // Burn the same time an existing account would cost. Without this, an
        // unknown address (or company) answers in about a millisecond and a
        // real one in sixty-seven, which is a free oracle for which exist.
        await burnHashingTime(password);
        return res.status(401).json({ error: REFUSAL });
      }

      const ok = await verifyPassword(password, found.passwordHash);
      // Checked AFTER the hash, deliberately: returning early for a disabled
      // account would make it answer faster than an active one and re-open the
      // timing oracle for exactly the accounts worth knowing about.
      if (!ok || found.disabledAt !== null) {
        return res.status(401).json({ error: REFUSAL });
      }

      // No company lookup here: `users.company_id` is a foreign key, so a user
      // naming a company that does not exist cannot be written in the first
      // place. Checking anyway would be a route reaching for an unscoped read
      // to defend against something the schema already prevents.
      const { token } = createSession(found.id);
      setSessionCookie(res, token);
      // The token is in the Set-Cookie header and NOWHERE in the body. A body
      // copy would be readable by any script the page loads, which is exactly
      // what HttpOnly exists to prevent.
      return res.status(200).json({ user: presentUser(found) });
    } catch (error) {
      if (error instanceof HashingBusyError) {
        // 503, not 401: "we could not check" is not "you are wrong", and
        // answering 401 here would lock a legitimate person out under load.
        return res.status(503).json({ error: error.message });
      }
      throw error;
    }
  });

  /**
   * Redeeming an invite: the only way an account is created.
   *
   * UNAUTHENTICATED AND UNAVOIDABLY SO — the person has no account yet, which
   * is the point. The invite token IS the credential, and every property that
   * makes that safe lives below or in src/db/invites.ts: it is 32 CSPRNG bytes,
   * stored only as a hash, bound to one address, single-use under a guarded
   * update inside one transaction, and expiring in a week.
   *
   * RATE LIMITED ON THE TOKEN, not on the email. The attack this bounds is
   * guessing a token, so the count has to follow the thing being guessed. A
   * per-email limit would let an attacker grind tokens all day by varying the
   * address they claim.
   */
  router.post("/signup", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      token?: unknown;
      email?: unknown;
      password?: unknown;
      companyName?: unknown;
    };
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const email = typeof body.email === "string" ? normaliseEmail(body.email) : "";
    const password = typeof body.password === "string" ? body.password : "";
    const companyName = typeof body.companyName === "string" ? body.companyName : undefined;
    if (!token || !email || !password) {
      return res
        .status(400)
        .json({ error: "token, email and password are required", code: "incomplete" });
    }

    const client = resolveClient(req, relay);
    if (client.kind === "rejected") {
      // `relay_rejected`, not `throttled`, for the reason login records.
      if (bySignupAddress.exceeded(client.peerKey)) {
        return res.status(429).json({ error: "too many attempts; try again later", code: "relay_rejected" });
      }
      return res.status(403).json({ error: "relay credential rejected", code: "relay_rejected" });
    }
    if (client.kind === "malformed") {
      return res.status(400).json({ error: "malformed client address", code: "malformed_client_address" });
    }

    // Client, then the relayed ceiling, then the token: the same order and the
    // same reasons as login.
    if (
      bySignupAddress.exceeded(client.key) ||
      (client.kind === "relayed" && signupCeiling.exceeded(RELAYED)) ||
      byToken.exceeded(token)
    ) {
      return res
        .status(429)
        .json({ error: "too many attempts; try again later", code: "throttled" });
    }

    try {
      // Hashed BEFORE the transaction: scrypt is async and the database
      // connection is synchronous, so hashing inside the write would hold the
      // lock — and every spend-cap check behind it — for the whole derivation.
      // A weak password is refused here, before the invite is even looked at,
      // so a bad password costs the invite nothing.
      const passwordHash = await hashPassword(password);
      const user = redeemInvite({ token, email, passwordHash, companyName });

      // Signed in immediately. The alternative is redirecting someone who has
      // just proved they hold a single-use invite to a login form, where their
      // first act is to re-enter the password they set a second ago.
      const { token: sessionToken } = createSession(user.id);
      setSessionCookie(res, sessionToken);
      return res.status(201).json({ user: presentUser(user) });
    } catch (error) {
      /*
       * The message on each of these is UNCHANGED, and that matters: a `curl`
       * caller and every existing assertion see exactly what they saw before.
       * The code is additive, and it is the only part the dashboard reads.
       */
      if (error instanceof WeakPasswordError) {
        return res.status(400).json({ error: error.message, code: "password_weak" });
      }
      if (error instanceof EmailTakenError) {
        return res.status(409).json({ error: error.message, code: "email_taken" });
      }
      if (error instanceof InviteNotUsableError) {
        return res.status(400).json({ error: error.message, code: "invite_unusable" });
      }
      if (error instanceof HashingBusyError) {
        return res.status(503).json({ error: error.message, code: "busy" });
      }
      throw error;
    }
  });

  return router;
}

/** GET /auth/me — mounted on the authenticated router. */
export function handleMe(req: Request, res: Response) {
  const session = sessionOf(req);
  if (!session) {
    return res.status(404).json({ error: "no session; this request used an API key" });
  }
  // The company-scoped accessor, even though the id came from the session and
  // could not be anyone else's. The unscoped sibling would also work here and
  // that is exactly why it is not used: the one justified exception is how the
  // habit erodes. (The name is not written out even in this comment — the
  // source guard in verify-api reads raw bytes, on purpose, after a previous
  // version was fooled by preprocessing.)
  const user = getUserInCompany(session.userId, session.companyId);
  if (!user) {
    // The session resolved, so the user existed a moment ago. Anything else is
    // a server fault, not a "not found" for the caller to act on.
    console.error(`[auth] session ${session.sessionId} resolved to a user that is not in its company`);
    return res.status(500).json({ error: "could not read the signed-in account" });
  }
  const company = companyFor(req);
  // The handle is how this person tells a colleague which company to sign in
  // to. Their own company's, from their own session: never anyone else's.
  return res.json({ user: presentUser(user), companyName: company.name, companyHandle: company.handle });
}

/** POST /auth/logout — mounted on the authenticated router. */
export function handleLogout(req: Request, res: Response) {
  const session = sessionOf(req);
  if (!session) {
    return res.status(400).json({ error: "no session to sign out of" });
  }
  revokeSession(session.sessionId);
  clearSessionCookie(res);
  return res.json({ signedOut: true });
}
