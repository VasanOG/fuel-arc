/**
 * Authenticated calls to the QuickBooks Online sandbox.
 *
 * Everything that reaches Intuit goes through here, which makes this the one
 * place four guarantees have to hold: the URL is on the sandbox origin, the
 * access token is fresh, nothing secret escapes into a log or an error, and --
 * when the caller names one -- the request goes to the QuickBooks company it
 * was meant for and no other (7A-3).
 *
 * NOTHING IN THIS FILE RETRIES A MUTATION ON ITS OWN. A create that may have
 * landed is the caller's problem to resolve deliberately (see
 * src/db/qbo-postings.ts and its `pending` state), because retrying a document
 * creation is exactly how a customer's expenses get doubled. The idempotency
 * key exists so that a retry the OPERATOR chooses is safe — not so this layer
 * can retry quietly.
 */
import { assertSandboxUrl, companyUrl, QBO_MINOR_VERSION } from "./config.js";
import { refreshTokens } from "./oauth.js";
import {
  connectionSecrets,
  getConnection,
  saveConnection,
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
} from "../db/qbo.js";

/** Intuit is comfortably fast; this only needs to bound a hung socket. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Intuit's duplicate-document-number fault. Named because it is load-bearing below. */
export const DUPLICATE_DOC_NUMBER_CODE = "6140";

export class NotConnectedError extends Error {
  constructor() {
    super("QuickBooks is not connected. Connect it from the dashboard first.");
    this.name = "NotConnectedError";
  }
}

/**
 * The request was meant for one QuickBooks company, and the connection now
 * points at another. Thrown BEFORE anything is sent.
 *
 * WHY THIS LIVES HERE AND NOT IN THE CALLERS. A caller can compare realms
 * before it starts, but every call below resolves the realm from the
 * connection afresh, across awaits -- so a check at the top of a multi-request
 * operation can be overtaken by another process reconnecting the company to
 * different books halfway through. The only check that cannot be overtaken is
 * the one made against the realm the URL is actually about to be built from,
 * after the token is resolved and immediately before the request exists.
 *
 * `definitelyNoEffect` is not on this error, deliberately: it is not a
 * QboApiError, so a posting path that marks attempts failed on a provable
 * no-op does not reach that branch. Nothing was sent -- but the attempt this
 * belongs to may already have landed in its OWN books on an earlier try, and
 * releasing its lines would book the spend twice.
 *
 * The message names no realm (ADR 0010). It says what to do instead.
 */
export class RealmMismatchError extends Error {
  constructor() {
    super(
      "This was made in a different QuickBooks company from the one connected now, so Fuel " +
        "will not send it there. Reconnect the QuickBooks company it was made in to act on it.",
    );
    this.name = "RealmMismatchError";
  }
}

export class QboApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /**
   * True when we can prove the request had no effect. A validation refusal is
   * safe to treat as "nothing happened"; a timeout or a 5xx is not, and the
   * caller must leave its posting `pending` rather than assume.
   */
  readonly definitelyNoEffect: boolean;

  constructor(params: {
    message: string;
    status: number;
    code: string | null;
    definitelyNoEffect: boolean;
  }) {
    super(params.message);
    this.name = "QboApiError";
    this.status = params.status;
    this.code = params.code;
    this.definitelyNoEffect = params.definitelyNoEffect;
  }
}

interface IntuitFault {
  Fault?: {
    Error?: { Message?: string; Detail?: string; code?: string }[];
    type?: string;
  };
}

/**
 * Turns an Intuit error body into one readable line.
 *
 * Reads ONLY the response body, never the request or the error object — the
 * same rule `describe` in src/lib/env.ts states, and it matters more here
 * because the outgoing headers carry a bearer token for a customer's books.
 *
 * `Detail` is preferred over `Message` because Intuit's `Message` is usually a
 * category ("Invalid Reference Id") while `Detail` names the actual field.
 */
function faultMessage(body: unknown, status: number): { message: string; code: string | null } {
  const fault = (body as IntuitFault)?.Fault?.Error?.[0];
  if (!fault) return { message: `QuickBooks returned HTTP ${status}`, code: null };

  const parts = [fault.Detail, fault.Message].filter(Boolean);
  return {
    message: parts.length > 0 ? parts.join(" — ") : `QuickBooks returned HTTP ${status}`,
    code: fault.code ?? null,
  };
}

/**
 * Returns a usable access token, refreshing first if it is close to expiry.
 *
 * THE ORDERING HERE IS THE WHOLE POINT. Intuit rotates the refresh token
 * roughly daily and force-expires its predecessor the moment a new one is
 * issued. So the new pair is PERSISTED BEFORE the new access token is used for
 * anything: a process that refreshes, makes its call, and dies before saving
 * has destroyed its own connection, and only a manual re-authorisation brings
 * it back. Saving first costs one write and removes that failure entirely.
 */
/**
 * The Intuit company id (realm) for a Fuel company.
 *
 * Separate from `accessTokenFor` because some paths need the realm to build the
 * URL — `companyinfo/{realmId}` is addressed by it — and asking for a token
 * would trigger a refresh for something that is only string interpolation.
 */
export function realmFor(companyId: string): string {
  const connection = getConnection(companyId);
  if (!connection) throw new NotConnectedError();
  return connection.realmId;
}

async function accessTokenFor(companyId: string): Promise<{ token: string; realmId: string }> {
  const connection = getConnection(companyId);
  const secrets = connectionSecrets(companyId);
  if (!connection || !secrets) throw new NotConnectedError();

  const expiresAt = new Date(secrets.accessExpiresAt).getTime();
  if (expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_MARGIN_MS) {
    return { token: secrets.accessToken, realmId: connection.realmId };
  }

  const grant = await refreshTokens(secrets.refreshToken);
  saveConnection({
    companyId,
    realmId: connection.realmId,
    accessToken: grant.accessToken,
    accessExpiresAt: grant.accessExpiresAt,
    refreshToken: grant.refreshToken,
    refreshExpiresAt: grant.refreshExpiresAt,
  });
  console.log(`[quickbooks] refreshed access token for company ${connection.realmId}`);

  return { token: grant.accessToken, realmId: connection.realmId };
}

interface RequestOptions {
  method: "GET" | "POST";
  /** Path under /v3/company/<realm>/, e.g. "journalentry" or "query". */
  path: string;
  body?: unknown;
  /**
   * Intuit's idempotency key, sent as the `requestid` QUERY PARAMETER — not a
   * header, which is the easy thing to assume. Repeating a value makes Intuit
   * replay its original response instead of acting again, which is what makes
   * an operator-chosen retry safe.
   */
  requestId?: string;
  /** Raw query string for the `query` endpoint. */
  query?: string;
  /**
   * The QuickBooks company this request must reach. When given, a connection
   * pointing anywhere else -- or a recorded realm of null, meaning Fuel cannot
   * say where the thing belongs -- is refused before the request exists.
   * Omitted only by calls about the connection itself (reading the company
   * profile, the currency), which have no prior record to be pinned to.
   */
  expectedRealm?: string | null;
}

/**
 * One authenticated call.
 *
 * The sandbox assertion happens on the fully-built URL, after query parameters
 * are attached, so nothing can be smuggled in through a path fragment.
 */
export async function qboRequest<T>(companyId: string, options: RequestOptions): Promise<T> {
  // A CHEAP REFUSAL FIRST, before the token is resolved. Not the authoritative
  // check -- that is the one below, against the realm actually addressed --
  // but resolving a token can REFRESH it, and a refresh rotates and persists
  // the connected company's credentials. A request that is going to be refused
  // has no business doing that to someone's live connection on the way out.
  if (options.expectedRealm !== undefined) {
    const current = getConnection(companyId);
    if (current !== null && current.realmId !== options.expectedRealm) {
      throw new RealmMismatchError();
    }
  }

  const { token, realmId } = await accessTokenFor(companyId);

  // Against the realm the URL is about to be built from -- after the token
  // (and any refresh) resolved, and with no await between here and fetch.
  if (options.expectedRealm !== undefined && options.expectedRealm !== realmId) {
    throw new RealmMismatchError();
  }

  const url = new URL(companyUrl(realmId, options.path));
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  if (options.requestId) url.searchParams.set("requestid", options.requestId);
  if (options.query) url.searchParams.set("query", options.query);

  // Checked again on the final string. companyUrl already asserted, but that
  // was before the query parameters existed, and this is the value actually
  // sent.
  assertSandboxUrl(url.toString());

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (caught) {
    // A transport failure proves nothing about whether the request arrived.
    // definitelyNoEffect stays false so a caller leaves its posting `pending`.
    throw new QboApiError({
      message: `Could not reach QuickBooks: ${(caught as Error).message}`,
      status: 0,
      code: null,
      definitelyNoEffect: false,
    });
  }

  const body = (await response.json().catch(() => ({}))) as unknown;

  if (!response.ok) {
    const { message, code } = faultMessage(body, response.status);
    throw new QboApiError({
      message,
      status: response.status,
      code,
      // A 4xx is Intuit rejecting the document outright, so nothing was
      // created. A 429 or 5xx may have been processed before the response was
      // lost, so it is NOT safe to call it a no-op.
      definitelyNoEffect: response.status >= 400 && response.status < 500 && response.status !== 429,
    });
  }

  return body as T;
}

/**
 * Whether a freshly granted access token WORKS against the QuickBooks company
 * the callback names. A liveness check, NOT the proof of which company was
 * granted.
 *
 * IT USED TO BE THAT PROOF, AND IT WAS WRONG. It assumed a token only reads the
 * company it was granted for. The live sandbox (2026-09-23, 7A-3 item 4) showed
 * otherwise: a token asked for ANOTHER company its Intuit user can reach is
 * answered 200, with the token's OWN company. A company nobody on the account
 * owns is still refused (401). So a 200 here means "this Intuit user can reach
 * that company", which someone editing `realmId` to another business they have
 * access to would pass. The proof is now the ID token's `realmid`
 * (`grantedRealm` in oauth.ts), checked before this runs. See ADR 0017.
 *
 * Deliberately NOT qboRequest: that resolves a token from a SAVED connection,
 * and this runs precisely before anything may be saved. The sandbox guard is
 * applied the same way, to the final URL.
 *
 * Three answers, because two are not enough: a 401/403/404 is Intuit saying
 * this token does not reach that company ("refused"); a transport failure, 429
 * or 5xx proves nothing either way ("unknown"). Both refuse the connection --
 * the difference is only what the operator is told.
 */
export async function grantReachesRealm(
  accessToken: string,
  realmId: string,
): Promise<"authorized" | "refused" | "unknown"> {
  const url = new URL(companyUrl(realmId, `companyinfo/${encodeURIComponent(realmId)}`));
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  assertSandboxUrl(url.toString());

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return "unknown";
  }
  if (response.ok) return "authorized";
  if (response.status === 401 || response.status === 403 || response.status === 404) return "refused";
  return "unknown";
}

/** A SELECT against Intuit's query endpoint, optionally pinned to one QuickBooks company. */
export function qboQuery<T>(
  companyId: string,
  statement: string,
  expectedRealm?: string | null,
): Promise<T> {
  return qboRequest<T>(companyId, {
    method: "GET",
    path: "query",
    query: statement,
    ...(expectedRealm !== undefined ? { expectedRealm } : {}),
  });
}

/**
 * Escapes a value for Intuit's query language.
 *
 * Their syntax is SQL-like and there is no parameter binding, so a value with a
 * quote in it would otherwise change the shape of the statement. Every caller
 * here passes values Fuel generated, but an account name reaches this from
 * configuration, and "we control the input today" is precisely the assumption
 * this project has already been bitten by once.
 */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
