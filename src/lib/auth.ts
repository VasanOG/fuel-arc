/**
 * Who is calling, and what that lets them do.
 *
 * Two disjoint credentials, not one. Slice 2 gave us a pause and an audit
 * trail for payments above a ceiling, but a single shared key meant the same
 * holder could request a payment and approve it — a two-party control with one
 * party. The role is derived from WHICH secret was presented, never from
 * anything the caller says about itself: a role in a header or body would be
 * self-asserted, and anyone holding a key could claim any role.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { bootstrapCompany, getCompanyUnscoped, type Company } from "../db/companies.js";
import { resolveSession, type SessionUser } from "../db/sessions.js";
import type { UserRole } from "../db/users.js";
import { requireEnv } from "./env.js";

export type Role = "operator" | "agent";

/**
 * Who is calling: a role AND the company it acts for, never one without the
 * other.
 *
 * Until 7A-1 `authenticate` resolved only a Role, and every route supplied the
 * company itself by calling `getDefaultCompany()`. The tenant was therefore a
 * property of the server, not of the credential — ADR 0009's "a seam, not
 * tenant isolation" in one sentence. Carrying `companyId` on the principal
 * makes it a property of who presented what.
 *
 * A DISCRIMINATED UNION, whose arms name HOW the caller was identified. It had
 * one arm until Stage 3 and now has two: the shared keys, and a signed-in
 * person. EVERY ARM IS REQUIRED TO CARRY `companyId`, so no arm can be added
 * without saying whose company it acts for, and a route cannot read a role
 * without a tenant arriving alongside it. That requirement is what made adding
 * the session arm a matter of filling in fields rather than revisiting ~44
 * route sites: `roleOf` and `companyOf` did not change.
 */
export type Principal =
  | {
      /**
       * One of the two shared secrets from the environment. Stated-legacy:
       * bound to the bootstrap company recorded in the database, and to
       * nothing else. It names no person, which is why `userOf` returns null
       * for it and why Stage 3 refuses it the powers that create identities.
       */
      via: "legacy-key";
      role: Role;
      companyId: string;
    }
  | {
      /**
       * A signed-in person. THE ARM THE ONE-ARM COMMENT ABOVE ANTICIPATED.
       *
       * `companyId` comes from the USER'S OWN ROW, not from the bootstrap
       * binding — which is the difference between a company that is a property
       * of the server and one that is a property of who is asking.
       */
      via: "session";
      role: Role;
      companyId: string;
      userId: string;
      userRole: UserRole;
      /** The stored session id (a hash), so sign-out can revoke exactly this one. */
      sessionId: string;
    };

declare global {
  namespace Express {
    interface Request {
      /** Set by `authenticate`; read via `roleOf` and `companyOf`. */
      principal?: Principal;
    }
  }
}

// Read once at boot so a missing key fails the server immediately, the same
// way X402_PAY_TO and TEST_PAYER_PRIVATE_KEY already do.
const operatorKey = requireEnv("FUEL_API_KEY");
const agentKey = requireEnv("FUEL_AGENT_KEY");

// Both values are ours, so a plain comparison is fine — there is no attacker
// on this path. Refusing to boot matters more than it looks: setting both to
// the same string would silently collapse the split back into one credential
// that can do everything, which is the exact gap this split exists to close,
// with no error and no visible symptom. Fail loudly instead.
if (operatorKey === agentKey) {
  throw new Error(
    "FUEL_API_KEY and FUEL_AGENT_KEY must be different secrets. " +
      "Identical values would let one credential both spend and approve, " +
      "which defeats the point of having two.",
  );
}

// Hashing both sides to a fixed length before comparing means a wrong-length
// guess can't throw (timingSafeEqual requires equal-length buffers) or be
// distinguished by length, so the check stays constant-time either way.
const operatorHash = createHash("sha256").update(operatorKey).digest();
const agentHash = createHash("sha256").update(agentKey).digest();

/*
 * RESOLVED AT BOOT, like the keys themselves, so an unanswerable binding stops
 * the server before it serves anything rather than on the first request.
 *
 * Held for the life of the process. The binding is recorded once and never
 * rewritten, so there is nothing to refresh — and a value that could change
 * between two requests is the one shape of this that would be worth worrying
 * about.
 */
const legacyCompanyId = bootstrapCompany().id;

/**
 * The role a presented token grants, or null.
 *
 * Both comparisons always run — deliberately not short-circuited with `||`.
 * Short-circuiting would make a valid operator key take one comparison and a
 * valid agent key two, and that timing difference leaks which role a stolen
 * key holds. Costs nothing to avoid.
 */
function roleFor(presented: string): Role | null {
  const presentedHash = createHash("sha256").update(presented).digest();
  const isOperator = timingSafeEqual(presentedHash, operatorHash);
  const isAgent = timingSafeEqual(presentedHash, agentHash);
  if (isOperator) return "operator";
  if (isAgent) return "agent";
  return null;
}

/** The session cookie's name. One place, so a rename cannot half-happen. */
export const SESSION_COOKIE = "fuel_session";

/**
 * One cookie out of the header, without a dependency.
 *
 * `cookie-parser` is a fine library and this is ten lines for the single cookie
 * Fuel sets; see src/lib/passwords.ts for the same reasoning about scrypt. It
 * takes the FIRST occurrence of the name: a request carrying the cookie twice
 * (a real technique — set a second one on a parent domain and hope the server
 * reads the attacker's) must not have its meaning decided by whichever the
 * parser happened to keep last.
 */
function cookieFrom(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return null; // malformed percent-encoding is not a credential
    }
  }
  return null;
}

/**
 * The signed-in person a raw `Cookie` header belongs to, or null.
 *
 * For the one route that needs to know WHO is calling but cannot sit behind
 * `authenticate`: the QuickBooks OAuth callback, reached by a browser redirect
 * from Intuit, which carries no bearer token (7A-3 item 4, ADR 0017). It asks
 * whether the person bringing the code back is the one who started the link.
 *
 * The same parser and the same `resolveSession` as `authenticate`, not a
 * second reading of either. Two definitions of "signed in" would be two places
 * for a revoked or disabled session to be forgotten. It takes the request, not
 * the header, so this file stays the only one that reads the cookie header
 * (verify-api's source guard).
 */
export function sessionFromRequest(req: Request): SessionUser | null {
  const cookie = cookieFrom(req.header("cookie"), SESSION_COOKIE);
  return cookie ? resolveSession(cookie) : null;
}

/**
 * Resolves WHO is calling — a signed-in person or a shared key — or rejects
 * with 401. Mounted once, ahead of every /api route, so no route is reachable
 * unauthenticated.
 *
 * COOKIE AND BEARER ARE MUTUALLY EXCLUSIVE, AND BOTH TOGETHER IS A REFUSAL.
 * Not "cookie wins", not "bearer wins": a request presenting two credentials is
 * asking the server to choose, and "which one wins" is precisely the ambiguity
 * an attacker picks at — a stolen key smuggled alongside a victim's cookie, or
 * a victim's cookie ridden in alongside an attacker's key (the classic CSRF
 * shape, where the browser attaches the cookie automatically). Refusing costs
 * an honest caller nothing: no legitimate client holds both.
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  const bearer = scheme === "Bearer" && token ? token : null;
  const cookie = cookieFrom(req.header("cookie"), SESSION_COOKIE);

  if (bearer && cookie) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (cookie) {
    const session = resolveSession(cookie);
    if (!session) {
      return res.status(401).json({ error: "unauthorized" });
    }
    req.principal = {
      via: "session",
      // A SESSION IS ALWAYS AN OPERATOR AND NEVER AN AGENT. The agent
      // credential is machine-to-machine: it moves money, and nothing a
      // browser holds should be able to. Written as a literal rather than
      // derived from anything on the user, so no data change can make a
      // session pay.
      role: "operator",
      companyId: session.user.companyId,
      userId: session.user.id,
      userRole: session.user.role,
      sessionId: session.sessionId,
    };
    return next();
  }

  if (!bearer) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const role = roleFor(bearer);
  if (!role) {
    return res.status(401).json({ error: "unauthorized" });
  }

  req.principal = { via: "legacy-key", role, companyId: legacyCompanyId };
  next();
}

/**
 * Restricts a route to specific roles, with 403 for an authenticated caller
 * holding the wrong one.
 *
 * 401 and 403 are kept distinct on purpose: "I don't know you" and "I know you
 * and you may not do this" are different problems with different fixes, and
 * collapsing them would make a misconfigured key look like a missing one.
 */
export function requireRole(...allowed: Role[]) {
  // Generic in P, the route's params type, rather than the plain `Request`
  // default. A middleware typed as `Request` hands Express's overload an
  // inference candidate for P, which collapses every route it guards from
  // `{ id: string }` to the catch-all `ParamsDictionary` — where `id` is
  // `string | string[]`. Staying generic contributes no candidate, so guarded
  // routes keep the param types they had before the guard was added.
  return function guard<P>(req: Request<P>, res: Response, next: NextFunction) {
    const role = roleOf(req);
    if (!allowed.includes(role)) {
      return res.status(403).json({
        error: `this endpoint requires the ${allowed.join(" or ")} credential`,
      });
    }
    next();
  };
}

/**
 * The authenticated principal, or a thrown error if somehow unset.
 *
 * Unreachable while `authenticate` is mounted ahead of every route — which is
 * the point: if that mount is ever removed, this throws a 500 rather than
 * quietly treating an unauthenticated caller as permitted.
 */
function principalOf(req: { principal?: Principal }): Principal {
  if (!req.principal) {
    throw new Error("principal is not set — authenticate must run before any route");
  }
  return req.principal;
}

export function roleOf(req: { principal?: Principal }): Role {
  return principalOf(req).role;
}

/**
 * The company this request acts for — the ONLY source of one a route may use.
 *
 * Throws rather than defaulting, for the same reason `roleOf` does: a missing
 * principal means the auth mount is broken, and the fallback that would make
 * this "work" is a company the caller never proved they belong to.
 */
export function companyOf(req: { principal?: Principal }): string {
  return principalOf(req).companyId;
}

/**
 * WHICH PERSON is calling, or null when a shared key is.
 *
 * Null is a real answer, not a missing one: the legacy keys name no individual,
 * and a decision made with one honestly has no author. Callers record what this
 * returns (see `decided_by` on an approval) rather than substituting a
 * placeholder — inventing "system" or the bootstrap owner's id would be
 * fabricating an audit trail, which is worse than admitting the gap.
 */
export function userOf(req: { principal?: Principal }): string | null {
  const principal = principalOf(req);
  return principal.via === "session" ? principal.userId : null;
}

/** The signed-in principal, or null for a key. For routes that need the session itself. */
export function sessionOf(
  req: { principal?: Principal },
): Extract<Principal, { via: "session" }> | null {
  const principal = principalOf(req);
  return principal.via === "session" ? principal : null;
}

/**
 * CSRF: a cookie-authenticated write must come from our own origin.
 *
 * WHY THIS IS NEEDED WHEN `SameSite=Lax` EXISTS. Lax is the first line and a
 * good one, but it is the BROWSER's promise, not ours: it does not cover every
 * browser Fuel might be opened in, and Lax still permits top-level navigations,
 * so a form POST is not as unreachable as it sounds. Two independent layers,
 * where the second is enforced by the server, is the same belt-and-braces the
 * dashboard's cap route already uses.
 *
 * ONLY SESSIONS ARE CHECKED. A bearer key carries no ambient authority — a
 * browser will not attach it to a cross-site request on its own, which is the
 * entire mechanism CSRF depends on. Applying this to key callers would break
 * every script and buy nothing.
 *
 * ABSENT `Origin` IS ALLOWED, deliberately. curl and other non-browser clients
 * send none, and a signed-in operator deciding an approval from a shell is a
 * workflow this stage explicitly keeps working. Browsers DO send it on exactly
 * the cross-site writes this is here to stop, which is what makes the check
 * meaningful despite the gap.
 *
 * Compares against the `Host` header rather than anything derived: the
 * dashboard learned the hard way that a framework's idea of its own origin can
 * normalise to `localhost` regardless of what the server is bound to.
 */
export function sameOriginForSessions(req: Request, res: Response, next: NextFunction) {
  const principal = req.principal;
  if (!principal || principal.via !== "session") return next();
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  const origin = req.header("origin");
  const host = req.header("host");
  if (origin && host && URL.parse(origin)?.host !== host) {
    return res.status(403).json({ error: "cross-origin request rejected" });
  }
  next();
}

/**
 * Restricts a route to a signed-in OWNER.
 *
 * Two refusals, kept distinct, because they have different fixes:
 *   - a shared key gets 403 saying this needs a signed-in person. The legacy
 *     keys are deliberately barred from every power that MAKES AN IDENTITY —
 *     inviting, managing users, creating a company. A secret that names nobody
 *     should not be able to decide who else exists.
 *   - a signed-in operator gets 403 saying it needs an owner.
 */
export function requireOwner() {
  return function guard<P>(req: Request<P>, res: Response, next: NextFunction) {
    const principal = principalOf(req);
    if (principal.via !== "session") {
      return res.status(403).json({
        error: "this endpoint requires a signed-in owner; a shared API key cannot manage accounts",
      });
    }
    if (principal.userRole !== "owner") {
      return res.status(403).json({ error: "this endpoint requires an owner" });
    }
    next();
  };
}

/**
 * The caller's own company, as a row.
 *
 * Lives here rather than in src/api.ts because it is the one legitimate use of
 * an unscoped company lookup: the id came from the authenticated principal, so
 * there is nothing to scope it BY. Keeping it beside `companyOf` lets the
 * route layer stay free of every `*Unscoped` accessor without exception.
 *
 * Throws rather than 404ing: a principal naming a company that does not exist
 * is a server fault, not a request for something missing.
 */
export function companyFor(req: { principal?: Principal }): Company {
  const company = getCompanyUnscoped(companyOf(req));
  if (!company) throw new Error("the authenticated principal names a company that does not exist");
  return company;
}
