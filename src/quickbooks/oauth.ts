/**
 * The OAuth 2.0 authorization-code handshake with Intuit.
 *
 * Three steps: build a consent URL, exchange the returned code for tokens, and
 * refresh those tokens before they lapse.
 *
 * NO PKCE, DELIBERATELY. Intuit documents exactly five authorization
 * parameters — client_id, response_type, scope, redirect_uri, state — and
 * `code_challenge` is not among them. Sending one anyway would be worse than
 * omitting it: a server that ignores the challenge still issues the code, so
 * the flow would appear hardened while providing nothing, and the next person
 * to read it would reasonably assume the interception attack was covered.
 *
 * What actually protects this flow:
 *   - Fuel's backend is a CONFIDENTIAL client. It holds `client_secret` server
 *     side and presents it at token exchange, which is the protection PKCE
 *     substitutes for in public clients that cannot keep a secret.
 *   - The redirect URI is registered with Intuit and matched exactly, so a code
 *     cannot be redirected somewhere else.
 *   - `state` is 32 random bytes, stored durably, bound to one company, and
 *     consumed exactly once (src/db/qbo.ts).
 *
 * Revisit if Intuit ever ships PKCE support. See ADR 0008.
 */
import { randomBytes } from "node:crypto";
import { requireEnv } from "../lib/env.js";
import { QBO_AUTHORIZE_URL, QBO_ID_TOKEN_ISSUER, QBO_SCOPE, QBO_TOKEN_URL } from "./config.js";

/** The CSRF token. 32 bytes from a CSPRNG — not a UUID, which is partly structured. */
export function newState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Where to send the operator to grant access.
 *
 * The redirect URI is read from env rather than derived from the request:
 * Intuit matches it character for character against what is registered on the
 * app, so it has to be one fixed known value, not whatever host the operator
 * happened to browse to.
 */
export function authorizeUrl(state: string): string {
  const url = new URL(QBO_AUTHORIZE_URL);
  url.searchParams.set("client_id", requireEnv("QBO_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QBO_SCOPE);
  url.searchParams.set("redirect_uri", requireEnv("QBO_REDIRECT_URI"));
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TokenGrant {
  accessToken: string;
  /** ISO timestamps, computed from the relative lifetimes Intuit returns. */
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  /**
   * Intuit's ID token, present on the authorization-code exchange because
   * `openid` is in the scope; absent on a refresh. Read once, by the callback,
   * to learn which company was granted (see `grantedRealm`). Never stored,
   * never logged.
   */
  idToken?: string;
}

interface IntuitTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Intuit authenticates the token endpoint with HTTP Basic over the client id
 * and secret — not a body parameter.
 */
function basicAuthHeader(): string {
  const credentials = `${requireEnv("QBO_CLIENT_ID")}:${requireEnv("QBO_CLIENT_SECRET")}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

/**
 * Posts to the token endpoint and normalises the answer.
 *
 * Uses the global fetch rather than src/lib/safe-fetch.ts, and that is a
 * considered choice: safeFetch exists to stop a CALLER-SUPPLIED url reaching
 * private network space, which is not the risk here — this URL is a module
 * constant. Worse, safeFetch strips the Authorization header across an origin
 * change, so an Intuit redirect would silently drop the Basic credentials and
 * surface as a confusing 401 rather than an error.
 *
 * The error path is written carefully. `body` may carry `error_description`,
 * which is safe to surface, but the request we sent carries the client secret
 * and possibly a refresh token — so nothing about the request is ever included,
 * and the raw error object is never logged. See the warning in src/lib/env.ts.
 */
async function requestToken(form: Record<string, string>): Promise<TokenGrant> {
  const response = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });

  const body = (await response.json().catch(() => ({}))) as IntuitTokenResponse;

  if (!response.ok) {
    // error_description is Intuit's own prose about what was wrong with the
    // grant; it does not echo the credential.
    const detail = body.error_description ?? body.error ?? "no detail";
    throw new Error(`QuickBooks token request failed (HTTP ${response.status}): ${detail}`);
  }

  if (!body.access_token || !body.refresh_token) {
    // Deliberately does not print the body: a partial success could contain one
    // of the two tokens, and this message may be logged.
    throw new Error("QuickBooks token response was missing a token");
  }

  const now = Date.now();
  return {
    accessToken: body.access_token,
    // Intuit returns relative lifetimes. Converting to absolute timestamps at
    // the boundary means everything downstream compares clocks, not durations,
    // and a token that sat in a queue is not treated as fresher than it is.
    accessExpiresAt: new Date(now + (body.expires_in ?? 3600) * 1000).toISOString(),
    refreshToken: body.refresh_token,
    refreshExpiresAt: new Date(
      now + (body.x_refresh_token_expires_in ?? 100 * 24 * 3600) * 1000,
    ).toISOString(),
    ...(typeof body.id_token === "string" ? { idToken: body.id_token } : {}),
  };
}

/**
 * Intuit did not say, in a form Fuel can rely on, which company it granted.
 *
 * The message names the failed check and nothing else: never the token, never
 * a claim value. An ID token is a credential-shaped string, and an error
 * message is the easiest way for one to reach a log.
 */
export class IdTokenError extends Error {
  constructor(check: string) {
    super(`The QuickBooks ID token failed a check (${check}), so the company it grants is unknown`);
    this.name = "IdTokenError";
  }
}

/**
 * THE QUICKBOOKS COMPANY INTUIT GRANTED, as Intuit states it (7A-3 item 4,
 * ADR 0017).
 *
 * WHY THIS AND NOT THE REDIRECT, AND NOT A READ. The redirect's `realmId` is
 * whatever the browser sent. And a successful read of a named company proves
 * less than it looks: measured against the live sandbox, a token asked for
 * another company its Intuit user can reach is answered 200, with the token's
 * OWN company. So someone with Intuit access to another business's books could
 * consent for their own, edit `realmId`, and pass a read-based check. The ID
 * token's `realmid` claim (listed in Intuit's discovery document) is Intuit's
 * own statement of which company this grant is for.
 *
 * WHAT IS CHECKED: the shape, the issuer (pinned), that the audience includes
 * our client id, that it has not expired, and that `realmid` is a non-empty
 * string.
 *
 * WHAT IS NOT: the signature, deliberately. This token arrived in the direct
 * response from Intuit's token endpoint (a pinned URL, over TLS), to a request
 * authenticated with our client secret. OpenID Connect Core 3.1.3.7(6) allows
 * TLS server validation in place of the signature in exactly that case.
 * Checking it would add a second network dependency (Intuit's key set) to
 * defend against someone who can already forge Intuit's TLS. This function
 * must therefore never be given an ID token from anywhere else: a browser, a
 * query string, a stored value.
 */
export function grantedRealm(idToken: string | undefined, now: number = Date.now()): string {
  if (typeof idToken !== "string" || idToken.length === 0) throw new IdTokenError("present");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new IdTokenError("shape");

  let claims: Record<string, unknown>;
  try {
    const payload = parts[1]!;
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error("not base64url");
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    claims = parsed as Record<string, unknown>;
  } catch {
    throw new IdTokenError("payload");
  }

  if (claims.iss !== QBO_ID_TOKEN_ISSUER) throw new IdTokenError("issuer");
  const clientId = requireEnv("QBO_CLIENT_ID");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) throw new IdTokenError("audience");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) throw new IdTokenError("expiry");
  if (typeof claims.realmid !== "string" || claims.realmid.length === 0) throw new IdTokenError("realmid");
  return claims.realmid;
}

/** Step two: the authorization code becomes a token pair. */
export function exchangeCode(code: string): Promise<TokenGrant> {
  return requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: requireEnv("QBO_REDIRECT_URI"),
  });
}

/**
 * Step three, and the one with a trap.
 *
 * Intuit rotates the refresh token roughly every 24 hours and FORCE-EXPIRES the
 * previous one the moment a new one is issued. So the returned refresh token
 * must be persisted before anything else happens — a process that refreshes,
 * uses the access token, and crashes before saving has destroyed its own
 * connection, and only a manual re-authorisation brings it back.
 *
 * That ordering is enforced by the caller (src/quickbooks/client.ts), which
 * saves before using. It is noted here because this is where the returned value
 * originates and where someone would reasonably look for the warning.
 */
export function refreshTokens(refreshToken: string): Promise<TokenGrant> {
  return requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
}
