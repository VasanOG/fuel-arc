/**
 * Verifies the read-only activity and environment contracts added in 5B-2.
 *
 * SAFE BY CONSTRUCTION. Builds a test database in the temp directory
 * (scripts/lib/test-db.ts) and points FUEL_DB_PATH at it before anything
 * touching the database is imported. It never opens `fuel.db`, never moves
 * funds, signs nothing, and reaches
 * no network — the two routes under test are pure reads over SQLite.
 *
 * WHY THIS SCRIPT EXISTS AT ALL. Until now no verification exercised an HTTP
 * route: verify-rollup and verify-quickbooks test pure functions and db-layer
 * functions. But auth, tenancy, query validation, pagination stability and the
 * response field allowlist are all properties OF THE ROUTE, and none of them
 * can be observed from below it. So this builds the real Express app from the
 * exported `api` Router and drives it over a real socket on an ephemeral port.
 * `src/server.ts` calls listen() at import time, so it is deliberately not
 * imported.
 *
 * Run:  npm run verify-api
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";

import { createTestDatabase } from "./lib/test-db.js";

let checks = 0;

function assert(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
}

function assertEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) {
    throw new Error(`FAILED: ${description}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

/**
 * Source with its comments removed.
 *
 * The source-grep checks below ask what the CODE does. Scanning raw text asks
 * something else and gets it wrong in the annoying direction: a comment
 * explaining why a pattern was removed reads as the pattern still being there,
 * and a check that fires on its own documentation is one people learn to
 * silence.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Test credentials, so the suite never depends on — or exercises — real keys. */
const OPERATOR_KEY = `operator-${randomUUID()}`;
const AGENT_KEY = `agent-${randomUUID()}`;
/**
 * The dashboard's relay key (ADR 0020), set on the MAIN app too, so "the relay
 * key is not an API credential" (R11) is asked of an API that actually knows
 * the key — not of one that has never heard of it, where it could not fail.
 * No existing test sends relay headers, so the main app behaves as before.
 */
const RELAY_KEY = `relay-${randomBytes(24).toString("hex")}`;

/**
 * Everything a response must never contain.
 *
 * Two lists doing different jobs. These are KEY NAMES and value fragments that
 * would mean a leak; the no-crypto list below is the terminology ADR 0006 bans
 * from any surface that leaves Fuel.
 */
const FORBIDDEN_FRAGMENTS = [
  "txHash",
  "tx_hash",
  "resourceUrl",
  "resource_url",
  "walletAddress",
  "fireblocks",
  "vault",
  "request_id",
  "requestid",
  "_enc",
  "access_token",
  "refresh_token",
  "spend_cap_base_units",
];

const NO_CRYPTO = ["0x", "usdc", "sepolia", "chain", "wallet", "facilitator", "x402", "eip155"];

async function main(): Promise<void> {
  const scratch = createTestDatabase("api");

  // Set BEFORE any import that reaches src/db/index.ts, which reads
  // FUEL_DB_PATH at module load and opens the file immediately.
  process.env.FUEL_DB_PATH = scratch;
  process.env.FUEL_API_KEY = OPERATOR_KEY;
  process.env.FUEL_AGENT_KEY = AGENT_KEY;
  process.env.FUEL_RELAY_KEY = RELAY_KEY;
  process.env.FUEL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  // This suite drives plain http over loopback, so the session cookie must not
  // be Secure or the assertions below could never see it come back. Set here,
  // explicitly, exactly as a developer's .env does — the default is ON.
  process.env.FUEL_COOKIE_SECURE = "false";
  // NO PATH TO CUSTODY. This suite loads no .env, and these are cleared anyway:
  // if a change ever routed a test request into the real provisioner, it must
  // die at requireEnv on this machine rather than create a sandbox vault.
  delete process.env.FIREBLOCKS_API_KEY;
  delete process.env.FIREBLOCKS_PRIVATE_KEY_PATH;

  const express = (await import("express")).default;
  const { api } = await import("../src/api.js");
  const { authenticate, sameOriginForSessions, SESSION_COOKIE } = await import("../src/lib/auth.js");
  const { publicAuthRouter, resetLoginLimits } = await import("../src/auth/routes.js");
  const { hashPassword, MIN_PASSWORD_LENGTH } = await import("../src/lib/passwords.js");
  const { activeUserCount, createUser, disableUser } = await import("../src/db/users.js");
  const { SESSION_IDLE_MS } = await import("../src/db/sessions.js");
  const { db, DB_PATH } = await import("../src/db/index.js");
  // TD-2. The database this process actually opened is the one just built --
  // not `fuel.db`, which src/db/index.ts falls back to if anything imported it
  // before FUEL_DB_PATH was set.
  assertEqual(DB_PATH, scratch, "TD-2: this suite opened its test database, not fuel.db");
  /**
   * A company's sign-in handle (ADR 0018). Signing in names the company now, so
   * every sign-in below names its user's own. A fixture company inserted with
   * plain SQL after boot has none yet (boot fills them), so it is given a
   * fixed one here -- test-only, and never a company created the real way.
   */
  const handleFor = (companyId: string): string => {
    const row = db.prepare("SELECT handle FROM companies WHERE id = ?").get(companyId) as
      | { handle: string | null }
      | undefined;
    if (!row) throw new Error(`FAILED: no company ${companyId} to name at sign-in`);
    if (row.handle) return row.handle;
    const handle = `fixture-${companyId.slice(0, 8)}`;
    db.prepare("UPDATE companies SET handle = ? WHERE id = ?").run(handle, companyId);
    return handle;
  };
  const { bootstrapCompany } = await import("../src/db/companies.js");
  const { presentStatus, REFUSAL_CODES } = await import("../src/lib/payment-presentation.js");
  const { ledgerStatus, descriptionFromResourceUrl } = await import(
    "../src/lib/export-presentation.js"
  );
  const { describeEnvironment } = await import("../src/lib/environment.js");
  const { ASSET_LABEL, NETWORK_LABEL } = await import("../src/fireblocks/provision.js");

  const app = express();
  app.use(express.json());
  /*
   * THE SAME MOUNT ORDER AS src/server.ts, and asserted to be below.
   *
   * This app is a stand-in for the real one, and a stand-in that is mounted
   * differently tests a server nobody runs. The ordering here is itself a
   * security property — `/api/auth` is deliberately ahead of `authenticate`,
   * and `sameOriginForSessions` deliberately behind it — so it is the last
   * thing that should be allowed to drift between the two files.
   */
  app.use("/api/auth", publicAuthRouter());
  app.use("/api", authenticate, sameOriginForSessions, api);
  /*
   * TEST-ONLY ROUTES THAT FAIL, so the catch-all error handler can be asserted
   * on (E1, E2). The detail string is what must never reach a caller.
   */
  const LEAKY_DETAIL = "SQLITE_CONSTRAINT: UNIQUE constraint failed: secret.detail";
  app.get("/__test/throw", () => {
    throw new Error(LEAKY_DETAIL);
  });
  app.get("/__test/reject", async () => {
    await Promise.resolve();
    throw new Error(LEAKY_DETAIL);
  });
  // An error that is NOT the body parser's but carries a status anyway (E5).
  app.get("/__test/status", () => {
    throw Object.assign(new Error(LEAKY_DETAIL), { status: 403, statusCode: 403 });
  });
  // Last, as in src/server.ts (asserted there as E4).
  const { unhandledErrors } = await import("../src/lib/errors.js");
  app.use(unhandledErrors);

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(
    path: string,
    key: string | null = OPERATOR_KEY,
    /**
     * A session cookie instead of a key. The caller must pass `null` for `key`
     * alongside it — `authenticate` refuses a request carrying both, on purpose,
     * so there is deliberately no way to express "either" here.
     */
    cookie?: string,
  ): Promise<{ status: number; body: any; text: string }> {
    const headers: Record<string, string> = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}${path}`, { headers });
    const text = await res.text();
    let body: any = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* a non-JSON body is itself a finding the caller can assert on */
    }
    return { status: res.status, body, text };
  }

  // Captured before anything runs, so "no document was created" is measured
  // against the state this suite started from.
  const postingsBefore = db.prepare("SELECT COUNT(*) AS n FROM qbo_postings").get() as { n: number };
  const draftsBefore = db
    .prepare("SELECT COUNT(*) AS n FROM qbo_posting_drafts")
    .get() as { n: number };

  try {
    /* ---- auth ---------------------------------------------------------- */
    console.log("\n== auth");
    for (const path of ["/api/activity", "/api/environment"]) {
      assertEqual((await call(path, null)).status, 401, `${path}: no credential is 401`);
      assertEqual((await call(path, "nonsense")).status, 401, `${path}: unknown token is 401`);
      assertEqual((await call(path, AGENT_KEY)).status, 403, `${path}: the agent key is 403`);
      assertEqual((await call(path)).status, 200, `${path}: the operator key is 200`);
    }
    assertEqual(
      (await call("/api/agents/anything", AGENT_KEY)).status,
      403,
      "agents/:id no longer answers the agent credential (hardened in 5B-2)",
    );
    console.log(`   ${checks} checks so far`);

    /* ---- sessions and sign-in ------------------------------------------ */
    console.log("\n== sessions and sign-in");
    {
      /**
       * A full HTTP call with the knobs this section needs: a cookie instead of
       * a key, an Origin header, a method and a body. `call()` above cannot
       * express any of those, and widening it would complicate 3,000 assertions
       * that do not care.
       */
      async function http(
        path: string,
        opts: {
          method?: string;
          key?: string | null;
          cookie?: string | null;
          origin?: string | null;
          body?: unknown;
        } = {},
      ): Promise<{ status: number; body: any; text: string; setCookie: string[] }> {
        const headers: Record<string, string> = {};
        if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
        if (opts.cookie) headers.Cookie = opts.cookie;
        if (opts.origin) headers.Origin = opts.origin;
        if (opts.body !== undefined) headers["content-type"] = "application/json";
        const res = await fetch(`${base}${path}`, {
          method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        const text = await res.text();
        let parsed: any = {};
        try {
          parsed = JSON.parse(text);
        } catch {
          /* asserted on as text */
        }
        return { status: res.status, body: parsed, text, setCookie: res.headers.getSetCookie() };
      }

      // The bootstrap company, read here rather than borrowed from a later
      // section, so this block stands on its own.
      const ownCompany = bootstrapCompany();

      const PASSWORD = "correct-horse-battery-staple";
      const OWNER_EMAIL = `owner-${randomUUID()}@example.com`;
      const owner = createUser({
        companyId: ownCompany.id,
        email: OWNER_EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        role: "owner",
      });

      const login = (email: string, password: string, extra: Record<string, unknown> = {}) =>
        http("/api/auth/login", { body: { company: handleFor(ownCompany.id), email, password }, ...extra });

      /** The cookie header a browser would send back, from a Set-Cookie line. */
      function cookieFromSetCookie(lines: string[]): string {
        const line = lines.find((l) => l.startsWith(`${SESSION_COOKIE}=`));
        if (!line) throw new Error("no session cookie was set");
        return line.split(";")[0]!;
      }

      resetLoginLimits();

      /* --- the happy path, and what the cookie carries ------------------ */
      const good = await login(OWNER_EMAIL, PASSWORD);
      assertEqual(good.status, 200, "a correct email and password signs in");
      assertEqual(good.body.user.id, owner.id, "the response names the user who signed in");
      assertEqual(
        Object.keys(good.body.user).sort().join(","),
        "email,id,role",
        "the signed-in user is an explicit allowlist, not a row",
      );
      const sessionCookie = cookieFromSetCookie(good.setCookie);
      const cookieLine = good.setCookie.find((l) => l.startsWith(`${SESSION_COOKIE}=`))!;
      assert(/HttpOnly/i.test(cookieLine), "the session cookie is HttpOnly, so a script cannot read it");
      assert(/SameSite=Lax/i.test(cookieLine), "the session cookie is SameSite=Lax");
      assert(/Path=\//i.test(cookieLine), "the session cookie is scoped to the whole site");
      assert(
        !/Secure/i.test(cookieLine),
        "with FUEL_COOKIE_SECURE=false it is not Secure, or loopback http could never send it back",
      );
      /*
       * AND THE DEFAULT IS THE OTHER WAY, which is the half that matters.
       *
       * The first version of this decided `Secure` from `req.hostname` — the
       * Host header. Security review rejected it: a reverse proxy that forwards
       * to loopback without passing the original host makes every production
       * request say `Host: localhost`, and the app would silently drop `Secure`
       * from every session cookie. The decision is now an explicit deployment
       * fact read once at boot, so it is tested as a pure function across the
       * values a real .env can hold rather than by faking a request.
       */
      {
        const { secureCookiesFrom } = await import("../src/auth/routes.js");
        assert(secureCookiesFrom({}), "an unset variable leaves the cookie Secure — production is the safe default");
        assert(secureCookiesFrom({ FUEL_COOKIE_SECURE: "" }), "an empty value does not turn Secure off");
        assert(secureCookiesFrom({ FUEL_COOKIE_SECURE: "0" }), "a stray 0 does not turn Secure off");
        assert(secureCookiesFrom({ FUEL_COOKIE_SECURE: "FALSE" }), "a near-miss spelling does not turn Secure off");
        assert(secureCookiesFrom({ FUEL_COOKIE_SECURE: "true" }), "the obvious opposite value keeps it on");
        assert(
          !secureCookiesFrom({ FUEL_COOKIE_SECURE: "false" }),
          "only the exact string false turns it off",
        );
      }
      {
        // And nothing in the request can reach that decision.
        const source = withoutComments(readFileSync(join("src", "auth", "routes.ts"), "utf8"));
        assert(
          !/req\.hostname|req\.header\(\s*["']host["']\s*\)/i.test(source),
          "the cookie's attributes are never derived from the Host header a caller sends",
        );
      }
      assert(/Max-Age=\d+/i.test(cookieLine), "the session cookie carries an expiry");

      /* --- nothing secret leaves in the body ---------------------------- */
      const tokenValue = sessionCookie.slice(SESSION_COOKIE.length + 1);
      for (const forbidden of [PASSWORD, tokenValue, "scrypt", "password_hash", "v1."]) {
        assert(
          !good.text.includes(forbidden),
          `the sign-in response does not contain "${forbidden.slice(0, 12)}"`,
        );
      }

      /* --- the cookie value is not what the database holds --------------- */
      {
        const rows = db.prepare("SELECT id FROM sessions").all() as unknown as { id: string }[];
        assert(rows.length > 0, "a session row exists after signing in");
        assert(
          rows.every((r) => r.id !== tokenValue),
          "the cookie value itself is NOT stored — a copied fuel.db is not a set of live logins",
        );
        const { storedIdMatches } = await import("../src/db/sessions.js");
        assert(
          rows.some((r) => storedIdMatches(tokenValue, r.id)),
          "the stored id is the hash of the cookie value",
        );
        const dump = JSON.stringify(
          db.prepare("SELECT * FROM sessions").all(),
        );
        assert(!dump.includes(tokenValue), "no column anywhere in sessions holds the cookie value");
      }

      /* --- a session is a working operator credential -------------------- */
      const asSession = await http("/api/company", { cookie: sessionCookie });
      assertEqual(asSession.status, 200, "a session reads an operator route");
      assertEqual(
        asSession.body.id,
        ownCompany.id,
        "and acts for the company on the USER'S row, not a server-wide default",
      );

      /* --- every way to fail says the same thing ------------------------- */
      resetLoginLimits();
      const wrongPassword = await login(OWNER_EMAIL, "not-the-password-at-all");
      resetLoginLimits();
      const unknownEmail = await login(`nobody-${randomUUID()}@example.com`, PASSWORD);
      assertEqual(wrongPassword.status, 401, "a wrong password is refused");
      assertEqual(unknownEmail.status, 401, "an unknown address is refused");
      assertEqual(
        wrongPassword.text,
        unknownEmail.text,
        "a wrong password and an unknown address are indistinguishable — no account oracle",
      );
      assertEqual(wrongPassword.setCookie.length, 0, "a refused sign-in sets no cookie");

      /* --- and they cost the same, which is the other half of it --------- */
      {
        const timed = async (email: string): Promise<number> => {
          resetLoginLimits();
          const t0 = process.hrtime.bigint();
          await login(email, PASSWORD);
          return Number(process.hrtime.bigint() - t0) / 1e6;
        };
        const known = await timed(OWNER_EMAIL);
        const unknown = await timed(`nobody-${randomUUID()}@example.com`);
        // Generous: this asserts the unknown path HASHES, not that the two are
        // identical. A skipped hash is ~1ms against ~67ms, which no amount of
        // scheduling noise closes.
        assert(
          unknown > known / 3,
          `an unknown address costs comparable time (known ${known.toFixed(0)}ms, unknown ${unknown.toFixed(0)}ms)`,
        );
      }

      /* --- two credentials at once is a refusal, not a choice ------------ */
      resetLoginLimits();
      const both = await http("/api/company", { cookie: sessionCookie, key: OPERATOR_KEY });
      assertEqual(both.status, 401, "a cookie AND a bearer key together is refused, not resolved");
      assertEqual(
        (await http("/api/company", { cookie: sessionCookie })).status,
        200,
        "the same cookie alone still works (the refusal is about ambiguity, not the cookie)",
      );

      /* --- a request carrying the cookie twice ---------------------------- */
      {
        // A REAL TECHNIQUE, not a curiosity: an attacker who can set a cookie on
        // a parent domain gets a second `fuel_session` into the same header and
        // hopes the server reads theirs. Which one is read must be a decision,
        // not whatever the parser happened to keep, so it is pinned here.
        const junk = `${SESSION_COOKIE}=not-a-real-session-value`;
        assertEqual(
          (await http("/api/company", { cookie: `${sessionCookie}; ${junk}` })).status,
          200,
          "with the cookie twice, the FIRST is the one read",
        );
        assertEqual(
          (await http("/api/company", { cookie: `${junk}; ${sessionCookie}` })).status,
          401,
          "and a junk value in first position is not skipped over to find a good one",
        );
      }

      /* --- a session can never move money -------------------------------- */
      {
        const agent = db.prepare("SELECT id FROM agents LIMIT 1").get() as { id: string } | undefined;
        assert(agent !== undefined, "the scratch database has an agent to aim at");
        const paid = await http(`/api/agents/${agent!.id}/pay`, {
          cookie: sessionCookie,
          body: { url: "http://127.0.0.1:1/paid-hello" },
        });
        assertEqual(
          paid.status,
          403,
          "a session cannot reach the agent pay route — a browser credential must not spend",
        );
      }

      /* --- who am I ------------------------------------------------------ */
      const me = await http("/api/auth/me", { cookie: sessionCookie });
      assertEqual(me.status, 200, "a session can ask who it is");
      assertEqual(me.body.user.email, OWNER_EMAIL, "and is told the right person");
      assertEqual(me.body.user.role, "owner", "including their role in the company");
      assertEqual(
        (await http("/api/auth/me", { key: OPERATOR_KEY })).status,
        404,
        "a shared key has no session to describe, and is told so rather than given one",
      );

      /* --- cross-origin writes ------------------------------------------- */
      {
        // The cap is read first and written back unchanged, so this section
        // proves who may write without altering a spending control.
        const currentCap = (await http("/api/company", { cookie: sessionCookie })).body.spendCap;
        assert(typeof currentCap === "string", "the company's cap reads as a dollar string");
        const writeBack = (opts: { key?: string; cookie?: string; origin?: string | null }) =>
          http("/api/company", { method: "PATCH", body: { spendCapUsd: currentCap }, ...opts });

        assertEqual(
          (await writeBack({ cookie: sessionCookie, origin: "http://evil.example" })).status,
          403,
          "a cookie-authenticated write from another origin is refused",
        );
        assert(
          (await writeBack({ cookie: sessionCookie, origin: base })).status < 400,
          "the same write from our own origin is allowed",
        );
        assert(
          (await writeBack({ key: OPERATOR_KEY, origin: "http://evil.example" })).status < 400,
          "a bearer key is exempt: no browser attaches it on its own, so there is nothing to forge",
        );
        assert(
          (await writeBack({ cookie: sessionCookie })).status < 400,
          "a request with no Origin at all is allowed — curl and scripts keep working",
        );
        assertEqual(
          (await http("/api/company", { cookie: sessionCookie })).body.spendCap,
          currentCap,
          "and the cap is exactly what it was before this section ran",
        );
      }

      /* --- ending a session, four ways ----------------------------------- */
      {
        // 1. signing out
        const outCookie = cookieFromSetCookie((await login(OWNER_EMAIL, PASSWORD)).setCookie);
        assertEqual((await http("/api/company", { cookie: outCookie })).status, 200, "the new session works");
        const out = await http("/api/auth/logout", { method: "POST", cookie: outCookie });
        assertEqual(out.status, 200, "signing out succeeds");
        assert(
          out.setCookie.some((l) => l.startsWith(`${SESSION_COOKIE}=`) && /Expires=|Max-Age=0/i.test(l)),
          "signing out clears the cookie in the browser too",
        );
        assertEqual(
          (await http("/api/company", { cookie: outCookie })).status,
          401,
          "and the cookie is dead server-side, not merely forgotten by the browser",
        );

        // 2. the absolute deadline
        const expiring = cookieFromSetCookie((await login(OWNER_EMAIL, PASSWORD)).setCookie);
        db.prepare("UPDATE sessions SET expires_at = ? WHERE revoked_at IS NULL").run(
          new Date(Date.now() - 1000).toISOString(),
        );
        assertEqual(
          (await http("/api/company", { cookie: expiring })).status,
          401,
          "a session past its absolute deadline is refused, however recently it was used",
        );

        // 3. the idle timeout
        const idle = cookieFromSetCookie((await login(OWNER_EMAIL, PASSWORD)).setCookie);
        assertEqual((await http("/api/company", { cookie: idle })).status, 200, "a fresh session works");
        db.prepare("UPDATE sessions SET last_seen_at = ? WHERE revoked_at IS NULL AND expires_at > ?").run(
          new Date(Date.now() - SESSION_IDLE_MS - 1000).toISOString(),
          new Date().toISOString(),
        );
        assertEqual(
          (await http("/api/company", { cookie: idle })).status,
          401,
          "a session left idle past the timeout is refused",
        );

        // 4. disabling the person
        const doomed = createUser({
          companyId: ownCompany.id,
          email: `doomed-${randomUUID()}@example.com`,
          passwordHash: await hashPassword(PASSWORD),
          role: "operator",
        });
        resetLoginLimits();
        const doomedCookie = cookieFromSetCookie(
          (await login(doomed.email, PASSWORD)).setCookie,
        );
        assertEqual(
          (await http("/api/company", { cookie: doomedCookie })).status,
          200,
          "the second user can sign in and read",
        );
        assert(disableUser(doomed.id, ownCompany.id), "disabling the user reports one row changed");
        // NOTHING REVOKES THE SESSION HERE, deliberately. Disabling a person has
        // to end the access they are ALREADY holding, and the session row is
        // still live at this point — so this asserts the check inside session
        // resolution, which is the line that holds when the revoke is forgotten.
        assertEqual(
          (await http("/api/company", { cookie: doomedCookie })).status,
          401,
          "disabling a person ends the session they are already holding, not just future sign-ins",
        );
        // And the sweep is there too, so the row does not sit around live.
        const { revokeSessionsForUser } = await import("../src/db/sessions.js");
        assertEqual(
          revokeSessionsForUser(doomed.id),
          1,
          "their outstanding session can be revoked outright as well",
        );
        resetLoginLimits();
        const refused = await login(doomed.email, PASSWORD);
        assertEqual(refused.status, 401, "and they cannot sign in again");
        assertEqual(
          refused.text,
          unknownEmail.text,
          "a disabled account is refused in the same words as one that never existed",
        );
      }

      /* --- throttling ----------------------------------------------------- */
      {
        resetLoginLimits();
        const email = OWNER_EMAIL;
        let sawLimit = false;
        for (let i = 0; i < 8; i += 1) {
          const res = await login(email, "wrong-password-here");
          if (res.status === 429) {
            sawLimit = true;
            break;
          }
        }
        assert(sawLimit, "repeated wrong passwords for one address are eventually refused outright");
        assertEqual(
          (await login(OWNER_EMAIL, PASSWORD)).status,
          429,
          "and the limit holds even for the CORRECT password — it is the attempt that is limited",
        );
        resetLoginLimits();
        assertEqual(
          (await login(OWNER_EMAIL, PASSWORD)).status,
          200,
          "clearing the window lets a legitimate person back in",
        );
      }

      /* --- the KDF must not stall the event loop -------------------------- */
      {
        resetLoginLimits();
        // Four concurrent sign-ins, which is the hashing ceiling, while a plain
        // read runs alongside. If hashing were synchronous, the read would queue
        // behind every one of them.
        const reads: number[] = [];
        const watcher = (async () => {
          for (let i = 0; i < 6; i += 1) {
            const t0 = process.hrtime.bigint();
            await http("/api/environment", { key: OPERATOR_KEY });
            reads.push(Number(process.hrtime.bigint() - t0) / 1e6);
          }
        })();
        await Promise.all([
          watcher,
          ...Array.from({ length: 4 }, () => login(OWNER_EMAIL, "wrong-but-still-hashed")),
        ]);
        const worst = Math.max(...reads);
        assert(
          worst < 150,
          `an unrelated read stays responsive while passwords hash (worst ${worst.toFixed(0)}ms)`,
        );
        resetLoginLimits();
      }

      /* --- a weak password is refused where it is set --------------------- */
      {
        const { WeakPasswordError } = await import("../src/lib/passwords.js");
        let threw: unknown = null;
        try {
          await hashPassword("short");
        } catch (error) {
          threw = error;
        }
        assert(threw instanceof WeakPasswordError, "a password under the minimum is refused");
        assert(MIN_PASSWORD_LENGTH >= 12, "the minimum length is at least 12 characters");
      }

      /* --- source guards --------------------------------------------------- */
      {
        const walk = (dir: string): string[] =>
          readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory()
              ? walk(join(dir, entry.name))
              : entry.name.endsWith(".ts")
                ? [join(dir, entry.name)]
                : [],
          );
        const sources = walk("src");

        // One hashing site, for the same reason there is one encryption site.
        for (const file of sources.filter((f) => f !== join("src", "lib", "passwords.ts"))) {
          assert(
            !/\bscrypt\w*\s*\(/.test(withoutComments(readFileSync(file, "utf8"))),
            `${file} does not hash passwords itself — src/lib/passwords.ts is the only place`,
          );
        }
        assert(
          /\bscrypt\w*\s*\(/.test(readFileSync(join("src", "lib", "passwords.ts"), "utf8")),
          "the hashing guard's pattern matches scrypt where it IS called",
        );
        // The SYNCHRONOUS form is what must never appear, here or anywhere: it
        // would hold the event loop for the whole derivation, stalling every
        // payment in flight behind whoever is signing in. Asserted separately
        // from the one-site rule above, because swapping `scrypt` for
        // `scryptSync` in this very file would otherwise satisfy both.
        assert(
          !/\bscryptSync\s*\(/.test(withoutComments(readFileSync(join("src", "lib", "passwords.ts"), "utf8"))),
          "passwords are hashed with the ASYNC scrypt, never scryptSync",
        );

        // One place that reads the cookie header, for the same reason.
        for (const file of sources.filter((f) => f !== join("src", "lib", "auth.ts"))) {
          const source = withoutComments(readFileSync(file, "utf8"));
          assert(
            !/\.header\(\s*["']cookie["']\s*\)|req\.cookies\b/i.test(source),
            `${file} does not read the cookie header itself — authenticate resolves the session`,
          );
        }

        /*
         * The test app above must mount the way the real server does.
         *
         * WHY THIS IS A SOURCE CHECK AND NOT A BEHAVIOURAL ONE, stated because
         * the difference is easy to lose: this suite builds its own Express app,
         * so unmounting a guard in src/server.ts changes nothing the requests
         * above can see. The behavioural tests prove the guard WORKS; these
         * assertions prove the real server actually USES it. A break test
         * confirmed both halves fire — removing the mount trips the assertions
         * below, and neutering the guard's body trips the cross-origin test.
         */
        const serverSource = withoutComments(readFileSync(join("src", "server.ts"), "utf8"));
        assert(
          /app\.use\(\s*["']\/api\/auth["']\s*,\s*publicAuthRouter\(\)\s*\)/.test(serverSource),
          "src/server.ts mounts the public auth router",
        );
        assert(
          /app\.use\(\s*["']\/api["']\s*,\s*authenticate\s*,\s*sameOriginForSessions\s*,\s*api\s*\)/.test(
            serverSource,
          ),
          "src/server.ts mounts authenticate and the CSRF guard ahead of every /api route",
        );
        assert(
          serverSource.indexOf('"/api/auth"') < serverSource.indexOf('app.use("/api", authenticate'),
          "and sign-in is mounted BEFORE the authenticated router, or it could never be reached",
        );

      /* --- an unexpected error tells the caller nothing (the catch-all) ---- */
      {
        const noLeak = (label: string, text: string) => {
          assert(!text.includes("secret.detail") && !text.includes("SQLITE"), `${label} -- and carries no error message`);
          assert(!/\n\s+at /.test(text) && !/at [\w.<>]+ \(/.test(text), `${label} -- and no stack trace`);
        };
        const thrown = await http("/__test/throw");
        assertEqual(thrown.status, 500, "E1: a route that throws answers 500");
        assertEqual(thrown.body.error, "internal error", "E1: with a plain 'internal error'");
        noLeak("E1", thrown.text);
        const rejected = await http("/__test/reject");
        assertEqual(rejected.status, 500, "E2: an async route that rejects answers 500");
        assertEqual(rejected.body.error, "internal error", "E2: with the same plain answer");
        noLeak("E2", rejected.text);
        const malformed = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"company": "x", "email": ',
        });
        const malformedText = await malformed.text();
        assertEqual(malformed.status, 400, "E3: malformed JSON is still a 400, not a 500");
        assert(!/Unexpected|JSON\.parse|position \d+/.test(malformedText), "E3: and names no parser detail");
        noLeak("E3", malformedText);
        const statused = await http("/__test/status");
        assertEqual(statused.status, 500, "E5: an error that only looks like a parser error (it has a status) is still a 500");
        assertEqual(statused.body.error, "internal error", "E5: with the same plain answer");
        noLeak("E5", statused.text);
        // Every way a route or middleware can be registered, not just the
        // styles server.ts happens to use today.
        const serverSrc = withoutComments(readFileSync(join("src", "server.ts"), "utf8"));
        const mounted = serverSrc.lastIndexOf("app.use(unhandledErrors)");
        const registrations = [...serverSrc.matchAll(/\bapp\s*\.\s*(?:use|all|get|post|put|patch|delete|head|options|route)\s*\(/g)];
        const lastRoute = Math.max(
          ...registrations.map((m) => m.index ?? -1).filter((index) => index !== mounted),
        );
        assert(registrations.length > 5, "E4: the registration pattern finds server.ts's routes at all");
        assert(mounted !== -1 && mounted > lastRoute, "E4: src/server.ts mounts the catch-all after every route");
      }
      }
    }
    console.log(`   ${checks} checks so far`);


    /* ---- invites and signup -------------------------------------------- */
    console.log("\n== invites and signup");
    {
      const { createInvite, listInvites } = await import("../src/db/invites.js");
      const { findUserForLogin } = await import("../src/db/users.js");
      const ownCompany = bootstrapCompany();
      const PASSWORD = "a-perfectly-fine-password";

      async function http(
        path: string,
        opts: { method?: string; key?: string | null; cookie?: string | null; body?: unknown } = {},
      ): Promise<{ status: number; body: any; text: string; setCookie: string[] }> {
        const headers: Record<string, string> = {};
        if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
        if (opts.cookie) headers.Cookie = opts.cookie;
        if (opts.body !== undefined) headers["content-type"] = "application/json";
        const res = await fetch(`${base}${path}`, {
          method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        const text = await res.text();
        let parsed: any = {};
        try {
          parsed = JSON.parse(text);
        } catch {
          /* asserted on as text */
        }
        return { status: res.status, body: parsed, text, setCookie: res.headers.getSetCookie() };
      }

      const signup = (body: Record<string, unknown>) => {
        resetLoginLimits();
        return http("/api/auth/signup", { body });
      };
      const freshInvite = (email: string, role: "owner" | "operator" = "operator") =>
        createInvite({ companyId: ownCompany.id, email, role });

      /* --- the happy path ------------------------------------------------ */
      {
        const email = `joiner-${randomUUID()}@example.com`;
        const { token } = freshInvite(email);
        const res = await signup({ token, email, password: PASSWORD });
        assertEqual(res.status, 201, "redeeming a valid invite creates the account");
        assertEqual(res.body.user.email, email, "and the account is the invited address");
        assert(
          res.setCookie.some((l) => l.startsWith(`${SESSION_COOKIE}=`)),
          "and signs the new person in, rather than bouncing them to a login form",
        );
        assert(!res.text.includes(token), "the response does not echo the invite token");
        assert(!res.text.includes(PASSWORD), "nor the password");
      }

      /* --- wrong recipient ------------------------------------------------ */
      {
        const email = `intended-${randomUUID()}@example.com`;
        const [local, domain] = email.split("@");
        for (const [claimed, why] of [
          [`someone-else-${randomUUID()}@example.com`, "a different address entirely"],
          [`${local}+tag@${domain}`, "the same mailbox with a +tag (a different address at some providers)"],
          [`${local}@other-${domain}`, "the same local part at another domain"],
        ] as const) {
          const { token } = freshInvite(email);
          const res = await signup({ token, email: claimed, password: PASSWORD });
          assertEqual(res.status, 400, `an invite cannot be redeemed with ${why}`);
        }

        // ...but the SAME address in a different SHAPE must still work, or a
        // mail client that capitalises an address would lock out the very
        // person the invite was for. Both sides go through one normaliser;
        // these are the controls proving it is applied to both.
        for (const [reshape, why] of [
          [(e: string) => ` ${e} `, "surrounding whitespace"],
          [(e: string) => e.toUpperCase(), "different casing"],
        ] as const) {
          const canonical = `shape-${randomUUID()}@example.com`;
          const { token } = freshInvite(canonical);
          const res = await signup({ token, email: reshape(canonical), password: PASSWORD });
          assertEqual(res.status, 201, `the SAME address with ${why} is accepted (control)`);
        }
      }

      /* --- the data layer normalises too, not only the route -------------- */
      {
        /*
         * CALLED DIRECTLY, BENEATH THE ROUTE, ON PURPOSE.
         *
         * The signup route normalises the address before it gets here, so a
         * break that removed normalisation inside `redeemInvite` changed
         * nothing observable through HTTP — the suite passed and the break test
         * did not fire. That is a real gap: the route is not the only caller
         * this function will ever have. These go straight at it.
         */
        const { redeemInvite } = await import("../src/db/invites.js");
        const canonical = `layer-${randomUUID()}@example.com`;
        const { token } = freshInvite(canonical);
        let normalised: string | null = null;
        try {
          normalised = redeemInvite({
            token,
            email: `  ${canonical.toUpperCase()}  `,
            passwordHash: await hashPassword(PASSWORD),
          }).email;
        } catch {
          // Swallowed so this reports as a named failure rather than ending the
          // run — a refusal here IS the finding.
        }
        assertEqual(
          normalised,
          canonical,
          "redeemInvite itself normalises the address on both sides of the comparison",
        );

        const other = `layer-other-${randomUUID()}@example.com`;
        const second = freshInvite(other);
        let refused = false;
        try {
          redeemInvite({
            token: second.token,
            email: `not-${other}`,
            passwordHash: await hashPassword(PASSWORD),
          });
        } catch {
          refused = true;
        }
        assert(refused, "and still refuses a genuinely different address when called directly");
      }

      /* --- reuse after a successful redemption ---------------------------- */
      {
        const email = `once-${randomUUID()}@example.com`;
        const { token } = freshInvite(email);
        // The realistic theft: the token is captured BEFORE its first use, from
        // a forwarded message or a chat log, and tried afterwards.
        const stolen = token;
        assertEqual((await signup({ token, email, password: PASSWORD })).status, 201, "the first redemption works");
        const second = await signup({
          token: stolen,
          email: `later-${randomUUID()}@example.com`,
          password: PASSWORD,
        });
        assertEqual(second.status, 400, "a token captured before its first use is dead after it");
      }

      /* --- a FAILED attempt must not burn the invite ---------------------- */
      {
        const email = `survivor-${randomUUID()}@example.com`;
        const { token } = freshInvite(email);

        const weak = await signup({ token, email, password: "short" });
        assertEqual(weak.status, 400, "a weak password is refused");

        const taken = await signup({ token, email: email, password: PASSWORD });
        assertEqual(taken.status, 201, "and the invite still works afterwards — a typo does not cost it");
      }
      {
        // The other way to fail late: the address is already an account. The
        // invite must survive that too, because the person may have been
        // invited twice and simply used the wrong link.
        const existing = `dup-${randomUUID()}@example.com`;
        const first = freshInvite(existing);
        assertEqual((await signup({ token: first.token, email: existing, password: PASSWORD })).status, 201, "the address is taken by a first signup");
        const second = freshInvite(existing);
        const clash = await signup({ token: second.token, email: existing, password: PASSWORD });
        assertEqual(clash.status, 409, "a second signup on a taken address is refused");
        const stillThere = listInvites(ownCompany.id).find((i) => i.id === second.invite.id);
        assert(stillThere !== undefined, "the second invite is still on the company's list");
        assertEqual(stillThere!.redeemedAt, null, "and THAT invite is still unredeemed, not burnt");
        assertEqual(stillThere!.revokedAt, null, "nor withdrawn by the failed attempt");
      }

      /* --- two people racing the same token -------------------------------- */
      {
        const email = `racer-${randomUUID()}@example.com`;
        const { token } = freshInvite(email);
        const usersBefore = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

        resetLoginLimits();
        /*
         * WHAT THIS DOES AND DOES NOT PROVE, corrected after a break test.
         *
         * It proves the OBSERVABLE contract: two simultaneous redemptions of
         * one token produce one account and one refusal. It does NOT prove the
         * transaction works, because `redeemInvite` has no `await` in it — Node
         * runs it to completion before the second request is looked at, so
         * JavaScript serialises these two, not SQLite. Removing the transaction
         * entirely leaves this test passing, which is exactly what the break
         * test showed.
         *
         * The real cross-process race lives in scripts/verify-migration.ts,
         * where two processes strike at the same wall-clock instant.
         */
        const [a, b] = await Promise.all([
          http("/api/auth/signup", { body: { token, email, password: PASSWORD } }),
          http("/api/auth/signup", { body: { token, email, password: PASSWORD } }),
        ]);
        const codes = [a.status, b.status].sort();
        assertEqual(codes[0], 201, "exactly one of two simultaneous redemptions succeeds");
        assert(codes[1] === 400 || codes[1] === 409, `and the other is refused (got ${codes[1]})`);

        const usersAfter = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
        assertEqual(usersAfter - usersBefore, 1, "and exactly one account exists afterwards");

        const invite = db
          .prepare("SELECT redeemed_by FROM invites WHERE email = ?")
          .get(email) as { redeemed_by: string | null };
        assert(invite.redeemed_by !== null, "the invite records which account redeemed it");
      }

      /* --- expiry and revocation, neither consumed by the attempt --------- */
      {
        const email = `expired-${randomUUID()}@example.com`;
        const { invite, token } = freshInvite(email);
        db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").run(
          new Date(Date.now() - 1000).toISOString(),
          invite.id,
        );
        assertEqual((await signup({ token, email, password: PASSWORD })).status, 400, "an expired invite is refused");
        const after = db.prepare("SELECT redeemed_at FROM invites WHERE id = ?").get(invite.id) as {
          redeemed_at: string | null;
        };
        assertEqual(after.redeemed_at, null, "and the failed attempt did not mark it used");
      }
      {
        const email = `revoked-${randomUUID()}@example.com`;
        const { invite, token } = freshInvite(email);
        db.prepare("UPDATE invites SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), invite.id);
        assertEqual((await signup({ token, email, password: PASSWORD })).status, 400, "a withdrawn invite is refused");
      }

      /* --- forgery, and the absence of an oracle --------------------------- */
      {
        const email = `nobody-${randomUUID()}@example.com`;
        const forged = await signup({
          token: randomBytes(32).toString("base64url"),
          email,
          password: PASSWORD,
        });
        assertEqual(forged.status, 400, "a well-formed token that was never minted is refused");

        const expiredEmail = `oracle-${randomUUID()}@example.com`;
        const { invite, token } = freshInvite(expiredEmail);
        db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").run(
          new Date(Date.now() - 1000).toISOString(),
          invite.id,
        );
        const expired = await signup({ token, email: expiredEmail, password: PASSWORD });
        const wrongAddress = await signup({
          token: freshInvite(`bound-${randomUUID()}@example.com`).token,
          email: `claimed-${randomUUID()}@example.com`,
          password: PASSWORD,
        });
        assertEqual(
          forged.text,
          expired.text,
          "a forged token and a real expired one are indistinguishable",
        );
        assertEqual(
          expired.text,
          wrongAddress.text,
          "and so is redeeming a real invite with the wrong address — no oracle for which invites exist",
        );
      }

      /* --- the refusal codes, and the one that must NOT split -------------- */
      {
        /*
         * WHY A CODE EXISTS: a browser signing somebody up has to tell a bad
         * invite from a short password, and it must do that without rendering
         * a sentence this server sent. See SIGNUP_CODES in src/auth/routes.ts.
         *
         * WHAT THE ORACLE ASSERTIONS ABOVE DO AND DO NOT COVER, stated
         * precisely because security review corrected an earlier version of
         * this comment. They compare whole response bodies, and the code
         * travels in the body, so a code splitting "expired" from "forged"
         * fails them — but they compare only THREE of the four cases. A
         * REVOKED invite is asserted on separately above, for status alone,
         * and is not in that comparison. So the fourth case is covered here
         * and nowhere else.
         *
         * Break-tested: splitting `expired` into its own code fails the
         * body-comparison assertion FIRST, because it runs earlier. Silencing
         * that one for a one-off diagnostic showed the named check below firing
         * on exactly the same break, which is what makes it a real break test
         * rather than one that merely happens to be nearby.
         *
         * IMPORTED FROM ./codes.js, NOT FROM THE ROUTE. That module imports
         * nothing, which is the whole point of it — see its docblock.
         */
        const { SIGNUP_CODES, RELAY_CODES } = await import("../src/auth/codes.js");

        const weakEmail = `code-weak-${randomUUID()}@example.com`;
        const weak = await signup({ token: freshInvite(weakEmail).token, email: weakEmail, password: "short" });
        assertEqual(weak.status, 400, "a short password is refused");
        assertEqual(weak.body.code, "password_weak", "and the code names the password, not the invite");

        const incomplete = await signup({ token: "", email: weakEmail, password: PASSWORD });
        assertEqual(incomplete.body.code, "incomplete", "a missing field answers its own code");

        /*
         * The four reasons an invite is unusable. ONE code for all of them —
         * this is the enumeration oracle restated for a field that is far
         * easier to read than prose, and therefore far easier to get wrong.
         */
        const unusableEmail = `code-bound-${randomUUID()}@example.com`;
        const expiring = freshInvite(unusableEmail);
        db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").run(
          new Date(Date.now() - 1000).toISOString(),
          expiring.invite.id,
        );
        const revoking = freshInvite(`code-revoked-${randomUUID()}@example.com`);
        db.prepare("UPDATE invites SET revoked_at = ? WHERE id = ?").run(
          new Date().toISOString(),
          revoking.invite.id,
        );

        for (const [why, body] of [
          ["a token that was never minted", { token: randomBytes(32).toString("base64url"), email: `x-${randomUUID()}@example.com` }],
          ["an expired invite", { token: expiring.token, email: unusableEmail }],
          ["a withdrawn invite", { token: revoking.token, email: revoking.invite.email }],
          ["an invite addressed to somebody else", { token: freshInvite(`code-other-${randomUUID()}@example.com`).token, email: `claimed-${randomUUID()}@example.com` }],
        ] as const) {
          const res = await signup({ ...body, password: PASSWORD });
          assertEqual(
            res.body.code,
            "invite_unusable",
            `${why} answers the one shared code, disclosing nothing about which invites exist`,
          );
        }

        const takenEmail = `code-taken-${randomUUID()}@example.com`;
        assertEqual((await signup({ token: freshInvite(takenEmail).token, email: takenEmail, password: PASSWORD })).status, 201, "an address is taken by a first signup");
        const taken = await signup({ token: freshInvite(takenEmail).token, email: takenEmail, password: PASSWORD });
        assertEqual(taken.body.code, "email_taken", "a taken address IS named — it is the caller's own, and redeemInvite records why");

        /*
         * Throttling, which needs the limiter NOT reset between attempts — so
         * this drives `http` directly rather than the `signup` helper.
         */
        resetLoginLimits();
        const spam = freshInvite(`code-spam-${randomUUID()}@example.com`);
        let throttled: Awaited<ReturnType<typeof http>> | null = null;
        for (let i = 0; i < 10 && throttled === null; i++) {
          const res = await http("/api/auth/signup", {
            body: { token: spam.token, email: `nope-${i}-${randomUUID()}@example.com`, password: PASSWORD },
          });
          if (res.status === 429) throttled = res;
        }
        assert(throttled !== null, "repeated attempts against one token are eventually throttled");
        assertEqual(throttled!.body.code, "throttled", "and the throttle names itself rather than looking like a bad invite");
        resetLoginLimits();

        /*
         * EXHAUSTING SIGNUP MUST NOT LOCK ANYBODY OUT OF SIGNING IN.
         *
         * These were one shared address bucket, and the consequence was
         * measured rather than argued: the dashboard calls Fuel server-side, so
         * every browser request arrives from ONE address, and nineteen
         * anonymous posts to the public signup page made /login answer 429 to
         * every operator in the company. A public page anybody can post to
         * could take out the product for people who had already signed up.
         *
         * WHAT THIS ASSERTS IS CONTAINMENT, NOT IMMUNITY. Signup is still
         * exhaustible here — the loop above just exhausted it. The claim is only
         * that login survives it. The per-address limit remains close to
         * meaningless behind a proxy, which is recorded as a residual rather
         * than papered over.
         */
        for (let i = 0; i < 25; i++) {
          await http("/api/auth/signup", {
            body: { token: `flood-${i}`, email: `flood-${i}@example.com`, password: PASSWORD },
          });
        }
        const signupAfterFlood = await http("/api/auth/signup", {
          body: { token: "flood-last", email: "flood-last@example.com", password: PASSWORD },
        });
        assertEqual(signupAfterFlood.status, 429, "(control) the flood really did exhaust signup's own address bucket");

        const loginAfterFlood = await http("/api/auth/login", {
          body: { company: handleFor(bootstrapCompany().id), email: `nobody-${randomUUID()}@example.com`, password: PASSWORD },
        });
        assert(
          loginAfterFlood.status !== 429,
          "and signing in still works — flooding signup does not lock existing operators out of the product",
        );
        resetLoginLimits();

        /*
         * THE VOCABULARY IS CLOSED IN BOTH DIRECTIONS.
         *
         * A code the route emits but does not declare cannot be handled by the
         * dashboard, which renders nothing for an unknown code — so the person
         * would see a blank refusal. A code declared but never emitted is a
         * notice nobody can ever reach. `busy` is the reason this is a source
         * check rather than five more HTTP calls: provoking HashingBusyError
         * needs the hashing ceiling saturated, which is inherently racy, and a
         * flaky assertion on a credential path is worse than a precise one.
         */
        const routeSource = readFileSync("src/auth/routes.ts", "utf8");
        /*
         * BOUNDED AT BOTH ENDS. An earlier version sliced to end-of-file, which
         * passes today only because nothing follows the signup handler that
         * emits a code — so the moment one did, this check would silently start
         * asserting about an unrelated route while still claiming to be about
         * signup. `return router;` is the handler's real upper bound.
         */
        const handlerStart = routeSource.indexOf('router.post("/signup"');
        const handlerEnd = routeSource.indexOf("return router;", handlerStart);
        assert(handlerStart !== -1 && handlerEnd > handlerStart, "the signup handler can be located in source");
        const signupHandler = routeSource.slice(handlerStart, handlerEnd);
        const emitted = new Set(
          [...signupHandler.matchAll(/code:\s*"([a-z_]+)"/g)].map((m) => m[1]),
        );
        for (const code of SIGNUP_CODES) {
          assert(emitted.has(code), `the signup handler actually emits the declared code ${code}`);
        }
        for (const code of emitted) {
          assert(
            (SIGNUP_CODES as readonly string[]).includes(code) ||
              (RELAY_CODES as readonly string[]).includes(code),
            `the signup handler emits no code missing from SIGNUP_CODES or RELAY_CODES (found ${code})`,
          );
        }

        /*
         * RELAY CODES ARE CLOSED TOO, AND THEY ARE THE ONLY CODES LOGIN MAY
         * CARRY (ADR 0020). Login's credential refusal is deliberately code-less
         * (see codes.ts), so the one thing that must never happen is a code on
         * the login handler that is not a relay code — that would be the first
         * crack in the single, indistinguishable refusal. Both handlers must
         * emit both relay codes, so the dashboard's mapping of them is never for
         * a code that cannot arrive.
         */
        const loginStart = routeSource.indexOf('router.post("/login"');
        assert(loginStart !== -1 && loginStart < handlerStart, "the login handler can be located in source");
        const loginHandler = routeSource.slice(loginStart, handlerStart);
        const loginCodes = new Set([...loginHandler.matchAll(/code:\s*"([a-z_]+)"/g)].map((m) => m[1]));
        for (const code of RELAY_CODES) {
          assert(emitted.has(code), `the signup handler emits the relay code ${code}`);
          assert(loginCodes.has(code), `the login handler emits the relay code ${code}`);
        }
        for (const code of loginCodes) {
          assert(
            (RELAY_CODES as readonly string[]).includes(code),
            `the login handler carries no code but a relay code (found ${code}) — its credential refusal stays code-less`,
          );
        }
      }

      /* --- ADR 0020: sign-in limits key on the client the dashboard vouches for */
      {
        console.log("\n== per-client sign-in limits behind the dashboard (ADR 0020)");
        const { relayConfigFrom, resolveClient, canonicalAddress, clientBucketOf, MIN_RELAY_KEY_LENGTH } =
          await import("../src/lib/client-key.js");
        const { MAX_TRACKED_KEYS } = await import("../src/lib/buckets.js");

        const RELAY = RELAY_KEY;
        const relayEnv = (extra: Record<string, string> = {}) => ({
          FUEL_API_KEY: OPERATOR_KEY,
          FUEL_AGENT_KEY: AGENT_KEY,
          FUEL_RELAY_KEY: RELAY,
          ...extra,
        });

        /*
         * Each configuration gets its own small app, mounted exactly as
         * src/server.ts mounts the real router, so one process can test a relay
         * that is on, off, and restricted to peers this socket is not.
         */
        async function relayApp(config: ReturnType<typeof relayConfigFrom>) {
          const a = express();
          a.use(express.json());
          a.use("/api/auth", publicAuthRouter({ relay: config }));
          a.use(unhandledErrors);
          const s = a.listen(0, "127.0.0.1");
          await new Promise((resolve) => s.once("listening", resolve));
          return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
        }

        /** One wrong-password sign-in. A fresh account each time unless one is named. */
        async function attempt(url: string, headers: Record<string, string>, email?: string) {
          const h = new Headers({ "Content-Type": "application/json" });
          for (const [k, v] of Object.entries(headers)) h.append(k, v);
          const res = await fetch(`${url}/api/auth/login`, {
            method: "POST",
            headers: h,
            body: JSON.stringify({
              company: "nobody-zzzz",
              email: email ?? `r-${randomUUID()}@example.com`,
              password: "wrong-password-123",
            }),
          });
          return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
        }
        const relayed = (client: string) => ({ "X-Fuel-Relay-Key": RELAY, "X-Fuel-Client-Address": client });

        const on = await relayApp(relayConfigFrom(relayEnv({ FUEL_RELAYED_CEILING: "30" })));
        try {
          // R1, R2. The relay is ON and keyed, or these would pass trivially.
          for (const [label, header] of [
            ["X-Fuel-Client-Address", "X-Fuel-Client-Address"],
            ["X-Forwarded-For", "X-Forwarded-For"],
          ] as const) {
            resetLoginLimits();
            let last = 0;
            for (let i = 1; i <= 21; i++) last = (await attempt(on.url, { [header]: `198.51.100.${i}` })).status;
            assertEqual(
              last,
              429,
              `R${label === "X-Forwarded-For" ? 2 : 1}: a direct caller cannot choose its bucket with ${label}`,
            );
          }

          // R3. A wrong key is refused as a relay problem, not a wrong password.
          resetLoginLimits();
          const wrong = await attempt(on.url, { "X-Fuel-Relay-Key": `x${RELAY}`, "X-Fuel-Client-Address": "203.0.113.9" });
          assertEqual(wrong.status, 403, "R3: a wrong relay key is refused");
          assertEqual(wrong.body.code, "relay_rejected", "R3: and named as a relay problem, never a credential one");

          // R5. THE FIX: one client exhausting its bucket does not throttle another.
          resetLoginLimits();
          let a21 = 0;
          for (let i = 1; i <= 21; i++) a21 = (await attempt(on.url, relayed("203.0.113.1"))).status;
          assertEqual(a21, 429, "R5: (control) client A really is throttled");
          assertEqual(
            (await attempt(on.url, relayed("203.0.113.2"))).status,
            401,
            "R5: one client exhausting its bucket does not throttle another",
          );

          // R21. Wrong keys are counted against the PEER — and against nothing
          // the claimed client owns.
          resetLoginLimits();
          for (let i = 0; i < 21; i++) {
            await attempt(on.url, { "X-Fuel-Relay-Key": `x${RELAY}`, "X-Fuel-Client-Address": "203.0.113.9" });
          }
          assertEqual((await attempt(on.url, {})).status, 429, "R21: a wrong relay key is counted against the peer");
          const relaySpent = await attempt(on.url, { "X-Fuel-Relay-Key": `x${RELAY}`, "X-Fuel-Client-Address": "203.0.113.9" });
          assertEqual(relaySpent.status, 429, "R21: and once the peer is spent, guessing at the key is throttled, not answered");
          assertEqual(
            relaySpent.body.code,
            "relay_rejected",
            "R22: a throttled relay refusal still says relay_rejected, so the dashboard never shows it as a person's lockout",
          );
          // The same on signup, whose own throttle code (`throttled`) would read
          // as the person's fault too.
          let signupSpent: { status: number; body: any } = { status: 0, body: {} };
          for (let i = 0; i < 21; i++) {
            const res = await fetch(`${on.url}/api/auth/signup`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Fuel-Relay-Key": `x${RELAY}`, "X-Fuel-Client-Address": "203.0.113.9" },
              body: JSON.stringify({ token: "t", email: `r-${randomUUID()}@example.com`, password: "wrong-password-123" }),
            });
            signupSpent = { status: res.status, body: await res.json().catch(() => ({})) };
          }
          assertEqual(signupSpent.status, 429, "R22: (control) signup's rejected relay is throttled too");
          assertEqual(signupSpent.body.code, "relay_rejected", "R22: and signup's throttled relay refusal says relay_rejected, not throttled");
          assert(
            (await attempt(on.url, relayed("203.0.113.9"))).status !== 429,
            "R21: and not against the client it named, which never vouched for anything",
          );

          // R6. Every unusable shape from a TRUSTED relay is a 400, never a
          // fall-back and never a fresh bucket.
          resetLoginLimits();
          const shapes: Array<[string, string]> = [
            ["two hops", "203.0.113.1, 203.0.113.2"],
            ["a port", "203.0.113.1:80"],
            ["brackets", "[::1]"],
            ["a zone", "fe80::1%en0"],
            ["empty", ""],
            ["an out-of-range octet", "999.1.1.1"],
            ["a hundred characters", "1".repeat(100)],
            ["a triple colon", "1:::2"],
            ["a leading colon", ":1:2:3:4:5:6:7"],
            ["a trailing newline", "203.0.113.1\n"],
            ["eight groups and ::", "1:2:3:4:5:6:7:8::"],
            ["leading zeros", "203.0.113.01"],
          ];
          for (const [label, value] of shapes) {
            const res =
              value.includes("\n")
                ? // fetch refuses a newline in a header value, so this one is
                  // asked of the resolver directly, with a stubbed request.
                  {
                    status:
                      resolveClient(
                        { headers: { "x-fuel-relay-key": RELAY, "x-fuel-client-address": value }, socket: { remoteAddress: "127.0.0.1" } },
                        relayConfigFrom(relayEnv()),
                      ).kind === "malformed"
                        ? 400
                        : 0,
                    body: null,
                  }
                : await attempt(on.url, relayed(value));
            assertEqual(res.status, 400, `R6: a trusted relay with an unusable address is refused (${label})`);
            // The newline row is asked of the resolver, which has no body to
            // name; asserting one there would only re-read our own literal.
            if (res.body !== null) {
              assertEqual(res.body.code, "malformed_client_address", `R6: and named for what it is (${label})`);
            }
          }

          const absent = await attempt(on.url, { "X-Fuel-Relay-Key": RELAY });
          assertEqual(absent.status, 400, "R6: a trusted relay with no client-address header at all is refused");

          // R7, R8, R9. One client however it is written.
          const sameClient: Array<[string, (i: number) => string]> = [
            ["R7: addresses inside one /64 share a bucket", (i) => `2001:db8:1:2::${(i).toString(16)}`],
            ["R8: an IPv4-mapped address is the same client as its IPv4", (i) => (i % 2 ? "::ffff:203.0.113.5" : "203.0.113.5")],
            ["R9: two spellings of one IPv6 address are one client", (i) => (i % 2 ? "2001:DB8::7" : "2001:db8:0:0::7")],
          ];
          for (const [label, address] of sameClient) {
            resetLoginLimits();
            let last = 0;
            for (let i = 1; i <= 21; i++) last = (await attempt(on.url, relayed(address(i)))).status;
            assertEqual(last, 429, label);
          }

          // R10. A relayed 127.0.0.1 (a local browser) is not a direct 127.0.0.1 (a curl).
          resetLoginLimits();
          let direct21 = 0;
          for (let i = 1; i <= 21; i++) direct21 = (await attempt(on.url, {})).status;
          assertEqual(direct21, 429, "R10: (control) the direct peer really is throttled");
          assertEqual(
            (await attempt(on.url, relayed("127.0.0.1"))).status,
            401,
            "R10: a relayed client never shares a bucket with a direct caller of the same address",
          );

          // R12. Changing addresses does not beat the per-account limit.
          resetLoginLimits();
          const victim = `victim-${randomUUID()}@example.com`;
          let sixth = 0;
          for (let i = 1; i <= 6; i++) sixth = (await attempt(on.url, relayed(`198.18.0.${i}`), victim)).status;
          assertEqual(sixth, 429, "R12: changing addresses does not beat the per-account limit");

          // R15. The relayed ceiling (30 here) holds against many clients.
          resetLoginLimits();
          let spent = 0;
          let ceilingHit = false;
          for (let c = 1; c <= 3 && !ceilingHit; c++) {
            for (let i = 0; i < 20; i++) {
              const res = await attempt(on.url, relayed(`192.0.2.${c}`));
              if (res.status === 429) {
                ceilingHit = true;
                break;
              }
              spent++;
            }
          }
          assert(ceilingHit && spent === 30, `R15: the relayed ceiling holds against many clients (spent ${spent})`);

          // R16. A rotating flood is stopped by the ceiling before it can churn
          // account counters. (That the ceiling sits below the key cap, so
          // eviction is unreachable through the relay, is R14's boot refusal.)
          resetLoginLimits();
          const target = `target-${randomUUID()}@example.com`;
          for (let i = 1; i <= 4; i++) await attempt(on.url, relayed(`198.18.1.${i}`), target);
          let floodStopped = false;
          for (let i = 0; i < 40 && !floodStopped; i++) {
            if ((await attempt(on.url, relayed(`198.18.2.${(i % 250) + 1}`))).status === 429) floodStopped = true;
          }
          assert(floodStopped, "R16: a rotating flood is stopped by the relayed ceiling before it can churn account counters");

          // R17. A header sent twice is refused, not half-believed.
          resetLoginLimits();
          const twiceKey = await attempt(on.url, { "X-Fuel-Relay-Key": RELAY, "x-fuel-relay-key": RELAY, "X-Fuel-Client-Address": "203.0.113.3" });
          assertEqual(twiceKey.status, 403, "R17: a repeated relay key header is refused");
          const twiceAddress = await attempt(on.url, { "X-Fuel-Relay-Key": RELAY, "X-Fuel-Client-Address": "203.0.113.3", "x-fuel-client-address": "203.0.113.4" });
          assertEqual(twiceAddress.status, 400, "R17: a repeated client-address header is refused");
        } finally {
          on.close();
        }

        // R13. Changing addresses does not beat the per-token limit, on signup.
        {
          const app2 = await relayApp(relayConfigFrom(relayEnv()));
          try {
            resetLoginLimits();
            const token = `guess-${randomUUID()}`;
            let last = 0;
            for (let i = 1; i <= 6; i++) {
              const h = new Headers({ "Content-Type": "application/json" });
              h.append("X-Fuel-Relay-Key", RELAY);
              h.append("X-Fuel-Client-Address", `198.18.3.${i}`);
              last = (
                await fetch(`${app2.url}/api/auth/signup`, {
                  method: "POST",
                  headers: h,
                  body: JSON.stringify({ token, email: `s-${i}@example.com`, password: PASSWORD }),
                })
              ).status;
            }
            assertEqual(last, 429, "R13: changing addresses does not beat the per-token limit");
          } finally {
            app2.close();
          }
        }

        // R4. The right key from a peer that is not allowed is refused.
        {
          const app4 = await relayApp(relayConfigFrom(relayEnv({ FUEL_RELAY_PEERS: "::1" })));
          try {
            resetLoginLimits();
            const res = await attempt(app4.url, relayed("203.0.113.1"));
            assertEqual(res.status, 403, "R4: the right relay key from an untrusted peer is refused");
          } finally {
            app4.close();
          }
        }

        // R19. An empty peer list trusts nobody — no fall-back to the default.
        {
          const config = relayConfigFrom(relayEnv({ FUEL_RELAY_PEERS: "" }));
          assertEqual(config.peers.size, 0, "R19: an empty peer list trusts nobody");
          assertEqual(
            resolveClient(
              { headers: { "x-fuel-relay-key": RELAY, "x-fuel-client-address": "203.0.113.1" }, socket: { remoteAddress: "127.0.0.1" } },
              config,
            ).kind,
            "rejected",
            "R19: so even 127.0.0.1 with the right key is refused",
          );
        }

        // R20. With the relay off, relay headers are ignored, never refused.
        {
          const off = await relayApp(relayConfigFrom({ FUEL_API_KEY: OPERATOR_KEY, FUEL_AGENT_KEY: AGENT_KEY }));
          try {
            resetLoginLimits();
            const first = await attempt(off.url, relayed("203.0.113.1"));
            assert(first.status !== 403, "R20: with the relay disabled, relay headers are ignored, not refused");
            let last = 0;
            for (let i = 2; i <= 21; i++) last = (await attempt(off.url, relayed(`203.0.113.${i}`))).status;
            assertEqual(last, 429, "R20: and every attempt keys on the peer, whatever address it claims");
          } finally {
            off.close();
          }
        }

        // R18, and the edges of the resolver, against stubbed sockets.
        const on18 = relayConfigFrom(relayEnv());
        const stub = (remoteAddress: string | undefined, headers: Record<string, string> = {}) => ({
          headers: { "x-fuel-relay-key": RELAY, "x-fuel-client-address": "203.0.113.1", ...headers },
          socket: { remoteAddress },
        });
        assertEqual(resolveClient(stub("::ffff:127.0.0.1"), on18).kind, "relayed", "R18: an IPv4-mapped peer matches a plain allowlist entry");
        assertEqual(resolveClient(stub(undefined), on18).kind, "rejected", "an undefined socket address never matches a peer");
        assertEqual(canonicalAddress("fe80::1%en0"), null, "a zone is refused before net.isIP, which would accept it");
        assertEqual(clientBucketOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64", "IPv6 keys on its /64");
        assertEqual(canonicalAddress("::"), canonicalAddress("0:0:0:0:0:0:0:0"), "'::' has one spelling");
        assertEqual(
          canonicalAddress("::203.0.113.1"),
          canonicalAddress("0:0:0:0:0:0:cb00:7101"),
          "an IPv4-compatible address has one spelling",
        );
        const peerKeyOf = (remoteAddress: string) => {
          const r = resolveClient({ headers: {}, socket: { remoteAddress } }, on18);
          return r.kind === "direct" ? r.key : `unexpected:${r.kind}`;
        };
        assertEqual(
          peerKeyOf("2001:db8:5:6::1"),
          peerKeyOf("2001:db8:5:6::2"),
          "a direct IPv6 caller is keyed per /64 too, not per address",
        );
        assertEqual(peerKeyOf("fe80::1%en0"), peerKeyOf("fe80::1"), "a zone on the socket address names no new caller");
        assert(peerKeyOf("fe80::1%en0") !== "peer:unknown", "and does not collapse the caller into peer:unknown");

        // R11. The relay key is not an API credential.
        assertEqual((await call("/api/agents", RELAY)).status, 401, "R11: the relay key is not an API credential");

        // R14. Boot refuses a relay config that is unsafe.
        const refuses = (env: Record<string, string>) => {
          try {
            relayConfigFrom(env);
            return false;
          } catch {
            return true;
          }
        };
        assert(refuses(relayEnv({ FUEL_RELAY_KEY: "k".repeat(MIN_RELAY_KEY_LENGTH - 1) })), "R14: boot refuses a relay key shorter than 32");
        assert(refuses(relayEnv({ FUEL_RELAY_KEY: OPERATOR_KEY.padEnd(40, "x"), FUEL_API_KEY: OPERATOR_KEY.padEnd(40, "x") })), "R14: boot refuses a relay key equal to FUEL_API_KEY");
        assert(refuses(relayEnv({ FUEL_RELAY_KEY: AGENT_KEY.padEnd(40, "x"), FUEL_AGENT_KEY: AGENT_KEY.padEnd(40, "x") })), "R14: boot refuses a relay key equal to FUEL_AGENT_KEY");
        assert(refuses(relayEnv({ FUEL_RELAYED_CEILING: String(MAX_TRACKED_KEYS) })), "R14: boot refuses a ceiling at or above the limiter's key cap");
        assert(refuses(relayEnv({ FUEL_RELAY_PEERS: "127.0.0.1,not-an-address" })), "R14: boot refuses an invalid peer");
        assert(refuses(relayEnv({ FUEL_RELAY_KEY: "" })), "R14: boot refuses a relay key that is set but empty");
        assert(refuses(relayEnv({ FUEL_RELAY_KEY: " ".repeat(40) })), "R14: boot refuses a relay key of only whitespace");
        for (const bad of ["0", "abc", "1.5", "-3"]) {
          assert(refuses(relayEnv({ FUEL_RELAYED_CEILING: bad })), `R14: boot refuses a relayed ceiling of ${bad}`);
        }
        assert(
          !refuses({ FUEL_API_KEY: OPERATOR_KEY, FUEL_AGENT_KEY: AGENT_KEY }),
          "R14: (control) an unset relay key is a valid config — the relay is simply off",
        );

        // The API reads the socket, never `req.ip`, and nothing turns `trust proxy` on.
        const clientKeySource = withoutComments(readFileSync("src/lib/client-key.ts", "utf8"));
        assert(!/\breq\.ip\b|\.ip\b/.test(clientKeySource), "client-key.ts never reads req.ip");
        assert(
          !/trust proxy/.test(withoutComments(readFileSync("src/server.ts", "utf8"))),
          "src/server.ts never sets trust proxy",
        );
        assert(
          !/\baddressOf\b|req\.ip\b/.test(withoutComments(readFileSync("src/auth/routes.ts", "utf8"))),
          "src/auth/routes.ts no longer keys on req.ip",
        );
        resetLoginLimits();
        console.log(`   ${checks} checks so far`);
      }

      /* --- ADR 0020: the dashboard's edge, and what its relays send ---------- */
      {
        /*
         * WHAT THIS REACHES, AND WHAT IT CANNOT. The edge's header logic and the
         * proof check are plain modules, so they are imported and asked real
         * questions, E4 over a real socket. What they cannot show is that Next
         * itself builds a route handler's headers from the stamped `req.headers`
         * and adds nothing back. That is proven live, against the real built
         * dashboard, by the spoof test in ADR 0020, not stubbed here: a stub of
         * Next would only confirm what I assumed Next does.
         */
        console.log("\n== the dashboard's edge records who is calling (ADR 0020)");
        const edge = await import("../dashboard/lib/edge.mjs");
        const {
          verifiedClientAddress,
          isRelayRefusal,
          RELAY_REFUSAL_CODES,
          CLIENT_ADDRESS_HEADER: DASH_ADDRESS,
          EDGE_PROOF_HEADER: DASH_PROOF,
          MIN_EDGE_PROOF_LENGTH,
        } = await import("../dashboard/lib/client-address.js");
        const { CLIENT_ADDRESS_HEADER: API_ADDRESS } = await import("../src/lib/client-key.js");
        const { RELAY_CODES: API_RELAY_CODES } = await import("../src/auth/codes.js");
        const PROOF = randomBytes(32).toString("hex");

        // E1. Every origin header a caller writes is replaced or removed.
        const forged = (): Record<string, string> => ({
          host: "127.0.0.1:3100",
          "x-fuel-client-address": "198.51.100.66",
          "x-fuel-edge-proof": "f".repeat(64),
          "x-forwarded-for": "198.51.100.67",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
          "x-forwarded-port": "443",
          forwarded: "for=198.51.100.68",
          "x-real-ip": "198.51.100.69",
        });
        const stamped = edge.stampEdgeHeaders(forged(), "127.0.0.1", PROOF);
        assertEqual(
          stamped["x-fuel-client-address"],
          "127.0.0.1",
          "E1: the edge overwrites a client-written X-Fuel-Client-Address with the socket peer",
        );
        assertEqual(stamped["x-forwarded-for"], "127.0.0.1", "E1: and a client-written X-Forwarded-For");
        assertEqual(stamped["x-fuel-edge-proof"], PROOF, "E1: and a client-written edge proof, with its own");
        assertEqual(stamped["x-forwarded-host"], "127.0.0.1:3100", "E1: and X-Forwarded-Host, with the request's own Host");
        assertEqual(stamped["x-forwarded-proto"], "http", "E1: and X-Forwarded-Proto");
        assertEqual(stamped["x-forwarded-port"], "3100", "E1: and X-Forwarded-Port");
        assert(!("forwarded" in stamped) && !("x-real-ip" in stamped), "E1: and drops Forwarded and X-Real-IP outright");
        const gone = edge.stampEdgeHeaders(forged(), undefined, PROOF);
        assert(
          !("x-fuel-client-address" in gone) && !("x-forwarded-for" in gone),
          "E1: a socket that has gone stamps no address, and the forged one is still removed",
        );
        assert(!Object.values(gone).includes("undefined"), "E1: and never the string 'undefined'");
        const hostless = edge.stampEdgeHeaders({ "x-forwarded-host": "evil.example" }, "127.0.0.1", PROOF);
        assert(!("x-forwarded-host" in hostless), "E1: with no Host, a client-written X-Forwarded-Host is removed, not kept");
        assertEqual(
          edge.stampEdgeHeaders({}, "fe80::1%en0", PROOF)["x-fuel-client-address"],
          "fe80::1",
          "E1: a zone on the socket address is dropped, since the API refuses '%'",
        );

        // E2. No genuine proof, no address. The order of these is the point:
        // the unset and empty cases are what `next start` looks like.
        const genuine = { [DASH_PROOF]: PROOF, [DASH_ADDRESS]: "203.0.113.5" };
        assertEqual(verifiedClientAddress(new Headers(genuine), PROOF), "203.0.113.5", "E2: (control) the edge's own proof yields the address");
        assertEqual(
          // The first character FLIPPED, never set: setting it to "0" left the
          // proof unchanged whenever the random one already began with "0", a
          // one-in-sixteen flake that break tests exposed (ADR 0021 session).
          verifiedClientAddress(
            new Headers({ ...genuine, [DASH_PROOF]: `${PROOF[0] === "0" ? "1" : "0"}${PROOF.slice(1)}` }),
            PROOF,
          ),
          null,
          "E2: a wrong proof yields no address",
        );
        assertEqual(verifiedClientAddress(new Headers({ [DASH_ADDRESS]: "203.0.113.5" }), PROOF), null, "E2: a missing proof yields no address");
        assertEqual(
          verifiedClientAddress(new Headers({ [DASH_ADDRESS]: "203.0.113.5" }), undefined),
          null,
          "E2: an unset proof yields no address, with no proof header to compare against either",
        );
        assertEqual(
          verifiedClientAddress(new Headers({ [DASH_PROOF]: "", [DASH_ADDRESS]: "203.0.113.5" }), ""),
          null,
          "E2: an empty proof yields no address, even against an empty header a browser sent",
        );
        const short = "s".repeat(MIN_EDGE_PROOF_LENGTH - 1);
        assertEqual(
          verifiedClientAddress(new Headers({ [DASH_PROOF]: short, [DASH_ADDRESS]: "203.0.113.5" }), short),
          null,
          "E2: a proof shorter than 32 characters yields no address",
        );
        assertEqual(verifiedClientAddress(new Headers({ [DASH_PROOF]: PROOF }), PROOF), null, "E2: a genuine proof naming no address yields none");

        // E3. A browser on ::1 is reported as ::1, which the API buckets as itself.
        assertEqual(edge.stampEdgeHeaders({}, "::1", PROOF)["x-fuel-client-address"], "::1", "E3: a client on ::1 is stamped as ::1");

        // E4. Over a real socket, wired as server.mjs wires it, against a caller
        // forging every header at once, the address header twice included.
        const { createServer } = await import("node:http");
        const seen: (string | null)[] = [];
        const edgeServer = createServer((req, res) => {
          edge.stampEdgeHeaders(req.headers, req.socket.remoteAddress, PROOF);
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
          seen.push(verifiedClientAddress(headers, PROOF));
          res.end();
        });
        edgeServer.listen(0, "127.0.0.1");
        await new Promise((resolve) => edgeServer.once("listening", resolve));
        try {
          const spoof = new Headers({
            "X-Fuel-Edge-Proof": "f".repeat(64),
            "X-Forwarded-For": "198.51.100.67",
            "X-Forwarded-Host": "evil.example",
          });
          spoof.append("X-Fuel-Client-Address", "198.51.100.66");
          spoof.append("X-Fuel-Client-Address", "198.51.100.70");
          await (await fetch(`http://127.0.0.1:${(edgeServer.address() as AddressInfo).port}/`, { headers: spoof })).text();
          assertEqual(seen.join(","), "127.0.0.1", "E4: over a real socket, the address a relay reads is the socket's, whatever the caller wrote");
        } finally {
          edgeServer.close();
        }

        // E5. The edge, the relays and the API agree on names and codes.
        assertEqual(edge.CLIENT_ADDRESS_HEADER, DASH_ADDRESS, "E5: the edge and the relays agree on the client-address header");
        assertEqual(DASH_ADDRESS, API_ADDRESS, "E5: and so does the API");
        assertEqual(edge.EDGE_PROOF_HEADER, DASH_PROOF, "E5: the edge and the relays agree on the proof header");
        assertEqual(
          [...RELAY_REFUSAL_CODES].join(","),
          [...API_RELAY_CODES].join(","),
          "E5: the dashboard's relay codes are exactly the API's RELAY_CODES",
        );
        assert(
          isRelayRefusal("relay_rejected") && isRelayRefusal("malformed_client_address"),
          "E5: both relay codes are recognised as relay refusals",
        );
        assert(
          !isRelayRefusal("throttled") && !isRelayRefusal("invite_unusable") && !isRelayRefusal(null),
          "E5: and nothing else is",
        );

        // E6. Source checks: who sends the key, who refuses, and how it starts.
        // They show the code is WRITTEN this way. The live test shows it runs so.
        const fuelClient = withoutComments(readFileSync("dashboard/lib/fuel.ts", "utf8"));
        const body = (start: string) => {
          const at = fuelClient.indexOf(start);
          return at === -1 ? "" : fuelClient.slice(at, fuelClient.indexOf("\n}\n", at));
        };
        assert(/\.\.\.relayHeaders\(clientAddress\)/.test(body("export async function startSession(")), "E6: startSession sends the relay headers");
        assert(/\.\.\.relayHeaders\(clientAddress\)/.test(body("export async function redeemInvite(")), "E6: redeemInvite sends the relay headers");
        assertEqual(
          [...fuelClient.matchAll(/relayHeaders\(/g)].length,
          3,
          "E6: relayHeaders is called by startSession and redeemInvite only (two calls and its definition)",
        );
        assert(!/relayHeaders|Relay-Key/i.test(body("async function fuelFetch(")), "E6: fuelFetch never carries the relay key");
        assertEqual([...fuelClient.matchAll(/process\.env\.FUEL_RELAY_KEY/g)].length, 1, "E6: lib/fuel.ts reads FUEL_RELAY_KEY in one place");

        function dashboardSources(dir: string, found: string[] = []): string[] {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            // next-env.d.ts is written by Next on a build and is gitignored. Not
            // ours to check, and counting it would make this suite run three
            // more checks in a built checkout than in a fresh clone, which a
            // check-count floor (scripts/test-baseline.json) cannot allow for.
            if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "next-env.d.ts") continue;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) dashboardSources(path, found);
            else if (/\.(ts|tsx|mjs|mts|js)$/.test(entry.name)) found.push(path);
          }
          return found;
        }
        const sources = dashboardSources("dashboard");
        assert(sources.includes("dashboard/server.mjs"), "E6: (control) the dashboard walk finds server.mjs");
        for (const file of sources) {
          const code = withoutComments(readFileSync(file, "utf8"));
          if (file !== "dashboard/lib/fuel.ts") {
            assert(!/process\.env\.FUEL_RELAY_KEY|x-fuel-relay-key/i.test(code), `E6: ${file} never reads or sends the relay key`);
          }
          if (!["dashboard/lib/edge.mjs", "dashboard/lib/edge.d.mts", "dashboard/lib/client-address.ts"].includes(file)) {
            assert(!/x-fuel-edge-proof/i.test(code), `E6: ${file} never reads the edge proof header itself`);
          }
          assert(!/NEXT_PUBLIC_[A-Z_]*(EDGE|RELAY)/.test(code), `E6: ${file} exposes neither secret to the browser`);
        }
        assert(!/\benv\s*:/.test(readFileSync("dashboard/next.config.mjs", "utf8")), "E6: next.config inlines no environment into the build");

        for (const [file, call, page] of [
          ["dashboard/app/api/session/route.ts", "startSession(", "login"],
          ["dashboard/app/api/signup/route.ts", "redeemInvite(", "signup"],
        ] as const) {
          const src = withoutComments(readFileSync(file, "utf8"));
          const verifyAt = src.indexOf("verifiedClientAddress(req.headers, process.env.FUEL_EDGE_PROOF)");
          const refuseAt = src.search(
            new RegExp(`if \\(client === null\\) \\{\\s*console\\.error\\([^;]*\\);\\s*return seeOther\\("/${page}\\?e=unreachable"\\);`),
          );
          const callAt = src.indexOf(call);
          assert(verifyAt !== -1, `E6: ${file} asks the edge for the client address`);
          assert(refuseAt > verifyAt && callAt > refuseAt, `E6: ${file} refuses on a null address BEFORE calling Fuel`);
          assert(new RegExp(`${call.replace("(", "\\(")}[^)]*,\\s*client\\s*\\)`).test(src), `E6: ${file} hands Fuel the verified address`);
          const relayAt = src.search(
            new RegExp(`if \\(isRelayRefusal\\(result\\.code\\)\\) \\{\\s*console\\.error\\([^;]*\\);\\s*return seeOther\\("/${page}\\?e=unreachable"\\);`),
          );
          assert(relayAt > callAt, `E6: ${file} maps a relay refusal to "could not reach Fuel"`);
          const nextOutcome = page === "login" ? src.indexOf("result.status === 429") : src.indexOf("encodeURIComponent(result.code");
          assert(nextOutcome > relayAt, `E6: ${file} does so before any outcome that would blame the person`);
        }

        const scripts = JSON.parse(readFileSync("dashboard/package.json", "utf8")).scripts;
        assertEqual(scripts.start, "node server.mjs start", "E6: npm start runs the edge, not next start");
        assertEqual(scripts.dev, "node server.mjs dev", "E6: npm run dev runs the edge, not next dev");
        const serverSrc = withoutComments(readFileSync("dashboard/server.mjs", "utf8"));
        assertEqual(edge.EDGE_HOST, "127.0.0.1", "E6: the edge binds loopback");
        assert(/server\.listen\(EDGE_PORT, EDGE_HOST\b/.test(serverSrc), "E6: server.mjs binds the hardcoded edge address");
        assert(!/process\.env\.(HOSTNAME|HOST|PORT)\b/.test(serverSrc), "E6: nothing in the environment can move the bind");
        assert(
          /stampEdgeHeaders\(req\.headers, req\.socket\.remoteAddress, proof\);\s*handle\(req, res\)/.test(serverSrc),
          "E6: every request is stamped before Next sees it",
        );
        assert(/const dev = mode === "dev";/.test(serverSrc), "E6: dev mode comes from the argument");
        assertEqual(
          [...serverSrc.matchAll(/NODE_ENV/g)].length === 1 &&
            /process\.env\.NODE_ENV = dev \? "development" : "production";/.test(serverSrc),
          true,
          "E6: and NODE_ENV is only ever written from it, never read",
        );
        assert(/randomBytes\(32\)/.test(serverSrc), "E6: the edge proof is 32 random bytes, made per process");
        console.log(`   ${checks} checks so far`);
      }

      /* --- ADR 0021: alerting -------------------------------------------------- */
      {
        /*
         * EVERY CHECK HERE IS PREFIXED `AL-` so none collides with the R, D, E and
         * O names elsewhere in this file, and every one names the exact outcome
         * it asserts: "refused" is not enough when a plain network error would
         * also look refused.
         *
         * Conditions are REAL ROWS in the tables the screens read, seeded into
         * companies made for this section, with sentinel secrets planted in the
         * source rows so "it did not leak" is a claim about data that was there.
         */
        console.log("\n== alerting: Fuel tells a person (ADR 0021)");
        const { createCompany } = await import("../src/db/companies.js");
        const { createTeam } = await import("../src/db/teams.js");
        const { createAgent } = await import("../src/db/agents.js");
        const { createSession } = await import("../src/db/sessions.js");
        const { createApprovalRequest } = await import("../src/db/approvals.js");
        const { saveConnection } = await import("../src/db/qbo.js");
        const { encryptSecret } = await import("../src/lib/secrets.js");
        const { reserveIfUnderCap } = await import("../src/db/payments.js");
        const alertEvents = await import("../src/alerts/events.js");
        const { attentionFor, collapse } = await import("../src/alerts/attention.js");
        const { sweepCompany, sweepAll } = await import("../src/alerts/sweeper.js");
        const dispatch = await import("../src/alerts/dispatch.js");
        const { startSweepLoop } = await import("../src/alerts/loop.js");
        const alertsDb = await import("../src/db/alerts.js");
        const webhookUrl = await import("../src/alerts/webhook-url.js");
        const { MAX_MESSAGE_CHARS } = await import("../src/alerts/text.js");
        const { dashboardOrigin } = await import("../src/lib/dashboard-origin.js");
        const { dashboardUrl } = await import("../src/quickbooks/callback.js");
        const nodeHttp = await import("node:http");
        const nodeNet = await import("node:net");
        const { createHash } = await import("node:crypto");

        const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
        const MIN = 60_000;
        const T0 = new Date();
        const at = (ms: number) => new Date(T0.getTime() + ms);
        const ALERT_PASSWORD = "alerting-section-password-1";
        const passwordHash = await hashPassword(ALERT_PASSWORD);

        const SENT = {
          resourceSecret: "SENTINELAPIKEY9f3a",
          payer: "0xsentinelpayer0000000000000000000000000001",
          nonce: `0xsentinelnonce${randomUUID().replace(/-/g, "")}`,
          tx: "0xsentineltx",
          address: "0xSENTINELAGENTADDRESS",
          email: `sentinel-decider-${randomUUID()}@example.com`,
          reason: "SENTINEL_FROZEN_REASON",
          path: `SENTINELPATH${randomUUID().replace(/-/g, "")}`,
        };

        /** A company for this section: a team, an owner, an operator, sessions. */
        async function freshCompany(label: string) {
          const company = createCompany({ name: `Alerts ${label} ${randomUUID().slice(0, 6)}`, spendCapBaseUnits: 10_000_000_000n });
          const team = createTeam({ companyId: company.id, name: `${label}-team`, spendCapBaseUnits: 10_000_000_000n });
          const owner = createUser({ companyId: company.id, email: `al-owner-${randomUUID()}@example.com`, passwordHash, role: "owner" });
          const operator = createUser({ companyId: company.id, email: `al-op-${randomUUID()}@example.com`, passwordHash, role: "operator" });
          const mk = (name: string, cap: bigint, teamId: string = team.id) =>
            createAgent({ id: randomUUID(), name, teamId, fireblocksVaultId: `al-${randomUUID()}`, address: SENT.address, spendCapBaseUnits: cap });
          return {
            company,
            team,
            owner,
            mk,
            ownerCookie: `${SESSION_COOKIE}=${createSession(owner.id).token}`,
            operatorCookie: `${SESSION_COOKIE}=${createSession(operator.id).token}`,
          };
        }

        const pay = (
          agentId: string,
          amount: bigint,
          status: string,
          extra: { refusal?: string; createdAt?: string } = {},
        ) =>
          db
            .prepare(
              `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at, refusal_code, is_demo)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            )
            .run(
              randomUUID(),
              agentId,
              amount,
              `https://merchant.test/x?api_key=${SENT.resourceSecret}`,
              status,
              status === "settled" ? SENT.tx : null,
              `detail ${SENT.resourceSecret}`,
              extra.createdAt ?? at(-2 * MIN).toISOString(),
              extra.refusal ?? null,
            );
        const stuckReceipt = (agentId: string, amount: bigint) =>
          db
            .prepare(
              `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status, payer_address, authorization_nonce, tx_hash, detail, created_at)
               VALUES (?, ?, NULL, ?, 'settle_unknown', ?, ?, ?, 'stuck', ?)`,
            )
            .run(randomUUID(), agentId, amount, SENT.payer, `${SENT.nonce}${randomUUID().slice(0, 8)}`, SENT.tx, at(-3 * MIN).toISOString());

        /** Every condition alerting can detect, as real rows, with amounts in `unit`s. */
        async function seedEverything(label: string, unit: bigint) {
          const c = await freshCompany(label);
          const alpha = c.mk("alpha", 1_000_000_000n);
          createApprovalRequest({ agentId: alpha.id, amountBaseUnits: unit, resourceUrl: `https://merchant.test/a?api_key=${SENT.resourceSecret}`, blockedScope: "team" });
          createApprovalRequest({ agentId: alpha.id, amountBaseUnits: unit + 1n, resourceUrl: `https://merchant.test/b?api_key=${SENT.resourceSecret}`, blockedScope: "anomaly" });
          pay(alpha.id, unit * 3n, "unreconciled");
          stuckReceipt(alpha.id, unit * 4n);
          pay(alpha.id, 5n, "blocked", { refusal: "VELOCITY", createdAt: at(-1 * MIN).toISOString() });
          const near = c.mk("near", 1000n);
          pay(near.id, 850n, "settled");
          const spent = c.mk("spent", 1000n);
          pay(spent.id, 1000n, "settled");
          const over = c.mk("over", 1000n);
          pay(over.id, 1500n, "settled");
          const frozen = c.mk("frozen", 1_000_000n);
          db.prepare("UPDATE agents SET frozen_at = ?, frozen_reason = ?, frozen_attempt_count = 3, last_frozen_attempt_at = ? WHERE id = ?").run(
            at(-5 * MIN).toISOString(),
            SENT.reason,
            at(-4 * MIN).toISOString(),
            frozen.id,
          );
          const smallTeam = createTeam({ companyId: c.company.id, name: `${label}-small`, spendCapBaseUnits: 100n });
          const tiny = c.mk("tiny", 1000n, smallTeam.id);
          pay(tiny.id, 200n, "settled");
          const draftId = randomUUID();
          db.prepare(
            `INSERT INTO qbo_posting_drafts (id, company_id, grain, posting_day, direction, counterparty, doc_number, payload_json, payload_hash, source_fingerprint, status, created_at, realm_id)
             VALUES (?, ?, 'daily', '2026-10-01', 'spend', NULL, ?, '{}', 'h', 'f', 'previewed', ?, 'realm-al')`,
          ).run(draftId, c.company.id, `AL-${draftId.slice(0, 8)}`, at(-10 * MIN).toISOString());
          db.prepare(
            `INSERT INTO qbo_postings (id, company_id, draft_id, doc_number, request_id, status, created_at, realm_id)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, 'realm-al')`,
          ).run(randomUUID(), c.company.id, draftId, `AL-${draftId.slice(0, 8)}`, randomUUID(), at(-10 * MIN).toISOString());
          saveConnection({
            companyId: c.company.id,
            realmId: `realm-al-${randomUUID()}`,
            accessToken: "access-token-al",
            accessExpiresAt: at(-60 * MIN).toISOString(),
            refreshToken: "refresh-token-al",
            refreshExpiresAt: at(-24 * 60 * MIN).toISOString(),
          });
          // A decided approval naming a person, so "no decider email" is about data that exists.
          const decider = createUser({ companyId: c.company.id, email: SENT.email, passwordHash, role: "operator" });
          db.prepare(
            `INSERT INTO approval_requests (id, agent_id, amount_base_units, resource_url, blocked_scope, status, created_at, decided_at, decided_by, detail)
             VALUES (?, ?, 1, 'https://merchant.test/d', 'team', 'denied', ?, ?, ?, NULL)`,
          ).run(randomUUID(), alpha.id, at(-30 * MIN).toISOString(), at(-29 * MIN).toISOString(), decider.id);
          return { ...c, alpha, near, frozen };
        }

        /** The same agent names, and only some conditions: the tenancy twin. */
        async function seedTwin(label: string, unit: bigint) {
          const c = await freshCompany(label);
          const alpha = c.mk("alpha", 1_000_000_000n);
          createApprovalRequest({ agentId: alpha.id, amountBaseUnits: unit, resourceUrl: "https://merchant.test/twin", blockedScope: "team" });
          pay(alpha.id, unit * 3n, "unreconciled");
          saveConnection({
            companyId: c.company.id,
            realmId: `realm-al-${randomUUID()}`,
            accessToken: "access-token-al",
            accessExpiresAt: at(60 * MIN).toISOString(),
            refreshToken: "refresh-token-al",
            refreshExpiresAt: at(3 * 24 * 60 * MIN).toISOString(),
          });
          return { ...c, alpha };
        }

        async function req(method: string, path: string, opts: { cookie?: string; key?: string; body?: unknown } = {}) {
          const headers: Record<string, string> = {};
          if (opts.cookie) {
            headers.Cookie = opts.cookie;
            headers.Origin = base;
          }
          if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
          if (opts.body !== undefined) headers["content-type"] = "application/json";
          const res = await fetch(`${base}${path}`, {
            method,
            headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          });
          const text = await res.text();
          let body: any = {};
          try {
            body = JSON.parse(text);
          } catch {
            /* asserted on as text */
          }
          return { status: res.status, body, text };
        }

        const countsByEvent = (companyId: string) => {
          const rows = db
            .prepare("SELECT event, COUNT(*) AS n FROM alert_events WHERE company_id = ? AND resolved_at IS NULL GROUP BY event")
            .all(companyId) as { event: string; n: number }[];
          return Object.fromEntries(rows.map((r) => [r.event, Number(r.n)]));
        };

        // A dispatcher this section drives, with its own clock and a recording transport.
        let clock = T0;
        const sent: { url: string; text: string }[] = [];
        let sendResult: import("../src/alerts/dispatch.js").SendResult = { outcome: "ok", retryable: false };
        const recordingSend: import("../src/alerts/dispatch.js").Send = async (url, text) => {
          sent.push({ url, text });
          return sendResult;
        };
        const d = dispatch.createDispatcher({ send: recordingSend, now: () => clock, timeoutMs: 300 });
        // Bounded, so a slot that never comes back fails a named check
        // instead of hanging the suite.
        const deliverNow = async () => {
          d.pump();
          await Promise.race([d.idle(), sleep(3000)]);
        };
        const seal = (companyId: string, url: string) => webhookUrl.sealWebhook(companyId, url);
        const setHook = (c: { company: { id: string }; owner: { id: string } }, url: string, now = clock) =>
          alertsDb.setWebhook({ companyId: c.company.id, secretEnc: seal(c.company.id, url), userId: c.owner.id, now });

        const A = await seedEverything("A", 111n);
        const B = await seedTwin("B", 222n);

        // ---- AL-A5 FIRST: the sweep is synchronous, structurally -----------------
        assert(
          sweepCompany.constructor.name === "Function" && alertsDb.applySweep.constructor.name === "Function",
          "AL-A5: the sweep and its transaction are plain synchronous functions, not async ones",
        );

        // ---- AL-A6, AL-A9 -----------------------------------------------------------
        const vocabulary = alertEvents.ALERT_EVENTS as readonly string[];
        assert(
          !vocabulary.includes("quickbooks_failing") && !vocabulary.includes("relay_rejected"),
          "AL-A6: QuickBooks failing and relay_rejected are not in the vocabulary: Fuel cannot detect them",
        );
        const savedDashboardUrl = process.env.FUEL_DASHBOARD_URL;
        for (const value of [undefined, "http://localhost:3100", "https://app.fuel.test/some/path?q=1", "not a url", "ftp://x.test"]) {
          if (value === undefined) delete process.env.FUEL_DASHBOARD_URL;
          else process.env.FUEL_DASHBOARD_URL = value;
          assertEqual(dashboardOrigin(), dashboardUrl(), `AL-A9: alert links and the QuickBooks callback agree on the dashboard origin (${value ?? "unset"})`);
        }
        if (savedDashboardUrl === undefined) delete process.env.FUEL_DASHBOARD_URL;
        else process.env.FUEL_DASHBOARD_URL = savedDashboardUrl;

        // ---- AL-A1: each detectable event opens exactly one row -------------------
        const firstA = sweepCompany(A.company.id, T0);
        assert(firstA !== null && typeof (firstA as { then?: unknown }).then !== "function", "AL-A5: a sweep returns no promise");
        sweepCompany(B.company.id, T0);
        const aCounts = countsByEvent(A.company.id);
        for (const event of alertEvents.ALERT_EVENTS.filter((e) => e !== "quickbooks_expiring")) {
          assertEqual(aCounts[event] ?? 0, 1, `AL-A1: seeded state opens exactly one ${event}`);
        }
        assertEqual(countsByEvent(B.company.id).quickbooks_expiring ?? 0, 1, "AL-A1: seeded state opens exactly one quickbooks_expiring");
        const again = sweepCompany(A.company.id, T0);
        assert(!again.wrote, "AL-A1: a second sweep of an unchanged company writes nothing");
        const anOpen = db
          .prepare("SELECT event, subject_key FROM alert_events WHERE company_id = ? AND resolved_at IS NULL LIMIT 1")
          .get(A.company.id) as { event: string; subject_key: string };
        let duplicateRefused = false;
        try {
          db.prepare(
            `INSERT INTO alert_events (id, company_id, event, severity, ceiling, subject_key, payload_json, opened_at, resolved_at, notify_state)
             VALUES (?, ?, ?, 'watch', 'watch', ?, '{}', ?, NULL, 'pending')`,
          ).run(randomUUID(), A.company.id, anOpen.event, anOpen.subject_key, T0.toISOString());
        } catch (error) {
          duplicateRefused = /UNIQUE/.test((error as Error).message);
        }
        assert(duplicateRefused, "AL-A1: the database itself refuses a second open row for one (company, event, subject)");

        // ---- AL-A7: detection is per company, with identical names ----------------
        const bCounts = countsByEvent(B.company.id);
        assertEqual(
          JSON.stringify(Object.keys(bCounts).sort()),
          JSON.stringify(["approval_waiting", "payment_unreconciled", "quickbooks_expiring"]),
          "AL-A7: a company with the same agent names gets exactly its own events, none of the other's",
        );
        const bAmounts = (db.prepare("SELECT payload_json FROM alert_events WHERE company_id = ?").all(B.company.id) as { payload_json: string }[])
          .map((r) => JSON.parse(r.payload_json).amountBaseUnits as string | null)
          .filter((x): x is string => x !== null);
        assert(bAmounts.every((x) => ["222", "666"].includes(x)), "AL-A7: and every amount in its events is its own");

        // ---- AL-A2: the API's list is the definition --------------------------------
        const viaApi = await req("GET", "/api/attention", { cookie: A.operatorCookie });
        assertEqual(viaApi.status, 200, "AL-A2: an operator can read what needs attention");
        const expected = collapse(attentionFor(A.company.id, new Date()));
        assertEqual(
          JSON.stringify(viaApi.body.items.map((i: any) => [i.event, i.agentId, i.items])),
          JSON.stringify(expected.map((g) => [g.event, g.agentId, g.items])),
          "AL-A2: GET /api/attention is exactly attentionFor, collapsed: one definition for the screen and the alerts",
        );
        assertEqual((await req("GET", "/api/attention", { key: AGENT_KEY })).status, 403, "AL-A2: the agent key cannot read it");
        {
          const T = await freshCompany("T");
          for (let i = 0; i < 101; i++) pay(T.mk(`many-${i}`, 1000n).id, 900n, "settled");
          const capped = await req("GET", "/api/attention", { cookie: T.operatorCookie });
          assert(
            capped.body.items.length === 100 && capped.body.total === 101 && capped.body.truncated === true,
            "AL-A2: the list is capped at 100 lines, and the rest are counted, not dropped",
          );
        }

        // ---- AL-A2, the dashboard half: the Overview renders that list and computes nothing
        /*
         * The API half above proves `/api/attention` IS the definition. These
         * prove the Overview shows it as it is: page.tsx has none of the old
         * arithmetic left, the wording module turns every item into exactly one
         * line, the five kinds the Overview already had read word for word as
         * before, and a failed read is shown as a failure. Both dashboard
         * modules are plain TypeScript, so they are imported and asked, not
         * only read.
         */
        {
          const words = await import("../dashboard/lib/attention.js");
          const overview = withoutComments(readFileSync("dashboard/app/page.tsx", "utf8"));
          for (const banned of ["isExhausted", "isOverAuthority", "parseUsd", "listApprovals", ".filter(", ".push("]) {
            assert(!overview.includes(banned), `AL-A2: the Overview computes nothing itself (no ${banned} in page.tsx)`);
          }
          assert(
            overview.includes("getAttentionItems()") && overview.includes(".map(attentionLine)"),
            "AL-A2: the Overview renders the API's list, one line per item",
          );
          assert(
            !withoutComments(readFileSync("dashboard/lib/attention.ts", "utf8")).includes(".filter("),
            "AL-A2: the wording module filters nothing",
          );

          // The real response for company A, through the dashboard's own picker.
          const picked = words.toAttentionList(viaApi.body);
          assert(
            picked !== null &&
              picked.items.length === viaApi.body.items.length &&
              picked.items.every((i: { label: string }, n: number) => words.attentionLine(i as never).kind === viaApi.body.items[n].label),
            "AL-A2: every line the API sends becomes one line on the Overview, under the API's own label",
          );

          // Every kind has its own sentence: the default branch (an unknown
          // kind from a newer API) is the only one with no reason given.
          const sample = (event: string, extra: Record<string, unknown> = {}) => ({
            event,
            label: (alertEvents.LABEL as Record<string, { one: string }>)[event]?.one ?? event,
            severity: "watch" as const,
            items: 1,
            agentId: "agent-1",
            agentName: "research-bot",
            teamName: "Ops",
            amount: "5",
            spent: "4",
            cap: "5",
            count: 3,
            since: "2026-10-01T10:00:00.000Z",
            until: "2026-10-12T10:00:00.000Z",
            scope: "team",
            frozenReason: null,
            href: "/agents/agent-1",
            ...extra,
          });
          const unworded = vocabulary.filter((e) => words.attentionLine(sample(e)).why === "");
          assertEqual(unworded.join(","), "", "AL-A2: every alert kind has its own sentence on the Overview");

          // The five kinds the Overview already had: the old page.tsx templates,
          // word for word, kind and tone included.
          const old: [string, Record<string, unknown>, string, string, string, string][] = [
            ["agent_frozen", {}, "Frozen", "bad", "research-bot", "No reason was recorded."],
            ["agent_frozen", { frozenReason: "paused by finance" }, "Frozen", "bad", "research-bot", "paused by finance"],
            ["approval_waiting", { amount: "12.5" }, "Awaiting approval", "bad", "$12.5 for research-bot", "Held since 2026-10-01 — blocked at the team ceiling."],
            ["approval_waiting", { scope: "company", agentName: null }, "Awaiting approval", "bad", "$5 for an agent", "Held since 2026-10-01 — blocked at the company ceiling."],
            ["agent_over_authority", { spent: "0.024", cap: "0.003" }, "Over authority", "watch", "research-bot", "Spent $0.024 against a $0.003 cap."],
            ["agent_no_authority", { cap: "0.005" }, "No authority left", "watch", "research-bot", "Spent its full $0.005. Its next payment will be refused."],
            ["team_at_ceiling", { spent: "0.185", cap: "0.021", href: null }, "Team at its ceiling", "watch", "Ops", "Spent $0.185 against a $0.021 cap. Every agent under it is affected."],
          ];
          for (const [event, extra, kind, tone, what, why] of old) {
            const line = words.attentionLine(sample(event, extra));
            assertEqual(
              JSON.stringify([line.kind, line.tone, line.what, line.why]),
              JSON.stringify([kind, tone, what, why]),
              `AL-A2: "${kind}" reads exactly as the Overview always worded it (${event}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""})`,
            );
          }
          assertEqual(
            words.attentionLine(sample("approval_waiting", { items: 3, amount: "15", scope: null })).what,
            "3 payments, $15 in all, for research-bot",
            "AL-A2: a collapsed line says how many and the total",
          );

          // Links stay inside the dashboard.
          const hrefOf = (href: string) => {
            const list = words.toAttentionList({ items: [sample("agent_frozen", { href })], total: 1 });
            return list === null || list.items.length !== 1 ? "list refused" : list.items[0].href;
          };
          assert(
            hrefOf("//evil.example/x") === null && hrefOf("javascript:alert(1)") === null && hrefOf("https://evil.example") === null &&
              hrefOf("/agents/0b3c-41") === "/agents/0b3c-41",
            "AL-A2: a link that would leave the dashboard is not rendered",
          );

          // A failed read is a failure on screen, never "nothing needs a person".
          assert(
            words.toAttentionList({ nope: true }) === null && words.toAttentionList({ items: [{ event: 1 }], total: 1 }) === null,
            "AL-A2: a response that is not the list is refused, not read as an empty one",
          );
          assert(
            words.toAttentionList({ items: [], total: 5 }) === null &&
              words.toAttentionList({ items: [sample("agent_frozen")], total: 0 }) === null &&
              words.toAttentionList({ items: [], total: 5, truncated: true }) === null &&
              words.toAttentionList({ items: [sample("agent_frozen")], total: 5, truncated: true }) !== null,
            "AL-A2: a total that disagrees with the items is refused, so it cannot render as nothing needing a person",
          );
          const allClear = overview.slice(overview.indexOf("Nothing needs a person."), overview.indexOf("</p>", overview.indexOf("Nothing needs a person.")));
          assert(
            allClear.length > 0 && !/QuickBooks/i.test(allClear),
            "AL-A2: the all-clear sentence claims nothing the list cannot know (it does not vouch for QuickBooks)",
          );
          const client = withoutComments(readFileSync("dashboard/lib/fuel.ts", "utf8"));
          const getter = client.slice(client.indexOf("export async function getAttentionItems"), client.indexOf("export async function getAlertSettings"));
          assert(
            (getter.match(/throw new Error/g) ?? []).length === 2 && !getter.includes("return {"),
            "AL-A2: the Overview's read throws on a failed or unrecognised answer, and never invents an empty list",
          );
          const failedAt = overview.indexOf("lines === null");
          const emptyAt = overview.indexOf("lines.length === 0");
          assert(
            failedAt !== -1 && emptyAt !== -1 && failedAt < emptyAt && overview.includes("return null;"),
            "AL-A2: the Overview shows a failed read as a failure before it can say nothing needs a person",
          );
        }

        // ---- AL-A4: the sweeper changes no pre-existing table ------------------------
        const tableHash = () => {
          const tables = (
            db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'alert_%' AND name NOT LIKE 'sqlite_%' ORDER BY name")
              .all() as { name: string }[]
          ).map((t) => t.name);
          const h = createHash("sha256");
          for (const t of tables) {
            h.update(t);
            for (const row of db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()) {
              h.update(JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
            }
          }
          return { tables, digest: h.digest("hex") };
        };
        const before = tableHash();
        await sweepAll({ now: () => T0, dispatcher: null });
        const after = tableHash();
        assert(
          ["agents", "payments", "approval_requests", "receipts", "qbo_postings", "qbo_connections", "users", "companies"].every((t) => before.tables.includes(t)),
          `AL-A4: (control) the hash covers every money and identity table (${before.tables.length} tables)`,
        );
        assertEqual(after.digest, before.digest, "AL-A4: a full sweep over every company changes no pre-existing table, not one byte");

        // ---- AL-R1: the webhook routes are owner-only --------------------------------
        const hookA = `https://hooks.a.test/services/${SENT.path}`;
        const hookB = "https://hooks.b.test/services/b";
        assertEqual((await req("GET", "/api/alerts/webhook", { key: OPERATOR_KEY })).status, 403, "AL-R1: the shared key cannot read the webhook");
        assertEqual((await req("GET", "/api/alerts/webhook", { cookie: A.operatorCookie })).status, 403, "AL-R1: an operator cannot read the webhook");
        assertEqual((await req("PUT", "/api/alerts/webhook", { cookie: A.operatorCookie, body: { url: hookA } })).status, 403, "AL-R1: an operator cannot set the webhook");
        assertEqual((await req("GET", "/api/alerts", { cookie: A.operatorCookie })).status, 403, "AL-R1: an operator cannot read the alert history");
        assertEqual((await req("DELETE", "/api/alerts/webhook", { cookie: A.operatorCookie })).status, 403, "AL-R1: an operator cannot remove the webhook");
        assertEqual((await req("PUT", "/api/alerts/webhook", { key: OPERATOR_KEY, body: { url: "https://hooks.a.test/x" } })).status, 403, "AL-R1: the shared key cannot set the webhook");
        assertEqual((await req("GET", "/api/alerts", { key: OPERATOR_KEY })).status, 403, "AL-R1: the shared key cannot read the alert history");
        assertEqual((await req("POST", "/api/alerts/webhook/test", { key: OPERATOR_KEY })).status, 403, "AL-R1: the shared key cannot send a test alert");
        assertEqual((await req("DELETE", "/api/alerts/webhook", { key: OPERATOR_KEY })).status, 403, "AL-R1: the shared key cannot remove the webhook");
        const putA = await req("PUT", "/api/alerts/webhook", { cookie: A.ownerCookie, body: { url: hookA } });
        assertEqual(putA.status, 200, "AL-R1: an owner can set the webhook");
        assertEqual(putA.body.host, "hooks.a.test", "AL-R1: and sees its host");
        const aSealed = alertsDb.getWebhookRow(A.company.id)!.secretEnc;
        assertEqual((await req("PUT", "/api/alerts/webhook", { cookie: B.ownerCookie, body: { url: hookB } })).status, 200, "AL-R1: (control) company B's owner sets B's");
        assertEqual(alertsDb.getWebhookRow(A.company.id)!.secretEnc, aSealed, "AL-R1: company B's owner cannot replace company A's webhook");
        assertEqual((await req("GET", "/api/alerts/webhook", { cookie: B.ownerCookie })).body.host, "hooks.b.test", "AL-R1: and reads only B's");

        // ---- AL-S4: set-time rules (sole owner of them) -----------------------------
        const ECHO = `ECHO${randomUUID().replace(/-/g, "")}`;
        for (const [bad, code] of [
          [`http://hooks.a.test/${ECHO}`, "not_https"],
          [`https://user:pass@hooks.a.test/${ECHO}`, "has_credentials"],
          [`https://hooks.a.test:8443/${ECHO}`, "non_default_port"],
          [`https://1.2.3.4/${ECHO}`, "ip_literal"],
          [`https://[::1]/${ECHO}`, "ip_literal"],
          [`https://[2001:db8::1]/${ECHO}`, "ip_literal"],
          [`https://0x7f000001/${ECHO}`, "ip_literal"],
          [`not a url ${ECHO}`, "not_a_url"],
          [`https://hooks.a.test/${ECHO}${"x".repeat(2100)}`, "too_long"],
        ] as const) {
          const refused = await req("PUT", "/api/alerts/webhook", { cookie: A.ownerCookie, body: { url: bad } });
          assertEqual(`${refused.status} ${refused.body.code}`, `400 ${code}`, `AL-S4: a webhook like ${bad.slice(0, 32)} is refused when set (${code})`);
          assert(!refused.text.includes(ECHO), `AL-S4: and the refusal does not echo it (${code})`);
        }
        assertEqual(alertsDb.getWebhookRow(A.company.id)!.secretEnc, aSealed, "AL-S4: and a refused URL replaces nothing");

        // ---- AL-D3: two companies, two webhooks: tenancy first, then delivery --------
        clock = at(1 * MIN);
        pay(B.mk("delta", 1_000_000_000n).id, 8888n, "unreconciled");
        sweepCompany(B.company.id, clock);
        pay(A.mk("delta", 1_000_000_000n).id, 9999n, "unreconciled");
        sweepCompany(A.company.id, clock);
        sent.length = 0;
        await deliverNow();
        // The first real deliveries of this section: their slots must come back.
        assertEqual(d.inFlight().total, 0, "AL-D6: every slot comes back when its delivery finishes (first deliveries)");
        const toAOnly = sent.filter((s) => s.url === hookA);
        const toBOnly = sent.filter((s) => s.url === hookB);
        assert(
          toBOnly.every((s) => !s.text.includes("0.009999")) && toAOnly.every((s) => !s.text.includes("0.008888")),
          "AL-D3: A's events never reach B's webhook, and B's never reach A's",
        );
        // Confirmed from the database, not from where a line lands in the text:
        // the event is in a delivery to its own company that was sent.
        const deliveredFor = (companyId: string, amount: string) =>
          (
            db
              .prepare(
                `SELECT d.status FROM alert_events e
                   JOIN alert_deliveries d ON d.id = e.delivery_id AND d.company_id = e.company_id
                  WHERE e.company_id = ? AND e.payload_json LIKE ?`,
              )
              .get(companyId, `%"amountBaseUnits":"${amount}"%`) as { status: string } | undefined
          )?.status;
        assert(toAOnly.length === 1 && deliveredFor(A.company.id, "9999") === "sent", "AL-D3: company A's alert reaches A's webhook");
        assert(toBOnly.length === 1 && deliveredFor(B.company.id, "8888") === "sent", "AL-D3: company B's alert reaches B's webhook");

        // ---- AL-A8: setting a webhook never sends what was already open --------------
        const baselined = db
          .prepare("SELECT COUNT(*) AS n FROM alert_events WHERE company_id = ? AND resolved_at IS NULL AND notify_state = 'baseline'")
          .get(A.company.id) as { n: number };
        assertEqual(Number(baselined.n), Object.values(aCounts).reduce((s, n) => s + n, 0), "AL-A8: every event open when the webhook was set is marked baseline");
        // A's own amounts from before the webhook: approval, anomaly, payment, receipt.
        const backlog = ["0.000111", "0.000112", "0.000333", "0.000444"];
        assert(
          !sent.some((s) => s.url === hookA && backlog.some((amount) => s.text.includes(amount))),
          "AL-A8: a webhook set while events are open never sends them",
        );
        pay(A.alpha.id, 7777n, "unreconciled");
        sweepCompany(A.company.id, clock);
        sent.length = 0;
        await deliverNow();
        const toA = sent.filter((s) => s.url === hookA);
        assertEqual(toA.length, 1, "AL-A8: a condition that opens afterwards is sent");
        assert(
          toA[0]!.text.includes("$0.007777") && !backlog.some((amount) => toA[0]!.text.includes(amount)),
          "AL-A8: and only that one, not the backlog",
        );

        {
          const N = await freshCompany("N");
          pay(N.mk("unswept", 1_000_000_000n).id, 4321n, "unreconciled");
          // No sweep: the condition is real, but there is no event for it yet.
          assertEqual((await req("PUT", "/api/alerts/webhook", { cookie: N.ownerCookie, body: { url: "https://hooks.n.test/x" } })).status, 200, "AL-A8: (control) the owner sets a webhook");
          sent.length = 0;
          sweepCompany(N.company.id, clock);
          await deliverNow();
          assert(
            !sent.some((x) => x.url === "https://hooks.n.test/x"),
            "AL-A8: a condition not yet swept when the webhook is set is never sent",
          );
        }

        // ---- AL-D5: what leaves Fuel ------------------------------------------------
        const hostile = A.mk("<!channel> @here `tick` *bold* <https://evil.test|click>\nFAKE: approve now \u202Eevil", 1_000_000n);
        pay(hostile.id, 4242n, "unreconciled");
        sweepCompany(A.company.id, clock);
        sent.length = 0;
        await deliverNow();
        const hostileText = sent.find((s) => s.url === hookA)?.text ?? "";
        assert(hostileText.includes("0.004242"), "AL-D5: (control) the hostile agent's alert was sent");
        assert(!hostileText.includes("<!channel>") && hostileText.includes("&lt;!channel&gt;"), "AL-D5: <!channel> in a name is escaped, so it pages nobody");
        assert(!hostileText.includes("<https://evil.test|click>"), "AL-D5: a <url|text> link in a name is escaped");
        assert(!/(^|\s)@here/.test(hostileText) && hostileText.includes("@\u200Bhere"), "AL-D5: a plain @here cannot notify");
        assert(!hostileText.split("\n").some((l) => l.startsWith("FAKE")), "AL-D5: a newline in a name cannot forge a line");
        assert(!hostileText.includes("\u202E"), "AL-D5: a bidi override in a name is removed");
        assert(!hostileText.includes("`tick`"), "AL-D5: a backtick in a name cannot close its code span");
        assert(hostileText.length <= MAX_MESSAGE_CHARS, "AL-D5: the message fits the receiver's limit");

        // Sentinels: present in the source rows, absent from everything that leaves.
        const present = (sql: string, ...args: string[]) => (db.prepare(sql).get(...(args as never[])) as { n: number }).n > 0;
        assert(present("SELECT COUNT(*) AS n FROM payments WHERE resource_url LIKE ?", `%${SENT.resourceSecret}%`), "AL-D5: (control) a resource URL carrying a secret is in the source rows");
        assert(present("SELECT COUNT(*) AS n FROM receipts WHERE payer_address = ?", SENT.payer), "AL-D5: (control) a payer address is in the source rows");
        assert(present("SELECT COUNT(*) AS n FROM users WHERE email = ?", SENT.email), "AL-D5: (control) a decider's email is in the source rows");
        assert(present("SELECT COUNT(*) AS n FROM agents WHERE address = ?", SENT.address), "AL-D5: (control) a custody address is in the source rows");
        const payloads = (db.prepare("SELECT payload_json FROM alert_events WHERE company_id IN (?, ?)").all(A.company.id, B.company.id) as { payload_json: string }[])
          .map((r) => r.payload_json)
          .join("\n");
        const alertsBody = (await req("GET", "/api/alerts", { cookie: A.ownerCookie })).text;
        const attentionBody = (await req("GET", "/api/attention", { cookie: A.operatorCookie })).text;
        const allTexts = sent.map((s) => s.text).join("\n") + "\n" + toA.map((s) => s.text).join("\n");
        for (const [where, haystack] of [
          ["the webhook text", allTexts],
          ["stored payloads", payloads],
          ["GET /api/alerts", alertsBody],
          ["GET /api/attention", attentionBody],
        ] as const) {
          for (const [what, needle] of [
            ["resource-URL secret", SENT.resourceSecret],
            ["payer address", SENT.payer],
            ["nonce", SENT.nonce.slice(0, 20)],
            ["tx hash", SENT.tx],
            ["custody address", SENT.address],
            ["decider email", SENT.email],
          ] as const) {
            assert(!haystack.includes(needle), `AL-D5: ${where} carries no ${what}`);
          }
        }
        for (const [where, haystack] of [["the webhook text", allTexts], ["stored payloads", payloads], ["GET /api/alerts", alertsBody]] as const) {
          assert(!haystack.includes(SENT.reason), `AL-D5: ${where} carries no operator-typed freeze reason`);
        }
        for (const term of NO_CRYPTO) {
          assert(!allTexts.toLowerCase().includes(term), `AL-D5: the webhook text carries no crypto term (${term})`);
        }
        for (const fragment of ["_enc", "txHash", "resourceUrl", "walletAddress", "access_token", "refresh_token"]) {
          assert(!alertsBody.includes(fragment) && !attentionBody.includes(fragment), `AL-D5: no route body carries ${fragment}`);
        }

        // ---- AL-A3: resolved events do not re-alert; cooldown; freeze cycling ------------
        {
          const Q = await freshCompany("Q");
          const cool = Q.mk("cool", 1000n);
          pay(cool.id, 850n, "settled");
          const ice = Q.mk("ice", 1_000_000n);
          setHook(Q, "https://hooks.q.test/x", at(0));
          const deliveriesOf = () => Number((db.prepare("SELECT COUNT(*) AS n FROM alert_deliveries WHERE company_id = ?").get(Q.company.id) as { n: number }).n);
          const nearRows = () =>
            db.prepare("SELECT id, notify_state, resolved_at FROM alert_events WHERE company_id = ? AND event = 'agent_near_cap'").all(Q.company.id) as {
              id: string;
              notify_state: string;
              resolved_at: string | null;
            }[];
          const step = async (ms: number) => {
            clock = at(ms);
            sweepCompany(Q.company.id, clock);
            await deliverNow();
          };
          await step(2 * MIN);
          const first = nearRows();
          assertEqual(first.length, 1, "AL-A3: (control) near-cap opens one row");
          const deliveriesAfterFirst = deliveriesOf();
          db.prepare("UPDATE agents SET spend_cap_base_units = 100000 WHERE id = ?").run(cool.id);
          await step(3 * MIN);
          db.prepare("UPDATE agents SET spend_cap_base_units = 1000 WHERE id = ?").run(cool.id);
          await step(7 * MIN);
          const reopened = nearRows();
          assert(
            reopened.length === 1 && reopened[0]!.id === first[0]!.id && reopened[0]!.notify_state === "silent" && deliveriesOf() === deliveriesAfterFirst,
            "AL-A3: a condition back within the cooldown reopens its old row silently, and nothing is sent",
          );
          db.prepare("UPDATE agents SET spend_cap_base_units = 100000 WHERE id = ?").run(cool.id);
          await step(8 * MIN);
          db.prepare("UPDATE agents SET spend_cap_base_units = 1000 WHERE id = ?").run(cool.id);
          await step(8 * MIN + 61 * MIN);
          const later = nearRows();
          assert(later.length === 2 && deliveriesOf() === deliveriesAfterFirst + 1, "AL-A3: after the cooldown it is a new alert, and it is sent");
          const frozenRows = () => Number((db.prepare("SELECT COUNT(*) AS n FROM alert_events WHERE company_id = ? AND event = 'agent_frozen'").get(Q.company.id) as { n: number }).n);
          const before = deliveriesOf();
          for (let i = 0; i < 4; i++) {
            db.prepare("UPDATE agents SET frozen_at = ? WHERE id = ?").run(at(80 * MIN + i * 2 * MIN).toISOString(), ice.id);
            await step(80 * MIN + i * 2 * MIN);
            db.prepare("UPDATE agents SET frozen_at = NULL WHERE id = ?").run(ice.id);
            await step(81 * MIN + i * 2 * MIN);
          }
          assert(frozenRows() === 1 && deliveriesOf() === before + 1, "AL-A3: freezing and unfreezing four times inside an hour is one alert");
        }

        // ---- AL-D4: an alert storm ---------------------------------------------------
        {
          const S = await freshCompany("S");
          const hookS = "https://hooks.s.test/x";
          setHook(S, hookS, at(200 * MIN));
          const toS = () => sent.filter((x) => x.url === hookS);
          sent.length = 0;
          const deliveries = (ceiling: string) =>
            Number((db.prepare("SELECT COUNT(*) AS n FROM alert_deliveries WHERE company_id = ? AND ceiling = ?").get(S.company.id, ceiling) as { n: number }).n);
          const allDeliveries = () => Number((db.prepare("SELECT COUNT(*) AS n FROM alert_deliveries WHERE company_id = ?").get(S.company.id) as { n: number }).n);
          const pendingOf = (ceiling: string) =>
            Number(
              (db.prepare("SELECT COUNT(*) AS n FROM alert_events WHERE company_id = ? AND ceiling = ? AND notify_state = 'pending' AND resolved_at IS NULL").get(S.company.id, ceiling) as { n: number }).n,
            );
          const sweepS = async (ms: number) => {
            clock = at(ms);
            sweepCompany(S.company.id, clock);
            await deliverNow();
          };
          // Watch noise: a new near-cap agent each sweep, two in the first.
          for (let i = 0; i < 6; i++) {
            const a = S.mk(`noisy-${i}`, 1000n);
            pay(a.id, 900n, "settled");
            if (i === 0) pay(S.mk("noisy-twin", 1000n).id, 900n, "settled");
            await sweepS(200 * MIN + i * MIN);
            if (i === 0) assertEqual(allDeliveries(), 1, "AL-D4: two new items in one sweep become one message");
          }
          assertEqual(deliveries("watch"), 4, "AL-D4: watch noise stops at its own hourly ceiling");
          assertEqual(pendingOf("watch"), 2, "AL-D4: and what it holds back waits as pending, not dropped");
          // Approval noise, as an agent-key holder can mint it: a new request each sweep.
          const victim = S.mk("victim", 1_000_000_000n);
          for (let i = 0; i < 8; i++) {
            createApprovalRequest({ agentId: victim.id, amountBaseUnits: 10n + BigInt(i), resourceUrl: `https://merchant.test/flood?i=${i}`, blockedScope: "team" });
            await sweepS(207 * MIN + i * MIN);
          }
          assertEqual(deliveries("approval"), 6, "AL-D4: approvals stop at their own hourly ceiling");
          pay(victim.id, 31337n, "unreconciled");
          await sweepS(216 * MIN);
          const moneyText = toS().at(-1)?.text ?? "";
          assert(moneyText.includes("0.031337"), "AL-D4: with the watch and approval ceilings full, a real unreconciled payment still gets out");
          assert(/2 approvals waiting for `victim`/.test(moneyText), "AL-D4: and the approvals held back ride along in it");
          // Held by its ceiling with nothing else happening: it must still go out.
          createApprovalRequest({ agentId: victim.id, amountBaseUnits: 99n, resourceUrl: "https://merchant.test/flood?late=1", blockedScope: "team" });
          await sweepS(217 * MIN);
          assertEqual(pendingOf("approval"), 1, "AL-D4: (control) an approval past its ceiling is held");
          const heldBefore = allDeliveries();
          await sweepS(268 * MIN);
          assert(
            allDeliveries() === heldBefore + 1 && (toS().at(-1)?.text ?? "").includes("0.000099"),
            "AL-D4: an event held by a ceiling is sent once its hour frees, with nothing new needed",
          );
          // Thirty more approvals for one agent and 500 stuck receipts across 12 agents, at once.
          for (let i = 0; i < 30; i++) {
            createApprovalRequest({ agentId: victim.id, amountBaseUnits: 1000n + BigInt(i), resourceUrl: `https://merchant.test/flood2?i=${i}`, blockedScope: "team" });
          }
          const receivers = Array.from({ length: 12 }, (_, i) => S.mk(`earner-${i}`, 1_000_000n));
          for (let i = 0; i < 500; i++) stuckReceipt(receivers[i % 12]!.id, 1000n);
          const stormBefore = allDeliveries();
          clock = at(270 * MIN);
          sweepCompany(S.company.id, clock);
          assertEqual(allDeliveries(), stormBefore + 1, "AL-D4: 530 new items in one sweep become one message");
          await deliverNow();
          const stormText = toS().at(-1)?.text ?? "";
          assert(/30 approvals waiting for `victim`/.test(stormText), "AL-D4: thirty approvals for one agent collapse to one line");
          assert((stormText.match(/^• /gm) ?? []).length <= 8 && /…and \d+ more\./.test(stormText), "AL-D4: at most eight lines, then 'and N more'");
          assert(stormText.length <= MAX_MESSAGE_CHARS, "AL-D4: and it fits the receiver's limit");
          assert(
            !stormText.includes(SENT.payer) && !stormText.includes(SENT.nonce.slice(0, 20)) && !stormText.includes(SENT.tx),
            "AL-D4: stuck receipts reach the webhook without their payer, nonce or hash",
          );
          const recorded = Number((db.prepare("SELECT COUNT(*) AS n FROM alert_events WHERE company_id = ? AND event = 'receipt_stuck'").get(S.company.id) as { n: number }).n);
          assertEqual(recorded, 500, "AL-D4: every one of the 500 is still recorded");
        }

        // ---- AL-D2: a webhook returning 500 forever; a 404 is permanent ----------------
        {
          const F = await freshCompany("F");
          setHook(F, "https://hooks.f.test/x", at(300 * MIN));
          const agent = F.mk("fails", 1_000_000_000n);
          pay(agent.id, 101n, "unreconciled");
          clock = at(300 * MIN);
          sweepCompany(F.company.id, clock);
          sendResult = { outcome: "http_5xx", retryable: true };
          const delivery = () =>
            db.prepare("SELECT id, status, attempts, next_attempt_at FROM alert_deliveries WHERE company_id = ? ORDER BY created_at LIMIT 1").get(F.company.id) as {
              id: string;
              status: string;
              attempts: number;
              next_attempt_at: string;
            };
          const gaps: number[] = [];
          for (let i = 0; i < 8; i++) {
            const before = delivery();
            if (before.status !== "due") break;
            clock = new Date(before.next_attempt_at);
            await deliverNow();
            const afterAttempt = delivery();
            if (afterAttempt.status === "due") gaps.push((new Date(afterAttempt.next_attempt_at).getTime() - clock.getTime()) / MIN);
          }
          assertEqual(delivery().status, "failed", "AL-D2: a webhook returning 500 forever is given up on");
          assertEqual(Number(delivery().attempts), alertsDb.MAX_ATTEMPTS, "AL-D2: after exactly six attempts");
          assertEqual(JSON.stringify(gaps), JSON.stringify([1, 2, 4, 8, 16]), "AL-D2: backing off 1, 2, 4, 8, 16 minutes");
          const state = await req("GET", "/api/alerts/webhook", { cookie: F.ownerCookie });
          assertEqual(state.body.state, "degraded", "AL-D2: and the owner sees the webhook as degraded");
          const eventState = () =>
            (db.prepare("SELECT notify_state FROM alert_events WHERE company_id = ? AND event = 'payment_unreconciled'").get(F.company.id) as { notify_state: string }).notify_state;
          assertEqual(eventState(), "pending", "AL-D2: the events of a failed delivery go back to pending, not lost");
          const failedAt = clock.getTime();
          const deliveriesOfF = () => Number((db.prepare("SELECT COUNT(*) AS n FROM alert_deliveries WHERE company_id = ?").get(F.company.id) as { n: number }).n);
          const beforeBreaker = deliveriesOfF();
          clock = new Date(failedAt + 1 * MIN);
          sweepCompany(F.company.id, clock);
          assertEqual(deliveriesOfF(), beforeBreaker, "AL-D2: a degraded webhook gets at most one new message per 15 minutes");
          sendResult = { outcome: "ok", retryable: false };
          sent.length = 0;
          clock = new Date(failedAt + 16 * MIN);
          sweepCompany(F.company.id, clock);
          await deliverNow();
          assert(
            sent.some((x) => x.url === "https://hooks.f.test/x" && x.text.includes("0.000101")),
            "AL-D2: the events of a failed delivery are sent again once the webhook answers",
          );
          sendResult = { outcome: "http_4xx", retryable: false };
          pay(agent.id, 202n, "unreconciled");
          clock = at(400 * MIN);
          sweepCompany(F.company.id, clock);
          await deliverNow();
          const second = db.prepare("SELECT status, attempts FROM alert_deliveries WHERE company_id = ? ORDER BY created_at DESC LIMIT 1").get(F.company.id) as {
            status: string;
            attempts: number;
          };
          assertEqual(`${second.status} ${second.attempts}`, "failed 1", "AL-D2: a 404 is permanent: one attempt, no retries");
          sendResult = { outcome: "ok", retryable: false };
        }

        // ---- AL-D6: a crashed send is retried after its lease, never in parallel --------
        {
          const L = await freshCompany("L");
          setHook(L, "https://hooks.l.test/x", at(500 * MIN));
          const agent = L.mk("leased", 1_000_000_000n);
          pay(agent.id, 303n, "unreconciled");
          clock = at(500 * MIN);
          sweepCompany(L.company.id, clock);
          const claimed = alertsDb.claimDue(clock, 5, new Set());
          assertEqual(claimed.filter((c) => c.companyId === L.company.id).length, 1, "AL-D6: (control) the delivery is claimed");
          assertEqual(
            alertsDb.claimDue(at(501 * MIN), 5, new Set()).filter((c) => c.companyId === L.company.id).length,
            0,
            "AL-D6: a claimed delivery is not claimed again while its lease holds",
          );
          const reclaimed = alertsDb.claimDue(at(503 * MIN), 5, new Set()).filter((c) => c.companyId === L.company.id);
          assert(reclaimed.length === 1 && reclaimed[0]!.attempts === 2, "AL-D6: after the lease runs out (a crash), it is retried");
          db.prepare("UPDATE alert_deliveries SET status = 'due', lease_until = NULL, next_attempt_at = ? WHERE company_id = ?").run(at(503 * MIN).toISOString(), L.company.id);
          let concurrent = 0;
          let maxConcurrent = 0;
          const slow = dispatch.createDispatcher({
            send: async () => {
              concurrent += 1;
              maxConcurrent = Math.max(maxConcurrent, concurrent);
              await sleep(100);
              concurrent -= 1;
              return { outcome: "ok", retryable: false };
            },
            now: () => at(504 * MIN),
            timeoutMs: 1000,
          });
          // A second due delivery for the same company, then two pumps at once.
          pay(agent.id, 304n, "unreconciled");
          db.prepare(
            `INSERT INTO alert_deliveries (id, company_id, ceiling, status, attempts, created_at, next_attempt_at)
             VALUES (?, ?, 'money', 'due', 0, ?, ?)`,
          ).run(randomUUID(), L.company.id, at(503 * MIN).toISOString(), at(503 * MIN).toISOString());
          slow.pump();
          slow.pump();
          assertEqual(slow.inFlight().companies.filter((c) => c === L.company.id).length, 1, "AL-D6: one company never has two deliveries in flight");
          await slow.idle();
          assertEqual(maxConcurrent, 1, "AL-D6: and its sends never overlap");
          db.prepare("UPDATE alert_deliveries SET status = 'cancelled' WHERE company_id = ? AND status = 'due'").run(L.company.id);

          // Across companies: never more than two in flight at once.
          const many = await Promise.all(["G1", "G2", "G3"].map((g) => freshCompany(g)));
          for (const g of many) {
            setHook(g, `https://hooks.${g.team.name.toLowerCase()}.test/x`, at(510 * MIN));
            pay(g.mk("g", 1_000_000_000n).id, 77n, "unreconciled");
            sweepCompany(g.company.id, at(510 * MIN));
          }
          const wide = dispatch.createDispatcher({
            send: async () => {
              await sleep(100);
              return { outcome: "ok", retryable: false };
            },
            now: () => at(510 * MIN),
            timeoutMs: 1000,
          });
          wide.pump();
          assertEqual(wide.inFlight().total, 2, "AL-D6: no more than two deliveries are in flight at once, across companies");
          await wide.idle();
          wide.pump();
          await wide.idle();
          assertEqual(wide.inFlight().total, 0, "AL-D6: every slot comes back when its delivery finishes");

          const Y = await freshCompany("Y");
          setHook(Y, "https://hooks.y.test/x", at(530 * MIN));
          pay(Y.mk("readable", 1_000_000_000n).id, 4444n, "unreconciled");
          pay(Y.mk("unreadable", 1_000_000_000n).id, 5555n, "unreconciled");
          clock = at(530 * MIN);
          sweepCompany(Y.company.id, clock);
          db.prepare("UPDATE alert_events SET payload_json = '{not json' WHERE company_id = ? AND payload_json LIKE '%5555%'").run(Y.company.id);
          sent.length = 0;
          const quiet = console.error;
          console.error = () => {};
          await deliverNow();
          console.error = quiet;
          const yText = sent.find((x) => x.url === "https://hooks.y.test/x")?.text ?? "";
          assert(yText.includes("0.004444"), "AL-D6: one unreadable event drops one line, not the message");

          // A delivery whose attempts never record an outcome (a crash every
          // time) is given up after six, and its events go back to pending.
          const X = await freshCompany("X");
          setHook(X, "https://hooks.x2.test/x", at(520 * MIN));
          pay(X.mk("crashy", 1_000_000_000n).id, 55n, "unreconciled");
          sweepCompany(X.company.id, at(520 * MIN));
          let t = 520;
          for (let i = 0; i < alertsDb.MAX_ATTEMPTS; i++) {
            alertsDb.claimDue(at(t * MIN), 5, new Set());
            t += 3;
          }
          alertsDb.claimDue(at(t * MIN), 5, new Set());
          const crashed = db.prepare("SELECT status, attempts FROM alert_deliveries WHERE company_id = ?").get(X.company.id) as { status: string; attempts: number };
          const crashedEvent = db.prepare("SELECT notify_state FROM alert_events WHERE company_id = ?").get(X.company.id) as { notify_state: string };
          assert(
            crashed.status === "failed" && Number(crashed.attempts) === alertsDb.MAX_ATTEMPTS && crashedEvent.notify_state === "pending",
            "AL-D6: a delivery that keeps crashing is given up after six attempts, and its events wait again",
          );
        }

        // ---- AL-D8: DELETE cancels, PUT re-points, the old destination is told ----------
        {
          const C = await freshCompany("C");
          const agent = C.mk("moves", 1_000_000_000n);
          setHook(C, "https://hooks.old.test/x", at(600 * MIN));
          pay(agent.id, 401n, "unreconciled");
          clock = at(600 * MIN);
          sweepCompany(C.company.id, clock);
          const { replacedSecretEnc } = setHook(C, "https://hooks.new.test/x", clock);
          sent.length = 0;
          await deliverNow();
          assert(sent.some((s) => s.url === "https://hooks.new.test/x") && !sent.some((s) => s.url === "https://hooks.old.test/x"), "AL-D8: a replaced webhook's queue goes to the new URL only");
          sent.length = 0;
          d.notifyChanged(C.company.id, replacedSecretEnc!);
          await sleep(50);
          assertEqual(
            JSON.stringify(sent.map((s) => [s.url, /changed where this company's alerts are sent/.test(s.text)])),
            JSON.stringify([["https://hooks.old.test/x", true]]),
            "AL-D8: the old destination is told, once, that it was replaced",
          );
          let notices = 0;
          const noticeDispatcher = dispatch.createDispatcher({
            send: async (_url, text) => {
              if (/changed where this company's alerts are sent/.test(text)) notices += 1;
              await sleep(100);
              return { outcome: "ok", retryable: false };
            },
            now: () => clock,
            timeoutMs: 1000,
          });
          noticeDispatcher.notifyChanged(C.company.id, replacedSecretEnc!);
          noticeDispatcher.notifyChanged(C.company.id, replacedSecretEnc!);
          noticeDispatcher.notifyChanged(C.company.id, replacedSecretEnc!);
          await sleep(300);
          assertEqual(notices, 1, "AL-D8: at most one change notice is outstanding per company");
          assert(
            /sealedUrl\(companyId, replacedSecretEnc\) !== href/.test(withoutComments(readFileSync("src/api.ts", "utf8"))),
            "AL-D8: re-saving the same URL sends no change notice",
          );
          pay(agent.id, 402n, "unreconciled");
          sweepCompany(C.company.id, clock);
          {
            // Claimed (in flight), then the webhook is removed, then the attempt fails retryably.
            const inFlight = alertsDb.claimDue(clock, 5, new Set()).find((c) => c.companyId === C.company.id);
            assert(inFlight !== undefined, "AL-D8: (control) a delivery is in flight");
            alertsDb.removeWebhook({ companyId: C.company.id, userId: C.owner.id, now: clock });
            alertsDb.completeDelivery({ id: inFlight!.id, companyId: C.company.id, outcome: "http_5xx", retryable: true, attempts: 1, now: clock });
            const after = db.prepare("SELECT status FROM alert_deliveries WHERE id = ?").get(inFlight!.id) as { status: string };
            assertEqual(after.status, "cancelled", "AL-D8: removing the webhook also stops a delivery that is mid-send, so it cannot retry elsewhere");
            setHook(C, "https://hooks.old.test/x", clock);
            pay(agent.id, 403n, "unreconciled");
            sweepCompany(C.company.id, clock);
          }
          alertsDb.removeWebhook({ companyId: C.company.id, userId: C.owner.id, now: clock });
          // A webhook set again later must not receive what was queued for the
          // removed one: those events were never meant for it.
          setHook(C, "https://hooks.third.test/x", clock);
          sent.length = 0;
          await deliverNow();
          assert(
            !sent.some((s) => s.url === "https://hooks.third.test/x" && (s.text.includes("0.000402") || s.text.includes("0.000403"))),
            "AL-D8: removing the webhook cancels what was queued for it",
          );
          const routeSource = withoutComments(readFileSync("src/api.ts", "utf8"));
          assert(
            (routeSource.match(/alertDispatcher\.notifyChanged\(/g) ?? []).length === 2,
            "AL-D8: both PUT (replace) and DELETE tell the old destination",
          );
        }

        // ---- AL-S1, S2, S3, S7, S8: the real sender ---------------------------------
        const signal = () => AbortSignal.timeout(3000);
        assertEqual((await dispatch.strictWebhookSend("https://localhost/hook", "t", signal())).outcome, "blocked_address", "AL-S1: the production sender refuses https://localhost at connect time (exactly blocked_address)");
        const fakeResolver = (address: string, family: 4 | 6) => {
          const calls = { n: 0 };
          const resolver = ((_host: string, _opts: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) => {
            calls.n += 1;
            cb(null, [{ address, family }]);
          }) as unknown as Parameters<typeof dispatch.createWebhookSender>[0]["resolver"];
          return { calls, resolver };
        };
        const strictWith = (address: string, family: 4 | 6) => {
          const f = fakeResolver(address, family);
          return { calls: f.calls, send: dispatch.createWebhookSender({ allowLoopback: false, checkUrl: webhookUrl.assertWebhookUrl, resolver: f.resolver }) };
        };
        {
          const s = strictWith("127.0.0.1", 4);
          assertEqual((await s.send("https://hooks.evil.test/x", "t", signal())).outcome, "blocked_address", "AL-S1: a name resolving to 127.0.0.1 is refused at connect time (exactly blocked_address)");
          assert(s.calls.n > 0, "AL-S1: (control) it was the connect-time DNS check that refused it");
        }
        for (const [address, family] of [["169.254.169.254", 4], ["::ffff:169.254.169.254", 6], ["::1", 6], ["10.0.0.5", 4]] as const) {
          const s = strictWith(address, family);
          assertEqual((await s.send("https://hooks.evil.test/x", "t", signal())).outcome, "blocked_address", `AL-S2: a name resolving to ${address} is refused at connect time (exactly blocked_address)`);
        }
        const listen = (handler: import("node:http").RequestListener) =>
          new Promise<{ port: number; server: import("node:http").Server; hits: () => number }>((resolve) => {
            let hits = 0;
            const server = nodeHttp.createServer((rq, rs) => {
              hits += 1;
              handler(rq, rs);
            });
            server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, server, hits: () => hits }));
          });
        const lenient = dispatch.createWebhookSender({ allowLoopback: true, checkUrl: (u) => u });
        {
          const target = await listen((_q, r) => r.end("ok"));
          const redirector = await listen((_q, r) => {
            r.writeHead(302, { Location: `http://127.0.0.1:${target.port}/` });
            r.end();
          });
          const metadataRedirect = await listen((_q, r) => {
            r.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
            r.end();
          });
          assertEqual((await lenient(`http://127.0.0.1:${redirector.port}/hook`, "t", signal())).outcome, "redirect_refused", "AL-S3: a webhook that redirects is refused (exactly redirect_refused)");
          assertEqual(target.hits(), 0, "AL-S3: and the redirect target is never contacted");
          assertEqual((await lenient(`http://127.0.0.1:${metadataRedirect.port}/hook`, "t", signal())).outcome, "redirect_refused", "AL-S3: a redirect to the metadata address is refused");
          for (const srv of [target, redirector, metadataRedirect]) srv.server.close();
        }
        assertEqual((await dispatch.strictWebhookSend("http://hooks.x.test/", "t", signal())).outcome, "invalid_url", "AL-S7: the webhook rules run again at send time: an http URL in the table is refused");
        assertEqual((await dispatch.strictWebhookSend("https://hooks.x.test:8443/", "t", signal())).outcome, "invalid_url", "AL-S7: so is a non-default port");
        assertEqual((await dispatch.strictWebhookSend("https://1.2.3.4/x", "t", signal())).outcome, "invalid_url", "AL-S7: and so is a numeric host");
        const dispatchSource = withoutComments(readFileSync("src/alerts/dispatch.ts", "utf8"));
        assert(
          /strictWebhookSend: Send = createWebhookSender\(\{ allowLoopback: false,/.test(dispatchSource),
          "AL-S1: the production sender is bound to no loopback",
        );
        assert(
          /strictWebhookSend: Send = createWebhookSender\(\{ allowLoopback: false, checkUrl: assertWebhookUrl \}\)/.test(dispatchSource),
          "AL-S7: and to the webhook rules",
        );
        assert(
          /createDispatcher\(\{ send: strictWebhookSend,/.test(withoutComments(readFileSync("src/alerts/runtime.ts", "utf8"))),
          "AL-S1: and it is the one the running dispatcher uses",
        );
        {
          let proxyConnections = 0;
          const proxy = nodeNet.createServer((sock) => {
            proxyConnections += 1;
            sock.destroy();
          });
          await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
          const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
          const receiver = await listen((_q, r) => r.end("ok"));
          const savedProxy = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, http_proxy: process.env.http_proxy, https_proxy: process.env.https_proxy };
          for (const k of Object.keys(savedProxy)) process.env[k] = proxyUrl;
          const viaName = dispatch.createWebhookSender({ allowLoopback: true, checkUrl: (u) => u, resolver: fakeResolver("127.0.0.1", 4).resolver });
          const outcome = (await viaName(`http://hooks.proxy.test:${receiver.port}/`, "t", signal())).outcome;
          for (const [k, v] of Object.entries(savedProxy)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
          assert(outcome === "ok" && receiver.hits() === 1, "AL-S8: (control) the send reached its receiver");
          assertEqual(proxyConnections, 0, "AL-S8: HTTPS_PROXY in the environment is never used for a webhook");
          proxy.close();
          receiver.server.close();
        }

        // ---- AL-D1: a slow webhook times out, bounded -----------------------------------
        {
          const D = await freshCompany("D");
          const sockets: import("node:net").Socket[] = [];
          const hang = nodeNet.createServer((sock) => sockets.push(sock));
          await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", () => resolve()));
          alertsDb.setWebhook({ companyId: D.company.id, secretEnc: seal(D.company.id, `http://127.0.0.1:${(hang.address() as AddressInfo).port}/`), userId: D.owner.id, now: clock });
          const slowDispatcher = dispatch.createDispatcher({ send: lenient, now: () => clock, timeoutMs: 300 });
          const started = Date.now();
          const raced = await Promise.race([slowDispatcher.sendTest(D.company.id), sleep(3000).then(() => "hung" as const)]);
          const tookMs = Date.now() - started;
          assertEqual(raced === "hung" ? "hung" : typeof raced === "string" ? raced : raced.outcome, "timeout", "AL-D1: a webhook that never answers is cut off at the timeout (exactly timeout)");
          assert(tookMs < 2000, `AL-D1: and within a bounded time (${tookMs}ms)`);
          for (const s of sockets) s.destroy();
          hang.close();
        }

        // ---- AL-S5: the URL never appears in a log, a response or a plaintext column -------
        {
          const K = await freshCompany("K");
          // localhost, not a made-up public name: the strict sender refuses it at
          // connect time without any DNS query leaving the machine, so this
          // section never depends on the network it happens to run on.
          const leakUrl = `https://localhost/services/${SENT.path}`;
          const captured: string[] = [];
          const originals = { log: console.log, warn: console.warn, error: console.error };
          const capture = (...args: unknown[]) => captured.push(args.map(String).join(" "));
          console.log = capture;
          console.warn = capture;
          console.error = capture;
          const bodies: string[] = [];
          try {
            console.error(`probe-${SENT.path.slice(-6)}-sink`);
            bodies.push((await req("PUT", "/api/alerts/webhook", { cookie: K.ownerCookie, body: { url: leakUrl } })).text);
            const agent = K.mk("leaky", 1_000_000_000n);
            pay(agent.id, 501n, "unreconciled");
            clock = at(700 * MIN);
            sweepCompany(K.company.id, clock);
            const real = dispatch.createDispatcher({ send: dispatch.strictWebhookSend, now: () => clock, timeoutMs: 3000 });
            real.pump();
            await real.idle();
            bodies.push((await req("POST", "/api/alerts/webhook/test", { cookie: K.ownerCookie })).text);
            bodies.push((await req("GET", "/api/alerts/webhook", { cookie: K.ownerCookie })).text);
            bodies.push((await req("GET", "/api/alerts", { cookie: K.ownerCookie })).text);
            bodies.push((await req("GET", "/api/attention", { cookie: K.operatorCookie })).text);
            bodies.push((await req("PUT", "/api/alerts/webhook", { cookie: K.ownerCookie, body: { url: `${leakUrl}/replaced` } })).text);
            bodies.push((await req("DELETE", "/api/alerts/webhook", { cookie: K.ownerCookie })).text);
            await sleep(200);
          } finally {
            console.log = originals.log;
            console.warn = originals.warn;
            console.error = originals.error;
          }
          const lastOutcome = db.prepare("SELECT outcome FROM alert_deliveries WHERE company_id = ? ORDER BY created_at DESC LIMIT 1").get(K.company.id) as { outcome: string | null };
          assert(captured.some((l) => l.includes("-sink")), "AL-S5: (control) the log capture works");
          assert(lastOutcome.outcome !== null && lastOutcome.outcome !== "ok", `AL-S5: (control) a real send to that URL was attempted and failed (${lastOutcome.outcome})`);
          assert(!captured.some((l) => l.includes(SENT.path)), "AL-S5: the webhook URL appears in no log line");
          assert(!bodies.some((b) => b.includes(SENT.path)), "AL-S5: the webhook URL appears in no route response");
          assert(!bodies.some((b) => b.includes("_enc")), "AL-S5: no route response carries an encrypted column's name");
          const sealedHosts = (db.prepare("SELECT secret_enc FROM alert_webhooks").all() as { secret_enc: string }[]).map((r) => r.secret_enc).join("\n");
          assert(sealedHosts.length > 0 && !sealedHosts.includes("localhost") && !sealedHosts.includes("hooks."), "AL-S5: no stored webhook carries its host in plaintext");
          for (const table of ["alert_webhooks", "alert_events", "alert_deliveries", "alert_webhook_changes", "alert_state"]) {
            const dump = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all(), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
            assert(!dump.includes(SENT.path), `AL-S5: ${table} holds no webhook URL in plaintext`);
          }
        }

        // ---- AL-S6: a sealed URL is bound to its company and its purpose -------------------
        {
          const bSealed = alertsDb.getWebhookRow(B.company.id)!.secretEnc;
          let swapped = false;
          try {
            webhookUrl.openWebhook(B.company.id, aSealed);
          } catch (error) {
            swapped = error instanceof webhookUrl.WebhookUnreadableError;
          }
          assert(swapped, "AL-S6: company A's sealed webhook does not open as company B's");
          db.prepare("UPDATE alert_webhooks SET secret_enc = ? WHERE company_id = ?").run(aSealed, B.company.id);
          assertEqual((await req("GET", "/api/alerts/webhook", { cookie: B.ownerCookie })).body.state, "unreadable", "AL-S6: a swapped row reads as unreadable, never as A's address");
          db.prepare("UPDATE alert_webhooks SET secret_enc = ? WHERE company_id = ?").run(bSealed, B.company.id);
          const otherPurpose = encryptSecret(JSON.stringify({ purpose: "quickbooks_token", companyId: B.company.id, url: hookB, host: "hooks.b.test" }));
          let refusedPurpose = false;
          try {
            webhookUrl.openWebhook(B.company.id, otherPurpose);
          } catch (error) {
            refusedPurpose = error instanceof webhookUrl.WebhookUnreadableError;
          }
          assert(refusedPurpose, "AL-S6: a blob sealed for another purpose is refused");
        }

        // ---- AL-R3: changing the webhook is rate-limited -------------------------------
        {
          const W = await freshCompany("W");
          const statuses: number[] = [];
          for (let i = 0; i < 8; i++) {
            statuses.push((await req("PUT", "/api/alerts/webhook", { cookie: W.ownerCookie, body: { url: `https://localhost/w${i}` } })).status);
          }
          assert(statuses.slice(0, 6).every((x) => x === 200) && statuses.includes(429), "AL-R3: changing the webhook is rate-limited");
          const W2 = await freshCompany("W2");
          await req("PUT", "/api/alerts/webhook", { cookie: W2.ownerCookie, body: { url: "https://localhost/w2" } });
          const removals: number[] = [];
          for (let i = 0; i < 7; i++) removals.push((await req("DELETE", "/api/alerts/webhook", { cookie: W2.ownerCookie })).status);
          assert(removals.includes(429), "AL-R3: so is removing it");
        }

        // ---- AL-R2: the test route -------------------------------------------------------
        {
          const R = await freshCompany("R");
          await req("PUT", "/api/alerts/webhook", { cookie: R.ownerCookie, body: { url: "https://localhost/r" } });
          // Change notices from the sections above share these slots.
          const { alertDispatcher } = await import("../src/alerts/runtime.js");
          await Promise.race([alertDispatcher.idle(), sleep(3000)]);
          const first = await req("POST", "/api/alerts/webhook/test", { cookie: R.ownerCookie });
          assertEqual(JSON.stringify(Object.keys(first.body).sort()), JSON.stringify(["delivered", "outcome"]), "AL-R2: the test route answers with an outcome word only, never the receiver's body");
          assert(first.body.outcome !== "blocked_address" && first.body.outcome !== "network_error", "AL-R2: refused and failed are shown to the owner the same way");
          const statuses: number[] = [];
          for (let i = 0; i < 6; i++) statuses.push((await req("POST", "/api/alerts/webhook/test", { cookie: R.ownerCookie })).status);
          assert(statuses.includes(429), "AL-R2: the test route is rate-limited");
          assertEqual((await req("POST", "/api/alerts/webhook/test", { cookie: R.operatorCookie })).status, 403, "AL-R2: an operator cannot send a test alert");
        }

        // ---- AL-R4: one unreadable stored alert cannot blank the history ----------------
        {
          const H = await freshCompany("H");
          const now = new Date().toISOString();
          // A kind a later version might retire. Resolved, so no sweep touches it.
          db.prepare(
            `INSERT INTO alert_events (id, company_id, event, severity, ceiling, subject_key, payload_json, opened_at, resolved_at, notify_state)
             VALUES (?, ?, 'retired_kind', 'watch', 'watch', 'agent:gone', '{"event":"retired_kind"}', ?, ?, 'silent')`,
          ).run(randomUUID(), H.company.id, now, now);
          const history = await req("GET", "/api/alerts", { cookie: H.ownerCookie });
          assert(
            history.status === 200 && history.body.alerts.length === 1 && history.body.alerts[0].agentName === null &&
              history.body.alerts[0].unreadable === true,
            "AL-R4: an alert row that no longer parses is listed without detail, and the rest of the history still loads",
          );
        }

        // ---- AL-P1..P3: the dashboard's Alerts panel ------------------------------------
        /*
         * The panel's whole contract is about what it never holds. The API
         * already never returns the URL (AL-S5); these prove the dashboard
         * would not pass it on if it did, that the field is write-only, and
         * that the proxy relays nothing it did not pick.
         */
        {
          const alertWords = await import("../dashboard/lib/alerts.js");
          const LEAK = `SECRETPATH${randomUUID().replace(/-/g, "")}`;
          const raw = {
            configured: true,
            host: "hooks.leak.test",
            setAt: null,
            state: "healthy",
            lastOutcome: "delivered",
            lastAttemptAt: null,
            sweeperLastRunAt: null,
            sweeperStale: false,
            url: `https://hooks.leak.test/services/${LEAK}`,
            secretEnc: LEAK,
          };
          const pickedHook = alertWords.toAlertWebhook(raw);
          const pickedAll = alertWords.toAlertSettings({
            webhook: raw,
            alerts: [{ label: "Frozen", openedAt: "2026-10-01T00:00:00.000Z", notice: "pending", agentName: "x", payloadJson: LEAK, subjectKey: LEAK }],
          });
          const pickedTest = alertWords.toTestResult({ delivered: false, outcome: "rejected", body: LEAK, status: 404 });
          assert(
            pickedHook !== null && pickedAll !== null && pickedTest !== null &&
              ![pickedHook, pickedAll, pickedTest].some((p) => JSON.stringify(p).includes(LEAK)),
            "AL-P1: the dashboard's alert pickers drop every field they do not name, so a URL could not ride along",
          );
          assertEqual(
            JSON.stringify(Object.keys(pickedTest!).sort()),
            JSON.stringify(["delivered", "outcome"]),
            "AL-P1: a test result reaches the browser as an outcome word only",
          );
          const realSettings = await req("GET", "/api/alerts", { cookie: A.ownerCookie });
          assert(
            alertWords.toAlertSettings(realSettings.body) !== null,
            "AL-P1: (control) the picker accepts the API's real alert history",
          );

          const panel = withoutComments(readFileSync("dashboard/components/AlertsPanel.tsx", "utf8"));
          const saveFn = panel.slice(panel.indexOf("function save("), panel.indexOf("async function commitSave"));
          assert(
            /type="password"/.test(panel) && /autoComplete="off"/.test(panel) && !/defaultValue|value=\{webhook/.test(panel),
            "AL-P2: the webhook field is a password field, autofill off, and never pre-filled",
          );
          assert(
            saveFn.includes("if (!isHttpsAddress(url))") &&
              saveFn.indexOf("isHttpsAddress(") < saveFn.indexOf("commitSave") &&
              !saveFn.includes("fetch(") &&
              ["hunter2", "correct horse battery", " ", "http://hooks.slack.com/x", "javascript:x"].every((v) => !alertWords.isHttpsAddress(v)) &&
              alertWords.isHttpsAddress("https://hooks.slack.com/services/T/B/x"),
            "AL-P2: nothing that is not an https address leaves the browser, so an autofilled password is never sent",
          );
          assert(
            /method="post"/.test(panel) && !/name="alert-webhook"/.test(panel),
            "AL-P2: a native submit could never put the URL in the address bar (method post, the field unnamed)",
          );
          const commitFn = panel.slice(panel.indexOf("async function commitSave"), panel.indexOf("async function remove"));
          assert(
            commitFn.includes("if (!isHttpsAddress(url))") && commitFn.indexOf("isHttpsAddress(") < commitFn.indexOf('call("PUT"'),
            "AL-P2: the Replace path checks for an https address too, before anything is sent",
          );
          const integrationsPage = withoutComments(readFileSync("dashboard/app/integrations/page.tsx", "utf8"));
          assert(
            integrationsPage.indexOf("viewer === null ?") !== -1 &&
              integrationsPage.indexOf("viewer === null ?") < integrationsPage.indexOf("!isOwner ?"),
            "AL-P2: a failed read of who is signed in is said, not shown as the operator's note",
          );
          assert(
            integrationsPage.includes("isOwner ? await getAlertSettings() : null"),
            "AL-P2: the alert settings are fetched for an owner only",
          );

          const proxy = withoutComments(readFileSync("dashboard/app/api/alerts/route.ts", "utf8"));
          const dashClient = withoutComments(readFileSync("dashboard/lib/fuel.ts", "utf8"));
          const relayCall = dashClient.slice(dashClient.indexOf("export async function callAlertWebhook"));
          assert(
            !/console\./.test(proxy) && !/console\./.test(relayCall.slice(0, relayCall.indexOf("\n}\n"))),
            "AL-P3: neither the proxy nor its client function logs anything",
          );
          assert(
            !/NextResponse\.json\(\s*result\.body/.test(proxy) &&
              proxy.includes("toAlertWebhook(result.body)") &&
              proxy.includes("toTestResult(result.body)") &&
              proxy.includes("REFUSAL_SENTENCE[o.code as string]") &&
              !/o\.error/.test(proxy),
            "AL-P3: the proxy answers only with picked fields, and never relays text from an error body",
          );
          const drifted = Object.entries(webhookUrl.WEBHOOK_URL_MESSAGES as Record<string, string>).filter(
            ([code, sentence]) => alertWords.REFUSAL_SENTENCE[code] !== sentence,
          );
          assertEqual(
            drifted.map(([code]) => code).join(","),
            "",
            "AL-P3: the dashboard's refusal sentences are Fuel's own, word for word",
          );
          const sameOrigin = withoutComments(readFileSync("dashboard/lib/same-origin.ts", "utf8"));
          assert(
            /headers\.get\("sec-fetch-site"\)/.test(sameOrigin) &&
              sameOrigin.indexOf("sec-fetch-site") < sameOrigin.indexOf('headers.get("origin")'),
            "AL-P3: every dashboard write refuses a request the browser marks as cross-site",
          );
          assert(proxy.includes("refuseCrossOrigin(req)"), "AL-P3: the proxy refuses a cross-origin write");
        }

        // ---- AL-D7: a big sweep is bounded ----------------------------------------------
        {
          const P = await freshCompany("P");
          const busy = P.mk("busy", 1_000_000n);
          const insert = db.prepare(
            `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status, payer_address, authorization_nonce, tx_hash, detail, created_at)
             VALUES (?, ?, NULL, 1, 'settle_unknown', ?, ?, NULL, NULL, ?)`,
          );
          db.exec("BEGIN");
          for (let i = 0; i < 5000; i++) insert.run(randomUUID(), busy.id, "0xbulk", `0xbulk-${randomUUID()}`, at(-3 * MIN).toISOString());
          db.exec("COMMIT");
          let t = Date.now();
          sweepCompany(P.company.id, at(800 * MIN));
          const firstMs = Date.now() - t;
          t = Date.now();
          sweepCompany(P.company.id, at(801 * MIN));
          const steadyMs = Date.now() - t;
          console.log(`   AL-D7 measured: opening 5,000 events ${firstMs}ms; an unchanged sweep of them ${steadyMs}ms`);
          assert(firstMs < 5000, `AL-D7: opening 5,000 events in one sweep stays under 5s (${firstMs}ms)`);
          assert(steadyMs < 1500, `AL-D7: an unchanged sweep over 5,000 open events stays under 1.5s (${steadyMs}ms)`);
        }

        // ---- AL-L1, AL-L2: the sweeper cannot skip or stall the reaper --------------------
        {
          const rejections: unknown[] = [];
          const onRejection = (reason: unknown) => rejections.push(reason);
          process.on("unhandledRejection", onRejection);
          const run = async (sweep: () => Promise<unknown>, ms: number) => {
            let ticks = 0;
            const reaper = setInterval(() => (ticks += 1), 10);
            const loop = startSweepLoop({ sweep, intervalMs: 20, onFailure: () => {}, runNow: true });
            await sleep(ms);
            loop.stop();
            clearInterval(reaper);
            return { ticks, stats: loop.stats() };
          };
          const throwing = await run(() => {
            throw new Error("sweep exploded");
          }, 300);
          assert(throwing.stats.failures >= 5 && throwing.ticks >= 15, `AL-L1: a sweep that throws is counted and the reaper keeps ticking (${throwing.ticks} ticks)`);
          const rejecting = await run(async () => {
            throw new Error("sweep rejected");
          }, 300);
          assert(rejecting.stats.failures >= 5 && rejecting.ticks >= 15, `AL-L1: a sweep that rejects is counted and the reaper keeps ticking (${rejecting.ticks} ticks)`);
          let concurrent = 0;
          let maxConcurrent = 0;
          const slowSweep = await run(async () => {
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await sleep(150);
            concurrent -= 1;
          }, 500);
          assertEqual(maxConcurrent, 1, "AL-L1: a sweep still running is never joined by another");
          assert(slowSweep.stats.skipped > 0 && slowSweep.ticks >= 25, `AL-L1: overlapping ticks are skipped and the reaper keeps its schedule (${slowSweep.ticks} ticks)`);
          await sleep(20);
          process.off("unhandledRejection", onRejection);
          assertEqual(rejections.length, 0, "AL-L1: no failed sweep becomes an unhandled rejection");

          const serverSource = withoutComments(readFileSync("src/server.ts", "utf8"));
          const reapStart = serverSource.indexOf("function reap(");
          const reapBody = serverSource.slice(reapStart, serverSource.indexOf("\n}\n", reapStart));
          assert(reapStart !== -1 && !/sweep|alert/i.test(reapBody), "AL-L2: reap() never calls the alert sweeper");
          assert(
            /setInterval\(\(\) => reap\("periodic"\), REAP_INTERVAL_MS\)/.test(serverSource) && /startSweepLoop\(\{/.test(serverSource),
            "AL-L2: the reaper and the sweeper each have their own timer",
          );
        }

        // ---- AL-F1, AL-F2: failures stay contained ------------------------------------------
        {
          const Z = await freshCompany("Z");
          const payer = Z.mk("still-pays", 1_000_000_000n);
          let threw = false;
          try {
            alertsDb.applySweep({
              companyId: `no-such-company-${randomUUID()}`,
              now: clock,
              changes: { open: [{ event: "agent_frozen", severity: "watch", ceiling: "watch", subjectKey: "x", payloadJson: "{}" }], resolve: [], update: [] },
              cooldownMs: 0,
            });
          } catch {
            threw = true;
          }
          let reserved = false;
          try {
            reserved = reserveIfUnderCap({ agentId: payer.id, amountBaseUnits: 1n, resourceUrl: "https://merchant.test/f1" }).ok;
          } catch {
            reserved = false;
          }
          assert(threw, "AL-F1: (control) the sweep transaction really did throw");
          assert(reserved, "AL-F1: after a sweep throws mid-transaction, a payment reservation still works");
          try {
            db.exec("ROLLBACK");
          } catch {
            /* nothing was left open, which is the point */
          }

          const rejections: unknown[] = [];
          const onRejection = (reason: unknown) => rejections.push(reason);
          process.on("unhandledRejection", onRejection);
          setHook(Z, "https://hooks.z.test/x", clock);
          pay(payer.id, 601n, "unreconciled");
          sweepCompany(Z.company.id, clock);
          const quiet = console.error;
          console.error = () => {};
          const poisoned = dispatch.createDispatcher({
            send: async () => {
              // Simulates the database refusing the outcome write.
              db.exec("BEGIN");
              return { outcome: "ok", retryable: false };
            },
            now: () => clock,
            timeoutMs: 300,
          });
          poisoned.pump();
          await poisoned.idle();
          await sleep(20);
          console.error = quiet;
          try {
            db.exec("ROLLBACK");
          } catch {
            /* closed already */
          }
          process.off("unhandledRejection", onRejection);
          assertEqual(rejections.length, 0, "AL-F2: a delivery whose outcome cannot be recorded does not become an unhandled rejection");
        }

        // The fixture QuickBooks rows were never documents and went nowhere; they
        // are removed so this suite's own "no QuickBooks document was created"
        // check keeps meaning exactly that.
        db.prepare("DELETE FROM qbo_postings WHERE realm_id = 'realm-al'").run();
        db.prepare("DELETE FROM qbo_posting_drafts WHERE realm_id = 'realm-al'").run();

        console.log(`   ${checks} checks so far`);
      }

      /* --- only a script can create a company ------------------------------ */
      {
        const before = (db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n;
        const foundingCount = () =>
          (db.prepare("SELECT COUNT(*) AS n FROM invites WHERE company_id IS NULL").get() as { n: number }).n;
        // A BASELINE, NOT ZERO. The script legitimately mints founding invites,
        // and the test database holds one, as the real one has since 7A-3 item 4
        // created a second company that way. What no ROUTE may do is add one.
        const foundingBefore = foundingCount();
        const attempt = await http("/api/invites", {
          key: OPERATOR_KEY,
          body: { email: `founder-${randomUUID()}@example.com`, role: "owner", companyId: null, company: null },
        });
        assertEqual(attempt.status, 403, "the shared key cannot mint an invite at all");
        assertEqual(
          (db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n,
          before,
          "and no company appeared",
        );

        assertEqual(foundingCount(), foundingBefore, "no founding invite was minted — no route can express one");
      }

      /* --- an address at another company is invisible (the invite oracle) -- */
      /*
       * THE ORACLE, AS AN OWNER WOULD RUN IT. Fuel sends no email, so whoever
       * mints an invite holds its token and can redeem it themselves. While
       * `users.email` was unique across the whole platform, redeeming answered
       * 409 `email_taken` for an address with an account ANYWHERE and 201 for
       * one with none -- telling one company's owner who has an account at
       * another. And the 201 was worse: it claimed the address for the whole
       * platform, so its real owner could never join their own company.
       *
       * No response wording can close that, because one path creates an
       * account and the other cannot. What closes it is that an address is
       * unique within a company only: the other company's account is simply
       * not in the way. So both paths must look identical, all the way through.
       */
      {
        const { createCompany } = await import("../src/db/companies.js");
        const { createSession } = await import("../src/db/sessions.js");
        const companyA = createCompany({ name: `Oracle A ${randomUUID().slice(0, 8)}`, spendCapBaseUnits: 0n });
        const companyB = createCompany({ name: `Oracle B ${randomUUID().slice(0, 8)}`, spendCapBaseUnits: 0n });
        const ownerOf = async (companyId: string) => {
          const user = createUser({
            companyId,
            email: `oracle-owner-${randomUUID()}@example.com`,
            passwordHash: await hashPassword(PASSWORD),
            role: "owner",
          });
          return `${SESSION_COOKIE}=${createSession(user.id).token}`;
        };
        const ownerA = await ownerOf(companyA.id);
        const ownerB = await ownerOf(companyB.id);

        // An address with an account at company A.
        const takenElsewhere = `oracle-target-${randomUUID()}@example.com`;
        createUser({ companyId: companyA.id, email: takenElsewhere, passwordHash: await hashPassword(PASSWORD), role: "operator" });
        // And one with an account nowhere.
        const nowhere = `oracle-control-${randomUUID()}@example.com`;

        const probe = async (ownerCookie: string, email: string) => {
          const invite = await http("/api/invites", { cookie: ownerCookie, body: { email, role: "operator" } });
          const redeemed = await signup({ token: invite.body.token, email, password: PASSWORD });
          return { invite, redeemed };
        };
        const shape = (r: { status: number; body: any }) =>
          `${r.status} ${Object.keys(r.body ?? {}).sort().join(",")}${r.body?.user ? ` user:${Object.keys(r.body.user).sort().join(",")}` : ""}`;

        const control = await probe(ownerB, nowhere);
        const target = await probe(ownerB, takenElsewhere);
        assertEqual(control.redeemed.status, 201, "O1: (control) an address with no account anywhere is invited and redeemed");
        assertEqual(shape(target.invite), shape(control.invite), "O1: inviting an address with an account at another company looks the same as inviting one with none");
        assertEqual(
          shape(target.redeemed),
          shape(control.redeemed),
          "O1: redeeming it looks the same too -- another company's account is not in the way, so nothing tells them apart",
        );
        assert(!/taken|exists|already/i.test(target.redeemed.text), "O1: and nothing in the answer says the address is in use");
        const accounts = db
          .prepare("SELECT company_id FROM users WHERE email = ? ORDER BY created_at")
          .all(takenElsewhere) as { company_id: string }[];
        assertEqual(
          accounts.map((a) => a.company_id).join(","),
          `${companyA.id},${companyB.id}`,
          "O1: the address now has two separate accounts, one per company; A's was not touched",
        );

        // NO SQUATTING. An address B claims first is still A's to invite.
        const claimedFirst = `oracle-squat-${randomUUID()}@example.com`;
        assertEqual((await probe(ownerB, claimedFirst)).redeemed.status, 201, "O2: (company B creates an address first)");
        const later = await probe(ownerA, claimedFirst);
        assertEqual(later.redeemed.status, 201, "O2: company A can still invite that address and create its own account for it");

        /* --- signing in names the company ---------------------------------- */
        const { disableUser: disable } = await import("../src/db/users.js");
        const handleA = handleFor(companyA.id);
        const handleB = handleFor(companyB.id);
        const signIn = (company: unknown, email: string, password: string) => {
          const body: Record<string, unknown> = { email, password };
          if (company !== undefined) body.company = company;
          return http("/api/auth/login", { body });
        };
        const PASSWORD_A = "the-password-at-company-a";
        const PASSWORD_B = "the-password-at-company-b";
        const both = `oracle-both-${randomUUID()}@example.com`;
        const atA = createUser({ companyId: companyA.id, email: both, passwordHash: await hashPassword(PASSWORD_A), role: "operator" });
        const atB = createUser({ companyId: companyB.id, email: both, passwordHash: await hashPassword(PASSWORD_B), role: "operator" });

        resetLoginLimits();
        const inA = await signIn(handleA, both, PASSWORD_A);
        assertEqual(inA.status, 200, "O3: an address with accounts at two companies signs in at the company it names");
        assertEqual(inA.body.user?.id, atA.id, "O3: and gets that company's account");
        const inB = await signIn(handleB, both, PASSWORD_B);
        assertEqual(inB.body.user?.id, atB.id, "O3: the same address at the other company is the other account");
        const crossed = await signIn(handleA, both, PASSWORD_B);
        assertEqual(crossed.status, 401, "O3: one company's password does not open the other company's account");
        resetLoginLimits();
        const typedLoosely = await signIn(`  ${handleA.toUpperCase()} `, both, PASSWORD_A);
        assertEqual(typedLoosely.body.user?.id, atA.id, "O3: a handle typed with capitals or spaces still names the company");

        /* --- every way to be wrong is one answer ---------------------------- */
        const disabledUser = createUser({
          companyId: companyA.id,
          email: `oracle-disabled-${randomUUID()}@example.com`,
          passwordHash: await hashPassword(PASSWORD_A),
          role: "operator",
        });
        disable(disabledUser.id, companyA.id);
        const refusedAs = async (label: string, company: unknown, email: string, password: string) => {
          resetLoginLimits();
          const r = await signIn(company, email, password);
          return [label, r] as const;
        };
        const answers = [
          await refusedAs("a wrong password", handleA, both, "not-the-password"),
          await refusedAs("an unknown address at a real company", handleA, `nobody-${randomUUID()}@example.com`, PASSWORD_A),
          await refusedAs("an unknown company", `no-such-company-${randomUUID().slice(0, 4)}`, both, PASSWORD_A),
          await refusedAs("a company that is not even handle-shaped", "!!! not a handle !!!", both, PASSWORD_A),
          await refusedAs("a disabled account", handleA, disabledUser.email, PASSWORD_A),
        ];
        for (const [label, r] of answers) {
          assertEqual(r.status, 401, `O4: ${label} is refused`);
          assertEqual(r.text, answers[0]![1].text, `O4: ${label} gets the very same answer as a wrong password`);
          assertEqual(r.setCookie.length, 0, `O4: ${label} sets no cookie`);
        }
        {
          const timed = async (company: string): Promise<number> => {
            resetLoginLimits();
            const t0 = process.hrtime.bigint();
            await signIn(company, both, PASSWORD_A);
            return Number(process.hrtime.bigint() - t0) / 1e6;
          };
          const known = await timed(handleA);
          const unknown = await timed(`no-such-company-${randomUUID().slice(0, 4)}`);
          assert(
            unknown > known / 3,
            `O4: an unknown company costs comparable time (known ${known.toFixed(0)}ms, unknown ${unknown.toFixed(0)}ms)`,
          );
        }

        resetLoginLimits();
        const noCompany = await signIn(undefined, both, PASSWORD_A);
        assertEqual(noCompany.status, 400, "O5: signing in without naming a company is refused as incomplete");
        assertEqual(noCompany.setCookie.length, 0, "O5: and sets no cookie");

        /* --- one company's failures say nothing about another's ------------- */
        resetLoginLimits();
        for (let i = 0; i < 5; i++) await signIn(handleB, both, `wrong-${i}`);
        assertEqual((await signIn(handleB, both, "wrong-again")).status, 429, "O6: (control) five failures really do throttle that account");
        const elsewhere = await signIn(handleA, both, PASSWORD_A);
        assertEqual(elsewhere.status, 200, "O6: failures at one company do not throttle the same address at another");
        resetLoginLimits();

        /* --- within a company, an address is still one account -------------- */
        const again = await probe(ownerB, both);
        assertEqual(again.redeemed.status, 409, "O7: a second account for the same address in the same company is refused");
        assertEqual(again.redeemed.body.code, "email_taken", "O7: as email_taken, which is this company's own business");

        /* --- the handle a caller sees is their own -------------------------- */
        const companyRes = await http("/api/company", { cookie: ownerB });
        assertEqual(companyRes.body.handle, handleB, "O8: GET /api/company carries the caller's own handle");
        const me = await http("/api/auth/me", { cookie: ownerB });
        assertEqual(me.body.companyHandle, handleB, "O8: /api/auth/me carries it too");
        const invited = await http("/api/invites", { cookie: ownerB, body: { email: `o8-${randomUUID()}@example.com`, role: "operator" } });
        assertEqual(invited.body.companyHandle, handleB, "O8: and so does a new invite, for the invitee to sign in with");
        for (const r of [companyRes, me, invited]) {
          assert(!r.text.includes(handleA), "O8: no answer carries another company's handle");
        }

        /* --- one founding invite makes one company -------------------------- */
        /*
         * Single-use carries weight now (src/db/invites.ts). While addresses were
         * unique platform-wide, a second redemption was refused for the address
         * already having an account. A founding invite makes a NEW company each
         * time, where it would not, so the redeemed check is the only guard.
         */
        {
          const founder = `founder-${randomUUID()}@example.com`;
          const { token } = createInvite({ companyId: null, email: founder, role: "owner" });
          const companies = () => (db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n;
          const first = await signup({ token, email: founder, password: PASSWORD });
          assertEqual(first.status, 201, "F1: a founding invite creates its company");
          const afterFirst = companies();
          const second = await signup({ token, email: founder, password: PASSWORD });
          assertEqual(second.status, 400, "F1: redeeming it a second time is refused");
          assertEqual(companies(), afterFirst, "F1: and makes no second company");
        }

        /* --- a company name says nothing about other companies -------------- */
        /*
         * Names were unique platform-wide, so founding a company with a name
         * already in use failed -- as a raw database error, stack and all. That
         * told a founder the name existed. Names are not unique now: the handle
         * identifies a company. So a taken name and a fresh one look the same.
         */
        {
          const founderOf = async (companyName: string) => {
            const founder = `founder-${randomUUID()}@example.com`;
            const { token } = createInvite({ companyId: null, email: founder, role: "owner" });
            return signup({ token, email: founder, password: PASSWORD, companyName });
          };
          const freshName = await founderOf(`Unused Name ${randomUUID().slice(0, 8)}`);
          const takenName = await founderOf(companyA.name);
          assertEqual(freshName.status, 201, "N1: (control) founding a company with an unused name works");
          assertEqual(
            `${takenName.status} ${Object.keys(takenName.body ?? {}).sort().join(",")}`,
            `${freshName.status} ${Object.keys(freshName.body ?? {}).sort().join(",")}`,
            "N1: founding a company with a name another company has looks exactly the same",
          );
          const namesake = db.prepare("SELECT handle FROM companies WHERE name = ?").all(companyA.name) as { handle: string | null }[];
          assertEqual(namesake.length, 2, "N1: two companies now share that name");
          assert(namesake[0]!.handle !== namesake[1]!.handle, "N1: and each has its own handle");
          for (const r of [freshName, takenName]) {
            assert(!/SQLITE|constraint failed|\n\s+at /.test(r.text), "N2: no signup answer carries a database message or a stack");
          }
        }
      }

      /* --- the legacy key is barred from every identity power -------------- */
      {
        for (const [method, path] of [
          ["POST", "/api/invites"],
          ["GET", "/api/invites"],
          ["POST", "/api/invites/anything/revoke"],
          ["GET", "/api/users"],
          ["POST", "/api/users/anything/disable"],
        ] as const) {
          const res = await http(path, {
            key: OPERATOR_KEY,
            method,
            body: method === "POST" ? { email: "x@example.com", role: "operator" } : undefined,
          });
          assertEqual(res.status, 403, `${method} ${path} refuses the shared operator key`);
          assert(
            /signed-in owner/.test(res.body.error ?? ""),
            `${method} ${path} says a signed-in owner is required, rather than looking like a wrong key`,
          );
        }
      }

      /* --- owner versus operator, and cross-company reach ------------------ */
      {
        const ownerEmail = `boss-${randomUUID()}@example.com`;
        const staffEmail = `staff-${randomUUID()}@example.com`;
        const ownerInvite = freshInvite(ownerEmail, "owner");
        const staffInvite = freshInvite(staffEmail, "operator");
        const ownerCookie = (await signup({ token: ownerInvite.token, email: ownerEmail, password: PASSWORD }))
          .setCookie.find((l) => l.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0]!;
        const staffCookie = (await signup({ token: staffInvite.token, email: staffEmail, password: PASSWORD }))
          .setCookie.find((l) => l.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0]!;

        assertEqual(
          (await http("/api/users", { cookie: ownerCookie })).status,
          200,
          "an owner can list the people in their company",
        );
        const staffTry = await http("/api/users", { cookie: staffCookie });
        assertEqual(staffTry.status, 403, "a plain operator cannot");
        assert(/owner/.test(staffTry.body.error ?? ""), "and is told it needs an owner");

        // Minting through the route: the token appears once and never again.
        const minted = await http("/api/invites", {
          cookie: ownerCookie,
          body: { email: `via-route-${randomUUID()}@example.com`, role: "operator" },
        });
        assertEqual(minted.status, 201, "an owner can mint an invite for their own company");
        assert(typeof minted.body.token === "string", "and is given the token, once");
        const listed = await http("/api/invites", { cookie: ownerCookie });
        assert(
          !listed.text.includes(minted.body.token),
          "the list never shows a token again — only a hash was stored",
        );
        assert(
          (db.prepare("SELECT COUNT(*) AS n FROM invites WHERE token_hash = ?").get(minted.body.token) as { n: number }).n === 0,
          "and the token itself is not what the database holds",
        );

        /*
         * AND CANNOT REACH ANOTHER COMPANY BY ASKING.
         *
         * A break test that let the route read `companyId` from the body went
         * unnoticed by the first version of this suite, because nothing sent
         * one. The route takes `companyOf(req)` and has no parameter for a
         * company; this is what proves a body field cannot become one.
         */
        // A real second company, so the break this guards against would
        // actually succeed rather than merely failing a foreign key.
        const { createCompany } = await import("../src/db/companies.js");
        const otherCompany = createCompany({
          name: `elsewhere-${randomUUID()}`,
          spendCapBaseUnits: 0n,
        });
        const injected = await http("/api/invites", {
          cookie: ownerCookie,
          body: {
            email: `injected-${randomUUID()}@example.com`,
            role: "operator",
            companyId: otherCompany.id,
            company_id: otherCompany.id,
            company: otherCompany.id,
          },
        });
        assertEqual(injected.status, 201, "the invite is still minted");
        const landed = db
          .prepare("SELECT company_id FROM invites WHERE id = ?")
          .get(injected.body.id) as { company_id: string };
        assertEqual(
          landed.company_id,
          ownCompany.id,
          "but it belongs to the OWNER'S company, not the one named in the body",
        );

        // An owner cannot lock their own company out of ownership.
        const self = await http("/api/auth/me", { cookie: ownerCookie });
        const selfDisable = await http(`/api/users/${self.body.user.id}/disable`, {
          cookie: ownerCookie,
          method: "POST",
        });
        assertEqual(selfDisable.status, 409, "an owner cannot disable their own account");

        // Disabling somebody ends the session they are holding right now.
        const staffMe = await http("/api/auth/me", { cookie: staffCookie });
        assertEqual(
          (await http("/api/company", { cookie: staffCookie })).status,
          200,
          "the operator is working normally before being disabled",
        );
        const disabled = await http(`/api/users/${staffMe.body.user.id}/disable`, {
          cookie: ownerCookie,
          method: "POST",
        });
        assertEqual(disabled.status, 200, "the owner disables them");
        assert(disabled.body.sessionsEnded >= 1, "and is told their live session was ended");
        assertEqual(
          (await http("/api/company", { cookie: staffCookie })).status,
          401,
          "the operator's session stops working immediately, not at its next expiry",
        );
      }
    }
    console.log(`   ${checks} checks so far`);


    /* ---- the way back in ----------------------------------------------- */
    console.log("\n== password recovery");
    {
      /*
       * RUN AS A REAL CHILD PROCESS, not by calling its functions.
       *
       * This script IS the recovery path — the thing you reach for when you
       * cannot sign in — so testing an imitation of it would test the wrong
       * artifact. It gets its own process, its own FUEL_DB_PATH, and its exit
       * code and output are what is asserted, the same way verify-migration
       * tests booting.
       */
      const run = (args: string[]): { ok: boolean; out: string } => {
        try {
          const out = execFileSync("npx", ["tsx", "scripts/set-password.ts", ...args], {
            encoding: "utf8",
            env: { ...process.env, FUEL_DB_PATH: scratch },
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { ok: true, out };
        } catch (error) {
          const e = error as { stdout?: string; stderr?: string; message: string };
          return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message}` };
        }
      };

      async function post(path: string, body: unknown, cookie?: string) {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
          body: JSON.stringify(body),
        });
        return { status: res.status, setCookie: res.headers.getSetCookie() };
      }

      const email = `recover-${randomUUID()}@example.com`;
      const ORIGINAL = "the-original-password";
      const { createUser } = await import("../src/db/users.js");
      const recovering = createUser({
        companyId: bootstrapCompany().id,
        email,
        passwordHash: await hashPassword(ORIGINAL),
        role: "owner",
      });

      // A live session, so we can prove a reset ends it.
      resetLoginLimits();
      const before = await post("/api/auth/login", { company: handleFor(bootstrapCompany().id), email, password: ORIGINAL });
      assertEqual(before.status, 200, "the account signs in with its original password");
      const staleCookie = before.setCookie
        .find((l) => l.startsWith(`${SESSION_COOKIE}=`))!
        .split(";")[0]!;

      /* --- it refuses to invent an account -------------------------------- */
      {
        const missing = run(["--company", handleFor(bootstrapCompany().id), "--email", `ghost-${randomUUID()}@example.com`]);
        assert(!missing.ok, "resetting an address with no account fails");
        assert(
          /cannot create an account/.test(missing.out),
          "and says so plainly, pointing at mint-invite instead",
        );
        assert(
          /mint-invite/.test(missing.out),
          "naming the script that DOES create accounts",
        );
      }

      /* --- it refuses a weak password ------------------------------------- */
      {
        // An address can have an account at more than one company (ADR 0018), so
        // the script will not guess which one to reset.
        const noCompany = run(["--email", email]);
        assert(!noCompany.ok, "a reset that names no company is refused");
        assert(/--company/.test(noCompany.out), "and it says which flag is missing");

        const weak = run(["--company", handleFor(bootstrapCompany().id), "--email", email, "--password", "short"]);
        assert(!weak.ok, "a password under the minimum is refused by the script too");
      }

      /* --- and the account still works, untouched -------------------------- */
      {
        resetLoginLimits();
        const still = await post("/api/auth/login", { company: handleFor(bootstrapCompany().id), email, password: ORIGINAL });
        assertEqual(still.status, 200, "a refused reset changed nothing about the account");
      }

      /* --- the real thing --------------------------------------------------- */
      {
        const reset = run(["--company", handleFor(bootstrapCompany().id), "--email", email]);
        assert(reset.ok, `the reset succeeds: ${reset.out.slice(0, 200)}`);

        const printed = /password:\s+(\S+)/.exec(reset.out);
        assert(printed !== null, "it prints the new password once");
        const fresh = printed![1]!;
        assert(
          /shown ONCE/i.test(reset.out) && /scrollback/i.test(reset.out),
          "and warns that it is shown once and is now in the scrollback",
        );
        assert(!reset.out.includes(ORIGINAL), "it never prints the password it replaced");
        assert(!/v1\.\d+\./.test(reset.out), "nor the stored hash");
        // Security review asked for this: a script that rewrites a credential
        // should say which database it is rewriting, because the difference
        // between live and scratch is one environment variable.
        assert(
          reset.out.includes(scratch),
          "and it names the database it is about to write to, before writing",
        );

        // THE POINT OF THE WHOLE SCRIPT: the new password works at the real
        // login route, not at some side door the script opened.
        resetLoginLimits();
        const signedIn = await post("/api/auth/login", { company: handleFor(bootstrapCompany().id), email, password: fresh });
        assertEqual(signedIn.status, 200, "the new password signs in through the ordinary login route");

        resetLoginLimits();
        const old = await post("/api/auth/login", { company: handleFor(bootstrapCompany().id), email, password: ORIGINAL });
        assertEqual(old.status, 401, "and the old password no longer does");

        // A reset is also a "kick everything out".
        const res = await fetch(`${base}/api/company`, { headers: { Cookie: staleCookie } });
        assertEqual(res.status, 401, "every session held before the reset is dead");
      }

      /* --- it does not quietly re-enable a disabled account ---------------- */
      {
        const { disableUser } = await import("../src/db/users.js");
        assert(disableUser(recovering.id, bootstrapCompany().id), "the account is disabled");
        const reset = run(["--company", handleFor(bootstrapCompany().id), "--email", email]);
        assert(reset.ok, "resetting a disabled account still succeeds");
        assert(
          /DISABLED/.test(reset.out),
          "but says the account is disabled and that this did not change it",
        );
        const printed = /password:\s+(\S+)/.exec(reset.out)![1]!;
        resetLoginLimits();
        const blocked = await post("/api/auth/login", { company: handleFor(bootstrapCompany().id), email, password: printed });
        assertEqual(blocked.status, 401, "and the new password still cannot sign a disabled account in");
      }
    }
    console.log(`   ${checks} checks so far`);

    /* ---- environment --------------------------------------------------- */
    console.log("\n== environment");
    const envRes = await call("/api/environment");
    assertEqual(
      Object.keys(envRes.body).sort().join(","),
      "environment,isProduction,label,surfaces",
      "environment returns exactly the four allowed keys",
    );
    assertEqual(envRes.body.environment, "sandbox", "every pinned surface reads as sandbox");
    assertEqual(envRes.body.isProduction, false, "isProduction is false");
    for (const surface of envRes.body.surfaces) {
      assertEqual(
        Object.keys(surface).sort().join(","),
        "environment,key,label",
        `surface ${surface.key} returns exactly the three allowed keys`,
      );
    }
    // The verdict must not carry the evidence.
    for (const secret of [
      "sandbox-quickbooks.api.intuit.com",
      "quickbooks.api.intuit.com",
      "eip155:84532",
      "x402.org",
      "fireblocks.io",
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e".toLowerCase(),
    ]) {
      assert(
        !envRes.text.toLowerCase().includes(secret.toLowerCase()),
        `environment does not disclose "${secret}"`,
      );
    }
    for (const term of NO_CRYPTO) {
      assert(!envRes.text.toLowerCase().includes(term), `environment says nothing about "${term}"`);
    }
    // No provider call, no network, from a route that only reports a verdict.
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((...args: Parameters<typeof realFetch>) => {
      fetches += 1;
      return realFetch(...args);
    }) as typeof fetch;
    describeEnvironment();
    globalThis.fetch = realFetch;
    assertEqual(fetches, 0, "describeEnvironment makes zero outbound requests");

    // Unknown must stay unknown. Proven on the real reducer's own lookup: an
    // unrecognised constant is the case that must never resolve to "sandbox".
    const envSource = readFileSync("src/lib/environment.ts", "utf8");
    assert(
      envSource.includes('KNOWN[value] ?? "unknown"'),
      "an unrecognised constant classifies as unknown, never as a default",
    );
    assert(
      !/\?\?\s*"sandbox"/.test(envSource),
      "nothing in the environment reducer defaults to sandbox",
    );
    console.log(`   ${checks} checks so far`);

    /* ---- canonical presentation ---------------------------------------- */
    console.log("\n== presentation");
    const CSV_LABELS: Record<string, string> = {
      settled: "Paid",
      unreconciled: "Awaiting confirmation",
      blocked: "Refused",
      failed: "Not completed",
      pending: "In progress",
      signing: "In progress",
    };
    for (const [status, label] of Object.entries(CSV_LABELS)) {
      assertEqual(ledgerStatus(status as never), label, `the CSV still prints "${label}"`);
      assertEqual(
        presentStatus(status as never).label,
        label,
        `the canonical table agrees for "${status}"`,
      );
    }
    // The export's description column can no longer carry a URL at all.
    assertEqual(
      descriptionFromResourceUrl("https://api.test/v1/scrape?api_key=SECRET"),
      "Agent API payment",
      "the CSV description is generic — neither path nor query survives",
    );
    console.log(`   ${checks} checks so far`);

    /* ---- a second company ---------------------------------------------- */
    console.log("\n== company scoping");
    const company = bootstrapCompany();
    const otherCompany = randomUUID();
    const otherTeam = randomUUID();
    const otherAgent = randomUUID();
    const otherPaymentIds = [randomUUID(), randomUUID(), randomUUID()];
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES (?, ?, ?, ?)",
    ).run(otherCompany, `Other Co ${otherCompany.slice(0, 8)}`, 1_000_000, "2099-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(otherTeam, otherCompany, "Other Team", 1_000_000, "2099-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address, spend_cap_base_units, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(otherAgent, `other-agent-${otherAgent.slice(0, 8)}`, otherTeam, "0", "0xdead", 1_000_000, "2099-01-01T00:00:00.000Z");
    for (const [i, id] of otherPaymentIds.entries()) {
      db.prepare(
        `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at)
         VALUES (?, ?, ?, ?, 'settled', ?, ?, ?)`,
      ).run(
        id,
        otherAgent,
        1000,
        "https://other.test/secret",
        `0x${"a".repeat(64)}`,
        "other company",
        `2099-01-0${i + 1}T00:00:00.000Z`,
      );
    }
    db.exec("COMMIT");

    const all: any[] = [];
    let cursor: string | null = null;
    do {
      const res: any = await call(`/api/activity?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      assertEqual(res.status, 200, "paging the whole set stays 200");
      all.push(...res.body.activity);
      cursor = res.body.page.nextCursor;
    } while (cursor);

    for (const id of otherPaymentIds) {
      assert(!all.some((p) => p.id === id), "another company's payment never appears in a page");
    }
    assert(
      !all.some((p) => p.agentId === otherAgent),
      "another company's agent never appears in a page",
    );
    /*
     * BOTH TABLES, because the ledger merges both directions since 6B-3. An
     * assertion that counted payments alone would have been satisfied by a
     * merge that silently dropped every receipt — which is exactly the bug a
     * two-arm UNION can have and a one-table query cannot.
     */
    const ownTotal = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM payments p
              JOIN agents a ON a.id = p.agent_id JOIN teams t ON t.id = a.team_id
             WHERE t.company_id = ?)
         + (SELECT COUNT(*) FROM receipts r
              JOIN agents a ON a.id = r.agent_id JOIN teams t ON t.id = a.team_id
             WHERE t.company_id = ?) AS n`,
      )
      .get(company.id, company.id) as { n: number };
    assertEqual(all.length, ownTotal.n, "a full walk returns this company's spend AND earn rows");
    assert(
      all.every((r) => r.direction === "spend" || r.direction === "earn"),
      "every ledger row names its direction",
    );

    /*
     * A rejected filter never quotes what the caller sent unless it was a
     * well-formed id. The Activity Ledger renders these messages beside its
     * filter form, so an error string is now shown to a person; React escapes
     * it and the API sends JSON, but a message that echoes arbitrary caller
     * text into a rendered page is a habit worth not having.
     */
    for (const [param, probe] of [
      ["agentId", "<script>alert(1)</script>"],
      ["teamId", "'; DROP TABLE payments; --"],
      ["status", "<img src=x onerror=alert(1)>"],
    ] as const) {
      const rejected = await call(`/api/activity?${param}=${encodeURIComponent(probe)}`);
      assertEqual(rejected.status, 400, `a malformed ${param} is refused`);
      assert(
        !rejected.text.includes(probe.slice(0, 12)),
        `the ${param} refusal does not quote what the caller sent`,
      );
      assert(!rejected.text.includes("<"), `the ${param} refusal contains no markup at all`);
    }
    // A well-formed id IS named, because "which of my ids was wrong" is the
    // whole diagnostic and a UUID is a bounded, safe string.
    assert(
      (await call(`/api/activity?agentId=${otherAgent}`)).text.includes(otherAgent),
      "a rejected id that is well-formed is still named, so the caller can fix it",
    );

    // A filter naming another company's agent is refused, not silently empty.
    assertEqual(
      (await call(`/api/activity?agentId=${otherAgent}`)).status,
      400,
      "filtering by another company's agent is a 400, not an empty page",
    );
    assertEqual(
      (await call(`/api/activity?teamId=${otherTeam}`)).status,
      400,
      "filtering by another company's team is a 400",
    );
    console.log(`   ${checks} checks so far`);

    /* ---- approvals ------------------------------------------------------ */
    console.log("\n== approvals");

    const ownAgent = db
      .prepare(
        `SELECT a.id, a.name FROM agents a JOIN teams t ON t.id = a.team_id
         WHERE t.company_id = ? LIMIT 1`,
      )
      .get(company.id) as { id: string; name: string };

    // Three rows, each answering a different question:
    //   otherApproval — belongs to another company. Must be invisible and
    //                   undecidable through every approval route.
    //   ownPending    — ours and pending. Proves a decision still works.
    //   leakyApproval — ours, with a credential in the URL and prose in
    //                   `detail`. Proves neither reaches a response.
    const otherApproval = randomUUID();
    const ownPending = randomUUID();
    const ownDeniable = randomUUID();
    const leakyApproval = randomUUID();
    const insertApproval = db.prepare(
      `INSERT INTO approval_requests
         (id, agent_id, amount_base_units, resource_url, blocked_scope, status, created_at, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec("BEGIN IMMEDIATE");
    insertApproval.run(
      otherApproval, otherAgent, 5000, "https://other.test/APPROVALSECRET",
      "team", "pending", "2099-02-01T00:00:00.000Z", "another company's business",
    );
    insertApproval.run(
      ownPending, ownAgent.id, 5000, "https://api.own.test/v1/x",
      "company", "pending", "2099-02-02T00:00:00.000Z", null,
    );
    insertApproval.run(
      ownDeniable, ownAgent.id, 5000, "https://api.own.test/v1/y",
      "team", "pending", "2099-02-03T00:00:00.000Z", null,
    );
    insertApproval.run(
      leakyApproval, ownAgent.id, 5000,
      "https://api.own.test/services/T000/APPROVALPATHSECRET?api_key=APPROVALQUERYSECRET",
      "anomaly", "pending", "2099-02-04T00:00:00.000Z",
      "0.005 is unusual for this agent: above the 0.003 threshold, against a median of 0.001",
    );
    db.exec("COMMIT");

    // Access. The list is operator-only as of 5B-3; the single-row read stays
    // open to both roles because it is how an agent checks its own held
    // payment, and that capability is deliberately preserved.
    assertEqual((await call("/api/approvals", null)).status, 401, "the list needs a credential");
    assertEqual((await call("/api/approvals", "nonsense")).status, 401, "an unknown token is 401");
    assertEqual(
      (await call("/api/approvals", AGENT_KEY)).status,
      403,
      "the approvals list no longer answers the agent credential",
    );
    assertEqual((await call("/api/approvals")).status, 200, "the operator can read the list");
    assertEqual(
      (await call(`/api/approvals/${ownPending}`, AGENT_KEY)).status,
      200,
      "an agent can still check one approval by id — the retry flow is preserved",
    );
    assertEqual(
      (await call(`/api/approvals/${ownPending}`, null)).status,
      401,
      "but not without a credential",
    );

    // Company scoping, through every approval route.
    const approvalList: any = await call("/api/approvals");
    assert(
      !approvalList.body.some((a: any) => a.id === otherApproval),
      "another company's approval never appears in the list",
    );
    assert(
      approvalList.body.some((a: any) => a.id === ownPending),
      "this company's approvals do appear",
    );
    assert(
      !approvalList.text.includes(otherAgent),
      "another company's agent id never appears in the list",
    );
    const scopedTotal = db
      .prepare(
        `SELECT COUNT(*) AS n FROM approval_requests r
         JOIN agents a ON a.id = r.agent_id JOIN teams t ON t.id = a.team_id
         WHERE t.company_id = ?`,
      )
      .get(company.id) as { n: number };
    assertEqual(
      approvalList.body.length,
      scopedTotal.n,
      "the list is exactly this company's approvals — no more, no fewer",
    );
    assertEqual(
      (await call(`/api/approvals/${otherApproval}`)).status,
      404,
      "another company's approval is 404 by id, not 200",
    );
    assertEqual(
      (await call(`/api/approvals/${otherApproval}`, AGENT_KEY)).status,
      404,
      "and 404 to an agent too",
    );
    for (const decision of ["approve", "deny"]) {
      const res = await fetch(`${base}/api/approvals/${otherApproval}/${decision}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPERATOR_KEY}` },
      });
      assertEqual(res.status, 404, `${decision} on another company's approval is refused`);
    }
    const untouched = db
      .prepare("SELECT status FROM approval_requests WHERE id = ?")
      .get(otherApproval) as { status: string };
    assertEqual(untouched.status, "pending", "and that approval was not decided by the attempt");

    // The response contract: a closed key set, checked on every route that
    // returns an approval.
    const APPROVAL_KEYS = [
      "agentId",
      "agentName",
      "amount",
      "amountBaseUnits",
      "approvalExpiresAt",
      "blockedScope",
      "createdAt",
      "decidedAt",
      "decidedBy",
      "id",
      "isDemo",
      "paymentId",
      "scopeLabel",
      "status",
      "statusLabel",
      "statusMeaning",
      "statusTone",
      "teamId",
      "teamName",
      "vendor",
    ].join(",");

    const byId: any = await call(`/api/approvals/${leakyApproval}`);
    for (const [label, sample] of [
      ["the list", approvalList.body[0]],
      ["one by id", byId.body],
    ] as const) {
      assertEqual(Object.keys(sample).sort().join(","), APPROVAL_KEYS, `${label}: keys are exact`);
      assertEqual(typeof sample.amount, "string", `${label}: amount is a string`);
      assertEqual(typeof sample.isDemo, "boolean", `${label}: isDemo is structural`);
      assertEqual(typeof sample.statusLabel, "string", `${label}: a display label is present`);
    }
    assertEqual(byId.body.vendor, "api.own.test", "an approval carries the vendor host only");
    assertEqual(byId.body.scopeLabel, "Unusual for this agent", "and a display-safe scope label");

    // The two fields this slice removed, proven gone on both routes and to
    // both roles. A URL that carries a credential in its path AND its query is
    // the case that matters: neither half may survive.
    for (const [label, text] of [
      ["the list", approvalList.text],
      ["one by id", byId.text],
      ["one by id, to an agent", (await call(`/api/approvals/${leakyApproval}`, AGENT_KEY)).text],
    ] as const) {
      assert(!text.includes("APPROVALQUERYSECRET"), `${label}: no URL query value reaches it`);
      assert(!text.includes("APPROVALPATHSECRET"), `${label}: no URL path segment reaches it`);
      assert(!text.includes("APPROVALSECRET"), `${label}: no other company's URL reaches it`);
      assert(!text.includes("resourceUrl"), `${label}: resourceUrl is not a field`);
      assert(!text.includes('"detail"'), `${label}: raw detail is not a field`);
      assert(!text.includes("is unusual for this agent"), `${label}: no prose from detail leaks`);
      assert(!text.includes("threshold"), `${label}: no anomaly threshold leaks`);
      for (const fragment of FORBIDDEN_FRAGMENTS) {
        assert(
          !text.toLowerCase().includes(fragment.toLowerCase()),
          `${label}: carries no "${fragment}"`,
        );
      }
      for (const term of NO_CRYPTO) {
        assert(!text.toLowerCase().includes(term), `${label}: says nothing about "${term}"`);
      }
    }

    // Unknown filters are refused rather than ignored.
    assertEqual((await call("/api/approvals?status=nope")).status, 400, "an unknown status is 400");
    assertEqual(
      (await call("/api/approvals?agentId=x")).status,
      400,
      "an unknown query parameter is 400, not silently unfiltered",
    );
    const pendingOnly: any = await call("/api/approvals?status=pending");
    assert(
      pendingOnly.body.every((a: any) => a.status === "pending"),
      "the status filter still filters",
    );

    /*
     * DECISIONS STILL WORK — AND THEY ARE MADE BY A PERSON NOW.
     *
     * This helper used to present the shared operator key. As of Commit D that
     * is refused for any company with accounts, which this one has, so the
     * helper signs somebody in and decides as them. The change is the point
     * rather than an accommodation: these assertions now exercise the path a
     * real operator uses, and a suite that kept approving with a key would go
     * on passing long after the path people actually use had broken.
     */
    const DECIDER_PASSWORD = "correct-horse-battery-staple";
    const DECIDER_EMAIL = `approver-${randomUUID()}@example.com`;
    const decider = createUser({
      companyId: bootstrapCompany().id,
      email: DECIDER_EMAIL,
      passwordHash: await hashPassword(DECIDER_PASSWORD),
      role: "operator",
    });
    resetLoginLimits();
    const deciderCookie = await (async () => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: handleFor(bootstrapCompany().id), email: DECIDER_EMAIL, password: DECIDER_PASSWORD }),
      });
      if (res.status !== 200) throw new Error(`the decider could not sign in: ${res.status}`);
      const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`));
      if (!line) throw new Error("signing the decider in set no cookie");
      return line.split(";")[0]!;
    })();

    async function decide(
      id: string,
      decision: "approve" | "deny",
      as: { cookie?: string; key?: string } = { cookie: deciderCookie },
    ) {
      const headers: Record<string, string> = {};
      if (as.key) headers.Authorization = `Bearer ${as.key}`;
      if (as.cookie) headers.Cookie = as.cookie;
      const res = await fetch(`${base}/api/approvals/${id}/${decision}`, {
        method: "POST",
        headers,
      });
      const text = await res.text();
      return { status: res.status, body: JSON.parse(text || "{}"), text };
    }
    const approved = await decide(ownPending, "approve");
    assertEqual(approved.status, 200, "a signed-in operator can approve");
    assertEqual(approved.body.status, "approved", "and the decision is recorded");
    /*
     * THE AUDIT TRAIL HAS A NAME ON IT. This is what Commit D is for: before it,
     * every approval in this database was decided by a holder of a shared key
     * and the honest answer to "who approved this" was nobody.
     */
    assertEqual(
      approved.body.decidedBy,
      DECIDER_EMAIL,
      "and it names the person who made it, not a role and not a placeholder",
    );
    assertEqual(
      (db.prepare("SELECT decided_by FROM approval_requests WHERE id = ?").get(ownPending) as { decided_by: string }).decided_by,
      decider.id,
      "the row stores the user id; only the response turns it into an address",
    );
    assert(
      !approved.text.includes(decider.id),
      "and the user id itself does not cross the wire — a second identifier to correlate people by is not needed on this surface",
    );
    assert(approved.body.approvalExpiresAt !== null, "an approval still gets an expiry");
    assertEqual(
      Object.keys(approved.body).sort().join(","),
      APPROVAL_KEYS,
      "the approve response uses the same allowlist",
    );
    assertEqual(
      (await decide(ownPending, "approve")).status,
      409,
      "a second approval of the same request is still 409, not a silent re-approve",
    );
    const denied = await decide(ownDeniable, "deny");
    assertEqual(denied.status, 200, "a signed-in operator can deny");
    assertEqual(denied.body.decidedBy, DECIDER_EMAIL, "and a denial is named too, not just an approval");
    assertEqual(denied.body.status, "denied", "and the denial is recorded");
    assertEqual(
      Object.keys(denied.body).sort().join(","),
      APPROVAL_KEYS,
      "the deny response uses the same allowlist",
    );
    assertEqual(
      (await decide(ownDeniable, "approve")).status,
      409,
      "a denied request cannot then be approved",
    );
    /* --- and a shared key is not told who decided, either ----------------- */
    {
      /*
       * SECURITY REVIEW FOUND THIS, AND IT IS THE SAME ARGUMENT THE COMMIT IS
       * BUILT ON, POINTED AT ITSELF. The legacy key resolves to `operator`, so
       * the first version of `decidedBy` handed the address of everyone who had
       * ever decided anything to the one credential this commit declares
       * untrustworthy to attach a name to a decision.
       *
       * Nothing legitimate wanted it: the dashboard carries sessions now and no
       * script reads the field. So it is withheld, and this asserts that the
       * SAME ROW reads differently to the two callers — which is the only way
       * to tell withholding apart from a field that is simply always null.
       */
      const asPerson: any = await call(`/api/approvals/${ownPending}`, null, deciderCookie);
      const asKey: any = await call(`/api/approvals/${ownPending}`, OPERATOR_KEY);

      assertEqual(asPerson.body.decidedBy, DECIDER_EMAIL, "a signed-in person is told who decided");
      assertEqual(asKey.body.decidedBy, null, "and a shared key is not");
      assertEqual(
        asKey.body.status,
        asPerson.body.status,
        "(control) while both callers see the same row, so this is withholding and not a different approval",
      );
      assert(
        !asKey.text.includes(DECIDER_EMAIL),
        "and the address appears nowhere else in what the key is handed",
      );
      assertEqual(
        Object.keys(asKey.body).sort().join(","),
        Object.keys(asPerson.body).sort().join(","),
        "the key gets the same SHAPE, so a caller cannot infer anything from a missing field",
      );

      // The list read, not just the single row — that is the one that would
      // let somebody enumerate addresses rather than look one up.
      const listAsKey: any = await call("/api/approvals", OPERATOR_KEY);
      assert(
        !listAsKey.text.includes(DECIDER_EMAIL),
        "and the whole queue discloses no addresses to a key, so there is nothing to harvest",
      );
      const listAsPerson: any = await call("/api/approvals", null, deciderCookie);
      assert(
        listAsPerson.text.includes(DECIDER_EMAIL),
        "(control) while a signed-in person does see them, so the queue is not simply empty",
      );
    }

    /* --- the shared key may no longer decide for a company with people ---- */
    {
      /*
       * THE POINT OF THE WHOLE STAGE IN ONE RULE. Two-party control whose
       * parties are both anonymous is one party: whoever holds FUEL_API_KEY and
       * FUEL_AGENT_KEY can request a payment and approve it, and `decided_by`
       * on a key-made decision is NULL forever. So once a company has accounts
       * that can decide as themselves, the key may not.
       */
      const keyTarget = randomUUID();
      insertApproval.run(
        keyTarget, ownAgent.id, 5000, "https://api.own.test/v1/key-attempt",
        "company", "pending", "2099-02-09T00:00:00.000Z", null,
      );

      const refused = await decide(keyTarget, "approve", { key: OPERATOR_KEY });
      assertEqual(refused.status, 403, "a shared key is refused a decision for a company that has people");
      assert(
        /sign in/i.test(refused.body.error ?? ""),
        "and the refusal says what to do instead, rather than reading as a broken key",
      );
      assertEqual(
        (db.prepare("SELECT status FROM approval_requests WHERE id = ?").get(keyTarget) as { status: string }).status,
        "pending",
        "and nothing was written",
      );

      // The same request, from a person, goes through. Without this the
      // assertion above would also pass if the route were broken for everyone.
      const allowed = await decide(keyTarget, "approve");
      assertEqual(allowed.status, 200, "(control) the same decision succeeds when a person makes it");
      assertEqual(allowed.body.decidedBy, DECIDER_EMAIL, "(control) and carries their name");

      /*
       * AND THE REFUSAL IS SCOPED, not global. A company nobody can sign in to
       * still needs its payments decidable — the scripts in scripts/ have no
       * browser. This is the control the plan named 14c, and it is the half
       * that stops the rule being "keys can never decide", which would strand
       * every company without accounts.
       */
      const { createCompany } = await import("../src/db/companies.js");
      const peopleless = createCompany({
        name: `Keyless Co ${randomUUID().slice(0, 8)}`,
        spendCapBaseUnits: 100_000n,
      });
      const peoplelessTeam = randomUUID();
      const peoplelessAgent = randomUUID();
      db.prepare(
        `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
         VALUES (?, ?, 'Platform', 50000, ?)`,
      ).run(peoplelessTeam, peopleless.id, "2099-02-09T00:00:00.000Z");
      db.prepare(
        `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                             spend_cap_base_units, created_at)
         VALUES (?, 'keyless-agent', ?, ?, '0xkeyless', 25000, ?)`,
      ).run(peoplelessAgent, peoplelessTeam, `vault-${randomUUID()}`, "2099-02-09T00:00:00.000Z");
      const peoplelessApproval = randomUUID();
      insertApproval.run(
        peoplelessApproval, peoplelessAgent, 5000, "https://api.keyless.test/v1/x",
        "company", "pending", "2099-02-09T00:00:00.000Z", null,
      );

      assertEqual(
        activeUserCount(peopleless.id),
        0,
        "(control) the second company genuinely has nobody who can sign in",
      );

      /*
       * Decided through the data layer rather than over HTTP, because the
       * legacy key is bound to the bootstrap company and cannot ACT for this
       * one — which is Stage 1's tenancy working, not a gap. What is under test
       * here is the refusal's condition, and this reaches it directly.
       */
      const { decideRequest, SharedKeyCannotDecideError } = await import("../src/db/approvals.js");
      /*
       * CAUGHT RATHER THAN ALLOWED TO PROPAGATE, because the first version of
       * this let the throw escape. Break-testing it — making the refusal fire
       * for every company — killed the suite with an uncaught error instead of
       * failing this check by name, which is the same weak-test shape this
       * stage has caught before: a break that trips something other than the
       * assertion written for it proves nothing about the assertion.
       */
      let keyDecided: unknown = null;
      let keyRefusal: string | null = null;
      try {
        keyDecided = decideRequest({
          id: peoplelessApproval,
          companyId: peopleless.id,
          decision: "approve",
          decidedBy: null,
        });
      } catch (error) {
        keyRefusal =
          error instanceof SharedKeyCannotDecideError ? "refused" : `unexpected: ${(error as Error).message}`;
      }
      assertEqual(
        keyRefusal,
        null,
        "(control) a nameless credential is NOT refused for a company that has no people — the rule is scoped to where a real identity exists",
      );
      assert(
        keyDecided !== null,
        "(control) and the decision actually lands",
      );
      assertEqual(
        (db.prepare("SELECT decided_by FROM approval_requests WHERE id = ?").get(peoplelessApproval) as { decided_by: string | null }).decided_by,
        null,
        "and that decision honestly records no author, rather than inventing one",
      );

      /*
       * AND IT UN-REFUSES ITSELF. If every account at a company is disabled,
       * the key works again. The alternative is a company whose held payments
       * nobody can release — a lockout on the approval queue, which is a worse
       * failure than a nameless decision.
       */
      const disabledCo = createCompany({
        name: `Disabled Co ${randomUUID().slice(0, 8)}`,
        spendCapBaseUnits: 100_000n,
      });
      const ghost = createUser({
        companyId: disabledCo.id,
        email: `ghost-${randomUUID()}@example.com`,
        passwordHash: await hashPassword(DECIDER_PASSWORD),
        role: "owner",
      });
      const disabledCoTeam = randomUUID();
      const disabledCoAgent = randomUUID();
      db.prepare(
        `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
         VALUES (?, ?, 'Platform', 50000, ?)`,
      ).run(disabledCoTeam, disabledCo.id, "2099-02-09T00:00:00.000Z");
      db.prepare(
        `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                             spend_cap_base_units, created_at)
         VALUES (?, 'ghost-agent', ?, ?, '0xghost', 25000, ?)`,
      ).run(disabledCoAgent, disabledCoTeam, `vault-${randomUUID()}`, "2099-02-09T00:00:00.000Z");

      /** Decides for disabledCo with a nameless credential, reporting what happened. */
      const keyDecidesForDisabledCo = (): "decided" | "refused" | string => {
        const id = randomUUID();
        insertApproval.run(
          id, disabledCoAgent, 5000, "https://api.ghost.test/v1/x",
          "company", "pending", "2099-02-09T00:00:00.000Z", null,
        );
        try {
          return decideRequest({ id, companyId: disabledCo.id, decision: "approve", decidedBy: null })
            ? "decided"
            : "changed nothing";
        } catch (error) {
          return error instanceof SharedKeyCannotDecideError ? "refused" : `unexpected: ${(error as Error).message}`;
        }
      };

      assertEqual(activeUserCount(disabledCo.id), 1, "(control) the company starts with somebody who can sign in");
      assertEqual(
        keyDecidesForDisabledCo(),
        "refused",
        "(control) and while that account is active the shared key is refused",
      );

      disableUser(ghost.id, disabledCo.id);
      assertEqual(
        activeUserCount(disabledCo.id),
        0,
        "disabling the last account leaves nobody who can decide as themselves",
      );
      /*
       * THE CONSEQUENCE, WHICH THIS TEST DID NOT ACTUALLY CHECK UNTIL SECURITY
       * REVIEW SAID SO. It asserted the count reached zero and stopped there —
       * proving the precondition of "it un-refuses itself" while claiming, in
       * its own comment, to prove the recovery. The count is not the point; a
       * company whose held payments nobody can release is the point.
       */
      assertEqual(
        keyDecidesForDisabledCo(),
        "decided",
        "and the key can decide again — a company whose every account is disabled does not become a queue of payments nobody can release",
      );
    }

    assertEqual(
      (await call(`/api/approvals/${randomUUID()}`)).status,
      404,
      "an id that names nothing is 404",
    );
    console.log(`   ${checks} checks so far`);

    /* ---- agents, teams and company (5B-4) -------------------------------- */
    console.log("\n== agents and teams");

    async function send(path: string, method: string, key: string, body?: unknown) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let parsed: any = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        /* a non-JSON body is itself a finding */
      }
      return { status: res.status, body: parsed, text };
    }

    // Access. Four reads that used to answer the shared agent credential.
    for (const path of ["/api/agents", "/api/company", "/api/teams", `/api/teams/${otherTeam}`]) {
      assertEqual((await call(path, null)).status, 401, `${path}: no credential is 401`);
      assertEqual(
        (await call(path, AGENT_KEY)).status,
        403,
        `${path}: the agent credential is refused (was ANY before 5B-4)`,
      );
    }
    assertEqual((await call("/api/agents")).status, 200, "the operator can still list agents");
    assertEqual((await call("/api/company")).status, 200, "and read the company");
    assertEqual((await call("/api/teams")).status, 200, "and list teams");

    // Scoping: the second company's agent and team are invisible and inert.
    const agentList: any = await call("/api/agents");
    assert(
      !agentList.body.some((a: any) => a.id === otherAgent),
      "another company's agent never appears in the roster",
    );
    const ownAgentCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM agents a JOIN teams t ON t.id = a.team_id
         WHERE t.company_id = ?`,
      )
      .get(company.id) as { n: number };
    assertEqual(agentList.body.length, ownAgentCount.n, "the roster is exactly this company's");

    const teamList: any = await call("/api/teams");
    assert(
      !teamList.body.some((t: any) => t.id === otherTeam),
      "another company's team never appears in the list",
    );
    assertEqual(
      (await call(`/api/teams/${otherTeam}`)).status,
      404,
      "another company's team is 404 by id",
    );
    assertEqual(
      (await call(`/api/agents/${otherAgent}`)).status,
      404,
      "another company's agent is 404 by id",
    );

    // WRITES. A 404 that still wrote would be worse than a 200, so each of
    // these checks the database as well as the status code.
    const capBefore = db
      .prepare("SELECT spend_cap_base_units AS cap FROM agents WHERE id = ?")
      .get(otherAgent) as { cap: number | bigint };
    assertEqual(
      (await send(`/api/agents/${otherAgent}`, "PATCH", OPERATOR_KEY, { spendCapUsd: "99.00" }))
        .status,
      404,
      "another company's agent cap cannot be set",
    );
    assertEqual(
      Number(
        (
          db.prepare("SELECT spend_cap_base_units AS cap FROM agents WHERE id = ?").get(otherAgent) as {
            cap: number | bigint;
          }
        ).cap,
      ),
      Number(capBefore.cap),
      "and its cap did not move",
    );
    assertEqual(
      (await send(`/api/agents/${otherAgent}/freeze`, "POST", OPERATOR_KEY, {})).status,
      404,
      "another company's agent cannot be frozen",
    );
    assertEqual(
      (await send(`/api/agents/${otherAgent}/unfreeze`, "POST", OPERATOR_KEY, {})).status,
      404,
      "nor unfrozen",
    );
    const stillRunning = db
      .prepare("SELECT frozen_at FROM agents WHERE id = ?")
      .get(otherAgent) as { frozen_at: string | null };
    assertEqual(stillRunning.frozen_at, null, "and its freeze state is untouched");

    const teamCapBefore = db
      .prepare("SELECT spend_cap_base_units AS cap FROM teams WHERE id = ?")
      .get(otherTeam) as { cap: number | bigint };
    assertEqual(
      (await send(`/api/teams/${otherTeam}`, "PATCH", OPERATOR_KEY, { spendCapUsd: "99.00" })).status,
      404,
      "another company's team cap cannot be set",
    );
    assertEqual(
      Number(
        (
          db.prepare("SELECT spend_cap_base_units AS cap FROM teams WHERE id = ?").get(otherTeam) as {
            cap: number | bigint;
          }
        ).cap,
      ),
      Number(teamCapBefore.cap),
      "and its cap did not move",
    );

    // THE MONEY PATH. The only assertion this suite makes about /pay, and it is
    // deliberately only the refusal: a foreign agent id must die at the lookup,
    // before any budget is reserved or anything is signed. A valid agent is
    // never paid from here — that would move real sandbox funds.
    const paymentsBefore = (db.prepare("SELECT COUNT(*) AS n FROM payments").get() as { n: number }).n;
    assertEqual(
      (await send(`/api/agents/${otherAgent}/pay`, "POST", AGENT_KEY, {
        url: "http://127.0.0.1:1/never",
      })).status,
      404,
      "another company's agent cannot be made to pay",
    );
    assertEqual(
      (await send(`/api/agents/${randomUUID()}/pay`, "POST", AGENT_KEY, {
        url: "http://127.0.0.1:1/never",
      })).status,
      404,
      "and neither can an agent that does not exist",
    );
    assertEqual(
      (db.prepare("SELECT COUNT(*) AS n FROM payments").get() as { n: number }).n,
      paymentsBefore,
      "neither attempt reserved a payment",
    );

    // Creating an agent against a foreign team must be refused BEFORE a
    // Fireblocks vault is provisioned — a 400 that leaves custody state behind
    // is not a refusal.
    const agentsBefore = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
    const created = await send("/api/agents", "POST", OPERATOR_KEY, {
      name: `should-never-exist-${randomUUID().slice(0, 8)}`,
      teamId: otherTeam,
      spendCapUsd: "1.00",
    });
    assertEqual(created.status, 400, "an agent cannot be created in another company's team");
    assertEqual(
      (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n,
      agentsBefore,
      "and no agent row was written",
    );
    const apiSource = withoutComments(readFileSync("src/api.ts", "utf8"));
    const createHandler = apiSource.slice(apiSource.indexOf('api.post("/agents", OPERATOR'));
    assert(
      createHandler.indexOf("getTeamInCompany") > 0 &&
        createHandler.indexOf("getTeamInCompany") <
          createHandler.indexOf("createAgentWithCustody"),
      "the team is proven to be in this company before any custody resource is created",
    );

    // Response contracts, closed key sets.
    assertEqual(
      Object.keys(agentList.body[0]).sort().join(","),
      "balance,createdAt,frozen,frozenAt,frozenAttempts,frozenReason,id,lastFrozenAttemptAt,ledger,name,remaining,spendCap,spent,teamId",
      "an agent's keys are exact",
    );
    assertEqual(
      Object.keys(teamList.body[0]).sort().join(","),
      "companyId,createdAt,id,name,remaining,spendCap,spent",
      "a team's keys are exact",
    );
    assertEqual(
      Object.keys((await call("/api/company")).body).sort().join(","),
      "handle,id,ledger,name,remaining,spendCap,spent",
      "the company's keys are exact",
    );

    /*
     * THE TWO BASES, ON THE WIRE, AND THE LABEL THAT KEEPS THEM APART.
     *
     * `spent` is the cap basis and counts money that MIGHT move; `ledger.spent`
     * is what DID move. A page showing both unlabelled would present two
     * numbers that look comparable and are not, so the note travels with the
     * figures rather than living in a dashboard template.
     */
    for (const [label, body] of [
      ["the company", (await call("/api/company")).body],
      ["an agent", agentList.body[0]],
    ] as const) {
      assertEqual(
        Object.keys(body.ledger).sort().join(","),
        "earned,net,note,spent",
        `${label}'s P&L block has exactly four keys`,
      );
      for (const figure of ["earned", "net", "spent"] as const) {
        assertEqual(
          typeof body.ledger[figure],
          "string",
          `${label}'s ledger.${figure} is a string, never a JSON number`,
        );
      }
      assert(
        body.ledger.note.length > 0 && /cap/i.test(body.ledger.note),
        `${label}'s P&L block carries the note that names the other basis`,
      );
    }

    /*
     * And they must actually DIVERGE, or the label is decoration. A payment in
     * flight is in the cap figure and not in the ledger one — this is the same
     * property verify-earning pins at the database level, asserted here on the
     * bytes a browser receives.
     */
    {
      const inFlight = randomUUID();
      const subject = agentList.body[0].id as string;
      db.prepare(
        `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, created_at)
         VALUES (?, ?, 777000, 'https://vendor.test/basis', 'pending', ?)`,
      ).run(inFlight, subject, new Date().toISOString());

      const withFlight: any = await call(`/api/agents/${subject}`);
      assert(
        withFlight.body.spent !== withFlight.body.ledger.spent,
        "with a payment in flight the cap basis and the P&L basis report different figures",
      );
      const company: any = await call("/api/company");
      assert(
        company.body.spent !== company.body.ledger.spent,
        "and the same divergence is visible on the company",
      );

      db.prepare("DELETE FROM payments WHERE id = ?").run(inFlight);
    }
    const ownTeamId = teamList.body[0].id;
    const teamDetail: any = await call(`/api/teams/${ownTeamId}`);
    for (const a of teamDetail.body.agents) {
      assertEqual(
        Object.keys(a).sort().join(","),
        "createdAt,frozen,frozenAt,frozenAttempts,frozenReason,id,lastFrozenAttemptAt,ledger,name,remaining,spendCap,spent,teamId",
        "an agent inside a team detail carries no extra fields",
      );
    }
    /*
     * Agent NAMES are operator-chosen text, and this database contains agents
     * called `vault1-signing-test` and `vault4-empty-test`. Scanning a whole
     * response for the word "vault" therefore fires on a legitimate name and
     * says nothing about whether a custody field leaked — the "check that
     * cries wolf" failure this suite keeps having to avoid.
     *
     * So the terminology scan runs over the response with name VALUES removed,
     * and the leak scan looks for the real secrets by value instead.
     */
    const withoutNames = (text: string) => text.replace(/"name":"[^"]*"/g, '"name":""');
    const custodyValues = db
      .prepare("SELECT address FROM agents")
      .all() as unknown as { address: string }[];

    for (const [label, text] of [
      ["the agent roster", agentList.text],
      ["the team list", teamList.text],
      ["a team's detail", teamDetail.text],
    ] as const) {
      const scannable = withoutNames(text);
      for (const fragment of FORBIDDEN_FRAGMENTS) {
        assert(
          !scannable.toLowerCase().includes(fragment.toLowerCase()),
          `${label}: carries no "${fragment}"`,
        );
      }
      for (const term of NO_CRYPTO) {
        assert(
          !scannable.toLowerCase().includes(term),
          `${label}: says nothing about "${term}" outside an operator-chosen name`,
        );
      }
      // Key names, quoted, so an agent called "address-book" cannot trip them.
      for (const key of ['"address"', '"fireblocksVaultId"', '"walletAddress"']) {
        assert(!text.includes(key), `${label}: ${key} is not a field`);
      }
      // And the values themselves, which no name-stripping can hide.
      for (const { address } of custodyValues) {
        assert(!text.includes(address), `${label}: no custody address value reaches it`);
      }
    }

    /*
     * NOTHING OUTSIDE THE DATA LAYER TOUCHES AN UNSCOPED READ OR NAMES A TENANT.
     *
     * This used to be a hand-maintained list of three names checked against
     * src/api.ts alone. It could not see a NEW unscoped function, it listed
     * `listAgents(`, which no longer existed, and it never read the gateway —
     * which was calling the unscoped `getAgent()` its own doc comment forbade.
     *
     * So the convention is carried by the NAME. Every deliberately unscoped
     * accessor ends in `Unscoped`, and `bootstrapCompany` is held to the same
     * rule: a route calling it is `getDefaultCompany()` again.
     *
     * THE SECOND VERSION OF THIS GUARD HAD TWO HOLES, found in security review:
     *
     *   - It stripped comments with a regex before matching, and that regex
     *     treats the `//` inside "http://" as a comment start — so
     *     `"http://" + getAgentUnscoped(id)` had the call deleted before the
     *     check ever saw it. Fixed by not stripping at all: no file outside the
     *     allowlist mentions these names even in a comment, so the RAW bytes
     *     are scanned and there is no preprocessing left to fool.
     *
     *   - It scanned a fixed set of route files, so any other module could
     *     `export { getAgentUnscoped as getAgentInternal }` and a route could
     *     import the innocent name. Fixed from both sides: the scan now covers
     *     ALL of src/ except an explicit allowlist, and inside the allowlist no
     *     unscoped name may be re-exported or aliased.
     *
     * WHAT THIS STILL CANNOT SEE, stated so nobody mistakes it for more: a new
     * function with a neutral name whose body is unscoped. Text cannot tell
     * `getThing(id)` that scopes from one that does not. That is what the
     * behavioural tests below — a foreign id must 404 — are for, and what
     * code review is for. This guard enforces the naming convention; it does
     * not prove the absence of unscoped reads.
     */
    {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? walk(join(dir, entry.name))
            : entry.name.endsWith(".ts")
              ? [join(dir, entry.name)]
              : [],
        );
      const everySource = walk("src");
      // Where these names may legitimately live: their definitions and the
      // internal re-reads beside them, and the one credential resolver.
      const ALLOWED = (file: string) =>
        file.startsWith(join("src", "db") + "/") || file === join("src", "lib", "auth.ts");
      const guarded = everySource.filter((file) => !ALLOWED(file));

      assert(
        [join("src", "api.ts"), join("src", "server.ts"), join("src", "gateway", "route.ts"),
         join("src", "quickbooks", "posting.ts")].every((f) => guarded.includes(f)),
        "the guarded set covers the routes, the server, the gateway and the QuickBooks engine",
      );

      const FORBIDDEN = /\b(\w+Unscoped|bootstrapCompany)\b/;
      // The pattern must be able to see what it forbids, or a rename would make
      // every assertion below pass by matching nothing.
      for (const [file, name] of [
        ["src/db/agents.ts", "getAgentUnscoped"],
        ["src/db/qbo-postings.ts", "getDraftUnscoped"],
        ["src/db/companies.ts", "bootstrapCompany"],
      ] as const) {
        assert(FORBIDDEN.test(readFileSync(file, "utf8")), `the guard's pattern matches ${name} where it is defined`);
      }
      for (const file of guarded) {
        const hit = readFileSync(file, "utf8").match(FORBIDDEN);
        assert(hit === null, `${file} names no unscoped accessor and no fixed tenant${hit ? ` (found ${hit[0]})` : ""}`);
      }

      // Inside the allowlist: an unscoped name may be defined and called, never
      // handed onward under another name.
      const LAUNDERED = /\b\w+Unscoped\s+as\s+\w+|export\s*\{[^}]*\b\w+Unscoped\b[^}]*\}/;
      for (const file of everySource.filter(ALLOWED)) {
        const hit = readFileSync(file, "utf8").match(LAUNDERED);
        assert(hit === null, `${file} does not re-export or alias an unscoped accessor${hit ? ` (found "${hit[0]}")` : ""}`);
      }
    }
    assert(
      /\bcompanyOf\(req\)/.test(apiSource),
      "src/api.ts takes its tenant from the request",
    );
    {
      // And the principal the resolver builds is the bootstrap company's, with
      // a second company present — the state in which the old code went wrong.
      const own: any = await call("/api/company");
      assertEqual(own.body.id, company.id, "the operator key acts for the recorded bootstrap company");
      assert(own.body.id !== otherCompany, "and not for the other company that now exists");
    }
    assert(
      /export function listTeams\(companyId: string\)/.test(
        withoutComments(readFileSync("src/db/teams.ts", "utf8")),
      ),
      "listTeams cannot be called without a company",
    );
    console.log(`   ${checks} checks so far`);

    /* ---- filters and validation ---------------------------------------- */
    console.log("\n== validation");
    for (const query of [
      "?nonsense=1",
      "?Limit=5",
      "?status=settled&sort=amount",
      "?offset=10",
    ]) {
      assertEqual(
        (await call(`/api/activity${query}`)).status,
        400,
        `an unknown query key is refused: ${query}`,
      );
    }
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=abc",
      "?limit=-1",
      "?limit=1.5",
      "?order=sideways",
      "?status=paid",
      "?from=2026-13-01",
      "?from=yesterday",
      "?to=2026-08",
      "?from=2026-08-10&to=2026-08-01",
      "?demo=yes",
      `?agentId=not-a-uuid`,
    ]) {
      assertEqual(
        (await call(`/api/activity${query}`)).status,
        400,
        `an invalid value is refused: ${query}`,
      );
    }
    const applied = (await call("/api/activity?status=settled&demo=false")).body.applied;
    assertEqual(applied.status.join(","), "settled", "applied echoes the filters that ran");
    assertEqual(applied.demo, false, "applied echoes the demo filter");
    console.log(`   ${checks} checks so far`);

    /* ---- pagination ----------------------------------------------------- */
    console.log("\n== pagination");
    const walk = async (limit: number, order: string): Promise<any[]> => {
      const seen: any[] = [];
      let next: string | null = null;
      let pages = 0;
      do {
        const res: any = await call(
          `/api/activity?limit=${limit}&order=${order}${next ? `&cursor=${next}` : ""}`,
        );
        assertEqual(res.status, 200, `${order} page ${pages} is 200`);
        assert(res.body.activity.length <= limit, `${order} page never exceeds the limit`);
        seen.push(...res.body.activity);
        next = res.body.page.nextCursor;
        pages += 1;
        if (pages > 500) throw new Error("pagination did not terminate");
      } while (next);
      return seen;
    };

    const newest = await walk(7, "newest");
    const oldest = await walk(7, "oldest");
    assertEqual(newest.length, ownTotal.n, "a newest-first walk sees every row exactly once");
    assertEqual(oldest.length, ownTotal.n, "an oldest-first walk sees every row exactly once");
    assertEqual(
      new Set(newest.map((p) => p.id)).size,
      newest.length,
      "a walk returns no duplicate",
    );
    assertEqual(
      newest.map((p) => p.id).reverse().join(","),
      oldest.map((p) => p.id).join(","),
      "the two orders are exact reverses of each other",
    );
    for (let i = 1; i < newest.length; i += 1) {
      const a = newest[i - 1];
      const b = newest[i];
      assert(
        a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id),
        "newest-first is a total order, ties broken by id",
      );
    }
    assertEqual(
      (await call("/api/activity?limit=100000")).status,
      400,
      "an unbounded page cannot be requested",
    );

    // Stability: a row arriving at the head mid-walk must not disturb pages
    // already returned, and must not appear behind the cursor.
    const firstPage: any = await call("/api/activity?limit=5&order=newest");
    const intruder = randomUUID();
    const anyAgent = db
      .prepare(
        `SELECT a.id FROM agents a JOIN teams t ON t.id = a.team_id WHERE t.company_id = ? LIMIT 1`,
      )
      .get(company.id) as { id: string };
    db.prepare(
      `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at)
       VALUES (?, ?, ?, ?, 'settled', NULL, NULL, ?)`,
    ).run(intruder, anyAgent.id, 1000, "https://intruder.test/x", new Date().toISOString());

    const secondPage: any = await call(
      `/api/activity?limit=5&order=newest&cursor=${firstPage.body.page.nextCursor}`,
    );
    assert(
      !secondPage.body.activity.some((p: any) => p.id === intruder),
      "a row inserted at the head does not appear behind an existing cursor",
    );
    for (const p of firstPage.body.activity) {
      assert(
        !secondPage.body.activity.some((q: any) => q.id === p.id),
        "a row already returned is not returned again after an insert",
      );
    }
    db.prepare("DELETE FROM payments WHERE id = ?").run(intruder);

    // Cursor binding and shape.
    const base64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const valid: any = await call("/api/activity?limit=5");
    for (const [label, bad] of [
      ["not base64", "%%%%"],
      ["not JSON", Buffer.from("hello").toString("base64url")],
      ["wrong shape", base64({ ca: {}, id: [], o: "newest", f: "x" })],
      ["missing fields", base64({ ca: "2026-01-01T00:00:00.000Z" })],
      ["bad timestamp", base64({ ca: "2026-01-01", id: randomUUID(), o: "newest", f: "x" })],
      ["injection in id", base64({ ca: "2026-01-01T00:00:00.000Z", id: "' OR '1'='1", o: "newest", f: "x" })],
    ] as const) {
      assertEqual(
        (await call(`/api/activity?limit=5&cursor=${encodeURIComponent(bad)}`)).status,
        400,
        `a cursor that is ${label} is refused`,
      );
    }
    assertEqual(
      (await call(`/api/activity?limit=5&order=oldest&cursor=${valid.body.page.nextCursor}`)).status,
      400,
      "a cursor from a different order is refused",
    );
    assertEqual(
      (await call(`/api/activity?limit=5&status=settled&cursor=${valid.body.page.nextCursor}`))
        .status,
      400,
      "a cursor from a different filter set is refused",
    );
    console.log(`   ${checks} checks so far`);

    /* ---- the response contract ------------------------------------------ */
    console.log("\n== response contract");
    /*
     * ONE key set for BOTH directions, and that is deliberate.
     *
     * A merged ledger renders through one table, so a spend row and an earn row
     * must present the identical shape — every difference between them is a
     * value, never a missing key. It also means this assertion catches a leak on
     * either side: an earn row that started carrying a payer address would fail
     * the same check that guards the spend row's resource URL.
     */
    const LEDGER_KEYS = [
      "agentId",
      "agentName",
      "amount",
      "amountBaseUnits",
      "approval",
      "counterparty",
      "createdAt",
      "direction",
      "id",
      "isDemo",
      "ledgerDate",
      "refusal",
      "settledAt",
      "status",
      "statusLabel",
      "statusMeaning",
      "statusTone",
      "teamId",
      "teamName",
    ].join(",");

    const sample: any = await call("/api/activity?limit=100");
    assertEqual(
      Object.keys(sample.body).sort().join(","),
      "activity,applied,filters,page",
      "the envelope has exactly four keys",
    );
    // The filter vocabulary is the server's, and it collapses the two statuses
    // that read as one thing rather than offering a distinction Fuel does not
    // make in words.
    const statusOptions: { value: string; label: string }[] = sample.body.filters.statuses;
    assertEqual(
      statusOptions.map((o) => o.label).join(" | "),
      "Paid or received | Awaiting confirmation | Refused | Not completed | In progress | Served, not paid",
      "the filter menu offers exactly the labels the presentation table owns",
    );
    assert(
      statusOptions.some((o) => o.value === "pending,signing,awaiting" && o.label === "In progress"),
      "the three in-progress states are offered as one option, because they read as one",
    );
    /*
     * The one word both vocabularies hold, offered ONCE.
     *
     * `settled` is in PaymentStatus and ReceiptStatus alike and means the same
     * event on each. Two menus would have listed it twice under two labels —
     * "Paid" and "Received" — as two options issuing the identical query. A
     * merged label is the honest version of that, and this pins it.
     */
    assertEqual(
      statusOptions.filter((o) => o.value.split(",").includes("settled")).length,
      1,
      "settled is offered exactly once, not once per direction",
    );
    assert(
      statusOptions.some((o) => o.value === "failed,abandoned"),
      "the two directions' not-completed states are one option, because they read as one",
    );
    for (const option of statusOptions) {
      assertEqual(
        (await call(`/api/activity?limit=1&status=${option.value}`)).status,
        200,
        `every offered filter value is one the route accepts: ${option.value}`,
      );
    }
    assertEqual(
      Object.keys(sample.body.page).sort().join(","),
      "hasMore,limit,nextCursor,order",
      "the page block has exactly four keys",
    );
    for (const payment of sample.body.activity) {
      // A CLOSED key set, not a denylist. A denylist only catches what someone
      // thought to grep for; this fails on any column a later migration adds
      // that a presenter starts spreading.
      assertEqual(
        Object.keys(payment).sort().join(","),
        LEDGER_KEYS,
        `a ${payment.direction} row's keys are exact`,
      );
      assert(
        payment.direction === "spend" || payment.direction === "earn",
        "every row names one of the two directions",
      );
      assertEqual(typeof payment.amount, "string", "amount is a string, never a JSON number");
      assertEqual(
        typeof payment.amountBaseUnits,
        "string",
        "amountBaseUnits is a string, never a JSON number",
      );
      if (payment.approval) {
        assertEqual(
          Object.keys(payment.approval).sort().join(","),
          "decidedAt,id,scope",
          "an approval summary carries no detail",
        );
      }
      if (payment.refusal) {
        assertEqual(
          Object.keys(payment.refusal).sort().join(","),
          "code,label",
          "a refusal carries a code and a label and nothing else",
        );
        assert(
          (REFUSAL_CODES as readonly string[]).includes(payment.refusal.code),
          `refusal code ${payment.refusal.code} is a known code`,
        );
      }
    }
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      assert(
        !sample.text.toLowerCase().includes(fragment.toLowerCase()),
        `no response carries "${fragment}"`,
      );
    }
    for (const term of NO_CRYPTO) {
      assert(!sample.text.toLowerCase().includes(term), `no response says "${term}"`);
    }
    assert(
      !/"amount(BaseUnits)?":\s*-?[0-9]/.test(sample.text),
      "no money appears in the raw JSON as a bare number",
    );

    // A credential in a vendor URL must not survive into a response, in a path
    // segment or a query string.
    const leaky = randomUUID();
    db.prepare(
      `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at)
       VALUES (?, ?, ?, ?, 'settled', NULL, NULL, ?)`,
    ).run(
      leaky,
      anyAgent.id,
      1000,
      "https://api.leak.test/services/T000/SUPERSECRETPATH?api_key=SUPERSECRETQUERY",
      new Date().toISOString(),
    );
    const leakRes: any = await call("/api/activity?limit=5&order=newest");
    const leakRow = leakRes.body.activity.find((p: any) => p.id === leaky);
    assert(leakRow !== undefined, "the crafted payment is visible to the ledger");
    assertEqual(leakRow.counterparty, "api.leak.test", "only the counterparty host is returned");
    assert(!leakRes.text.includes("SUPERSECRETQUERY"), "a URL query value never reaches a response");
    assert(!leakRes.text.includes("SUPERSECRETPATH"), "a URL path segment never reaches a response");
    console.log(`   ${checks} checks so far`);

    /* ---- the hardened agent route --------------------------------------- */
    console.log("\n== agents/:id");
    const detail: any = await call(`/api/agents/${anyAgent.id}`);
    assertEqual(detail.status, 200, "the operator can still read an agent");
    assert(
      typeof detail.body.paymentsTotal === "number",
      "the route says how many payments exist, not just how many it showed",
    );
    assert(
      detail.body.payments.length <= 25,
      "an agent's payment history is bounded rather than returned whole",
    );
    for (const p of detail.body.payments) {
      assertEqual(
        Object.keys(p).sort().join(","),
        "amount,createdAt,id,isDemo,refusal,settledAt,status,statusLabel,statusTone,vendor",
        "an agent-detail payment's keys are exact",
      );
    }
    for (const fragment of ["txHash", "resourceUrl", "detail", "walletAddress"]) {
      assert(
        !detail.text.includes(fragment),
        `agents/:id no longer returns "${fragment}"`,
      );
    }

    /*
     * Funding, narrowly (ADR 0019, narrowing 0005).
     *
     * A real value, not a placeholder: `anyAgent` is a row in the test
     * database whose address has a custody address's exact shape, so a match
     * here is a match on that stored value, not on a pattern.
     */
    console.log("\n== agents/:id funding (ADR 0019)");
    const agentRow = db.prepare("SELECT address FROM agents WHERE id = ?").get(anyAgent.id) as {
      address: string;
    };
    assertEqual(
      Object.keys(detail.body.funding ?? {}).sort().join(","),
      "address,asset,network",
      "funding carries exactly address, asset and network",
    );
    assertEqual(
      detail.body.funding.address,
      agentRow.address,
      "funding.address is this agent's own real custody address",
    );
    assertEqual(
      detail.body.funding.network,
      NETWORK_LABEL,
      "funding.network is the one source-of-truth label from provision.ts",
    );
    assertEqual(
      detail.body.funding.asset,
      ASSET_LABEL,
      "funding.asset is the one source-of-truth label from provision.ts",
    );
    // GET /api/agents (the list) is deliberately untouched by ADR 0019 — the
    // exception is the single-agent route only. `agentList` was already read
    // above as a plain roster check; re-examined here for the property this
    // slice adds.
    assert(
      agentList.body.every((a: any) => a.funding === undefined),
      "GET /api/agents (the list) never carries a funding field",
    );
    assert(
      !agentList.text.includes(agentRow.address),
      "GET /api/agents (the list) never carries any agent's custody address",
    );
    // Already established above ("agents/:id no longer answers the agent
    // credential (hardened in 5B-2)"): the shared AGENT credential is refused
    // with 403 before any body — funding included — is ever built. Reasserted
    // here, by name, next to the feature it protects.
    assertEqual(
      (await call(`/api/agents/${anyAgent.id}`, AGENT_KEY)).status,
      403,
      "the shared AGENT credential still cannot reach funding on agents/:id",
    );
    console.log(`   ${checks} checks so far`);

    /* ---- demo marker, adversarially ------------------------------------- */
    console.log("\n== demo marker");
    const seedSource = readFileSync("scripts/seed-demo-day.ts", "utf8");
    assert(
      !/DELETE FROM \w+ WHERE detail = \?/.test(seedSource),
      "the seed script no longer deletes rows by matching free text",
    );
    assert(
      (seedSource.match(/DELETE FROM \w+ WHERE is_demo = 1/g) ?? []).length === 2,
      "both of the seed script's deletes are scoped to the structural marker",
    );
    assert(
      seedSource.includes('paymentColumns.includes("is_demo")'),
      "the seed script refuses to run without the marker column",
    );

    // Nothing anywhere infers demo status from free text any more. This is the
    // check that keeps the two halves consistent: the backend has a structural
    // column, and a surface that went back to string-matching would be reading
    // a field a third party can influence.
    for (const file of [
      "dashboard/lib/fuel.ts",
      "dashboard/lib/presentation.ts",
      "dashboard/app/agents/[id]/page.tsx",
      "src/api.ts",
    ]) {
      assert(
        !withoutComments(readFileSync(file, "utf8")).includes('=== "demo-seed"'),
        `${file} does not infer demo status from free text`,
      );
    }
    const approvalsRes: any = await call("/api/approvals?status=approved");
    // Asserted, not branched on: with no approved row this check used to skip
    // itself and say nothing. The test database always has some.
    assert(approvalsRes.body.length > 0, "there is an approved approval to read the marker from");
    assertEqual(
      typeof approvalsRes.body[0].isDemo,
      "boolean",
      "an approval carries a structural demo marker rather than requiring a text match",
    );

    // No production write path can set the marker.
    for (const file of ["src/db/payments.ts", "src/db/approvals.ts", "src/api.ts"]) {
      assert(
        !/is_demo\s*(=|,)\s*1/.test(readFileSync(file, "utf8")),
        `${file} contains no path that sets is_demo = 1`,
      );
    }

    // THE ADVERSARIAL CASE. payments.detail can hold a string a third-party
    // merchant chose (describeRejection in src/payments/pay.ts). A real payment
    // carrying the demo text must survive a re-seed and must not read as demo.
    const impostorDay = "2031-04-05";
    const impostor = randomUUID();
    db.prepare(
      `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at)
       VALUES (?, ?, ?, ?, 'unreconciled', NULL, 'demo-seed', ?)`,
    ).run(impostor, anyAgent.id, 1000, "https://real.test/x", `${impostorDay}T10:00:00.000Z`);

    db.prepare("DELETE FROM payments WHERE is_demo = 1 AND created_at LIKE ?").run(
      `${impostorDay}%`,
    );
    const survived = db.prepare("SELECT is_demo FROM payments WHERE id = ?").get(impostor) as
      | { is_demo: number }
      | undefined;
    assert(survived !== undefined, "a real payment whose detail says demo-seed survives a re-seed");
    assertEqual(Number(survived?.is_demo), 0, "and it is still marked real");

    const impostorRes: any = await call(
      `/api/activity?limit=100&from=${impostorDay}&to=${impostorDay}`,
    );
    const impostorRow = impostorRes.body.activity.find((p: any) => p.id === impostor);
    assertEqual(impostorRow?.isDemo, false, "and the API reports it as real, not demo");
    assertEqual(
      (await call(`/api/activity?demo=true&from=${impostorDay}&to=${impostorDay}`)).body.activity
        .length,
      0,
      "the demo filter does not match it",
    );

    /* ---- refusal codes --------------------------------------------------- */
    console.log("\n== refusal codes");
    const codesInDb = db
      .prepare("SELECT DISTINCT refusal_code AS c FROM payments WHERE refusal_code IS NOT NULL")
      .all() as unknown as { c: string }[];
    for (const { c } of codesInDb) {
      assert((REFUSAL_CODES as readonly string[]).includes(c), `stored refusal code ${c} is known`);
    }
    const historical = db
      .prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'blocked' AND refusal_code IS NULL")
      .get() as { n: number };
    assert(
      historical.n > 0,
      "historical refusals exist and were left uncoded rather than guessed at",
    );
    const historicalRes: any = await call("/api/activity?status=blocked&limit=100");
    assert(
      historicalRes.body.activity.every((p: any) => p.refusal === null),
      "a refusal recorded before codes existed reports no reason rather than an invented one",
    );
    const paySource = readFileSync("src/db/payments.ts", "utf8");
    assertEqual(
      (paySource.match(/recordBlocked\(\s*"/g) ?? []).length,
      REFUSAL_CODES.length,
      "every refusal site passes a code, and there are as many sites as codes",
    );
    console.log(`   ${checks} checks so far`);

    /* ---- the accounting export ------------------------------------------ */
    console.log("\n== export isolation and redaction");

    // The strongest surface to test, because its output leaves Fuel and lands
    // in a third party's books. By now the scratch database holds another
    // company's payments AND a payment whose URL carries a credential in both
    // its path and its query, so one file exercises both properties.
    const csv = await call("/api/exports/transactions.csv?include=all");
    assertEqual(csv.status, 200, "the operator can still export");
    assertEqual((await call("/api/exports/transactions.csv", AGENT_KEY)).status, 403, "an agent cannot");

    const csvLines = csv.text.trim().split("\n");
    const csvRows = csvLines.slice(1);
    assert(csvRows.length > 0, "the export is not empty");

    // Isolation. Nothing that identifies the second company may be in the file.
    for (const id of otherPaymentIds) {
      assert(!csv.text.includes(id), "another company's payment id is not in the export");
    }
    assert(!csv.text.includes(otherAgent), "another company's agent id is not in the export");
    assert(
      !csv.text.includes("other-agent-"),
      "another company's agent NAME is not in the export either",
    );
    assert(!csv.text.includes("other.test"), "another company's vendor is not in the export");

    const exportable = db
      .prepare(
        `SELECT COUNT(*) AS n FROM payments p
         JOIN agents a ON a.id = p.agent_id JOIN teams t ON t.id = a.team_id
         WHERE t.company_id = ?`,
      )
      .get(company.id) as { n: number };
    assertEqual(
      csvRows.length,
      exportable.n,
      "the export is exactly this company's payments — the scope predicate neither widens nor drops rows",
    );

    // Redaction, unchanged and re-proven rather than assumed. 5B-2 removed the
    // URL from the description column; a scope predicate must not have been
    // the change that quietly put it back.
    assert(!csv.text.includes("SUPERSECRETQUERY"), "no URL query value reaches the export");
    assert(!csv.text.includes("SUPERSECRETPATH"), "no URL path segment reaches the export");
    for (const [i, line] of csvRows.entries()) {
      assert(!line.includes("http"), `export row ${i + 1} carries no URL`);
      assert(!line.includes("?"), `export row ${i + 1} carries no query string`);
      assert(!line.includes("="), `export row ${i + 1} carries no key=value pair`);
    }
    for (const term of NO_CRYPTO) {
      assert(!csv.text.toLowerCase().includes(term), `the export says nothing about "${term}"`);
    }

    // The predicate is required by the TYPE, not by remembering to pass it —
    // an optional companyId would make the unscoped read the easy one to write.
    const exportSource = withoutComments(readFileSync("src/db/payments.ts", "utf8"));
    assert(
      /listPaymentsForExport\(opts:\s*\{\s*companyId:\s*string;/.test(exportSource),
      "listPaymentsForExport cannot be called without a company",
    );
    console.log(`   ${checks} checks so far`);

    console.log("\n== safe accounting-status boundary");

    /*
     * The contract that decides what the browser may learn about the
     * QuickBooks connection.
     *
     * Tested against a POISONED object, not against today's real response.
     * Asking "does the live status happen to lack a realm id" proves nothing
     * durable — the live response HAS one, and the question is whether the
     * narrowing drops it. So the input below carries every field that must
     * never cross, plus fields nobody has invented yet, and the assertions are
     * about what comes out.
     *
     * Both directions are checked: the closed key set (nothing extra crossed)
     * and the preserved values (nothing needed was dropped). A presenter that
     * returned {} would pass a leak test and fail the product.
     */
    const { toAccountingStatus, ACCOUNTING_STATUS_KEYS } = await import(
      "../dashboard/lib/accounting-status.js"
    );

    const POISON = {
      connected: true,
      connectedAt: "2026-08-25T10:00:00.000Z",
      readyToPost: true,
      missing: [],
      environment: "sandbox",
      accountingCurrency: {
        currency: "USD",
        source: "quickbooks_preferences",
        checkedAt: "2026-08-25T10:05:00.000Z",
        verified: true,
      },
      // Everything the raw response really carries and must not pass on.
      realmId: "9341457784003246",
      accessExpiresAt: "2026-08-27T11:00:00.000Z",
      refreshExpiresAt: "2026-09-26T10:00:00.000Z",
      config: {
        expenseAccountId: "92",
        suspenseAccountId: "93",
        contraAccountId: "94",
        contraAccountKind: "CreditCard",
        rollupGrain: "day",
      },
      // Things a future version of presentQboStatus might add. None of these
      // exist today, which is exactly the point: a denylist would admit them.
      accessToken: "eyJhbGciOiJSUzI1NiJ9.LEAKED",
      refreshToken: "AB11730000000LEAKED",
      clientId: "ABxyzClientIdentifier",
      redirectUri: "http://localhost:4000/quickbooks/callback",
      apiBaseUrl: "https://sandbox-quickbooks.api.intuit.com/v3/company/9341457784003246",
      requestId: "5c1d0e1a-0000-4000-8000-000000000000",
      lastRawResponse: { CompanyInfo: { Id: "1", CompanyName: "Sandbox Co" } },
      someFieldInventedNextQuarter: "should not cross",
    };

    const safe = toAccountingStatus(POISON);
    assert(safe !== null, "a well-formed status narrows rather than being refused");

    const safeKeys = Object.keys(safe!).sort();
    const expectedKeys = [...ACCOUNTING_STATUS_KEYS].sort();
    assertEqual(
      safeKeys.join(","),
      expectedKeys.join(","),
      "the safe status has EXACTLY the declared keys — no more, no fewer",
    );
    /*
     * The width is pinned as a number as well as a list, so a key ADDED to
     * ACCOUNTING_STATUS_KEYS cannot make both sides of the comparison above
     * agree on something wider without anyone noticing. 6B-3 took it from seven
     * to nine by adding the revenue-readiness pair.
     */
    assertEqual(safeKeys.length, 9, "the contract is nine keys wide");
    /*
     * And the revenue pair narrows like everything else: a poisoned body must
     * not be able to push a non-string into the operator's "Missing: …" line,
     * and an absent flag must read as false rather than as "probably fine".
     */
    assertEqual(
      toAccountingStatus({ connected: true })!.readyToPostRevenue,
      false,
      "revenue readiness defaults to false when the field is absent, never to true",
    );
    assertEqual(
      JSON.stringify(
        toAccountingStatus({
          connected: true,
          missingForRevenue: ["income account", { id: "42" }, 7],
        })!.missingForRevenue,
      ),
      JSON.stringify(["income account"]),
      "only strings survive into the revenue blocker list, so no id can render into it",
    );

    // Nothing forbidden crossed, checked by value as well as by key. A field
    // renamed on the way through would still be a leak.
    const serialised = JSON.stringify(safe);
    for (const leak of [
      "9341457784003246",
      "accessExpiresAt",
      "refreshExpiresAt",
      "accessToken",
      "refreshToken",
      "LEAKED",
      "clientId",
      "redirectUri",
      "callback",
      "intuit",
      "expenseAccountId",
      "suspenseAccountId",
      "contraAccountId",
      "contraAccountKind",
      "rollupGrain",
      "requestId",
      "lastRawResponse",
      "CompanyInfo",
      "someFieldInventedNextQuarter",
      "should not cross",
      "http",
      "realm",
      "config",
    ]) {
      assert(
        !serialised.toLowerCase().includes(leak.toLowerCase()),
        `the safe status carries no "${leak}"`,
      );
    }
    for (const term of NO_CRYPTO) {
      assert(!serialised.toLowerCase().includes(term), `the safe status says nothing about "${term}"`);
    }
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      assert(
        !serialised.toLowerCase().includes(fragment.toLowerCase()),
        `the safe status carries no "${fragment}"`,
      );
    }

    // The other direction: everything /accounting and /integrations draw with
    // survived the narrowing. This is what stops the leak test being passable
    // by returning an empty object.
    assertEqual(safe!.connected, true, "connected survives");
    assertEqual(safe!.connectedAt, "2026-08-25T10:00:00.000Z", "connectedAt survives");
    assertEqual(safe!.readyToPost, true, "readyToPost survives");
    assertEqual(safe!.currency, "USD", "the currency survives");
    assertEqual(safe!.currencyVerified, true, "the verification flag survives");
    assertEqual(
      safe!.currencyCheckedAt,
      "2026-08-25T10:05:00.000Z",
      "the currency check date survives",
    );

    // `missing` is the one array that reaches an operator's screen verbatim.
    const withMissing = toAccountingStatus({
      ...POISON,
      readyToPost: false,
      missing: ["expense account", "USD verification", { accountId: "92" }, 99, null],
    });
    assertEqual(
      JSON.stringify(withMissing!.missing),
      JSON.stringify(["expense account", "USD verification"]),
      "missing keeps its plain-English items and drops anything that is not one",
    );
    assertEqual(withMissing!.readyToPost, false, "readyToPost tracks the real value");

    // A currency Fuel has not verified must not be dressed up as verified.
    const unverified = toAccountingStatus({
      connected: true,
      accountingCurrency: { currency: "GBP", source: null, checkedAt: null, verified: false },
    });
    assertEqual(unverified!.currency, "GBP", "an unverified currency is still reported");
    assertEqual(unverified!.currencyVerified, false, "but never as verified — ADR 0008");
    assertEqual(unverified!.readyToPost, false, "a missing readyToPost is false, not truthy");
    assertEqual(unverified!.connectedAt, null, "a missing date is null, not undefined");

    // Shapes that are not a status are refused outright rather than half-read.
    for (const bad of [null, undefined, 42, "connected", [], [{ connected: true }], {}, { connected: "yes" }]) {
      assertEqual(
        toAccountingStatus(bad),
        null,
        `a ${JSON.stringify(bad) ?? "nullish"} body is refused, not partially believed`,
      );
    }

    /*
     * The narrowing is applied at BOTH doors.
     *
     * A source check, because the alternative — booting Next and reading its
     * network traffic — belongs in qa-dashboard, which does exactly that. What
     * this proves is the property qa-dashboard cannot: that the proxy route,
     * which is what the browser actually refetches through, does not simply
     * pass the raw body along.
     */
    const routeSrc = withoutComments(
      readFileSync("dashboard/app/api/quickbooks/route.ts", "utf8"),
    );
    assert(
      routeSrc.includes("toAccountingStatus"),
      "the QuickBooks proxy narrows /status before answering the browser",
    );
    assert(
      /narrow:\s*"status"/.test(routeSrc),
      "and it narrows per allowlist entry, so a new endpoint cannot inherit the passthrough",
    );
    assert(
      routeSrc.includes("toAccountingActionResult"),
      "the action replies that also carry the connection object are narrowed too",
    );
    const pageSrc = withoutComments(readFileSync("dashboard/app/accounting/page.tsx", "utf8"));
    assert(
      !pageSrc.includes("realmId"),
      "/accounting renders no realm id",
    );
    assert(
      !/callQuickBooks\("\/status"\)/.test(pageSrc),
      "/accounting reads the status through the contract, not the raw passthrough",
    );
    assert(
      !/["'`](Sandbox|Production)["'`]/.test(pageSrc),
      "/accounting writes no environment name of its own",
    );
    const benchSrc = withoutComments(
      readFileSync("dashboard/components/AccountingWorkbench.tsx", "utf8"),
    );
    for (const field of [
      "realmId",
      "accessExpiresAt",
      "refreshExpiresAt",
      "expenseAccountId",
      "suspenseAccountId",
      "contraAccountId",
    ]) {
      assert(
        !benchSrc.includes(field),
        `AccountingWorkbench cannot render "${field}" — it does not name it`,
      );
    }
    // The contract is imported, not re-declared. A local copy of the interface
    // is how the previous version drifted wide enough to print a realm id.
    assert(
      /import\s*\{[^}]*AccountingStatus[^}]*\}\s*from\s*"@\/lib\/accounting-status"/.test(benchSrc),
      "AccountingWorkbench imports the contract rather than describing it again",
    );

    /*
     * IDEMPOTENCE. The contract is applied at two doors, so the browser's
     * refetch narrows a body the proxy has already narrowed — this function
     * runs on its own output as a matter of course, not as an edge case.
     *
     * The first version read the currency claim only from `accountingCurrency`,
     * the UPSTREAM spelling. A second pass over the flat contract shape found
     * nothing there and silently reset a verified USD company to "not verified
     * yet" after every post, account setup and disconnect. It degraded in the
     * safe direction, which is exactly why nobody would have noticed.
     */
    const onceNarrowed = toAccountingStatus(POISON);
    const twiceNarrowed = toAccountingStatus(onceNarrowed);
    assertEqual(
      JSON.stringify(twiceNarrowed),
      JSON.stringify(onceNarrowed),
      "narrowing an already-narrowed status changes nothing — the refetch path",
    );
    assertEqual(twiceNarrowed!.currency, "USD", "the currency survives a second pass");
    assertEqual(
      twiceNarrowed!.currencyVerified,
      true,
      "and so does its verification — this is the bug that shipped",
    );
    assertEqual(
      twiceNarrowed!.currencyCheckedAt,
      "2026-08-25T10:05:00.000Z",
      "and the date it was checked",
    );
    // Three passes, because "idempotent" is a property, not a coincidence.
    assertEqual(
      JSON.stringify(toAccountingStatus(twiceNarrowed)),
      JSON.stringify(onceNarrowed),
      "and a third pass is still the same object",
    );
    // Poison must not survive the flat path either: a second narrowing of a
    // body that carries BOTH shapes cannot be a way back in.
    const bothShapes = toAccountingStatus({ ...POISON, currency: "GBP", currencyVerified: true });
    assertEqual(
      bothShapes!.currency,
      "USD",
      "when both spellings are present the nested upstream one wins, not a smuggled flat field",
    );
    const flatOnly = toAccountingStatus({
      connected: true,
      readyToPost: true,
      missing: [],
      currency: "USD",
      currencyVerified: true,
      currencyCheckedAt: "2026-08-25T10:05:00.000Z",
      realmId: "9341457784003246",
      accessExpiresAt: "2026-08-27T11:00:00.000Z",
    });
    assertEqual(flatOnly!.currency, "USD", "a flat body is read");
    assertEqual(
      Object.keys(flatOnly!).sort().join(","),
      expectedKeys.join(","),
      "and narrowing it still drops everything forbidden",
    );
    assert(
      !JSON.stringify(flatOnly).includes("9341457784003246"),
      "including on the flat path — the realm id does not ride in that way either",
    );

    /*
     * A failed refetch must report "unknown", never a stale "Connected".
     *
     * The component used to keep its previous status when narrowing failed.
     * That left "Connected. Expense, suspense and contra accounts are set."
     * on screen after a Disconnect whose follow-up read did not come back.
     */
    assert(
      /setStatus\(s\.ok \? toAccountingStatus\(s\.body\) : null\)/.test(benchSrc),
      "a refetch that did not come back sets the status to unknown, not to what it was",
    );

    /*
     * The post-OAuth banner must agree with Fuel, not with the URL. Anyone can
     * open /accounting?connected=1; the parameter says where the operator came
     * from, and is not evidence that a connection exists.
     */
    assert(
      /\{connected && status\?\.connected &&/.test(pageSrc),
      "the connected banner is confirmed against the real status, not the query string alone",
    );

    // The contract module must stay pure, or the poison test above cannot run
    // and neither can the Client Component import it.
    /*
     * The ACTION contract.
     *
     * `presentQboStatus` is spread into three more replies besides `/status`
     * — `/setup-accounts`, `/verify-currency` and `PATCH /config` — and
     * `/setup-accounts` is a button an operator presses. Narrowing `/status`
     * alone left the realm id, both OAuth expiries and three account ids going
     * to the browser on every account setup. This is the regression test for
     * the door that was actually open.
     */
    const { toAccountingActionResult, ACCOUNTING_ACTION_KEYS } = await import(
      "../dashboard/lib/accounting-status.js"
    );

    // The real shape of a /setup-accounts reply: its own fields, then the raw
    // status object spread in behind them.
    const POISONED_ACTION = {
      quickBooksCompany: "Sandbox Company_US_1",
      homeCurrency: "USD",
      currencySource: "quickbooks_preferences",
      currencyCheckedAt: "2026-08-25T10:05:00.000Z",
      multiCurrencyEnabled: false,
      created: ["Agent API spend", "Suspense - Unconfirmed Agent Payments"],
      reused: ["Fuel balance"],
      ...POISON,
    };

    const safeAction = toAccountingActionResult(POISONED_ACTION);
    assert(safeAction !== null, "a well-formed action reply narrows");
    assertEqual(
      Object.keys(safeAction!).sort().join(","),
      [...ACCOUNTING_ACTION_KEYS].sort().join(","),
      "the action reply has EXACTLY the declared keys — no more, no fewer",
    );
    assertEqual(Object.keys(safeAction!).length, 12, "the action contract is twelve keys wide");

    const actionJson = JSON.stringify(safeAction);
    for (const leak of [
      "9341457784003246",
      "accessExpiresAt",
      "refreshExpiresAt",
      "accessToken",
      "refreshToken",
      "LEAKED",
      "clientId",
      "redirectUri",
      "intuit",
      "expenseAccountId",
      "suspenseAccountId",
      "contraAccountId",
      "contraAccountKind",
      "rollupGrain",
      "requestId",
      "lastRawResponse",
      "CompanyInfo",
      "someFieldInventedNextQuarter",
      "http",
      "realm",
      "config",
      // Its own extra fields that the UI does not read must not ride along.
      "multiCurrencyEnabled",
      "currencySource",
      "homeCurrency",
    ]) {
      assert(
        !actionJson.toLowerCase().includes(leak.toLowerCase()),
        `the action reply carries no "${leak}"`,
      );
    }
    for (const term of NO_CRYPTO) {
      assert(!actionJson.toLowerCase().includes(term), `the action reply says nothing about "${term}"`);
    }

    // The other direction: what the workbench actually draws with survived.
    assertEqual(safeAction!.quickBooksCompany, "Sandbox Company_US_1", "the company NAME survives");
    assertEqual(safeAction!.created.length, 2, "created account names survive");
    assertEqual(safeAction!.reused.length, 1, "reused account names survive");
    assertEqual(safeAction!.connected, true, "and the connection state behind them");
    assertEqual(safeAction!.currency, "USD", "and the currency");
    assertEqual(safeAction!.currencyVerified, true, "and its verification");

    // created/reused are NAMES. An id smuggled into those arrays as a number
    // or object must not be stringified into an operator's success message.
    const mixed = toAccountingActionResult({
      ...POISONED_ACTION,
      created: ["Agent API spend", 92, { id: "93" }, null],
      reused: [],
    });
    assertEqual(
      JSON.stringify(mixed!.created),
      JSON.stringify(["Agent API spend"]),
      "only string account names cross; anything else is dropped, not stringified",
    );

    // Idempotent, like the status contract — the same double-narrowing applies.
    assertEqual(
      JSON.stringify(toAccountingActionResult(safeAction)),
      JSON.stringify(safeAction),
      "narrowing an already-narrowed action reply changes nothing",
    );

    /*
     * EVERY allowlisted route states what happens to its body.
     *
     * The defect this replaces was not a wrong narrowing — it was a route
     * nobody had to think about. `narrow` is a required field on each entry,
     * so a new endpoint cannot be added without choosing, and "none" has to be
     * typed rather than fallen into.
     */
    const routeCode = withoutComments(
      readFileSync("dashboard/app/api/quickbooks/route.ts", "utf8"),
    );

    // Just the array literal, so the TYPE ANNOTATION above it — which also
    // reads `{ method: "GET" | "POST" | "PATCH"; ... }` — is not counted as a
    // fourteenth endpoint.
    const allowStart = routeCode.indexOf("= [", routeCode.indexOf("const ALLOWED"));
    const allowBody = routeCode.slice(allowStart, routeCode.indexOf("];", allowStart));
    const allowEntries = allowBody.split("{ method:").slice(1);
    assert(allowEntries.length >= 13, `allowlist parsed (${allowEntries.length} entries)`);
    for (const entry of allowEntries) {
      const pattern = entry.match(/pattern:\s*\/\^([^$]*)\$\//);
      const narrow = entry.match(/narrow:\s*"(status|action|none)"/);
      assert(
        narrow !== null,
        `every allowlist entry declares a narrowing (missing on: ${entry.slice(0, 60).trim()})`,
      );
      assert(pattern !== null, "every allowlist entry is an anchored pattern");
    }

    /*
     * The routes that answer with the raw connection object must be narrowed.
     *
     * Read out of src/api.ts rather than hardcoded here: a fifth route that
     * spreads presentQboStatus tomorrow fails this check instead of silently
     * handing the browser a realm id.
     */
    const apiCode = withoutComments(readFileSync("src/api.ts", "utf8"));
    const statusBearing = new Set<string>();
    for (const m of apiCode.matchAll(
      /api\.(?:get|post|patch)\(\s*"\/integrations\/quickbooks(\/[\w-]*)"([\s\S]{0,4000}?)\n\}\);/g,
    )) {
      if (m[2].includes("presentQboStatus")) statusBearing.add(m[1]);
    }
    assertEqual(
      statusBearing.size,
      4,
      `four routes answer with presentQboStatus (${[...statusBearing].sort().join(", ")})`,
    );
    for (const route of statusBearing) {
      const entry = allowEntries.find(
        (e) => (e.match(/pattern:\s*\/\^([^$]*)\$\//)?.[1] ?? "").replace(/\\/g, "") === route,
      );
      assert(entry !== undefined, `${route} is on the proxy allowlist`);
      const narrow = entry?.match(/narrow:\s*"(status|action|none)"/)?.[1];
      assert(
        narrow === "status" || narrow === "action",
        `${route} answers with the raw connection object, so the proxy must narrow it (got "${narrow}")`,
      );
    }

    // Comment-stripped: this file's own documentation NAMES the things it does
    // not do ("no `server-only` import"), and a check that fires on the prose
    // explaining it is one people learn to silence.
    const contractSrc = withoutComments(
      readFileSync("dashboard/lib/accounting-status.ts", "utf8"),
    );
    assert(!contractSrc.includes("server-only"), "the contract module is importable from a client");
    assert(!contractSrc.includes("fetch("), "the contract module does no I/O");
    assert(!contractSrc.includes("process.env"), "the contract module reads no configuration");
    /*
     * No spread in either PICKER. Scoped to the two functions rather than the
     * whole file: `ACCOUNTING_ACTION_KEYS` legitimately spreads the status key
     * LIST to stay in sync with it, and a file-wide ban would have to be
     * loosened to allow that — loosening it for the wrong reason is how the
     * real protection gets lost. What must never be spread is a body.
     */
    for (const fn of ["toAccountingStatus", "toAccountingActionResult"]) {
      const at = contractSrc.indexOf(`export function ${fn}`);
      assert(at !== -1, `${fn} is exported from the contract module`);
      const body = contractSrc.slice(at, contractSrc.indexOf("\n}", at));
      assert(!body.includes("..."), `${fn} spreads nothing — every key is picked by hand`);
    }

    console.log(`   ${checks} checks so far`);

    /* ---- the trace contract matches what the dashboard declares (6B-1) ---- */
    console.log("\n== the trace contract and the dashboard agree");
    {
      /*
       * THIS CHECK EXISTS BECAUSE ITS ABSENCE COST A NEAR-MISS.
       *
       * dashboard/components/AccountingWorkbench.tsx hand-declares TraceSource,
       * TraceLine and Trace.summary over a JSON fetch. Nothing links them to
       * this route: renaming a field here leaves the component reading
       * `undefined`, rendering blank cells, with no build error and no throw.
       * 6B-1 renamed four of them and only a grep found it.
       *
       * So the two are compared directly. Reading the component's source from a
       * backend suite is unusual, and it is the honest option: a contract
       * asserted in one place and consumed in another is not a contract until
       * something checks both ends.
       */
      const source = readFileSync("dashboard/components/AccountingWorkbench.tsx", "utf8");
      const declaredFields = (block: string): string[] => {
        const start = source.indexOf(block);
        if (start === -1) throw new Error(`FAILED: ${block} is gone from the dashboard`);
        const body = source.slice(start, source.indexOf("\n}", start));
        return [...body.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]!);
      };

      // Scoped to the company the operator key answers for. It was "the newest
      // draft anywhere", which held only while every draft in the copied
      // database belonged to that company; the alerting section's fixture
      // company has one too. The same fragility 58780d5 fixed in
      // verify-quickbooks.
      const draftRow = db
        .prepare("SELECT id FROM qbo_posting_drafts WHERE company_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(bootstrapCompany().id) as { id: string } | undefined;
      assert(draftRow !== undefined, "the scratch database has a draft to trace");

      const trace = await call(
        `/api/integrations/quickbooks/postings/${draftRow!.id}/trace`,
        OPERATOR_KEY,
      );
      assertEqual(trace.status, 200, "the trace route answers for a draft id");

      /*
       * EVERY DECLARED FIELD MUST BE PRESENT; EXTRAS ARE FINE.
       *
       * Written first as an equality and it failed immediately: the route sends
       * `day` and `ledgerClass`, which the component has simply never used.
       * That is not drift -- a response carrying more than a consumer reads is
       * how a contract stays forward-compatible. The failure that matters is the
       * other direction: a field the dashboard DECLARES and the route no longer
       * sends, which renders as a blank cell and nothing else.
       */
      const mustContain = (label: string, actual: object, declared: string[]): void => {
        const keys = Object.keys(actual);
        const missing = declared.filter((f) => !keys.includes(f));
        assertEqual(
          missing.join(","),
          "",
          `${label}: the dashboard declares [${missing}] and the route does not send them`,
        );
      };

      const declaredSummary = [...source.matchAll(/summary: \{([\s\S]*?)\n {2}\};/g)].flatMap(
        (m) => [...m[1]!.matchAll(/^\s{4}(\w+):/gm)].map((k) => k[1]!),
      );
      assert(declaredSummary.length > 0, "the dashboard declares a trace summary shape");
      mustContain("summary", trace.body.summary ?? {}, declaredSummary);

      const lineRow = trace.body.lines?.[0];
      assert(lineRow !== undefined, "the trace has at least one line to compare");
      mustContain("TraceLine", lineRow, declaredFields("interface TraceLine {"));

      const sourceRow = trace.body.lines?.flatMap((l: any) => l.sources ?? [])[0];
      assert(sourceRow !== undefined, "and at least one source beneath a line");
      mustContain("TraceSource", sourceRow, declaredFields("interface TraceSource {"));

      // The rename itself, pinned by name so a revert is a failure rather than
      // a silently blank column.
      for (const gone of ["vendor", "payments", "paymentId"]) {
        assert(
          !(gone in lineRow) && !(gone in sourceRow),
          `"${gone}" is gone from the trace contract, not merely unused`,
        );
      }

      /*
       * AND THE REQUEST SIDE, which the check above does not cover and which is
       * how a real break shipped.
       *
       * Everything above compares the component's declared RESPONSE types
       * against what the route sends. That is half a contract. The other half
       * is what the component SENDS, and nothing was looking at it: `direction`
       * became required on /preview, the component kept posting `{ day }`, and
       * the Preview button 400d on every click — with this suite green, because
       * a request body is not a type declaration.
       *
       * Grepping the source is crude and it is the honest option: the component
       * builds that body as an inline literal, so there is nothing to import
       * and assert against. Anything better means a shared contract module,
       * which is a bigger change than this slice.
       */
      const previewCall = /api\("\/preview"[\s\S]{0,200}?body:\s*\{([^{}]*)\}/.exec(source);
      assert(previewCall !== null, "the dashboard's preview call is still recognisable");
      // Field NAMES only: `direction: "spend"` yields ["direction"], not the
      // value, so this pins that the field is sent without pinning which
      // direction the spend workbench happens to ask for.
      const sentFields = [...previewCall![1]!.matchAll(/(\w+)\s*(?::|,|$)/g)].map((m) => m[1]!);
      for (const required of ["day", "direction"]) {
        assert(
          sentFields.includes(required),
          `the dashboard sends "${required}" to /preview, which the route requires ` +
            `(sends: ${sentFields.join(", ")})`,
        );
      }
    }

    /* ---- the preview contract gained a required field (6B-1) ------------- */
    console.log("\n== preview requires a direction");
    {
      // Checked BEFORE any config lookup, so these hold whatever state the
      // QuickBooks connection is in — which is what makes them cheap to assert
      // here rather than needing a connected company.
      //
      // REQUIRED WITH NO DEFAULT, deliberately. Defaulting to "spend" would let
      // every un-updated caller keep working while being unable to post revenue
      // at all: an integration that looks healthy and books half the money.
      const noDirection = await send("/api/integrations/quickbooks/preview", "POST", OPERATOR_KEY, {
        day: "2026-09-01",
      });
      assertEqual(noDirection.status, 400, "a preview with no direction is refused");
      assert(
        /direction is required/.test(noDirection.body.error ?? ""),
        `and the message says which field (got: ${noDirection.text})`,
      );

      const badDirection = await send("/api/integrations/quickbooks/preview", "POST", OPERATOR_KEY, {
        day: "2026-09-01",
        direction: "sideways",
      });
      assertEqual(badDirection.status, 400, "an unknown direction is refused too");
      assert(
        /spend, earn/.test(badDirection.body.error ?? ""),
        `and names the two that exist (got: ${badDirection.text})`,
      );

      // Not 400 for the direction's sake. Whatever this company's QuickBooks
      // state is, "direction was accepted" is the claim being made.
      const good = await send("/api/integrations/quickbooks/preview", "POST", OPERATOR_KEY, {
        day: "2026-09-01",
        direction: "earn",
      });
      assert(
        !/direction/.test(good.body.error ?? ""),
        `a valid direction gets past the field check (got: ${good.text})`,
      );
    }

    /* ---- which QuickBooks company, recorded and kept server-side (7A-3) --- */
    console.log("\n== realm ids are recorded, and stay out of drafts, postings and traces");
    {
      /*
       * THE RECORD IS SERVER-SIDE. A realm id identifies a customer's books at
       * Intuit (ADR 0010), and none of the posting surfaces needs one: they are
       * about documents, and a document's books are Fuel's business to check,
       * not the operator's to read.
       *
       * The STATUS route is deliberately not in this list. It has always
       * reported the connected realm to an operator-authenticated caller, and
       * the dashboard proxy narrows it away before a browser sees it (pinned
       * by the accounting-status allowlist above). That is existing, intended
       * behaviour; what this checks is that recording a realm on every artifact
       * did not leak it into the three surfaces that describe artifacts.
       */
      const companyId = bootstrapCompany().id;
      const realm = (
        db.prepare("SELECT realm_id FROM qbo_connections WHERE company_id = ?").get(companyId) as
          | { realm_id: string }
          | undefined
      )?.realm_id;
      assert(realm !== undefined, "the scratch database has a connected QuickBooks company");

      // POSITIVE CONTROL: the realm really is on the rows being presented, so
      // "the response does not contain it" is a statement about presentation,
      // not about there being nothing to leak.
      const stampedDraft = db
        .prepare("SELECT id FROM qbo_posting_drafts WHERE company_id = ? AND realm_id = ? LIMIT 1")
        .get(companyId, realm!) as { id: string } | undefined;
      const stampedPosting = db
        .prepare("SELECT id FROM qbo_postings WHERE company_id = ? AND realm_id = ? LIMIT 1")
        .get(companyId, realm!) as { id: string } | undefined;
      assert(stampedDraft !== undefined, "a draft in the scratch database carries the realm");
      assert(stampedPosting !== undefined, "and so does a posting");

      const surfaces: [string, string][] = [
        ["the drafts list", "/api/integrations/quickbooks/drafts"],
        ["the postings list", "/api/integrations/quickbooks/postings"],
        ["a draft's trace", `/api/integrations/quickbooks/postings/${stampedDraft!.id}/trace`],
        ["a posting's trace", `/api/integrations/quickbooks/postings/${stampedPosting!.id}/trace`],
      ];
      for (const [label, path] of surfaces) {
        const res = await send(path, "GET", OPERATOR_KEY);
        assertEqual(res.status, 200, `${label} answers`);
        assert(res.text.length > 50, `${label} has a body to search`);
        assert(!res.text.includes(realm!), `${label} names no realm id`);
        assert(!/realm/i.test(res.text), `${label} carries no realm field under any name`);
      }
    }

    console.log("\n== PATCH /config: a hand-typed account id is stamped with the books connected now");
    {
      /*
       * THE HAZARD IS THE IDS THE PATCH LEAVES ALONE. An operator who types an
       * expense account id read it in the books connected now, so that id may
       * carry the current stamp. The suspense and contra ids beside it may have
       * been read from different books; stamping the whole mapping with the
       * current realm would vouch for them, and the realm check at preview
       * would believe it.
       *
       * The books are "switched" by writing the connection row directly,
       * bypassing the connect route's guard. That is precisely the state the
       * stamp must stay honest through.
       */
      const companyId = bootstrapCompany().id;
      const connectionRow = db
        .prepare("SELECT * FROM qbo_connections WHERE company_id = ?")
        .get(companyId) as Record<string, string>;
      const configBefore = db
        .prepare("SELECT * FROM qbo_config WHERE company_id = ?")
        .get(companyId) as Record<string, string | null>;
      const realm = connectionRow.realm_id!;
      const stampNow = () =>
        (db.prepare("SELECT * FROM qbo_config WHERE company_id = ?").get(companyId) as Record<
          string,
          string | null
        >);
      const patch = (body: Record<string, unknown>) =>
        send("/api/integrations/quickbooks/config", "PATCH", OPERATOR_KEY, body);

      try {
        assertEqual(stampNow().accounts_realm_id, realm, "the mapping starts stamped with the connected books");

        // 1. Same books: an edit is accepted and the stamp is the current realm.
        const same = await patch({ expenseAccountId: configBefore.expense_account_id });
        assertEqual(same.status, 200, "an account id patched in the books it was read from is accepted");
        assertEqual(stampNow().accounts_realm_id, realm, "and the stamp is the connected books");

        // 2. Switched books, partial patch: refused, nothing written.
        db.prepare("UPDATE qbo_connections SET realm_id = 'verify-other-books' WHERE company_id = ?").run(
          companyId,
        );
        const partial = await patch({ expenseAccountId: "63" });
        assertEqual(
          partial.status,
          409,
          "after the books change, a patch that leaves old account ids standing is refused",
        );
        assert(
          /Run account setup again/.test(partial.body.error ?? ""),
          `and says how to get out (got: ${partial.text})`,
        );
        assert(
          !partial.text.includes("verify-other-books") && !partial.text.includes(realm),
          "and names neither set of books",
        );
        assertEqual(stampNow().expense_account_id, configBefore.expense_account_id, "nothing was written");
        assertEqual(stampNow().accounts_realm_id, realm, "and the old stamp still describes the old ids");

        // 3. Switched books, a patch that leaves nothing old standing: accepted,
        // stamped with the NEW books. Revenue is not patchable, so it is cleared
        // here the way a company that never set it up would have it.
        db.prepare("UPDATE qbo_config SET revenue_account_id = NULL WHERE company_id = ?").run(companyId);
        const whole = await patch({ expenseAccountId: "63", suspenseAccountId: "91", contraAccountId: "35" });
        assertEqual(whole.status, 200, "a patch that replaces every account id is accepted after a switch");
        assertEqual(
          stampNow().accounts_realm_id,
          "verify-other-books",
          "and is stamped with the books connected now",
        );

        // 4. A patch touching no account id leaves the stamp alone, even when it
        // disagrees with the connection: it changes nothing the stamp speaks for.
        db.prepare("UPDATE qbo_connections SET realm_id = ? WHERE company_id = ?").run(realm, companyId);
        const grainOnly = await patch({ rollupGrain: stampNow().rollup_grain });
        assertEqual(grainOnly.status, 200, "a grain-only patch is accepted");
        assertEqual(
          stampNow().accounts_realm_id,
          "verify-other-books",
          "and does not restamp account ids it never touched",
        );

        // 5. No connection at all: an account id cannot be said to belong anywhere.
        db.prepare("DELETE FROM qbo_connections WHERE company_id = ?").run(companyId);
        const unconnected = await patch({ expenseAccountId: "63" });
        assertEqual(unconnected.status, 409, "account ids cannot be set with no QuickBooks company connected");

        /*
         * 6. ACCOUNT SETUP, WITH THE BOOKS MOVING UNDER IT. The route saves four
         * ids and one stamp; if the connection moves after the first account
         * lookup, the rest must be refused and NOTHING saved -- not the ids
         * read so far, and not a stamp. Intuit is stubbed; requests to this
         * suite's own server pass through to the real fetch.
         */
        const { saveConnection: connectForTest } = await import("../src/db/qbo.js");
        connectForTest({
          companyId,
          realmId: realm,
          accessToken: "not-a-real-access-token",
          accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          refreshToken: "not-a-real-refresh-token",
          refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
        const beforeSetup = stampNow();
        const passThrough = globalThis.fetch;
        const intuitRealms: string[] = [];
        let accountQueries = 0;
        globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.hostname === "127.0.0.1") return passThrough(input as string, init);
          intuitRealms.push(decodeURIComponent(url.pathname.split("/")[3] ?? ""));
          const json = (body: unknown) =>
            new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
          const query = url.searchParams.get("query") ?? "";
          if (/FROM Preferences/.test(query)) {
            return json({ QueryResponse: { Preferences: [{ CurrencyPrefs: { HomeCurrency: { value: "USD" } } }] } });
          }
          if (/FROM Account/.test(query)) {
            accountQueries += 1;
            // The books move while the first account lookup is in flight.
            if (accountQueries === 1) {
              db.prepare("UPDATE qbo_connections SET realm_id = 'verify-moved-books' WHERE company_id = ?").run(
                companyId,
              );
            }
            return json({ QueryResponse: { Account: [{ Id: "63", Name: "x" }] } });
          }
          return json({ CompanyInfo: { CompanyName: "Scratch Co", Country: "US" } });
        }) as typeof fetch;
        let moved: Awaited<ReturnType<typeof send>>;
        try {
          moved = await send("/api/integrations/quickbooks/setup-accounts", "POST", OPERATOR_KEY, {});
        } finally {
          globalThis.fetch = passThrough;
        }
        assertEqual(moved.status, 409, "account setup refuses once the books move under it");
        assert(
          !moved.text.includes("verify-moved-books") && !moved.text.includes(realm),
          "and the refusal names neither set of books",
        );
        assertEqual(accountQueries, 1, "no account lookup was sent after the move");
        assert(
          intuitRealms.every((r) => r === realm),
          `every request that did go was addressed to the original books (got: ${intuitRealms.join(",")})`,
        );
        for (const column of [
          "expense_account_id",
          "suspense_account_id",
          "contra_account_id",
          "revenue_account_id",
          "accounts_realm_id",
        ]) {
          assertEqual(stampNow()[column], beforeSetup[column], `a refused setup saved nothing: ${column} unchanged`);
        }
      } finally {
        db.prepare("DELETE FROM qbo_connections WHERE company_id = ?").run(companyId);
        const cols = Object.keys(connectionRow);
        db.prepare(
          `INSERT INTO qbo_connections (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        ).run(...(cols.map((c) => connectionRow[c]) as never[]));
        const configCols = Object.keys(configBefore).filter((c) => c !== "company_id");
        db.prepare(
          `UPDATE qbo_config SET ${configCols.map((c) => `${c} = ?`).join(", ")} WHERE company_id = ?`,
        ).run(...(configCols.map((c) => configBefore[c]) as never[]), companyId);
      }
      assertEqual(stampNow().accounts_realm_id, realm, "the fixture is restored");
    }

    console.log("\n== writing off a posting whose books are gone: owners only (7A-3 item 3)");
    {
      /*
       * The function-level behaviour (QuickBooks tried first, lines held, the
       * guard lifted) lives in verify-quickbooks. These are what only the route
       * can show: WHO may do it, what they must supply, what the reply and the
       * postings list say afterwards -- and to whom.
       *
       * Intuit is stubbed and always unavailable here, so a write-off that gets
       * past validation goes through. Requests to this suite's own server pass
       * through to the real fetch.
       */
      const companyId = bootstrapCompany().id;
      const connectionRow = db
        .prepare("SELECT * FROM qbo_connections WHERE company_id = ?")
        .get(companyId) as Record<string, string>;
      const realm = connectionRow.realm_id!;
      const { saveConnection: connectForTest } = await import("../src/db/qbo.js");
      connectForTest({
        companyId,
        realmId: realm,
        accessToken: "not-a-real-access-token",
        accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        refreshToken: "not-a-real-refresh-token",
        refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

      const PASSWORD = "correct-horse-battery-staple";
      const OWNER_EMAIL = `wo-owner-${randomUUID()}@example.com`;
      const OPERATOR_EMAIL = `wo-operator-${randomUUID()}@example.com`;
      for (const [email, role] of [[OWNER_EMAIL, "owner"], [OPERATOR_EMAIL, "operator"]] as const) {
        createUser({ companyId, email, passwordHash: await hashPassword(PASSWORD), role });
      }
      resetLoginLimits();
      const signIn = async (email: string) => {
        const res = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ company: handleFor(companyId), email, password: PASSWORD }),
        });
        const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`));
        if (res.status !== 200 || !line) throw new Error(`FAILED: ${email} could not sign in (${res.status})`);
        return line.split(";")[0]!;
      };
      const ownerCookie = await signIn(OWNER_EMAIL);
      const operatorCookie = await signIn(OPERATOR_EMAIL);
      const as = async (
        path: string,
        method: string,
        who: { cookie?: string; key?: string; origin?: string },
        body?: unknown,
      ) => {
        const headers: Record<string, string> = {};
        if (who.key) headers.Authorization = `Bearer ${who.key}`;
        if (who.cookie) headers.Cookie = who.cookie;
        if (who.origin) headers.Origin = who.origin;
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const res = await fetch(`${base}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await res.text();
        let parsed: any = {};
        try {
          parsed = JSON.parse(text);
        } catch {
          /* a non-JSON body is itself a finding */
        }
        return { status: res.status, body: parsed, text };
      };

      // A pending posting in the connected books, and a posted one.
      const now = new Date().toISOString();
      const seed = (id: string, status: "pending" | "posted", company = companyId) => {
        db.prepare(
          `INSERT INTO qbo_posting_drafts (id, company_id, direction, grain, posting_day, counterparty, doc_number,
                                           payload_json, payload_hash, source_fingerprint, status, created_at, realm_id)
           VALUES (?, ?, 'spend', 'daily', '2019-12-30', NULL, ?, '{}', 'h', 'f', 'posted', ?, ?)`,
        ).run(`draft-${id}`, company, `FUEL-${id.slice(-10)}`, now, realm);
        db.prepare(
          `INSERT INTO qbo_postings (id, company_id, draft_id, doc_number, request_id, status, created_at, realm_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, company, `draft-${id}`, `FUEL-${id.slice(-10)}`, `req-${id}`, status, now, realm);
        return `FUEL-${id.slice(-10)}`;
      };
      const pendingId = `wo-pending-${randomUUID()}`;
      const postedId = `wo-posted-${randomUUID()}`;
      const foreignId = `wo-foreign-${randomUUID()}`;
      const foreignCompany = randomUUID();
      const pendingDoc = seed(pendingId, "pending");
      seed(postedId, "posted");
      db.prepare(
        "INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES (?, 'Write-off other', 1000000, ?)",
      ).run(foreignCompany, now);
      const foreignDoc = seed(foreignId, "pending", foreignCompany);

      const passThrough = globalThis.fetch;
      let intuitRequests = 0;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === "127.0.0.1") return passThrough(input as string, init);
        intuitRequests += 1;
        return new Response(JSON.stringify({ Fault: { Error: [{ Message: "Service unavailable" }] } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const abandon = (id: string, who: { cookie?: string; key?: string; origin?: string }, body: unknown) =>
        as(`/api/integrations/quickbooks/postings/${id}/abandon`, "POST", who, body);
      const good = { reason: "The old QuickBooks company was cancelled.", confirmDocNumber: pendingDoc };
      const pendingRow = () =>
        db.prepare("SELECT status, abandoned_at, abandoned_by, abandon_reason FROM qbo_postings WHERE id = ?").get(
          pendingId,
        ) as { status: string; abandoned_at: string | null; abandoned_by: string | null; abandon_reason: string | null };

      try {
        // --- who may ------------------------------------------------------
        const byKey = await abandon(pendingId, { key: OPERATOR_KEY }, good);
        assertEqual(byKey.status, 403, "a shared key cannot write a posting off -- it names nobody");
        const byOperator = await abandon(pendingId, { cookie: operatorCookie }, good);
        assertEqual(byOperator.status, 403, "a signed-in operator cannot write a posting off -- it needs an owner");
        const crossOrigin = await abandon(pendingId, { cookie: ownerCookie, origin: "http://evil.test" }, good);
        assertEqual(crossOrigin.status, 403, "an owner's session from another origin is refused");
        assertEqual(pendingRow().abandoned_at, null, "none of those wrote anything");
        assertEqual(intuitRequests, 0, "and none of them asked QuickBooks anything");

        // --- what the owner must supply ------------------------------------
        const noReason = await abandon(pendingId, { cookie: ownerCookie }, { confirmDocNumber: pendingDoc });
        assertEqual(noReason.status, 400, "a write-off with no reason is refused");
        const shortReason = await abandon(pendingId, { cookie: ownerCookie }, { reason: "gone", confirmDocNumber: pendingDoc });
        assertEqual(shortReason.status, 400, "a write-off with a token reason is refused");
        const wrongDoc = await abandon(pendingId, { cookie: ownerCookie }, { ...good, confirmDocNumber: "FUEL-wrong" });
        assertEqual(wrongDoc.status, 400, "a write-off whose typed document number does not match is refused");
        const noDoc = await abandon(pendingId, { cookie: ownerCookie }, { reason: good.reason });
        assertEqual(noDoc.status, 400, "a write-off with no typed document number is refused");
        const foreign = await abandon(foreignId, { cookie: ownerCookie }, { ...good, confirmDocNumber: foreignDoc });
        assertEqual(foreign.status, 404, "another company's posting cannot be written off -- it does not exist here");
        const onPosted = await abandon(postedId, { cookie: ownerCookie }, { ...good, confirmDocNumber: `FUEL-${postedId.slice(-10)}` });
        assertEqual(onPosted.status, 409, "a posted posting cannot be written off");
        assertEqual(pendingRow().abandoned_at, null, "none of those wrote anything either");
        assertEqual(intuitRequests, 0, "and none of them asked QuickBooks anything");

        // --- the owner writes it off ---------------------------------------
        const done = await abandon(pendingId, { cookie: ownerCookie }, good);
        assertEqual(done.status, 200, "an owner can write off a pending posting QuickBooks cannot answer for");
        assert(intuitRequests > 0, "QuickBooks was tried first");
        assertEqual(done.body.status, "pending", "the posting is still pending -- the outcome is still unknown");
        assertEqual(done.body.abandonedBy, OWNER_EMAIL, "the reply names the owner who wrote it off");
        assertEqual(done.body.abandonReason, good.reason, "and carries their reason");
        assert(typeof done.body.abandonedAt === "string", "and when");
        assert(!done.text.includes(realm), "and names no realm");
        assert(
          !/Service unavailable/.test(done.text) && !("abandonEvidence" in done.body),
          "and does not pass Intuit's error text back out as evidence",
        );

        const again = await abandon(pendingId, { cookie: ownerCookie }, good);
        assertEqual(again.status, 409, "it cannot be written off twice");

        // --- what the postings list says, and to whom ----------------------
        const listed = await as("/api/integrations/quickbooks/postings", "GET", { cookie: ownerCookie });
        const inList = (listed.body.postings as any[]).find((p) => p.postingId === pendingId);
        assert(inList !== undefined, "a written-off posting is still in the postings list");
        assertEqual(inList?.abandonedBy, OWNER_EMAIL, "and a signed-in reader is told who wrote it off");
        assert(
          !(listed.body.needsReconciliation as any[]).some((p) => p.postingId === pendingId),
          "but it is NOT in needs-reconciliation: nobody can reconcile it",
        );
        const byKeyList = await as("/api/integrations/quickbooks/postings", "GET", { key: OPERATOR_KEY });
        const keyView = (byKeyList.body.postings as any[]).find((p) => p.postingId === pendingId);
        assertEqual(keyView?.abandonedBy, null, "a shared key is NOT told who wrote it off");
        assertEqual(keyView?.abandonReason, good.reason, "though it can read the reason");
        assertEqual(pendingRow().status, "pending", "and in the database it is still pending");
      } finally {
        globalThis.fetch = passThrough;
        db.prepare("DELETE FROM qbo_postings WHERE id IN (?, ?, ?)").run(pendingId, postedId, foreignId);
        db.prepare("DELETE FROM qbo_posting_drafts WHERE id IN (?, ?, ?)").run(
          `draft-${pendingId}`,
          `draft-${postedId}`,
          `draft-${foreignId}`,
        );
        db.prepare("DELETE FROM companies WHERE id = ?").run(foreignCompany);
        db.prepare("DELETE FROM qbo_connections WHERE company_id = ?").run(companyId);
        const cols = Object.keys(connectionRow);
        db.prepare(
          `INSERT INTO qbo_connections (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        ).run(...(cols.map((c) => connectionRow[c]) as never[]));
      }
    }

    console.log("\n== the dashboard offers a write-off to owners only, and sends what the route needs");
    {
      /*
       * SOURCE ASSERTIONS, AND WHY THAT IS THE LIMIT HERE. The page and the
       * workbench import through the `@/` alias, which this suite cannot
       * resolve, so they cannot be rendered from here -- the same documented
       * limit as the signup route handlers. What IS asserted is the wiring the
       * API checks above depend on. The button is a display choice; the API's
       * requireOwner is the protection, and it is tested over HTTP above.
       */
      const proxy = withoutComments(readFileSync("dashboard/app/api/quickbooks/route.ts", "utf8"));
      assert(
        /pattern:\s*\/\^\\\/postings\\\/\[\\w-\]\+\\\/abandon\$\/,\s*narrow:\s*"none"/.test(proxy),
        "the dashboard proxy relays POST /postings/:id/abandon, narrowed to none",
      );

      const page = withoutComments(readFileSync("dashboard/app/accounting/page.tsx", "utf8"));
      assert(
        /const isOwner = viewer\?\.role === "owner";/.test(page),
        "the accounting page decides isOwner from the signed-in viewer's own role",
      );
      assert(/isOwner=\{isOwner\}/.test(page), "and passes it to the workbench");

      const bench = withoutComments(readFileSync("dashboard/components/AccountingWorkbench.tsx", "utf8"));
      assert(
        /const canWriteOff = isOwner && p\.status === "pending" && !writtenOff;/.test(bench),
        "the write-off is offered only to an owner, only on a pending posting not already written off",
      );
      const buttonAt = bench.indexOf("Write off…");
      assert(buttonAt !== -1, "the workbench has a Write off button");
      assert(
        /\{canWriteOff && !panelOpen && \(\s*<button/.test(bench) && /\{canWriteOff && panelOpen && \(/.test(bench),
        "and both the button and its panel render only under canWriteOff",
      );
      assert(
        /api\(`\/postings\/\$\{p\.postingId\}\/abandon`,\s*\{[\s\S]{0,80}body:\s*\{\s*reason:[^}]*confirmDocNumber:/.test(bench),
        "the confirm step sends both reason and confirmDocNumber, which the route requires",
      );
      assert(
        /writtenOff\s*\?\s*"written off, outcome unknown"/.test(bench),
        "a written-off posting is labelled as written off, not as needing reconciliation",
      );
    }

    console.log("\n== the routes refuse the wrong books: reconcile, status, setup (7A-3)");
    {
      /*
       * The function-level refusals live in verify-quickbooks. These are the
       * three things only a route can show: the HTTP status and message an
       * operator gets, that status stops claiming readiness it does not have,
       * and that account setup's CURRENCY read is pinned too.
       *
       * Intuit is stubbed throughout; requests to this suite's own server pass
       * through. The connection is replaced with one holding obvious fake
       * tokens that do not expire, so no path here can refresh anything real.
       */
      const companyId = bootstrapCompany().id;
      const connectionRow = db
        .prepare("SELECT * FROM qbo_connections WHERE company_id = ?")
        .get(companyId) as Record<string, string>;
      const configBefore = db
        .prepare("SELECT * FROM qbo_config WHERE company_id = ?")
        .get(companyId) as Record<string, string | null>;
      const realm = connectionRow.realm_id!;
      const { saveConnection: connectForTest } = await import("../src/db/qbo.js");
      connectForTest({
        companyId,
        realmId: realm,
        accessToken: "not-a-real-access-token",
        accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        refreshToken: "not-a-real-refresh-token",
        refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const moveBooks = (to: string) =>
        db.prepare("UPDATE qbo_connections SET realm_id = ? WHERE company_id = ?").run(to, companyId);

      const passThrough = globalThis.fetch;
      let intuit: string[] = [];
      /** Moves the books while the Nth Preferences read of a request is in flight. */
      let moveOnPreferences = 0;
      let preferencesSeen = 0;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === "127.0.0.1") return passThrough(input as string, init);
        const query = url.searchParams.get("query") ?? "";
        intuit.push(`${url.pathname} ${query}`);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        if (/FROM Preferences/.test(query)) {
          preferencesSeen += 1;
          if (preferencesSeen === moveOnPreferences) moveBooks("verify-moved-books");
          return json({ QueryResponse: { Preferences: [{ CurrencyPrefs: { HomeCurrency: { value: "USD" } } }] } });
        }
        if (/FROM JournalEntry/.test(query)) return json({ QueryResponse: {} });
        if (/FROM Account/.test(query)) return json({ QueryResponse: { Account: [{ Id: "63", Name: "x" }] } });
        return json({ CompanyInfo: { CompanyName: "Scratch Co", Country: "US" } });
      }) as typeof fetch;

      const draftId = `verify-realm-draft-${randomUUID()}`;
      const postingId = `verify-realm-posting-${randomUUID()}`;
      try {
        // --- reconcile ------------------------------------------------------
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO qbo_posting_drafts (id, company_id, direction, grain, posting_day, counterparty, doc_number,
                                           payload_json, payload_hash, source_fingerprint, status, created_at, realm_id)
           VALUES (?, ?, 'spend', 'daily', '2019-11-12', NULL, ?, '{}', 'h', 'f', 'previewed', ?, ?)`,
        ).run(draftId, companyId, `FUEL-verify-${postingId.slice(-8)}`, now, realm);
        db.prepare(
          `INSERT INTO qbo_postings (id, company_id, draft_id, doc_number, request_id, status, created_at, realm_id)
           VALUES (?, ?, ?, ?, 'req-verify-realm', 'pending', ?, ?)`,
        ).run(postingId, companyId, draftId, `FUEL-verify-${postingId.slice(-8)}`, now, realm);

        moveBooks("verify-moved-books");
        intuit = [];
        const reconcile = await send(
          `/api/integrations/quickbooks/postings/${postingId}/reconcile`,
          "POST",
          OPERATOR_KEY,
          {},
        );
        assertEqual(reconcile.status, 409, "reconciling a pending posting after the books change is a 409");
        assert(
          /Reconnect the QuickBooks company it was made in/.test(reconcile.body.error ?? ""),
          `and tells the operator what would resolve it (got: ${reconcile.text})`,
        );
        assert(
          !reconcile.text.includes(realm) && !reconcile.text.includes("verify-moved-books"),
          "and names neither set of books",
        );
        assertEqual(intuit.length, 0, "and nothing was asked of QuickBooks");
        assertEqual(
          (db.prepare("SELECT status FROM qbo_postings WHERE id = ?").get(postingId) as { status: string }).status,
          "pending",
          "and the posting is still pending -- never failed on the wrong books' answer",
        );

        // --- status ---------------------------------------------------------
        const ACCOUNT_SETUP = "account setup for the connected QuickBooks company";
        const movedStatus = await send("/api/integrations/quickbooks/status", "GET", OPERATOR_KEY);
        assertEqual(movedStatus.status, 200, "status answers after the books move");
        assertEqual(
          movedStatus.body.readyToPost,
          false,
          "status does not claim ready while the account ids belong to other books",
        );
        assert(
          (movedStatus.body.missing as string[]).includes(ACCOUNT_SETUP),
          `and says what is missing (got: ${JSON.stringify(movedStatus.body.missing)})`,
        );
        moveBooks(realm);
        const backStatus = await send("/api/integrations/quickbooks/status", "GET", OPERATOR_KEY);
        assert(
          !(backStatus.body.missing as string[]).includes(ACCOUNT_SETUP),
          "and stops saying so once the right books are connected again",
        );

        // --- setup: one set of books from the currency read onwards -----------
        // The books move while setup is reading the currency. That reading was
        // pinned and is a true reading of the ORIGINAL books; what must not
        // happen is setup carrying on and saving ids against the new ones.
        // (The currency record itself carries no stamp -- recorded as a known
        // residual; post re-reads it, pinned to the draft's books, before any
        // JournalEntry, so it cannot carry a send to the wrong books.)
        const accountsBefore = db
          .prepare(
            `SELECT expense_account_id, suspense_account_id, contra_account_id, revenue_account_id,
                    accounts_realm_id FROM qbo_config WHERE company_id = ?`,
          )
          .get(companyId);
        //
        // Twice: moving during the FIRST Preferences read (the currency check)
        // and during the SECOND (the company profile the reply names). Each is
        // caught by a different pin -- the profile's, then the accounts' --
        // and a test of only one would let the other go unexercised.
        for (const [nth, when] of [
          [1, "during its currency read"],
          [2, "after it read the company profile"],
        ] as const) {
          moveBooks(realm);
          preferencesSeen = 0;
          moveOnPreferences = nth;
          intuit = [];
          const setup = await send("/api/integrations/quickbooks/setup-accounts", "POST", OPERATOR_KEY, {});
          moveOnPreferences = 0;
          assertEqual(setup.status, 409, `account setup refuses when the books move ${when}`);
          assert(
            !intuit.some((r) => /FROM Account/.test(r)),
            `and never went on to look up accounts when the books moved ${when}`,
          );
          assertEqual(
            JSON.stringify(
              db
                .prepare(
                  `SELECT expense_account_id, suspense_account_id, contra_account_id, revenue_account_id,
                          accounts_realm_id FROM qbo_config WHERE company_id = ?`,
                )
                .get(companyId),
            ),
            JSON.stringify(accountsBefore),
            `and saved no account id and no stamp when the books moved ${when}`,
          );
        }
      } finally {
        globalThis.fetch = passThrough;
        db.prepare("DELETE FROM qbo_postings WHERE id = ?").run(postingId);
        db.prepare("DELETE FROM qbo_posting_drafts WHERE id = ?").run(draftId);
        db.prepare("DELETE FROM qbo_connections WHERE company_id = ?").run(companyId);
        const cols = Object.keys(connectionRow);
        db.prepare(
          `INSERT INTO qbo_connections (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        ).run(...(cols.map((c) => connectionRow[c]) as never[]));
        const configCols = Object.keys(configBefore).filter((c) => c !== "company_id");
        db.prepare(
          `UPDATE qbo_config SET ${configCols.map((c) => `${c} = ?`).join(", ")} WHERE company_id = ?`,
        ).run(...(configCols.map((c) => configBefore[c]) as never[]), companyId);
      }
    }

    console.log("\n== quickbooks oauth callback");

    /*
     * The one route in Fuel with NO AUTHENTICATION, and until this slice the
     * one route no suite could drive: it lived inline in src/server.ts, which
     * calls listen() at import time, so importing it to test it started a
     * server. Extracting the handler is what made these checks possible.
     *
     * NOTHING REAL IS REACHED. `fetch` is stubbed for the duration, so no
     * request goes to Intuit, no token is exchanged with anyone, and no
     * QuickBooks document is created — the callback has no code path that
     * could create one, which is asserted below rather than assumed.
     */
    const { quickBooksCallback, CONNECTED_REDIRECT_PATH } = await import(
      "../src/quickbooks/callback.js"
    );
    const { createOAuthState, getConnection, saveConnection } = await import("../src/db/qbo.js");

    const callbackApp = express();
    callbackApp.get("/integrations/quickbooks/callback", quickBooksCallback);
    const callbackServer = callbackApp.listen(0, "127.0.0.1");
    await new Promise((resolve) => callbackServer.once("listening", resolve));
    const callbackBase = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}`;

    // The test client must keep the REAL fetch: the stub below replaces the
    // global one, and a client using it would be answering its own requests.
    const liveFetch = globalThis.fetch;
    // `cookie` is the browser's session, as Intuit's redirect would carry it:
    // the callback now asks who brought the code back (7A-3 item 4).
    const hit = (query: string, cookie?: string) =>
      liveFetch(`${callbackBase}/integrations/quickbooks/callback${query}`, {
        redirect: "manual",
        ...(cookie ? { headers: { Cookie: cookie } } : {}),
      });

    /*
     * PEOPLE, NOT COMPANIES, START A CONNECTION. Every state in this section is
     * minted by a real user with a real session, and the callback is hit
     * carrying that session, the way the browser that pressed Connect would.
     * Sessions are minted directly rather than through /login: the global fetch
     * is Intuit's stub for most of this section.
     */
    const { createSession, revokeSessionsForUser } = await import("../src/db/sessions.js");
    type Person = { userId: string; companyId: string; email: string; cookie: string };
    const newPerson = async (forCompany: string, role: "owner" | "operator" = "owner"): Promise<Person> => {
      const email = `cb-${role}-${randomUUID()}@example.com`;
      const user = createUser({
        companyId: forCompany,
        email,
        passwordHash: await hashPassword("correct-horse-battery-staple"),
        role,
      });
      return { userId: user.id, companyId: forCompany, email, cookie: `${SESSION_COOKIE}=${createSession(user.id).token}` };
    };
    const people = new Map<string, Person>();
    const personFor = async (forCompany: string): Promise<Person> => {
      let person = people.get(forCompany);
      if (!person) {
        person = await newPerson(forCompany);
        people.set(forCompany, person);
      }
      return person;
    };
    /** A connect link started by `who`, as POST /connect would mint it. */
    const startedBy = (who: Person): string => {
      const st = randomUUID();
      createOAuthState({ state: st, companyId: who.companyId, userId: who.userId });
      return st;
    };

    // Test-only OAuth configuration. Set here rather than read from .env so
    // this suite never touches a real Intuit client, and so it runs the same
    // way on a machine that has never been connected.
    process.env.QBO_CLIENT_ID ??= "test-client-id";
    process.env.QBO_CLIENT_SECRET ??= "test-client-secret";
    process.env.QBO_REDIRECT_URI ??= "http://localhost:3000/integrations/quickbooks/callback";

    const REALM = "9341457784003246";
    const companyId = bootstrapCompany().id;
    let tokenExchanges = 0;
    let intuitUrls: string[] = [];
    // Runs inside the stubbed token exchange, to put a competing write in the
    // window between the callback's check and its save.
    let duringExchange: (() => void) | null = null;

    /*
     * A STUB THAT BEHAVES LIKE INTUIT DID, LIVE, ON 2026-09-23 (7A-3 item 4).
     *
     * Every authorization code grants ONE realm, written into the code:
     * `own-<realm>`. The token response carries an ID token whose `realmid` is
     * that realm -- taken from the code, never from the callback's query, or
     * the stub would be agreeing with whatever it was asked.
     *
     * `companyinfo` answers the way Intuit was measured to: 200 for the granted
     * realm, AND 200 for any other realm the same Intuit user can reach
     * (`sameIntuitUser`), with the GRANTED company's data -- then 401 for a
     * realm nobody on the account owns. The previous stub refused every realm
     * but the granted one; that was the assumption the live probe disproved,
     * and a stub that kept it would pass a callback that trusted the read.
     *
     * Variant prefixes shape the ID token for the refusal tests: `noid-`,
     * `badparts-`, `badb64-`, `badjson-`, `norealm-`, `iss-`, `aud-`, `exp-`.
     * `flaky-` makes the companyinfo read fail (503).
     */
    let companyInfoReads: string[] = [];
    const sameIntuitUser = new Set<string>();
    const grantOf = (code: string) => {
      const dash = code.indexOf("-");
      return dash === -1 ? { kind: code, realm: "" } : { kind: code.slice(0, dash), realm: code.slice(dash + 1) };
    };
    const b64 = (value: unknown) =>
      Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
    const idTokenFor = (code: string): string | undefined => {
      const { kind, realm } = grantOf(code);
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: "https://oauth.platform.intuit.com/op/v1",
        aud: [process.env.QBO_CLIENT_ID],
        sub: "stub-intuit-user",
        realmid: realm,
        iat: now,
        exp: now + 3600,
      };
      const header = b64({ alg: "RS256", kid: "stub", typ: "JWT" });
      switch (kind) {
        case "noid":
          return undefined;
        case "badparts":
          return `${header}.${b64(claims)}`;
        case "badb64":
          return `${header}.@@not-base64@@.sig`;
        case "badjson":
          return `${header}.${b64("this is not json")}.sig`;
        case "norealm":
          delete claims.realmid;
          break;
        case "iss":
          claims.iss = "https://attacker.example/op/v1";
          break;
        case "aud":
          claims.aud = ["some-other-client"];
          break;
        case "exp":
          claims.exp = now - 60;
          break;
      }
      return `${header}.${b64(claims)}.stub-signature`;
    };
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(
        typeof input === "string" ? input : (input as Request)?.url ?? input,
      );
      intuitUrls.push(url);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

      const info = /\/v3\/company\/([^/]+)\/companyinfo\/([^/?]+)/.exec(url);
      if (info) {
        companyInfoReads.push(url);
        const auth = new Headers(init?.headers).get("Authorization") ?? "";
        const { kind, realm: granted } = grantOf(auth.replace(/^Bearer tok:/, ""));
        const named = decodeURIComponent(info[2]!);
        if (kind === "flaky") return json(503, {});
        return named === granted || (sameIntuitUser.has(named) && sameIntuitUser.has(granted))
          ? json(200, { CompanyInfo: { CompanyName: `Books ${granted}` } })
          : json(401, { fault: "AuthorizationFault" });
      }

      tokenExchanges += 1;
      duringExchange?.();
      const code = new URLSearchParams(String(init?.body ?? "")).get("code") ?? "";
      const idToken = idTokenFor(code);
      return json(200, {
        access_token: `tok:${code}`,
        refresh_token: "stub-refresh-token",
        expires_in: 3600,
        x_refresh_token_expires_in: 8_726_400,
        token_type: "bearer",
        ...(idToken === undefined ? {} : { id_token: idToken }),
      });
    }) as typeof fetch;

    try {
      /* ---- only a person can start a connection ------------------------ */
      // First in this section: it needs nothing the callback checks leave
      // behind, and a link that records nobody would otherwise surface as the
      // success path failing rather than here, where the cause is.
      {
        const statesNow = () =>
          (db.prepare("SELECT COUNT(*) AS n FROM qbo_oauth_states").get() as { n: number }).n;
        const connectAs = async (headers: Record<string, string>) => {
          const r = await liveFetch(`${base}/api/integrations/quickbooks/connect`, { method: "POST", headers });
          return { status: r.status, body: (await r.json().catch(() => ({}))) as { authorizeUrl?: string } };
        };
        const before = statesNow();
        const byKey = await connectAs({ Authorization: `Bearer ${OPERATOR_KEY}` });
        assertEqual(byKey.status, 403, "H7: a shared key cannot start a QuickBooks connection");
        assertEqual(statesNow(), before, "H7: and no link was minted for it");

        const connectOperator = await newPerson(companyId, "operator");
        const connectOwner = await newPerson(companyId, "owner");
        for (const who of [connectOperator, connectOwner]) {
          const res = await connectAs({ Cookie: who.cookie });
          assertEqual(res.status, 200, `H8: a signed-in ${who.email.split("-")[1]} can start one`);
          const st = new URL(res.body.authorizeUrl ?? "http://x/").searchParams.get("state") ?? "";
          const row = db.prepare("SELECT * FROM qbo_oauth_states WHERE state = ?").get(st) as
            | Record<string, string | null>
            | undefined;
          assertEqual(row?.created_by ?? null, who.userId, `H8: the ${who.email.split("-")[1]}'s link records who started it`);
        }
      }

      /* ---- the success path -------------------------------------------- */
      const operatorA = await personFor(companyId);
      const goodState = startedBy(operatorA);

      const okRes = await hit(
        `?code=own-${REALM}&state=${goodState}&realmId=${REALM}`,
        operatorA.cookie,
      );
      assertEqual(okRes.status, 302, "a valid callback redirects the operator back");

      const location = okRes.headers.get("location") ?? "";
      assert(location.endsWith(CONNECTED_REDIRECT_PATH), "to the accounting page, flagged connected");
      assert(location.includes("connected=1"), "the flag is valueless — its presence is the signal");

      // The point of the change. Checked by VALUE and by shape, not by key
      // name: a realm id is a bare number and would sail past a name scan.
      assert(!location.includes(REALM), "the redirect carries no realm id");
      assert(
        !/\b\d{10,}\b/.test(location),
        "and nothing else identifier-shaped — a provider id is just a long number",
      );
      for (const forbidden of ["realm", "company", "accountId", "token", "code", "state"]) {
        assert(
          !location.toLowerCase().includes(forbidden.toLowerCase()),
          `the redirect carries no "${forbidden}"`,
        );
      }
      // The destination is fixed configuration, not anything from the request:
      // this route has no authentication, so an echoed return URL would be an
      // open redirect.
      assert(
        location.startsWith("http://localhost:3100/") ||
          location.startsWith(process.env.FUEL_DASHBOARD_URL ?? "\u0000"),
        "the destination is the configured dashboard, never a caller-supplied URL",
      );

      /* ---- token storage, unchanged ------------------------------------ */
      assertEqual(tokenExchanges, 1, "exactly one token exchange happened");
      const stored = getConnection(companyId);
      assert(stored !== null, "the connection was saved");
      assertEqual(stored!.realmId, REALM, "the realm id is still STORED — only the URL lost it");
      assert(
        Date.parse(stored!.accessExpiresAt) > Date.now(),
        "the access token expiry was recorded from the grant",
      );
      assert(
        Date.parse(stored!.refreshExpiresAt) > Date.parse(stored!.accessExpiresAt),
        "and the refresh expiry outlives it",
      );

      /* ---- state validation, unchanged --------------------------------- */
      // Single use. The same state must not connect a second time.
      const replay = await hit(`?code=own-${REALM}&state=${goodState}&realmId=${REALM}`, operatorA.cookie);
      assertEqual(replay.status, 400, "a replayed state is refused");
      assertEqual(tokenExchanges, 1, "and no code is exchanged for it — the state is checked FIRST");

      const unknown = await hit(`?code=own-${REALM}&state=${randomUUID()}&realmId=${REALM}`, operatorA.cookie);
      assertEqual(unknown.status, 400, "a state Fuel never issued is refused");
      assertEqual(tokenExchanges, 1, "still nothing exchanged");

      // Missing parameters, each on its own.
      for (const [query, what] of [
        [`?state=${randomUUID()}&realmId=${REALM}`, "code"],
        [`?code=c&realmId=${REALM}`, "state"],
        [`?code=c&state=${randomUUID()}`, "realmId"],
      ] as const) {
        const res = await hit(query);
        assertEqual(res.status, 400, `a callback missing ${what} is refused`);
      }
      assertEqual(tokenExchanges, 1, "none of the malformed callbacks exchanged anything");

      // A declined consent screen is the operator saying no, not a fault.
      const declined = await hit("?error=access_denied");
      assertEqual(declined.status, 400, "a declined consent screen is reported, not thrown");
      assert(
        !(await declined.text()).includes(REALM),
        "and the decline message names no company",
      );

      /* ---- the person who started it finishes it (7A-3 item 4) ---------- */
      /*
       * THE HIJACK. A connect link used to be bound to a company and to nobody
       * in it. An operator at one company could press Connect, hand the Intuit
       * link to someone at another company that had not connected yet, and the
       * books THAT person consented for were saved under the first company:
       * readable by it, and never connectable by their real owner, because a
       * QuickBooks company belongs to one Fuel company. grantReachesRealm cannot
       * see it -- the token really does read those books; its holder consented.
       * So the callback asks who brought the code back, before spending it.
       */
      {
        const takerCo = randomUUID();
        const takerName = `Taker Books ${takerCo.slice(0, 8)}`;
        db.prepare(
          "INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES (?, ?, 0, ?)",
        ).run(takerCo, takerName, "2099-01-01T00:00:00.000Z");
        const takerOwner = await personFor(takerCo);
        const takerOperator = await newPerson(takerCo, "operator");
        // Books the lured person can read, and no Fuel company holds yet.
        const lured = await newPerson(companyId);
        const luredBooks = `lured-books-${randomUUID().slice(0, 8)}`;
        const finish = async (st: string, realm: string, cookie?: string) => {
          const r = await hit(`?code=own-${realm}&state=${st}&realmId=${realm}`, cookie);
          return { status: r.status, text: await r.text() };
        };
        const booksHeld = (realm: string) =>
          (db.prepare("SELECT COUNT(*) AS n FROM qbo_connections WHERE realm_id = ?").get(realm) as { n: number }).n;

        const exchangesBefore = tokenExchanges;
        const readsBefore = companyInfoReads.length;
        const hijackState = startedBy(takerOwner);
        const hijack = await finish(hijackState, luredBooks, lured.cookie);
        assertEqual(hijack.status, 400, "H1: a link finished by someone at another company is refused");
        assertEqual(tokenExchanges, exchangesBefore, "H1: and the code is never exchanged");
        assertEqual(companyInfoReads.length, readsBefore, "H1: and no books are read with it");
        assert(getConnection(takerCo) === null, "H1: nothing is saved for the company that made the link");
        assertEqual(booksHeld(luredBooks), 0, "H1: and the lured person's books are still free to connect");
        assertEqual(getConnection(companyId)!.realmId, REALM, "H1: the other company's own connection is untouched");
        assert(
          /signed in as the person who started it/.test(hijack.text),
          "H1: the refusal says who has to finish it",
        );
        for (const [what, value] of [
          ["the books", luredBooks],
          ["the company that made the link", takerCo],
          ["its name", takerName],
          ["the other company", companyId],
          ["who made the link", takerOwner.email],
          ["who brought it back", lured.email],
        ] as const) {
          assert(!hijack.text.includes(value), `H9: the refusal does not name ${what}`);
        }

        const sameCompany = await finish(startedBy(takerOwner), luredBooks, takerOperator.cookie);
        assertEqual(
          sameCompany.status,
          400,
          "H1b: a link finished by a different person in the SAME company is refused -- the rule is the person",
        );

        const noCookieState = startedBy(takerOwner);
        const noCookie = await finish(noCookieState, luredBooks);
        assertEqual(noCookie.status, 400, "H2: a link finished with no session at all is refused");
        const junkCookie = await finish(startedBy(takerOwner), luredBooks, `${SESSION_COOKIE}=not-a-session`);
        assertEqual(junkCookie.status, 400, "H2: and with a session value Fuel never issued");
        assertEqual(tokenExchanges, exchangesBefore, "H2: neither exchanged a code");

        const afterMismatch = await finish(noCookieState, luredBooks, takerOwner.cookie);
        assertEqual(afterMismatch.status, 400, "H10: a link refused once is spent, even for the person who made it");
        assert(/already used/.test(afterMismatch.text), "H10: and is reported as already used");

        const disabled = await newPerson(takerCo, "operator");
        const disabledState = startedBy(disabled);
        // Left with a live session on purpose: the refusal must come from the
        // disabled user, not from the revocation that disabling normally does.
        db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), disabled.userId);
        const disabledRes = await finish(disabledState, luredBooks, disabled.cookie);
        assertEqual(disabledRes.status, 400, "H4: a person disabled since pressing Connect cannot finish it");

        const signedOut = await newPerson(takerCo, "operator");
        const signedOutState = startedBy(signedOut);
        revokeSessionsForUser(signedOut.userId);
        const signedOutRes = await finish(signedOutState, luredBooks, signedOut.cookie);
        assertEqual(signedOutRes.status, 400, "H5: a person who signed out since pressing Connect cannot finish it");

        const lapsed = await newPerson(takerCo, "operator");
        const lapsedState = startedBy(lapsed);
        db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run("2000-01-01T00:00:00.000Z", lapsed.userId);
        const lapsedRes = await finish(lapsedState, luredBooks, lapsed.cookie);
        assertEqual(lapsedRes.status, 400, "H5: nor one whose session has expired");

        // A state from before this column existed names nobody, and is refused
        // rather than read as "anybody".
        const anonymousState = randomUUID();
        db.prepare(
          `INSERT INTO qbo_oauth_states (state, company_id, created_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, NULL)`,
        ).run(anonymousState, takerCo, new Date().toISOString(), new Date(Date.now() + 600_000).toISOString());
        const anonymous = await finish(anonymousState, luredBooks, takerOwner.cookie);
        assertEqual(anonymous.status, 400, "H6: a link that records nobody as its starter is refused");

        assertEqual(tokenExchanges, exchangesBefore, "H1-H6: no refused link exchanged a code");
        assertEqual(getConnection(takerCo), null, "H1-H6: and none saved a connection");

        const ownBooks = `taker-books-${randomUUID().slice(0, 8)}`;
        const own = await finish(startedBy(takerOwner), ownBooks, takerOwner.cookie);
        assertEqual(own.status, 302, "H3: the person who started it, in their own browser, connects");
        assertEqual(getConnection(takerCo)?.realmId ?? null, ownBooks, "H3: and their books are saved for their company");
      }

      /* ---- the books are the ones Intuit granted (7A-3 item 4, part 2) -- */
      /*
       * WHAT THE LIVE PROBE FOUND. A token asked for another QuickBooks company
       * its Intuit user can reach is answered 200 -- with the token's OWN
       * company. So "a read of the named realm succeeded" proves only that the
       * user can reach it, not that the grant is for it. Someone with Intuit
       * access to another business's books could consent for their own, edit
       * `realmId` in the redirect, and have Fuel save the other business's id
       * against a token that writes into their own books -- locking the real
       * owner out as a side effect. The ID token's `realmid` is Intuit saying
       * which company it granted, and the callback now believes only that.
       */
      {
        const realmCo = randomUUID();
        db.prepare(
          "INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES (?, ?, 0, ?)",
        ).run(realmCo, `Realm Books ${realmCo.slice(0, 8)}`, "2099-01-01T00:00:00.000Z");
        const connector = await personFor(realmCo);
        const ownBooks = `granted-books-${randomUUID().slice(0, 8)}`;
        const otherBooks = `reachable-books-${randomUUID().slice(0, 8)}`;
        sameIntuitUser.add(ownBooks);
        sameIntuitUser.add(otherBooks);
        const heldBy = (realm: string) =>
          (db.prepare("SELECT COUNT(*) AS n FROM qbo_connections WHERE realm_id = ?").get(realm) as { n: number }).n;
        const finish = async (code: string, realm: string) => {
          const r = await hit(`?code=${code}&state=${startedBy(connector)}&realmId=${realm}`, connector.cookie);
          return { status: r.status, text: await r.text() };
        };

        // The stub is faithful to what Intuit did, or none of this means anything.
        const modelled = await globalThis.fetch(
          `https://sandbox-quickbooks.api.intuit.com/v3/company/${otherBooks}/companyinfo/${otherBooks}`,
          { headers: { Authorization: `Bearer tok:own-${ownBooks}` } },
        );
        const modelledBody = (await modelled.json()) as { CompanyInfo?: { CompanyName?: string } };
        assert(
          modelled.status === 200 && modelledBody.CompanyInfo?.CompanyName === `Books ${ownBooks}`,
          "(the stub answers like Intuit did: 200 for other books the same user reaches, with the token's own company)",
        );

        const logged: string[] = [];
        const original = { log: console.log, warn: console.warn, error: console.error };
        for (const level of ["log", "warn", "error"] as const) {
          console[level] = (...args: unknown[]) => {
            logged.push(args.map(String).join(" "));
          };
        }
        const texts: string[] = [];
        try {
          const exchangesBefore = tokenExchanges;
          const readsBefore = companyInfoReads.length;
          const edited = await finish(`own-${ownBooks}`, otherBooks);
          texts.push(edited.text);
          assertEqual(edited.status, 400, "R1: a callback naming other books the same Intuit user can reach is refused");
          assertEqual(getConnection(realmCo), null, "R1: nothing is saved");
          assertEqual(tokenExchanges, exchangesBefore + 1, "R1: (the code was exchanged -- the ID token only exists after)");
          assertEqual(companyInfoReads.length, readsBefore, "R1: and no books are read before the refusal");
          assertEqual(heldBy(otherBooks), 0, "R1: those books are still free for their real owner");
          assert(/does not match the QuickBooks company it names/.test(edited.text), "R1: the refusal says the grant and the books disagree");

          const unconfirmed = async (label: string, code: string) => {
            const res = await finish(code, ownBooks);
            texts.push(res.text);
            assertEqual(res.status, 502, `${label}`);
            assertEqual(getConnection(realmCo), null, `${label} -- and nothing is saved`);
            assert(/Could not confirm the QuickBooks company/.test(res.text), `${label} -- and it says the company could not be confirmed`);
          };
          await unconfirmed("R2: a token response with no ID token is refused", `noid-${ownBooks}`);
          await unconfirmed("R3: an ID token that is not three parts is refused", `badparts-${ownBooks}`);
          await unconfirmed("R3: an ID token whose payload is not base64url is refused", `badb64-${ownBooks}`);
          await unconfirmed("R3: an ID token whose payload is not JSON is refused", `badjson-${ownBooks}`);
          await unconfirmed("R3: an ID token that names no realm is refused", `norealm-${ownBooks}`);
          await unconfirmed("R4: an ID token from another issuer is refused", `iss-${ownBooks}`);
          await unconfirmed("R5: an ID token issued to another client is refused", `aud-${ownBooks}`);
          await unconfirmed("R6: an expired ID token is refused", `exp-${ownBooks}`);
          assertEqual(companyInfoReads.length, readsBefore, "R2-R6: none of them read any books");

          const granted = await finish(`own-${ownBooks}`, ownBooks);
          assertEqual(granted.status, 302, "the books the ID token names are connected");
          assertEqual(getConnection(realmCo)?.realmId ?? null, ownBooks, "and saved as those books");
        } finally {
          Object.assign(console, original);
        }
        for (const text of texts) {
          assert(!text.includes(ownBooks) && !text.includes(otherBooks), "R8: no refusal names either set of books");
          assert(!text.includes("tok:") && !text.includes("stub-signature"), "R8: no refusal carries token material");
        }
        for (const line of logged) {
          assert(!line.includes("tok:") && !line.includes("stub-signature") && !line.includes("eyJ"), `R8: no log line carries token material (${line.slice(0, 80)})`);
          assert(!line.includes(otherBooks), `R8: no log line names the books that were refused (${line.slice(0, 80)})`);
        }

        const connectRes = await liveFetch(`${base}/api/integrations/quickbooks/connect`, {
          method: "POST",
          headers: { Cookie: connector.cookie },
        });
        const authorizeUrl = ((await connectRes.json()) as { authorizeUrl?: string }).authorizeUrl ?? "http://x/";
        assertEqual(
          new URL(authorizeUrl).searchParams.get("scope"),
          "com.intuit.quickbooks.accounting openid",
          "R7: Fuel asks for accounting plus an ID token, and nothing else",
        );
      }

      /* ---- one Fuel company per QuickBooks company ---------------------- */
      const rivalCompany = randomUUID();
      db.prepare(
        "INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES (?, ?, 0, ?)",
      ).run(rivalCompany, `Rival Books ${rivalCompany.slice(0, 8)}`, "2099-01-01T00:00:00.000Z");
      // Started and finished by the same person, so these checks keep testing
      // what they always tested: the books, not the person.
      const callbackFor = async (forCompany: string, code: string, realm: string) => {
        const who = await personFor(forCompany);
        const r = await hit(`?code=${code}&state=${startedBy(who)}&realmId=${realm}`, who.cookie);
        return { status: r.status, text: await r.text() };
      };

      /*
       * SQUATTING. An operator finishes consent for their OWN books and edits
       * the realm id to a business that has not connected yet. Saved, that
       * business could never connect: its books would already belong to a
       * Fuel company. The ID token names the books the grant is for, and they
       * are not these, so it is refused -- before the forged realm is read.
       */
      const victimRealm = `victim-realm-${randomUUID().slice(0, 8)}`;
      const squat = await callbackFor(rivalCompany, "own-rival-realm", victimRealm);
      assertEqual(squat.status, 400, "a callback naming books the grant cannot read is refused");
      assert(getConnection(rivalCompany) === null, "and nothing is saved for the squatter");
      assert(
        !companyInfoReads.some((u) => u.includes(`/companyinfo/${victimRealm}`)),
        "the forged realm was refused on the ID token, before any read of it",
      );
      const victimCompany = randomUUID();
      db.prepare(
        "INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES (?, ?, 0, ?)",
      ).run(victimCompany, `Victim Books ${victimCompany.slice(0, 8)}`, "2099-01-01T00:00:00.000Z");
      const owner = await callbackFor(victimCompany, `own-${victimRealm}`, victimRealm);
      assertEqual(owner.status, 302, "so the real owner of those books can still connect them");

      // AND NO ORACLE. A forged realm that IS connected elsewhere gets the same
      // 400 as one that is not -- "already connected" is only ever said to a
      // caller who proved they can read those books.
      const probe = await callbackFor(rivalCompany, "own-rival-realm", REALM);
      assertEqual(probe.status, 400, "probing a connected realm without access to it reveals nothing");
      assert(!/already connected/.test(probe.text), "not even that it is connected");

      const unsureRealm = `unsure-${randomUUID().slice(0, 8)}`;
      const unsure = await callbackFor(rivalCompany, `flaky-${unsureRealm}`, unsureRealm);
      assertEqual(unsure.status, 502, "when the check itself cannot be completed, nothing is connected");
      assert(getConnection(rivalCompany) === null, "and nothing is saved");

      // A caller who CAN read REALM, arriving for a second Fuel company.
      const rival = await callbackFor(rivalCompany, `own-${REALM}`, REALM);
      assertEqual(rival.status, 409, "a second Fuel company cannot connect a QuickBooks company already connected");
      assert(getConnection(rivalCompany) === null, "and nothing is saved for it");
      assert(
        /already connected to another Fuel account/.test(rival.text) &&
          !rival.text.includes(REALM) &&
          !rival.text.includes(companyId) &&
          !rival.text.includes(bootstrapCompany().name),
        "the refusal says the books are taken, and not by whom",
      );

      // POSITIVE CONTROL: the company that holds the realm reconnects to it.
      const againState = startedBy(operatorA);
      const again = await hit(`?code=own-${REALM}&state=${againState}&realmId=${REALM}`, operatorA.cookie);
      assertEqual(again.status, 302, "the company holding the realm can reconnect to it");
      assertEqual(getConnection(companyId)!.realmId, REALM, "and still holds it");

      // THE BACKSTOP. The realm is free when checked, and taken by the time the
      // exchange returns -- the window only the UNIQUE index can close.
      const raceRealm = `race-realm-${randomUUID().slice(0, 8)}`;
      const thirdCompany = randomUUID();
      db.prepare(
        "INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES (?, ?, 0, ?)",
      ).run(thirdCompany, `Third Books ${thirdCompany.slice(0, 8)}`, "2099-01-01T00:00:00.000Z");
      duringExchange = () => {
        saveConnection({
          companyId: thirdCompany,
          realmId: raceRealm,
          accessToken: "a",
          refreshToken: "r",
          accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      };
      const rivalPerson = await personFor(rivalCompany);
      const raceState = startedBy(rivalPerson);
      const raced = await hit(`?code=own-${raceRealm}&state=${raceState}&realmId=${raceRealm}`, rivalPerson.cookie);
      duringExchange = null;
      assertEqual(raced.status, 409, "a realm taken during the exchange is still refused, not a 502");
      assert(getConnection(rivalCompany) === null, "and the late company saved nothing");
      assertEqual(getConnection(thirdCompany)!.realmId, raceRealm, "while the company that got there first keeps it");

      /* ---- books cannot move while a posting is unresolved -------------- */
      /*
       * A pending posting records its document number but not which QuickBooks
       * company it went to, so moving the connection would make reconciliation
       * ask the wrong books -- find nothing -- and release the lines to be
       * booked twice. Both doors are tested: switching realm, and disconnecting.
       */
      const pendingPostingFor = (forCompany: string): string => {
        const draftId = randomUUID();
        const postingId = randomUUID();
        db.prepare(
          `INSERT INTO qbo_posting_drafts (id, company_id, direction, grain, posting_day, counterparty, doc_number,
             payload_json, payload_hash, source_fingerprint, status, created_at)
           VALUES (?, ?, 'spend', 'daily', '2099-02-02', NULL, ?, '{}', 'h', 'f', 'posted', '2099-02-02T00:00:00.000Z')`,
        ).run(draftId, forCompany, `FUEL-mv${postingId.slice(0, 10)}`);
        db.prepare(
          `INSERT INTO qbo_postings (id, company_id, draft_id, doc_number, request_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', '2099-02-02T00:00:00.000Z')`,
        ).run(postingId, forCompany, draftId, `FUEL-mv${postingId.slice(0, 10)}`, randomUUID());
        return postingId;
      };
      const removePosting = (postingId: string) => {
        const { draft_id } = db.prepare("SELECT draft_id FROM qbo_postings WHERE id = ?").get(postingId) as { draft_id: string };
        db.prepare("DELETE FROM qbo_postings WHERE id = ?").run(postingId);
        db.prepare("DELETE FROM qbo_posting_drafts WHERE id = ?").run(draft_id);
      };

      const movingCompany = randomUUID();
      db.prepare(
        "INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES (?, ?, 0, ?)",
      ).run(movingCompany, `Moving Books ${movingCompany.slice(0, 8)}`, "2099-01-01T00:00:00.000Z");
      const oldBooks = `old-books-${randomUUID().slice(0, 8)}`;
      const newBooks = `new-books-${randomUUID().slice(0, 8)}`;
      assertEqual((await callbackFor(movingCompany, `own-${oldBooks}`, oldBooks)).status, 302, "a company connects its books");
      const unresolved = pendingPostingFor(movingCompany);

      const moved = await callbackFor(movingCompany, `own-${newBooks}`, newBooks);
      assertEqual(moved.status, 409, "with a posting unresolved, it cannot connect different books");
      assertEqual(getConnection(movingCompany)!.realmId, oldBooks, "and stays connected to the books the posting went to");
      assert(
        /Reconcile them first/.test(moved.text) && !moved.text.includes(oldBooks) && !moved.text.includes(newBooks),
        "the refusal says what to do, and names no books",
      );
      assertEqual(
        (await callbackFor(movingCompany, `own-${oldBooks}`, oldBooks)).status,
        302,
        "but it can renew the connection to the SAME books, which is how dead tokens are replaced",
      );
      saveConnection({
        companyId: movingCompany,
        realmId: oldBooks,
        accessToken: "refreshed",
        refreshToken: "refreshed",
        accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      assert(true, "and a token refresh, which always passes the same books, is never refused");

      db.prepare("UPDATE qbo_postings SET status = 'failed' WHERE id = ?").run(unresolved);
      assertEqual(
        (await callbackFor(movingCompany, `own-${newBooks}`, newBooks)).status,
        302,
        "once nothing is unresolved, the company can move to different books",
      );
      removePosting(unresolved);

      // The disconnect door, through the operator route (bound to this company).
      // Through liveFetch, NOT send(): the global fetch is Intuit's stub for
      // the length of this section, and a request sent through it never reaches
      // Fuel at all -- the first draft of this check passed exactly that way.
      const disconnect = async () => {
        const r = await liveFetch(`${base}/api/integrations/quickbooks/disconnect`, {
          method: "POST",
          headers: { Authorization: `Bearer ${OPERATOR_KEY}` },
        });
        return { status: r.status, text: await r.text() };
      };
      const heldOpen = pendingPostingFor(companyId);
      const refusedDisconnect = await disconnect();
      assertEqual(refusedDisconnect.status, 409, "with a posting unresolved, the company cannot disconnect");
      assert(getConnection(companyId) !== null, "so the connection that reconciling needs is still there");
      assert(/Reconcile them first/.test(refusedDisconnect.text), "and it is told why");
      db.prepare("UPDATE qbo_postings SET status = 'posted' WHERE id = ?").run(heldOpen);
      const allowedDisconnect = await disconnect();
      assertEqual(allowedDisconnect.status, 200, "a posted document does not hold the connection open");
      removePosting(heldOpen);
      assertEqual(
        (await callbackFor(companyId, `own-${REALM}`, REALM)).status,
        302,
        "(and the company reconnects, restoring the state later checks expect)",
      );

      /* ---- no document was created ------------------------------------- */
      // Asserted structurally as well as by count: the callback reaches
      // exchangeCode and nothing else, so there is no path from here to a
      // journal entry even if the counts happened to agree.
      const postingsAfter = db
        .prepare("SELECT COUNT(*) AS n FROM qbo_postings")
        .get() as { n: number };
      assertEqual(postingsAfter.n, postingsBefore.n, "no QuickBooks document was created");
      const draftsAfter = db
        .prepare("SELECT COUNT(*) AS n FROM qbo_posting_drafts")
        .get() as { n: number };
      assertEqual(draftsAfter.n, draftsBefore.n, "and no draft either");
      // The token endpoint, and ONE read: companyinfo for the realm the
      // callback claims, which is how that claim is proved. Never a query,
      // never a document.
      for (const url of intuitUrls) {
        assert(
          !/journalentry|\/query/i.test(url) &&
            (url.startsWith("https://oauth.platform.intuit.com/") ||
              /^https:\/\/sandbox-quickbooks\.api\.intuit\.com\/v3\/company\/[^/]+\/companyinfo\//.test(url)),
          `the callback reached only the token endpoint and a sandbox companyinfo read (${url})`,
        );
      }

      /* ---- and the source says the same thing -------------------------- */
      const callbackSrc = withoutComments(readFileSync("src/quickbooks/callback.ts", "utf8"));
      assert(
        !/connected=\$\{/.test(callbackSrc),
        "the redirect interpolates nothing into the connected flag",
      );
      /*
       * grantedRealm DOES NOT CHECK THE ID TOKEN'S SIGNATURE, and that is sound
       * only because the token it reads came straight from Intuit's token
       * endpoint over TLS (ADR 0017). So it is called in exactly one place, on
       * exactly that value. A second caller -- a stored token, a browser-supplied
       * one, a replay flow -- would inherit a trust it has not earned.
       */
      {
        const srcFiles = (dir: string): string[] =>
          readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory() ? srcFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
          );
        const callers = srcFiles("src").flatMap((file) =>
          [...withoutComments(readFileSync(file, "utf8")).matchAll(/\bgrantedRealm\s*\(([^)]*)\)/g)]
            // Skip the definition itself: a call is not preceded by `function `.
            .filter((m) => !m.input!.slice(0, m.index!).endsWith("function "))
            .map((m) => `${file}: grantedRealm(${m[1]})`),
        );
        assertEqual(
          callers.join(" | "),
          `${join("src", "quickbooks", "callback.ts")}: grantedRealm(grant.idToken)`,
          "the unsigned ID token is read in one place only: the callback, on the token response it just received",
        );
      }
      assert(
        !callbackSrc.includes("req.query.returnTo") && !/redirect\(.*req\./.test(callbackSrc),
        "and builds its destination from configuration, never from the request",
      );
      // A live-attempt clash is unreachable over HTTP in one process (see
      // beginPosting), so its mapping is pinned in source: without it the
      // refusal would fall through to a generic 500 that hides "wait, then
      // preview again".
      const apiSrc = withoutComments(readFileSync("src/api.ts", "utf8"));
      const qboErrorFn = apiSrc.slice(apiSrc.indexOf("function respondQboError"));
      assert(
        /if \(error instanceof DocumentInFlightError\) \{\s*return res\.status\(409\)/.test(qboErrorFn),
        "a posting refused as in flight answers 409",
      );
      const serverSrc = withoutComments(readFileSync("src/server.ts", "utf8"));
      assert(
        !serverSrc.includes("connected="),
        "src/server.ts no longer builds this redirect at all",
      );
    } finally {
      globalThis.fetch = liveFetch;
      callbackServer.close();
    }

    console.log(`   ${checks} checks so far`);

    /*
     * 6B-2. The receipt routes, and the boundary they have to hold.
     *
     * ASSERTED ON DELIVERED BYTES, NOT ON THE TYPE. That distinction is the
     * whole reason closing ADR 0005 took two attempts: a TypeScript annotation
     * is erased at build time, so it stops a field being rendered without
     * stopping it being transmitted. A receipt row carries three things that
     * must never cross — a payer's wallet address, the authorization nonce that
     * identifies it on-chain, and a settlement hash — so the presenter is an
     * explicit allowlist pick and this reads the response text to prove it.
     */
    console.log("\n== receipts: the read path and its allowlist ==");
    {
      const company = bootstrapCompany();
      const agent = db
        .prepare(
          `SELECT a.id FROM agents a JOIN teams t ON t.id = a.team_id
           WHERE t.company_id = ? LIMIT 1`,
        )
        .get(company.id) as { id: string };

      const PAYER = "0xfeedfacefeedfacefeedfacefeedfacefeedface";
      const NONCE = "0x" + "ab".repeat(32);
      const HASH = "0x" + "cd".repeat(32);
      const seedReceipt = (id: string, status: string, nonceSuffix: string) => {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status,
                                 payer_address, authorization_nonce, tx_hash, created_at, settled_at)
           VALUES (?, ?, NULL, 12345, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          agent.id,
          status,
          PAYER,
          NONCE.slice(0, -2) + nonceSuffix,
          status === "settled" ? HASH : null,
          now,
          status === "settled" ? now : null,
        );
      };
      seedReceipt("api-rec-settled", "settled", "01");
      seedReceipt("api-rec-unknown", "settle_unknown", "02");
      seedReceipt("api-rec-unsettled", "served_unsettled", "03");

      const list = await call("/api/receipts");
      assertEqual(list.status, 200, "GET /api/receipts answers an operator");
      assert(Array.isArray(list.body.receipts), "and returns a receipts array");
      assert(
        list.body.receipts.some((r: any) => r.id === "api-rec-settled"),
        "which includes the company's receipts",
      );

      // THE BOUNDARY. Every one of these is present on the row and must not be
      // in the bytes.
      for (const secret of [PAYER, NONCE.slice(0, -2) + "01", HASH]) {
        assert(
          !list.text.toLowerCase().includes(secret.toLowerCase()),
          `the receipts response does not carry ${secret.slice(0, 10)}…`,
        );
      }
      for (const fragment of FORBIDDEN_FRAGMENTS) {
        assert(
          !list.text.includes(fragment),
          `the receipts response does not carry "${fragment}"`,
        );
      }
      for (const term of NO_CRYPTO) {
        assert(
          !list.text.toLowerCase().includes(term),
          `the receipts response uses no crypto term "${term}" (ADR 0006)`,
        );
      }

      // The needs-attention list is what makes a stuck receipt findable.
      const attentionIds = (list.body.needsAttention ?? []).map((r: any) => r.id);
      assert(
        attentionIds.includes("api-rec-unknown") && attentionIds.includes("api-rec-unsettled"),
        "needsAttention holds both unresolved states",
      );
      assert(
        !attentionIds.includes("api-rec-settled"),
        "and not the settled one",
      );

      // Filtering, and refusing a filter it does not understand.
      const filtered = await call("/api/receipts?status=settle_unknown");
      assertEqual(filtered.status, 200, "receipts accept a status filter");
      assertEqual(
        filtered.body.receipts.length,
        1,
        "which narrows the list to the matching rows",
      );
      const badStatus = await call("/api/receipts?status=nonsense");
      assertEqual(badStatus.status, 400, "an unknown status is refused, not ignored");
      const badParam = await call("/api/receipts?nope=1");
      assertEqual(badParam.status, 400, "an unknown query parameter is refused, not ignored");

      // Role: this is operator-only, like every other read here.
      assertEqual((await call("/api/receipts", AGENT_KEY)).status, 403, "an agent may not read receipts");
      assertEqual((await call("/api/receipts", null)).status, 401, "and an anonymous caller may not");
    }

    console.log("\n== reconcile routes: guards and attestation ==");
    {
      const post = async (path: string, body: unknown, key: string | null = OPERATOR_KEY) => {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, body: JSON.parse(text || "{}"), text };
      };

      // A receipt that is not in a reconcilable state is a 409, not a 500 and
      // not a silent no-op.
      assertEqual(
        (await post("/api/receipts/api-rec-settled/reconcile", {})).status,
        409,
        "reconciling a settled receipt is refused",
      );
      assertEqual(
        (await post("/api/receipts/does-not-exist/reconcile", {})).status,
        404,
        "reconciling an unknown receipt is a 404",
      );

      // The payment side. Seed an unreconciled payment to act on.
      const company = bootstrapCompany();
      const agent = db
        .prepare(
          `SELECT a.id FROM agents a JOIN teams t ON t.id = a.team_id
           WHERE t.company_id = ? LIMIT 1`,
        )
        .get(company.id) as { id: string };
      db.prepare(
        `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, detail, created_at)
         VALUES ('api-pay-unrec', ?, 5000, 'https://vendor.test/x', 'unreconciled', 'never confirmed', ?)`,
      ).run(agent.id, new Date().toISOString());

      assertEqual(
        (await post("/api/payments/api-pay-unrec/reconcile", { outcome: "settled" })).status,
        400,
        "a payment reconcile without a note is refused",
      );
      assertEqual(
        (await post("/api/payments/api-pay-unrec/reconcile", { outcome: "maybe", note: "x y z" }))
          .status,
        400,
        "and an outcome outside the two allowed values is refused",
      );

      const done = await post("/api/payments/api-pay-unrec/reconcile", {
        outcome: "failed",
        note: "authorization expired unused, checked on the explorer",
      });
      assertEqual(done.status, 200, "a well-formed payment reconcile succeeds");
      assertEqual(
        done.body.basis,
        // This payment was seeded without an authorization window, as every row
        // signed before 6B-2 was. The response says so rather than claiming a
        // check it could not run — "operator attestation" would have been the
        // vaguer, more flattering answer.
        "expiry not recorded",
        "and names what was NOT verified, rather than implying it was",
      );
      assertEqual(
        (
          await post("/api/payments/api-pay-unrec/reconcile", {
            outcome: "failed",
            note: "again",
          })
        ).status,
        409,
        "a second reconcile of the same payment is refused",
      );

      assertEqual(
        (await post("/api/payments/api-pay-unrec/reconcile", { outcome: "failed", note: "x y z" }, AGENT_KEY))
          .status,
        403,
        "an agent may not reconcile a payment",
      );

      // A settlement reference on a payment recorded as never settled is a
      // contradiction, refused rather than stored.
      db.prepare(
        `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, detail, created_at)
         VALUES ('api-pay-live', ?, 5000, 'https://vendor.test/x', 'unreconciled', 'never confirmed', ?)`,
      ).run(agent.id, new Date().toISOString());
      assertEqual(
        (
          await post("/api/payments/api-pay-live/reconcile", {
            outcome: "failed",
            note: "expired, honestly",
            txHash: "0x" + "a".repeat(64),
          })
        ).status,
        400,
        "a txHash on a non-settled outcome is refused",
      );

      /*
       * THE BUDGET-RELEASE GUARD, at the route. A live authorization can still
       * be settled by the facilitator, so releasing its budget would let the
       * agent spend again against money that can still move — and nothing
       * revisits a `failed` row afterwards.
       */
      db.prepare(
        `UPDATE payments SET authorization_valid_before = ? WHERE id = 'api-pay-live'`,
      ).run(Math.floor(Date.now() / 1000) + 3600);
      const live = await post("/api/payments/api-pay-live/reconcile", {
        outcome: "failed",
        note: "operator believes this one failed",
      });
      assertEqual(live.status, 409, "releasing budget on a live authorization is refused");
      assert(
        typeof live.body.authorizationExpiresAt === "string",
        "and the refusal says when it may be retried",
      );
      // The refusal must not become a leak: it says WHEN, never what.
      for (const term of NO_CRYPTO) {
        assert(
          !live.text.toLowerCase().includes(term),
          `the refusal carries no crypto term "${term}"`,
        );
      }
      assertEqual(
        (
          db.prepare("SELECT status FROM payments WHERE id = 'api-pay-live'").get() as {
            status: string;
          }
        ).status,
        "unreconciled",
        "and the row is left exactly as it was",
      );

      // Settling is always allowed: it only ever keeps budget consumed.
      assertEqual(
        (
          await post("/api/payments/api-pay-live/reconcile", {
            outcome: "settled",
            note: "confirmed on the explorer",
          })
        ).status,
        200,
        "but recording a live authorization as settled is allowed",
      );
    }


    /* ---- the merged ledger ---------------------------------------------- */
    /*
     * Runs LAST, because it needs the receipts the section above seeded. Those
     * three rows — one settled, one settle_unknown, one served_unsettled — are
     * the earn side of everything below, and each carries a payer address, an
     * authorization nonce and (on the settled one) a transaction hash that must
     * not reach a browser.
     */
    /* ---- the earning endpoints route ------------------------------------ */
    /*
     * Runs before the ledger block and after the receipts one, so the seeded
     * receipts exist. This route had NO closed key-set assertion until 6B-3,
     * which meant the one response carrying an endpoint's origin URL and its
     * ownership nonce was the one nobody was pinning.
     */
    console.log("\n== earning endpoints: the read path and its allowlist ==");
    {
      const list: any = await call("/api/earning-endpoints");
      assertEqual(list.status, 200, "GET /api/earning-endpoints answers an operator");
      assertEqual(
        (await call("/api/earning-endpoints", AGENT_KEY)).status,
        403,
        "an agent may not read the earning endpoints",
      );

      for (const endpoint of list.body) {
        // A CLOSED key set. `forwardSecret` is the one that must never be here:
        // it is the shared secret an origin verifies Fuel's signature with, and
        // it is returned exactly once, at registration, like an API key.
        assertEqual(
          Object.keys(endpoint).sort().join(","),
          "agentId,blocker,createdAt,earned,enabled,id,label,originUrl,ownership,priceUsd,probes,stuck,updatedAt,url",
          "an endpoint's keys are exact",
        );
        assertEqual(
          typeof endpoint.earned,
          "string",
          "earned is a string, never a JSON number",
        );
        assertEqual(typeof endpoint.stuck, "number", "the stuck count is a count");
        assert(
          !("forwardSecret" in endpoint) && !("forward_secret" in endpoint),
          "the forward secret is never on a list response",
        );
      }
      assert(
        !/forward[_ ]?secret/i.test(list.text),
        "the forward secret does not appear anywhere in the bytes",
      );

      /*
       * EARNED COUNTS CONFIRMED RECEIPTS ONLY, and the stuck count is what
       * stops that figure standing in for the whole story. An endpoint whose
       * receipts are all unresolved reports $0 earned and a non-zero stuck
       * count — a revenue total alone would look healthiest exactly when work
       * was being served unpaid.
       */
      const withEndpoint = db
        .prepare(`SELECT id, agent_id FROM earning_endpoints LIMIT 1`)
        .get() as { id: string; agent_id: string } | undefined;
      if (withEndpoint) {
        const stamp = new Date().toISOString();
        db.prepare(
          `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status,
                                 payer_address, authorization_nonce, created_at, settled_at)
           VALUES ('api-ep-settled', ?, ?, 4000, 'settled', ?, ?, ?, ?)`,
        ).run(withEndpoint.agent_id, withEndpoint.id, "0x" + "31".repeat(20), "0x" + "41".repeat(32), stamp, stamp);
        db.prepare(
          `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status,
                                 payer_address, authorization_nonce, created_at)
           VALUES ('api-ep-stuck', ?, ?, 9000, 'served_unsettled', ?, ?, ?)`,
        ).run(withEndpoint.agent_id, withEndpoint.id, "0x" + "32".repeat(20), "0x" + "42".repeat(32), stamp);

        const after: any = await call("/api/earning-endpoints");
        const row = after.body.find((e: any) => e.id === withEndpoint.id);
        assert(row !== undefined, "the endpoint is still listed");

        /*
         * Checked against the database's own sum over the SETTLED rows rather
         * than a literal. This endpoint may already carry revenue from earlier
         * in the suite, and a hardcoded figure would pass or fail on what ran
         * before it — the assertion has to be about the rule, not the fixture.
         */
        const { baseUnitsToDollars } = await import("../src/lib/money.js");
        const settledSum = db
          .prepare(
            `SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM receipts
             WHERE endpoint_id = ? AND status = 'settled'`,
          )
          .get(withEndpoint.id) as { total: number | bigint };
        assertEqual(
          row.earned,
          baseUnitsToDollars(BigInt(settledSum.total)),
          "earned is exactly the sum of this endpoint's confirmed receipts",
        );
        // And the unconfirmed 9000 is NOT in it, which is the point.
        const allSum = db
          .prepare(
            `SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM receipts
             WHERE endpoint_id = ?`,
          )
          .get(withEndpoint.id) as { total: number | bigint };
        assert(
          BigInt(allSum.total) > BigInt(settledSum.total),
          "the fixture really does have an unconfirmed receipt to exclude",
        );
        assert(
          row.earned !== baseUnitsToDollars(BigInt(allSum.total)),
          "earned excludes the unconfirmed receipt rather than counting every one",
        );
        assert(
          row.stuck >= 1,
          "and the unconfirmed one is reported as stuck rather than folded into earned",
        );

        /*
         * A SINGLE-ENDPOINT RESPONSE REPORTS THE SAME FIGURE AS THE LIST.
         *
         * `presentEndpoint`'s totals were briefly an OPTIONAL parameter, which
         * meant the three routes returning one endpoint after a write reported
         * `earned: "0"` regardless of what it had earned — a figure asserted
         * without being computed, on the response an operator sees immediately
         * after renaming an endpoint. Making them required is only half the
         * fix; this is the half that keeps them required.
         */
        const renamed = await send(
          `/api/earning-endpoints/${withEndpoint.id}`,
          "PATCH",
          OPERATOR_KEY,
          { label: `Renamed ${randomUUID().slice(0, 8)}` },
        );
        if (renamed.status === 200) {
          assertEqual(
            renamed.body.earned,
            row.earned,
            "a single-endpoint response reports the same earnings as the list",
          );
          assertEqual(
            renamed.body.stuck,
            row.stuck,
            "and the same stuck count",
          );
        }

        db.exec("DELETE FROM receipts WHERE id IN ('api-ep-settled', 'api-ep-stuck')");
      }
    }
    console.log(`   ${checks} checks so far`);

    /* ---- the accounting engine is company-scoped ------------------------ */
    /*
     * THE HOLE NOBODY WROTE DOWN.
     *
     * ADR 0009 documented the company predicate as "a seam, not tenant
     * isolation" and named the two reads that were missing it. It did not name
     * the posting engine, and the posting engine never had the predicate at
     * all: not one exported function in src/db/postings.ts takes a companyId.
     *
     * This block is the proof, and it uses the second company the suite has
     * seeded since 5B-3 — `other-agent-...` paying `https://other.test/secret`,
     * three settled payments of 1000 base units. That total is under a cent, so
     * the rollup never posts it and it sits in `notYetPosted.buckets` forever,
     * carrying another company's agent name and vendor host, on every single
     * call to this route.
     *
     * The CSV export got exactly these assertions in 5B-3 (see "Isolation.
     * Nothing that identifies the second company may be in the file"). The
     * engine behind it did not.
     */
    console.log("\n== the accounting engine is company-scoped ==");
    {
      const postings: any = await call("/api/postings");
      assertEqual(postings.status, 200, "an operator can read the postings view");

      // The residual buckets are the leak: no date filter narrows them, and
      // they carry a name and a counterparty straight from another tenant.
      assert(
        !postings.text.includes("other-agent-"),
        "another company's agent NAME is not in the postings view",
      );
      assert(
        !postings.text.includes("other.test"),
        "another company's counterparty is not in the postings view",
      );
      assert(
        !postings.text.includes(otherAgent),
        "another company's agent id is not in the postings view",
      );

      /*
       * And the drill-down, which until 7A-1 took a bare line id and checked
       * nothing at all — returning agent names, per-payment amounts and the
       * human who approved each one.
       *
       * THE FIXTURE IS BUILT HERE RATHER THAN ASSUMED. The first version of
       * this block looked for an existing foreign line and skipped the
       * assertion when it found none — and it always found none, because the
       * second company's seeded payments total 3000 base units, under a cent,
       * so the rollup never turns them into a line. The check passed by doing
       * nothing, and a deliberate un-scoping of drillDown did not fail it.
       * A scan that finds nothing to scan prints a pass.
       *
       * So the line is created, with its matching absorption so the row is
       * balanced rather than merely present, and its existence is asserted
       * before it is used.
       */
      const foreignLineId = randomUUID();
      db.prepare(
        `INSERT INTO posting_lines
           (id, run_id, agent_id, counterparty, posting_day, ledger_class,
            amount_base_units, created_at)
         VALUES (?, ?, ?, 'other.test', '2099-04-01', 'expense', 1000, ?)`,
      ).run(foreignLineId, randomUUID(), otherAgent, new Date().toISOString());
      db.prepare(
        `INSERT INTO export_postings (payment_id, line_id, absorbed_base_units)
         VALUES (?, ?, 1000)`,
      ).run(otherPaymentIds[0], foreignLineId);

      const foreignLine = db
        .prepare(
          `SELECT pl.id FROM posting_lines pl
           JOIN agents a ON a.id = pl.agent_id
           JOIN teams  t ON t.id = a.team_id
           WHERE t.company_id != ? LIMIT 1`,
        )
        .get(company.id) as { id: string } | undefined;
      assert(
        foreignLine !== undefined,
        "the fixture really does have another company's posting line to ask for",
      );
      assertEqual(
        (await call(`/api/postings/${foreignLine!.id}`)).status,
        404,
        "another company's posting line is a 404, not a 200",
      );
      // And it is absent from the list, not merely unreachable by id.
      assert(
        !postings.text.includes(foreignLineId),
        "another company's posting line id is not in the postings view",
      );

      /*
       * The postings CSV, which leaves the building. Same assertions as the
       * payments CSV already carries, on the export that did not get them.
       */
      const postingsCsv = await call("/api/exports/postings.csv");
      if (postingsCsv.status === 200) {
        assert(
          !postingsCsv.text.includes("other-agent-"),
          "another company's agent name is not in the postings export",
        );
        assert(
          !postingsCsv.text.includes("other.test"),
          "another company's counterparty is not in the postings export",
        );
      }

      /*
       * A POSTING RUN BELONGS TO ONE COMPANY.
       *
       * Until 7A-3 runPosting posted EVERY company's books in one transaction,
       * so this operator's button created another company's ledger lines,
       * attributed to a run that company never started. 7A-1 stopped the route
       * from REPORTING the other company's totals; the writes themselves went on
       * happening. This block is the test that the writes are gone.
       *
       * The other company is given money that genuinely clears a cent. Without
       * it "none of theirs" would be vacuous — a run that posts every company
       * also posts none of theirs when they have nothing to post.
       */
      const { runPosting, computeBuckets, verifyPostingIntegrity } = await import(
        "../src/db/postings.js"
      );
      const { clearable } = await import("../src/accounting/rollup.js");
      const { baseUnitsToDollars: toDollars } = await import("../src/lib/money.js");

      const RUN_SHARE_HOST = "run-share-other.test";
      for (let i = 0; i < 2; i++) {
        db.prepare(
          `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, created_at, settled_at)
           VALUES (?, ?, 20000, ?, 'settled', ?, ?)`,
        ).run(
          randomUUID(),
          otherAgent,
          `https://${RUN_SHARE_HOST}/x`,
          "2099-05-01T00:00:00.000Z",
          "2099-05-01T00:00:00.000Z",
        );
      }

      const linesOf = (companyId: string) =>
        Number(
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM posting_lines pl
                   JOIN agents a ON a.id = pl.agent_id
                   JOIN teams  t ON t.id = a.team_id
                  WHERE t.company_id = ?`,
              )
              .get(companyId) as { n: number }
          ).n,
        );
      const absorptionsOf = (companyId: string) =>
        Number(
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM export_postings ep
                   JOIN posting_lines pl ON pl.id = ep.line_id
                   JOIN agents a ON a.id = pl.agent_id
                   JOIN teams  t ON t.id = a.team_id
                  WHERE t.company_id = ?`,
              )
              .get(companyId) as { n: number }
          ).n,
        );
      const postableOf = (companyId: string) =>
        computeBuckets(companyId).reduce((sum, b) => sum + clearable(b.residual).postable, 0n);

      /*
       * THE OTHER COMPANY'S BOOKS, WITH ONE NAMED EXCEPTION.
       *
       * The drill-down test above plants a deliberately sub-cent line
       * (`foreignLineId`, 1000 base units) so it has a foreign row to probe. The
       * engine could never have written it, and the whole-cent check is right
       * to report it. It is excluded here by its id and nothing else, so any
       * other problem — a wrong conservation figure, money left unposted, an
       * over-absorbed source — still fails. The first version of these
       * assertions demanded a spotless ledger and tripped on that plant; the
       * engine was correct and the assertion was too broad.
       */
      const otherBooksProblems = () =>
        verifyPostingIntegrity(otherCompany).filter(
          (p) => !(p.check === "whole-cent lines" && p.detail.includes(foreignLineId)),
        );

      const theirLinesBefore = linesOf(otherCompany);
      const theirPostableBefore = postableOf(otherCompany);
      assert(
        theirPostableBefore > 0n,
        "(fixture) the other company really does hold money that clears a cent",
      );

      const run: any = await send("/api/postings/run", "POST", OPERATOR_KEY);
      assertEqual(run.status, 200, "an operator can run the posting engine");

      assertEqual(
        linesOf(otherCompany),
        theirLinesBefore,
        "this company's run creates none of another company's lines",
      );
      assertEqual(
        postableOf(otherCompany),
        theirPostableBefore,
        "and leaves the other company's unposted money exactly where it was",
      );

      const inRun = (companyId: string, op: "=" | "!=") =>
        db
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(pl.amount_base_units), 0) AS units
               FROM posting_lines pl
               JOIN agents a ON a.id = pl.agent_id
               JOIN teams  t ON t.id = a.team_id
              WHERE pl.run_id = ? AND t.company_id ${op} ?`,
          )
          .get(run.body.runId, companyId) as { n: number; units: number | bigint };
      const mine = inRun(company.id, "=");
      assertEqual(
        Number(inRun(company.id, "!=").n),
        0,
        "the run id names this company's lines and nobody else's",
      );
      assertEqual(run.body.linesCreated, Number(mine.n), "linesCreated counts this run's lines");
      assertEqual(run.body.posted, toDollars(BigInt(mine.units)), "posted sums this run's lines");
      assert(
        !run.text.includes(RUN_SHARE_HOST) && !run.text.includes(otherAgent),
        "and the run response names nothing of the other company's",
      );

      /*
       * The other company's money is not lost by being left alone — its OWN run
       * posts it, under a run id of its own. Called on the engine directly
       * because this company has no signed-in person in this block to press the
       * button, and what is being proven is the engine's scoping, not a route.
       */
      const theirRun = runPosting(otherCompany);
      assert(theirRun.linesCreated > 0, "the other company's own run posts its money");
      assert(
        theirRun.runId !== run.body.runId,
        "under a run id of its own, so a run id names exactly one company's books",
      );
      assertEqual(
        otherBooksProblems().length,
        0,
        "and the other company's books are clean afterwards, conservation included",
      );

      /*
       * ONE COMPANY'S FAILURE IS ITS OWN.
       *
       * One transaction for every company meant one bad row anywhere failed
       * every company's run — verifyPostingIntegrity's check 3c records that
       * as the reason it would rather post an unattributable receipt than
       * refuse it. Now a failure inside the other company's books cannot reach
       * this company's run at all.
       *
       * THE FAULT IS INJECTED ON THE ABSORPTION INSERT, NOT THE LINE INSERT, on
       * purpose. Failing the very first write would leave nothing to roll back,
       * and "no partial rows" would pass whether or not the run was atomic. Here
       * the line row is already written when the fault fires, so only a real
       * rollback removes it.
       *
       * A TEMP trigger on this process's own connection, over the suite's
       * test database: it never reaches any file's schema, and
       * it is dropped in `finally` whatever happens.
       */
      {
        const ourAgent = (
          db
            .prepare(
              `SELECT a.id FROM agents a JOIN teams t ON t.id = a.team_id
                WHERE t.company_id = ? ORDER BY a.created_at LIMIT 1`,
            )
            .get(company.id) as { id: string }
        ).id;
        const insertSettled = db.prepare(
          `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, created_at, settled_at)
           VALUES (?, ?, 20000, ?, 'settled', ?, ?)`,
        );
        for (let i = 0; i < 2; i++) {
          const at = "2099-05-02T00:00:00.000Z";
          insertSettled.run(randomUUID(), ourAgent, "https://isolation-ours.test/x", at, at);
          insertSettled.run(randomUUID(), otherAgent, "https://isolation-theirs.test/x", at, at);
        }

        db.exec(`
          CREATE TEMP TRIGGER fail_other_company_books
          BEFORE INSERT ON export_postings
          WHEN NEW.line_id IN (
            SELECT pl.id FROM posting_lines pl
              JOIN agents a ON a.id = pl.agent_id
              JOIN teams  t ON t.id = a.team_id
             WHERE t.company_id = '${otherCompany}'
          )
          BEGIN SELECT RAISE(ABORT, 'injected failure in the other company''s books'); END
        `);
        try {
          const ours: any = await send("/api/postings/run", "POST", OPERATOR_KEY);
          assertEqual(
            ours.status,
            200,
            "this company's run succeeds while another company's books would fail",
          );
          assert(
            ours.body.linesCreated > 0,
            "and really posts — this company had money of its own, so the success is not vacuous",
          );

          const linesBefore = linesOf(otherCompany);
          const absorptionsBefore = absorptionsOf(otherCompany);
          let injected = false;
          try {
            runPosting(otherCompany);
          } catch (error) {
            injected = /injected failure/.test(String(error));
          }
          assert(injected, "(control) the injected failure really fires for the other company");
          assertEqual(
            linesOf(otherCompany),
            linesBefore,
            "a failed run leaves no partial lines behind — it is still all or nothing",
          );
          assertEqual(
            absorptionsOf(otherCompany),
            absorptionsBefore,
            "and no orphaned absorptions",
          );
        } finally {
          db.exec("DROP TRIGGER IF EXISTS temp.fail_other_company_books");
        }

        const recovered = runPosting(otherCompany);
        assert(
          recovered.linesCreated > 0,
          "once the fault clears, the other company's money posts — nothing was lost or stranded",
        );
        assertEqual(
          otherBooksProblems().length,
          0,
          "and its books are clean after the failed run and the retry",
        );
      }
    }
    console.log(`   ${checks} checks so far`);

    /* ---- lookups by id are scoped in SQL, and a test says so ------------- */
    /*
     * FOUR ROUTES USED TO FETCH BY BARE ID AND COMPARE COMPANIES AFTERWARDS:
     * endpoint verify/rename, receipt reconcile, and every QuickBooks draft and
     * posting route. That comparison is gone — the scoped getters answer null
     * for another company's row, so the 404 comes from the query.
     *
     * Which means each of these routes is now exactly as isolated as one WHERE
     * clause, and a break test proved nothing was watching: rewriting
     * getDraftInCompany, getPostingInCompany, getEndpointInCompany or
     * getReceiptInCompany to ignore the company passed every suite. Nor did the
     * old after-checks have tests. This block is what was missing.
     *
     * EVERY FOREIGN ROW IS CHOSEN SO A LEAK IS SAFE AND LOUD. A leaked lookup
     * must answer with something other than 404 WITHOUT reaching a network:
     * postings in `failed` (reconcile and reverse both 409 before any
     * QuickBooks call), a receipt already `settled` (409 before any chain
     * read), a rename with nothing to change (400 before any write). The post
     * route is deliberately not probed with a foreign draft — a leak there
     * would go on to ask QuickBooks for the currency — so the getter it uses
     * is tested directly instead.
     */
    console.log("\n== lookups by id are scoped in SQL ==");
    {
      const { getDraftInCompany, getPostingInCompany } = await import("../src/db/qbo-postings.js");
      const { getEndpointInCompany } = await import("../src/db/earning-endpoints.js");
      const { getReceiptInCompany } = await import("../src/db/receipts.js");

      const foreignEndpoint = randomUUID();
      const foreignReceipt = randomUUID();
      const foreignDraft = randomUUID();
      const foreignPosting = randomUUID();
      const at = "2099-06-01T00:00:00.000Z";

      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO earning_endpoints (id, agent_id, public_id, origin_url, label, price_base_units,
                                        forward_secret, ownership_nonce, enabled, created_at, updated_at)
         VALUES (?, ?, ?, 'http://127.0.0.1:9/x', 'Foreign Endpoint', 1000, 'x', 'x', 0, ?, ?)`,
      ).run(foreignEndpoint, otherAgent, randomBytes(12).toString("base64url"), at, at);
      db.prepare(
        `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status, payer_address,
                               authorization_nonce, created_at, settled_at)
         VALUES (?, ?, ?, 1000, 'settled', ?, ?, ?, ?)`,
      ).run(foreignReceipt, otherAgent, foreignEndpoint, `0x${"b".repeat(40)}`, randomBytes(32).toString("hex"), at, at);
      db.prepare(
        `INSERT INTO qbo_posting_drafts (id, company_id, grain, posting_day, direction, counterparty,
                                         doc_number, payload_json, payload_hash, source_fingerprint,
                                         status, created_at)
         VALUES (?, ?, 'daily', '2099-06-01', 'spend', NULL, 'FUEL-FOREIGN', '{}', 'h', 'f', 'previewed', ?)`,
      ).run(foreignDraft, otherCompany, at);
      db.prepare(
        `INSERT INTO qbo_postings (id, company_id, draft_id, doc_number, request_id, status, created_at)
         VALUES (?, ?, ?, 'FUEL-FOREIGN', ?, 'failed', ?)`,
      ).run(foreignPosting, otherCompany, foreignDraft, randomUUID(), at);
      db.exec("COMMIT");

      // Positive controls first. A getter that returned null for EVERYTHING
      // would pass every "invisible to the other company" check below.
      assert(getEndpointInCompany(foreignEndpoint, otherCompany) !== null, "the endpoint is visible to its own company");
      assert(getReceiptInCompany(foreignReceipt, otherCompany) !== null, "the receipt is visible to its own company");
      assert(getDraftInCompany(foreignDraft, otherCompany) !== null, "the draft is visible to its own company");
      assert(getPostingInCompany(foreignPosting, otherCompany) !== null, "the posting is visible to its own company");

      assertEqual(getEndpointInCompany(foreignEndpoint, company.id), null, "and invisible to this one: endpoint");
      assertEqual(getReceiptInCompany(foreignReceipt, company.id), null, "and invisible to this one: receipt");
      assertEqual(getDraftInCompany(foreignDraft, company.id), null, "and invisible to this one: draft");
      assertEqual(getPostingInCompany(foreignPosting, company.id), null, "and invisible to this one: posting");

      // And through the routes, where a leak would show as a non-404.
      const probes: [string, string, unknown][] = [
        [`/api/earning-endpoints/${foreignEndpoint}`, "PATCH", {}],
        [`/api/receipts/${foreignReceipt}/reconcile`, "POST", {}],
        [`/api/integrations/quickbooks/postings/${foreignPosting}/reconcile`, "POST", {}],
        [`/api/integrations/quickbooks/postings/${foreignPosting}/reverse`, "POST", {}],
      ];
      for (const [path, method, body] of probes) {
        const res = await send(path, method, OPERATOR_KEY, body);
        assertEqual(res.status, 404, `${method} ${path.replace(/[0-9a-f-]{36}/, ":foreign")} is a 404`);
      }
      for (const id of [foreignDraft, foreignPosting]) {
        const trace: any = await call(`/api/integrations/quickbooks/postings/${id}/trace`);
        assertEqual(trace.status, 404, "tracing another company's draft or posting is a 404");
        assert(!trace.text.includes("FUEL-FOREIGN"), "and returns nothing of it");
      }
      // Unchanged by the probes: a leak that 404'd afterwards but wrote first
      // would still be a leak.
      const label = db.prepare("SELECT label FROM earning_endpoints WHERE id = ?").get(foreignEndpoint) as { label: string };
      assertEqual(label.label, "Foreign Endpoint", "the foreign endpoint was not modified");
    }
    console.log(`   ${checks} checks so far`);

    console.log("\n== the ledger merges both directions ==");
    {
      const PAYER = "0xfeedfacefeedfacefeedfacefeedfacefeedface";
      const HASH = "0x" + "cd".repeat(32);

      const all: any[] = [];
      let cursor: string | null = null;
      const texts: string[] = [];
      do {
        const res: any = await call(`/api/activity?limit=50${cursor ? `&cursor=${cursor}` : ""}`);
        assertEqual(res.status, 200, "paging the merged ledger stays 200");
        texts.push(res.text);
        all.push(...res.body.activity);
        cursor = res.body.page.nextCursor;
      } while (cursor);

      const earn = all.filter((r) => r.direction === "earn");
      const spend = all.filter((r) => r.direction === "spend");
      assert(earn.length >= 3, "the seeded receipts reach the ledger as earn rows");
      assert(spend.length > 0, "and payments still reach it as spend rows");

      /*
       * THE BOUNDARY, ON DELIVERED BYTES. Not on a type and not on the row
       * object: closing ADR 0005 took two attempts because a TypeScript
       * annotation is erased at build time, so it stops a field being rendered
       * without stopping it being transmitted. db/ledger.ts never loads these
       * columns onto an earn row, and this is the assertion that the second
       * lock — the API's field-by-field pick — is not the only thing holding.
       */
      for (const text of texts) {
        assert(
          !text.toLowerCase().includes(PAYER.toLowerCase()),
          "no ledger page carries a payer address",
        );
        assert(
          !text.toLowerCase().includes(HASH.toLowerCase()),
          "no ledger page carries a settlement hash",
        );
        assert(!/"(payerAddress|authorizationNonce|txHash|detail)"/.test(text),
          "no ledger page carries a withheld field name at all");
        for (const term of NO_CRYPTO) {
          assert(!text.toLowerCase().includes(term), `no ledger page says "${term}" (ADR 0006)`);
        }
      }

      /*
       * ORDERING ACROSS THE MERGE. One cursor over two tables is only legal
       * while (created_at, id) is a total order over the union, so the merged
       * sequence must be monotone — not merely each table's own.
       */
      for (let i = 1; i < all.length; i++) {
        const prev = all[i - 1];
        const row = all[i];
        assert(
          prev.createdAt > row.createdAt ||
            (prev.createdAt === row.createdAt && prev.id > row.id),
          "the merged page is strictly ordered by (createdAt, id), newest first",
        );
      }
      assertEqual(
        new Set(all.map((r) => `${r.direction}:${r.id}`)).size,
        all.length,
        "a full walk of the merged ledger repeats no row",
      );

      /*
       * DIRECTION FILTER, and the arithmetic that proves it partitions rather
       * than samples: the two halves must add back up to the whole.
       */
      const onlySpend: any = await call("/api/activity?limit=100&direction=spend");
      const onlyEarn: any = await call("/api/activity?limit=100&direction=earn");
      assert(
        onlySpend.body.activity.every((r: any) => r.direction === "spend"),
        "direction=spend returns no earn rows",
      );
      assert(
        onlyEarn.body.activity.every((r: any) => r.direction === "earn"),
        "direction=earn returns no spend rows",
      );
      assertEqual(onlyEarn.body.activity.length, earn.length, "direction=earn returns all of them");
      assertEqual(
        (await call("/api/activity?direction=sideways")).status,
        400,
        "an unknown direction is refused, not ignored",
      );

      /*
       * DEMO EXCLUDES THE EARN SIDE. `receipts` has no is_demo column because no
       * path writes a demo receipt, so demo=true must drop the arm rather than
       * return real revenue inside a view whose entire purpose is to isolate
       * fabricated data. demo=false includes every receipt, because every
       * receipt is real.
       */
      const demoTrue: any = await call("/api/activity?limit=100&demo=true");
      assert(
        demoTrue.body.activity.every((r: any) => r.direction === "spend"),
        "demo=true returns no earn rows, because no receipt is demo data",
      );
      const demoFalse: any = await call("/api/activity?limit=100&demo=false");
      assertEqual(
        demoFalse.body.activity.filter((r: any) => r.direction === "earn").length,
        earn.length,
        "demo=false keeps every earn row, because every receipt is real",
      );

      /*
       * THE STATUS SPLIT. A word from one vocabulary must drop the other arm
       * entirely — NOT leave it unfiltered, which is the failure that would
       * return every receipt ever written in answer to ?status=blocked.
       */
      const blocked: any = await call("/api/activity?limit=100&status=blocked");
      assertEqual(
        blocked.body.activity.filter((r: any) => r.direction === "earn").length,
        0,
        "an outbound-only status returns no earn rows at all",
      );
      const servedUnsettled: any = await call("/api/activity?limit=100&status=served_unsettled");
      assert(
        servedUnsettled.body.activity.length > 0 &&
          servedUnsettled.body.activity.every((r: any) => r.direction === "earn"),
        "an inbound-only status returns only earn rows",
      );
      /*
       * And the one shared word reaches BOTH arms. `settled` is the single
       * member of both vocabularies, and it means the same event on each side,
       * so it must not be treated as belonging to whichever one it was matched
       * against first.
       */
      const settled: any = await call("/api/activity?limit=100&status=settled");
      assert(
        settled.body.activity.some((r: any) => r.direction === "spend") &&
          settled.body.activity.some((r: any) => r.direction === "earn"),
        "the one status both vocabularies share reaches both arms",
      );
      assert(
        settled.body.activity.every((r: any) => r.status === "settled"),
        "and narrows both arms to it",
      );
      // A well-formed question with no rows in it is an empty page, not a 400.
      const impossible: any = await call("/api/activity?direction=earn&status=blocked");
      assertEqual(impossible.status, 200, "a contradictory but valid filter pair is not an error");
      assertEqual(impossible.body.activity.length, 0, "it is simply empty");

      /*
       * THE COUNTERPARTY RENAME. A spend row's counterparty is the merchant
       * host; an earn row's is the endpoint's label in the books. One column,
       * two sources, and neither is ever the payer.
       */
      for (const row of all) {
        assertEqual(typeof row.counterparty, "string", "every row names a counterparty");
        assert(row.counterparty.length > 0, "and never as an empty string");
      }
      assert(
        earn.every((r: any) => r.isDemo === false && r.refusal === null && r.approval === null),
        "an earn row's spend-only fields are true statements, not padding",
      );
    }

    console.log("\n== agent names are per team, and every agent gets its own vault ==");
    {
      const custody = await import("../src/agents/create.js");
      const { createAgentWithCustody, vaultNameFor, AgentNameTakenError, VaultAlreadyHeldError } =
        custody;

      /*
       * A STUB THAT BEHAVES LIKE FIREBLOCKS WHERE IT MATTERS. The real
       * provisionAgentWallet is idempotent by vault NAME: ask for a name that
       * exists and you get that vault back. A stub that minted a fresh vault
       * per call would make the vault-naming check below pass even with vaults
       * named after agents, because the hazard is precisely the reuse. So the
       * stub reuses, by name, exactly as the real one does. It never reaches
       * the network.
       */
      const vaultsByName = new Map<string, string>();
      const provisionCalls: string[] = [];
      let gate: Promise<void> | null = null;
      let duringProvision: (() => void) | null = null;
      const stub = async (vaultName: string) => {
        provisionCalls.push(vaultName);
        if (gate) await gate;
        duringProvision?.();
        let vault = vaultsByName.get(vaultName);
        if (!vault) {
          vault = `stub-vault-${randomUUID()}`;
          vaultsByName.set(vaultName, vault);
        }
        return { vaultAccountId: vault, address: `0xstub${vault.slice(-8)}` };
      };

      const insertCompanyWithTeam = (label: string): string => {
        const companyId = randomUUID();
        const teamId = randomUUID();
        db.prepare(
          "INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES (?, ?, 0, ?)",
        ).run(companyId, `${label} ${companyId.slice(0, 8)}`, "2099-01-01T00:00:00.000Z");
        db.prepare(
          "INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at) VALUES (?, ?, 'Team', 0, ?)",
        ).run(teamId, companyId, "2099-01-01T00:00:00.000Z");
        return teamId;
      };
      const teamA = insertCompanyWithTeam("Custody A");
      const teamB = insertCompanyWithTeam("Custody B");
      const name = `researcher-${randomUUID().slice(0, 8)}`;
      const rejects = async (promise: Promise<unknown>, type: Function): Promise<boolean> => {
        try {
          await promise;
          return false;
        } catch (error) {
          return error instanceof type;
        }
      };

      // POSITIVE CONTROL. Without it every refusal below could pass against a
      // function that refuses everything.
      const first = await createAgentWithCustody({ name, teamId: teamA, spendCapBaseUnits: 0n }, stub);
      assertEqual(first.name, name, "an agent is created with a fresh name");
      assertEqual(provisionCalls.length, 1, "which provisioned exactly once");
      assertEqual(provisionCalls[0], vaultNameFor(first.id), "for a vault named after the agent's id");
      assert(!provisionCalls[0]!.includes(name), "and the vault name does not contain the agent's name");

      // THE CUSTODY HOLE. Same name, another company. Named after agents, the
      // idempotent provisioner would hand this one company A's vault.
      const twin = await createAgentWithCustody({ name, teamId: teamB, spendCapBaseUnits: 0n }, stub);
      assert(twin.id !== first.id, "the same name is accepted in another company's team");
      assert(
        twin.fireblocksVaultId !== first.fireblocksVaultId,
        "and that agent gets its OWN vault, not the first company's",
      );

      // REFUSED BEFORE CUSTODY. The UNIQUE constraint would also refuse this,
      // but only after a vault existed -- so what is asserted is that the
      // provisioner was never called.
      const callsBefore = provisionCalls.length;
      assert(
        await rejects(createAgentWithCustody({ name, teamId: teamA, spendCapBaseUnits: 0n }, stub), AgentNameTakenError),
        "a name already used in the team is refused",
      );
      assertEqual(provisionCalls.length, callsBefore, "before any vault is provisioned");

      // THE RACE. Two requests for one new name, both past the lookup before
      // either writes: the reservation must refuse the second before its await.
      const raced = `raced-${randomUUID().slice(0, 8)}`;
      // The gate holds the first request inside its provisioning await long
      // enough for the second to arrive. Opened on a timer rather than by the
      // second request settling, so that with the reservation removed -- when
      // both requests wait on it -- this still finishes and FAILS rather than
      // hanging.
      gate = new Promise<void>((resolve) => setTimeout(resolve, 50));
      const callsBeforeRace = provisionCalls.length;
      const one = createAgentWithCustody({ name: raced, teamId: teamA, spendCapBaseUnits: 0n }, stub);
      const two = createAgentWithCustody({ name: raced, teamId: teamA, spendCapBaseUnits: 0n }, stub);
      const settledPair = await Promise.allSettled([one, two]);
      gate = null;
      assertEqual(
        provisionCalls.length - callsBeforeRace,
        1,
        "two concurrent creations of one name provision one vault, not two",
      );
      assert(
        settledPair.filter((r) => r.status === "fulfilled").length === 1 &&
          settledPair.some((r) => r.status === "rejected" && r.reason instanceof AgentNameTakenError),
        "and exactly one of them succeeds, the other refused as a name clash",
      );
      assert(
        await rejects(createAgentWithCustody({ name: raced, teamId: teamA, spendCapBaseUnits: 0n }, stub), AgentNameTakenError),
        "the reservation is released: a later attempt meets the real row, not a stale lock",
      );
      const freed = `freed-${randomUUID().slice(0, 8)}`;
      await createAgentWithCustody(
        { name: freed, teamId: teamA, spendCapBaseUnits: 0n },
        async () => {
          throw new Error("provisioning failed");
        },
      ).catch(() => undefined);
      assertEqual(
        (await createAgentWithCustody({ name: freed, teamId: teamA, spendCapBaseUnits: 0n }, stub)).name,
        freed,
        "and a failed provisioning releases it too, so the name is not locked out",
      );

      // THE BACKSTOP, when another PROCESS wins between the lookup and the
      // write -- which no in-process reservation can see.
      const lateName = `late-${randomUUID().slice(0, 8)}`;
      duringProvision = () => {
        db.prepare(
          `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address, spend_cap_base_units, created_at)
           VALUES (?, ?, ?, ?, '0xelsewhere', 0, ?)`,
        ).run(randomUUID(), lateName, teamA, `elsewhere-${randomUUID()}`, "2099-01-01T00:00:00.000Z");
      };
      assert(
        await rejects(createAgentWithCustody({ name: lateName, teamId: teamA, spendCapBaseUnits: 0n }, stub), AgentNameTakenError),
        "a clash only the database sees is still a name clash, not a raw error",
      );
      duringProvision = null;
      assertEqual(
        Number((db.prepare("SELECT COUNT(*) AS n FROM agents WHERE team_id = ? AND name = ?").get(teamA, lateName) as { n: number }).n),
        1,
        "and it wrote no second row",
      );

      const heldVault = first.fireblocksVaultId;
      assert(
        await rejects(
          createAgentWithCustody(
            { name: `stolen-${randomUUID().slice(0, 8)}`, teamId: teamB, spendCapBaseUnits: 0n },
            async () => ({ vaultAccountId: heldVault, address: "0xstolen" }),
          ),
          VaultAlreadyHeldError,
        ),
        "a provisioner that hands back a vault another agent holds is refused",
      );
      assertEqual(
        Number((db.prepare("SELECT COUNT(*) AS n FROM agents WHERE fireblocks_vault_id = ?").get(heldVault) as { n: number }).n),
        1,
        "and the vault still has exactly one agent",
      );

      // THE CONSTRAINTS THEMSELVES, below every piece of application code.
      const insertAgent = (teamId: string, agentName: string, vault: string) =>
        db
          .prepare(
            `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address, spend_cap_base_units, created_at)
             VALUES (?, ?, ?, ?, '0xraw', 0, '2099-01-01T00:00:00.000Z')`,
          )
          .run(randomUUID(), agentName, teamId, vault);
      const refusedBy = (fn: () => unknown, pattern: RegExp): boolean => {
        try {
          fn();
          return false;
        } catch (error) {
          return pattern.test((error as Error).message);
        }
      };
      assert(
        refusedBy(() => insertAgent(teamA, name, `raw-${randomUUID()}`), /UNIQUE constraint failed: agents\.team_id, agents\.name/),
        "the database refuses a second agent with one name in one team",
      );
      assert(
        refusedBy(() => insertAgent(teamB, `raw-${randomUUID().slice(0, 8)}`, heldVault), /UNIQUE constraint failed: agents\.fireblocks_vault_id/),
        "the database refuses a second agent on one vault, even in another company",
      );
      const rawName = `raw-${randomUUID().slice(0, 8)}`;
      insertAgent(teamA, rawName, `raw-${randomUUID()}`);
      insertAgent(teamB, rawName, `raw-${randomUUID()}`);
      assert(true, "but one name in two teams, on two vaults, is accepted");

      // OVER HTTP. Refused before the provisioner -- which in this process has
      // no credentials, so reaching it would be a 500, not a 409.
      const bootstrapTeam = (
        db.prepare("SELECT id FROM teams WHERE company_id = ? ORDER BY created_at LIMIT 1").get(bootstrapCompany().id) as { id: string }
      ).id;
      const takenName = `http-taken-${randomUUID().slice(0, 8)}`;
      insertAgent(bootstrapTeam, takenName, `raw-${randomUUID()}`);
      const agentsBeforeHttp = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
      const clash = await send("/api/agents", "POST", OPERATOR_KEY, {
        name: `  ${takenName} `,
        teamId: bootstrapTeam,
        spendCapUsd: "1.00",
      });
      assertEqual(clash.status, 409, "POST /api/agents answers a taken name with 409, before custody");
      assert(!/vault|fireblocks/i.test(clash.text), "and its message names no custody detail");
      assertEqual(
        (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n,
        agentsBeforeHttp,
        "and wrote nothing",
      );

      // A PROVISIONING FAILURE SAYS NOTHING ABOUT CUSTODY. This process has no
      // Fireblocks credentials, so a fresh name gets past every refusal and the
      // real provisioner throws at requireEnv -- before any client exists, so
      // no request is made. Its text names the credential; the response must not.
      const agentsBeforeFailure = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
      const failed = await send("/api/agents", "POST", OPERATOR_KEY, {
        name: `http-fresh-${randomUUID().slice(0, 8)}`,
        teamId: bootstrapTeam,
        spendCapUsd: "1.00",
      });
      assertEqual(failed.status, 500, "a provisioning failure is a 500");
      assert(
        !/fireblocks|vault|FIREBLOCKS_|\.env/i.test(failed.text),
        "whose body carries no provider or custody detail",
      );
      assertEqual(
        (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n,
        agentsBeforeFailure,
        "and no agent row exists without a vault behind it",
      );

      // The route cannot reach the provisioner except through the ordered path.
      const routeSource = withoutComments(readFileSync("src/api.ts", "utf8"));
      assert(!/provisionAgentWallet/.test(routeSource), "the route layer never calls the provisioner directly");

      // The repair script writes the vault name out rather than importing it
      // (the import would boot the migration that refuses the database it
      // repairs), so the two formulas are pinned together here.
      const script = readFileSync("scripts/remediate-shared-vault.ts", "utf8");
      assertEqual(vaultNameFor("X"), "fuel-agent-X", "vault names are fuel-agent-<agent id>");
      assert(script.includes("`fuel-agent-${FIXTURE_ID}`"), "and the repair script names its vault the same way");
      assert(
        !/from\s+["'][^"']*src\/db\//.test(withoutComments(script)) &&
          !/import\(\s*["'][^"']*src\/db\//.test(withoutComments(script)),
        "and never imports the database module whose migration it has to get past",
      );
    }

    /* ---- two companies, two people, one sweep (Commit D) ---------------- */
    console.log("\n== two signed-in people, two companies, nothing shared");
    {
      /**
       * THE TEST THAT TURNS "A SEAM" INTO "ISOLATION", for the routes it covers.
       *
       * ADR 0009 called the tenancy a seam rather than isolation, and it was
       * right to: with one company in the database and one shared key bound to
       * it, no test could tell a route that scopes correctly from a route that
       * scopes to the only company there is. Stage 3 is what makes the
       * distinction observable, because a second company with its own signed-in
       * person can finally exist.
       *
       * WHAT IT SWEEPS: every OPERATOR read that returns rows. The approach is
       * deliberately blunt — collect the identifiers that belong to company A,
       * sign in as somebody at company B, and assert that not one of those
       * strings appears anywhere in any response. A per-route assertion about
       * which fields should match would test my idea of the response shape; a
       * substring sweep tests the property that actually matters, which is that
       * A's data does not leave the building.
       *
       * The control matters as much as the sweep: the same routes, read by A's
       * own person, MUST contain those identifiers. Without it a route that
       * returned nothing at all — or that was broken for everyone — would sail
       * through.
       */
      const alpha = bootstrapCompany();

      const { createCompany } = await import("../src/db/companies.js");
      const beta = createCompany({
        name: `Sweep Co ${randomUUID().slice(0, 8)}`,
        spendCapBaseUnits: 500_000n,
      });

      const SWEEP_PASSWORD = "correct-horse-battery-staple";
      async function personAt(companyId: string): Promise<string> {
        const email = `sweep-${randomUUID()}@example.com`;
        createUser({
          companyId,
          email,
          passwordHash: await hashPassword(SWEEP_PASSWORD),
          role: "owner",
        });
        resetLoginLimits();
        const res = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ company: handleFor(companyId), email, password: SWEEP_PASSWORD }),
        });
        if (res.status !== 200) throw new Error(`sweep sign-in failed: ${res.status}`);
        const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`));
        if (!line) throw new Error("sweep sign-in set no cookie");
        return line.split(";")[0]!;
      }

      const atAlpha = await personAt(alpha.id);
      const atBeta = await personAt(beta.id);

      /*
       * Beta gets real furniture of its own, so the sweep is comparing two
       * populated companies rather than one populated and one empty. An empty
       * company would make every "beta cannot see alpha" assertion pass for the
       * uninteresting reason that beta's reads return nothing.
       */
      const betaTeam = randomUUID();
      const betaAgent = randomUUID();
      db.prepare(
        `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
         VALUES (?, ?, 'Sweep Team', 250000, ?)`,
      ).run(betaTeam, beta.id, "2099-03-02T00:00:00.000Z");
      db.prepare(
        `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                             spend_cap_base_units, created_at)
         VALUES (?, 'sweep-agent', ?, ?, '0xsweep', 100000, ?)`,
      ).run(betaAgent, betaTeam, `vault-${randomUUID()}`, "2099-03-02T00:00:00.000Z");

      /*
       * The identifiers that belong to alpha and must never appear in a
       * response to beta. Read out of the database rather than hardcoded, so
       * this keeps meaning something as the fixtures above change.
       */
      const alphaIds = new Set<string>([alpha.id]);
      for (const row of db
        .prepare(
          `SELECT a.id AS agent_id, t.id AS team_id
             FROM agents a JOIN teams t ON t.id = a.team_id
            WHERE t.company_id = ?`,
        )
        .all(alpha.id) as unknown as { agent_id: string; team_id: string }[]) {
        alphaIds.add(row.agent_id);
        alphaIds.add(row.team_id);
      }
      for (const row of db
        .prepare(
          `SELECT r.id AS id FROM approval_requests r
             JOIN agents a ON a.id = r.agent_id
             JOIN teams  t ON t.id = a.team_id
            WHERE t.company_id = ?`,
        )
        .all(alpha.id) as unknown as { id: string }[]) {
        alphaIds.add(row.id);
      }
      assert(alphaIds.size > 3, "the sweep found real identifiers at the first company to look for");

      const SWEPT_ROUTES = [
        "/api/company",
        "/api/teams",
        "/api/agents",
        "/api/approvals",
        "/api/approvals?status=pending",
        "/api/activity",
        "/api/earning-endpoints",
        "/api/receipts",
        "/api/postings",
        "/api/exports/transactions.csv",
        "/api/exports/postings.csv",
        "/api/integrations/quickbooks/status",
        "/api/integrations/quickbooks/drafts",
        "/api/integrations/quickbooks/postings",
        "/api/users",
        "/api/invites",
      ];

      async function readAs(cookie: string, path: string): Promise<{ status: number; text: string }> {
        const res = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
        return { status: res.status, text: await res.text() };
      }

      let leaks = 0;
      for (const path of SWEPT_ROUTES) {
        const mine = await readAs(atBeta, path);
        assert(
          mine.status < 500,
          `${path}: answers beta's person without a server error (got ${mine.status})`,
        );
        const found = [...alphaIds].filter((id) => mine.text.includes(id));
        if (found.length > 0) leaks += 1;
        assert(
          found.length === 0,
          `${path}: carries nothing belonging to the other company (found ${found.slice(0, 2).join(", ")})`,
        );
      }
      assertEqual(leaks, 0, "no swept route leaked across the two companies");

      /*
       * THE CONTROL, AND IT IS NOT OPTIONAL. Every assertion above would also
       * hold if these routes returned empty bodies, 403s, or nothing at all.
       * The same reads, made by alpha's own person, have to CONTAIN alpha's
       * identifiers — otherwise the sweep is measuring breakage, not isolation.
       */
      let sawAlphaData = 0;
      for (const path of ["/api/company", "/api/teams", "/api/agents", "/api/approvals"]) {
        const mine = await readAs(atAlpha, path);
        assertEqual(mine.status, 200, `(control) ${path}: alpha's own person can read it`);
        if ([...alphaIds].some((id) => mine.text.includes(id))) sawAlphaData += 1;
      }
      assertEqual(
        sawAlphaData,
        4,
        "(control) and every one of those routes really does return this company's own rows, so the sweep above was not passing on empty responses",
      );

      /*
       * And the reverse direction, so the sweep is not accidentally asymmetric:
       * alpha must not see beta's agent either.
       */
      const alphaSeesBeta = await readAs(atAlpha, "/api/agents");
      assert(
        !alphaSeesBeta.text.includes(betaAgent),
        "and the first company cannot see the second's agent either — the isolation runs both ways",
      );
      const betaSeesOwn = await readAs(atBeta, "/api/agents");
      assert(
        betaSeesOwn.text.includes(betaAgent),
        "(control) while beta's person does see beta's own agent",
      );
    }
    console.log(`   ${checks} checks so far`);

    /* ---- the dashboard signs people in, and can decide (Commit C) -------- */
    console.log("\n== the dashboard signs in, and decides");
    {
      /**
       * WHAT THIS SECTION IS FOR, AND WHAT IT HONESTLY CANNOT REACH.
       *
       * Commit C moved the dashboard off a shared key and onto the viewer's
       * session, and gave the Approvals page the ability to decide. Two halves,
       * tested two different ways:
       *
       *   - THE API HALF is exercised for real, over a socket, with a cookie —
       *     because that is now the credential a decision arrives on, and a
       *     suite that only ever approved with a bearer key would keep passing
       *     long after the path a person uses had broken.
       *   - THE DASHBOARD HALF is Next code. Its guards are imported and asked
       *     real questions (they are ordinary modules), and the rest is checked
       *     by reading the source, in the same style as the *Unscoped guards.
       *
       * What neither half reaches: a real browser, a real cookie jar, and the
       * question of whether Next relays Set-Cookie the way this design assumes.
       * That is deliberately NOT faked here. It is listed in docs/roadmap.md as
       * a live check, because a stub of Next would only confirm what I assumed
       * Next does.
       */
      const company = bootstrapCompany();

      /** An agent belonging to the bootstrap company, for approvals to hang off. */
      const ownAgentRow = db
        .prepare(
          `SELECT a.id AS id FROM agents a
             JOIN teams t ON t.id = a.team_id
            WHERE t.company_id = ? LIMIT 1`,
        )
        .get(company.id) as { id: string } | undefined;
      if (!ownAgentRow) throw new Error("the bootstrap company has no agent to hang an approval on");

      const insertApproval = db.prepare(
        `INSERT INTO approval_requests
           (id, agent_id, amount_base_units, resource_url, blocked_scope, status, created_at, detail)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      );
      function pendingApproval(agentId: string): string {
        const id = randomUUID();
        insertApproval.run(id, agentId, 5000, "https://api.own.test/v1/decide", "company", "2099-03-01T00:00:00.000Z");
        return id;
      }

      /** Signs a fresh user in over real HTTP and returns the cookie header. */
      async function signIn(email: string, password: string, companyId: string): Promise<string> {
        const res = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ company: handleFor(companyId), email, password }),
        });
        if (res.status !== 200) throw new Error(`sign-in failed with ${res.status}`);
        const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`));
        if (!line) throw new Error("sign-in set no session cookie");
        return line.split(";")[0]!;
      }

      /** A decision, exactly as the dashboard's route handler would send it. */
      async function decideAs(
        cookie: string | null,
        id: string,
        decision: "approve" | "deny",
        origin: string | null = base,
      ) {
        const headers: Record<string, string> = {};
        if (cookie) headers.Cookie = cookie;
        if (origin) headers.Origin = origin;
        const res = await fetch(`${base}/api/approvals/${id}/${decision}`, { method: "POST", headers });
        const text = await res.text();
        let body: any = {};
        try {
          body = JSON.parse(text);
        } catch {
          /* asserted on as text */
        }
        return { status: res.status, body, text };
      }

      resetLoginLimits();

      const PASSWORD = "correct-horse-battery-staple";
      const DECIDER_EMAIL = `decider-${randomUUID()}@example.com`;
      const decider = createUser({
        companyId: company.id,
        email: DECIDER_EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        role: "operator",
      });
      const cookie = await signIn(DECIDER_EMAIL, PASSWORD, company.id);

      /* --- a signed-in person can decide, which is the whole point --------- */
      const toApprove = pendingApproval(ownAgentRow.id);
      const approved = await decideAs(cookie, toApprove, "approve");
      assertEqual(approved.status, 200, "a signed-in person can approve a held payment");
      assertEqual(approved.body.status, "approved", "and the decision is recorded");
      assertEqual(
        (await decideAs(cookie, toApprove, "approve")).status,
        409,
        "a second approval is still 409 — a session gets no weaker guard than a key did",
      );

      const toDeny = pendingApproval(ownAgentRow.id);
      assertEqual((await decideAs(cookie, toDeny, "deny")).status, 200, "a signed-in person can deny");

      /* --- and CSRF cannot make that decision for them --------------------- */
      const crossOrigin = pendingApproval(ownAgentRow.id);
      const forged = await decideAs(cookie, crossOrigin, "approve", "http://evil.example");
      assertEqual(
        forged.status,
        403,
        "a cross-origin POST carrying the cookie is refused — a browser cannot be made to approve a payment",
      );
      assertEqual(
        (db.prepare("SELECT status FROM approval_requests WHERE id = ?").get(crossOrigin) as { status: string }).status,
        "pending",
        "and the refusal happened before anything was written",
      );

      /*
       * THE CONTROL. Without this, the assertion above would also pass if the
       * route were simply broken for everyone — the commonest way a CSRF test
       * lies. An absent Origin is the shell workflow the stage promised to keep
       * working, so this proves the check discriminates rather than blocks.
       */
      assertEqual(
        (await decideAs(cookie, crossOrigin, "approve", null)).status,
        200,
        "(control) the same request with no Origin at all succeeds — curl still decides",
      );

      /* --- and it is still the caller's OWN company ------------------------ */
      {
        const { createCompany } = await import("../src/db/companies.js");
        const other = createCompany({ name: `Decide Co ${randomUUID().slice(0, 8)}`, spendCapBaseUnits: 100_000n });
        const OTHER_EMAIL = `other-${randomUUID()}@example.com`;
        createUser({
          companyId: other.id,
          email: OTHER_EMAIL,
          passwordHash: await hashPassword(PASSWORD),
          role: "owner",
        });
        const otherCookie = await signIn(OTHER_EMAIL, PASSWORD, other.id);
        const mine = pendingApproval(ownAgentRow.id);
        assertEqual(
          (await decideAs(otherCookie, mine, "approve")).status,
          404,
          "a signed-in person at another company cannot decide this company's payment",
        );
        assertEqual(
          (db.prepare("SELECT status FROM approval_requests WHERE id = ?").get(mine) as { status: string }).status,
          "pending",
          "and it stays pending",
        );
        /*
         * 404 AND NOT 403, deliberately. 403 would confirm the id names a real
         * approval somewhere, which is an existence oracle across tenants.
         */
        assert(
          !JSON.stringify(await decideAs(otherCookie, mine, "approve")).includes(company.id),
          "and the refusal names nothing about the company it belongs to",
        );
        // (control) the same person CAN decide their own company's rows, so the
        // refusal above is scoping rather than a session that cannot decide.
        const theirAgent = db
          .prepare(`SELECT a.id AS id FROM agents a JOIN teams t ON t.id = a.team_id WHERE t.company_id = ? LIMIT 1`)
          .get(other.id) as { id: string } | undefined;
        assert(
          theirAgent === undefined,
          "(control) a brand-new company has no agents, so this scoping test cannot be satisfied by an empty table",
        );
        assertEqual(
          (await decideAs(otherCookie, randomUUID(), "approve")).status,
          404,
          "(control) and an id that names nothing is the same 404 — the two are indistinguishable",
        );
      }

      /* --- the dashboard's own guards, imported and asked real questions --- */
      {
        const { refuseCrossOrigin } = await import("../dashboard/lib/same-origin.js");
        const mk = (headers: Record<string, string>) =>
          new Request("http://127.0.0.1:3100/api/approvals/x/decide", { method: "POST", headers });

        assertEqual(
          refuseCrossOrigin(mk({ origin: "http://127.0.0.1:3100", host: "127.0.0.1:3100" })),
          null,
          "the dashboard allows a write from its own origin",
        );
        const refused = refuseCrossOrigin(mk({ origin: "http://evil.example", host: "127.0.0.1:3100" }));
        assertEqual(refused?.status, 403, "and refuses one from anywhere else");
        /*
         * THE PORT IS PART OF IT. Cookies ignore the port, so on a developer's
         * machine anything else listening on loopback shares this cookie jar —
         * which makes a page served from :9999 a same-HOST, different-ORIGIN
         * attacker. Comparing hosts WITH ports is what separates them.
         */
        assertEqual(
          refuseCrossOrigin(mk({ origin: "http://127.0.0.1:9999", host: "127.0.0.1:3100" }))?.status,
          403,
          "a different PORT on the same host is a different origin, and is refused",
        );
        assertEqual(
          refuseCrossOrigin(mk({ host: "127.0.0.1:3100" })),
          null,
          "(control) a request with no Origin is allowed — non-browser clients send none",
        );
      }

      /* --- the two processes agree on the cookie's name -------------------- */
      {
        const { SESSION_COOKIE: dashboardName } = await import("../dashboard/lib/session-cookie.js");
        assertEqual(
          dashboardName,
          SESSION_COOKIE,
          "the dashboard and the API name the session cookie identically — they cannot import each other, so this is the only thing holding them together",
        );
      }

      /* --- the routing gate, asked about real paths ------------------------ */
      {
        const { middleware, config } = await import("../dashboard/middleware.js");
        const { NextRequest } = await import("../dashboard/node_modules/next/server.js");
        /*
         * The `host` header is set because a browser always sets one, and
         * because it is the input the gate actually reads. See the assertion
         * below for what happens without it.
         */
        const request = (path: string, cookieHeader?: string) => {
          const headers: Record<string, string> = { host: "127.0.0.1:3100" };
          if (cookieHeader) headers.cookie = cookieHeader;
          return new NextRequest(`http://127.0.0.1:3100${path}`, { headers });
        };
        const visit = (path: string, cookieHeader?: string) => middleware(request(path, cookieHeader));

        assertEqual(visit("/approvals").status, 307, "a visitor with no session is redirected");
        {
          /*
           * THE PATH IS ASSERTED AND THE HOST DELIBERATELY IS NOT.
           *
           * An earlier version of this checked the host too, and it was a
           * misleading test: it passed here while the real thing did something
           * else. Next's server REWRITES the origin of a middleware redirect
           * after middleware returns, so the value observable from inside this
           * process is not the value a browser receives. Asserting it would be
           * asserting a number that nothing downstream honours.
           *
           * What Next actually does with the origin is measured and recorded in
           * dashboard/middleware.ts, against a running production build, which
           * is the only place that question can honestly be answered.
           */
          const target = new URL(visit("/approvals").headers.get("location")!);
          assertEqual(target.pathname, "/login", "to the sign-in page");
          assertEqual(target.search, "", "with no query carried over from wherever they were going");
        }
        assertEqual(
          visit("/approvals", `${SESSION_COOKIE}=anything`).status,
          200,
          "(control) a visitor holding the cookie is let through, so the gate is not simply refusing everyone",
        );

        const gated = new RegExp(`^${config.matcher[0]}$`);
        /*
         * THE POSITIVE SIDE IS THE CONTROL. Without it, widening the exclusion
         * to everything would pass the list below with room to spare — the gate
         * would let the whole product through while every "deliberately does
         * not cover" assertion went green.
         */
        for (const path of ["/", "/approvals", "/agents", "/settings", "/api/approvals/x/decide", "/api/agents/x/cap"]) {
          assert(gated.test(path), `the gate covers ${path}`);
        }
        /*
         * A PAGE THAT HANDS OUT A COOKIE CANNOT REQUIRE ONE. Each path here is
         * part of getting signed in, so gating any of them is a redirect loop
         * by construction: the visitor is sent to /login to obtain the cookie
         * that /login itself now demands. /signup and /api/signup join the list
         * for exactly the reason /login and /api/session are already on it.
         */
        for (const path of [
          "/login",
          "/api/session",
          "/api/session/end",
          "/signup",
          "/api/signup",
          "/_next/static/chunk.js",
        ]) {
          assert(!gated.test(path), `the gate deliberately does not cover ${path}`);
        }

        /*
         * AN EXCLUSION IS A WHOLE SEGMENT, NEVER A PREFIX.
         *
         * Found by security review, and it is the kind that never announces
         * itself: a bare alternation inside the matcher's lookahead matches a
         * PREFIX, so a route merely STARTING with an excluded name inherits its
         * unauthenticated status. None of the paths below exists today, which is
         * precisely why this is a test rather than a code comment — the failure
         * would arrive with a future route, silently, in front of the one
         * surface in the product that mints identities.
         */
        for (const path of [
          "/signup-secret",
          "/signupadmin",
          "/login-as",
          "/api/session-refresh",
          "/api/signupBatch",
        ]) {
          assert(
            gated.test(path),
            `${path} is gated — an exclusion covers its own segment, not everything sharing its prefix`,
          );
        }
      }

      /* --- the dashboard holds no credential of its own -------------------- */
      {
        /** Every TypeScript source in the dashboard, excluding its dependencies. */
        function dashboardSources(dir: string, found: string[] = []): string[] {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (entry.name === "node_modules" || entry.name === ".next") continue;
              dashboardSources(path, found);
            } else if (/\.tsx?$/.test(entry.name) && entry.name !== "next-env.d.ts") {
              found.push(path);
            }
          }
          return found;
        }

        const sources = dashboardSources("dashboard");
        assert(sources.length > 20, "the dashboard source scan found files to scan");

        /*
         * THE DOCUMENTATION PAGE IS THE ONE ALLOWED MENTION, and it is named
         * rather than pattern-matched, in the style of the *Unscoped allowlist
         * above. /developer teaches a script author to call the Fuel API with a
         * bearer key, which is still exactly how a script authenticates. The
         * point of this guard is that the DASHBOARD does not, and an allowlist
         * of one keeps that distinction explicit instead of quietly widening.
         */
        const MAY_MENTION_BEARER = ["dashboard/app/developer/page.tsx"];

        for (const file of sources) {
          const raw = readFileSync(file, "utf8");
          const code = withoutComments(raw);
          assert(
            !/process\.env\.FUEL_API_KEY/.test(code),
            `${file} does not read FUEL_API_KEY — the dashboard holds no key`,
          );
          assert(
            !/process\.env\.FUEL_AGENT_KEY/.test(code),
            `${file} does not read FUEL_AGENT_KEY either`,
          );
          if (!MAY_MENTION_BEARER.includes(file)) {
            assert(
              !/Authorization/i.test(code),
              `${file} builds no Authorization header — a credential here would be a shared one`,
            );
          }
        }

        /*
         * AND THE SESSION IS FORWARDED BY NAME, NOT WHOLESALE. Passing the raw
         * `cookie` header through would hand Fuel every unrelated cookie the
         * browser holds for this host — and cookies ignore the port, so in
         * development that is every cookie set by anything on localhost.
         */
        const client = withoutComments(readFileSync(join("dashboard", "lib", "fuel.ts"), "utf8"));
        assert(
          /cookies\(\)\)\.get\(SESSION_COOKIE\)/.test(client),
          "the client reads the one named cookie",
        );
        assert(
          !/headers\(\)[\s\S]{0,40}\.get\(\s*["']cookie["']\s*\)/i.test(client),
          "and never forwards the raw cookie header wholesale",
        );
        assert(
          /redirect\(SIGN_IN\)/.test(client),
          "and a 401 from Fuel becomes a redirect to sign in, not an error reading 'Fuel could not be reached'",
        );
      }

      /* --- sign-in names the company (ADR 0018) ----------------------------- */
      {
        /*
         * SOURCE CHECKS, with the same honest limit as the signup ones below:
         * they establish the dashboard is WRITTEN to send the company, not that
         * it runs that way. The run is proven by signing in through the rebuilt
         * dashboard, which is a live step. Without the company the API answers
         * 400, so a relay that dropped it would lock everybody out, and nothing
         * the API tests above can see would change.
         */
        const loginPage = withoutComments(readFileSync("dashboard/app/login/page.tsx", "utf8"));
        assert(/<input[^>]*\bname="company"/.test(loginPage), "D1: the sign-in form asks for the company");
        assert(!/<select\b/.test(loginPage), "D1: typed, never picked from a list of companies");
        const relay = withoutComments(readFileSync("dashboard/app/api/session/route.ts", "utf8"));
        assert(/form\.get\(\s*["']company["']\s*\)/.test(relay), "D2: the sign-in relay reads the company from the form");
        assert(
          /startSession\(\s*company\s*,\s*email\s*,\s*password\s*,\s*client\s*\)/.test(relay),
          "D2: and passes it on to Fuel",
        );
        const fuelClient = withoutComments(readFileSync("dashboard/lib/fuel.ts", "utf8"));
        assert(
          /JSON\.stringify\(\{\s*company\s*,\s*email\s*,\s*password\s*\}\)/.test(fuelClient),
          "D3: startSession sends the company to /api/auth/login",
        );
        assert(
          /companyHandle:\s*String\(raw\.companyHandle/.test(fuelClient),
          "D4: the viewer carries the company's handle from /api/auth/me",
        );
        const badge = withoutComments(readFileSync("dashboard/components/shell/ViewerBadge.tsx", "utf8"));
        assert(/\{viewer\.companyHandle\}/.test(badge), "D4: and the badge shows it");
        assert(
          loginPage.includes('"That company, email and password do not match an account."'),
          "D5: the refusal names all three, as vague as the API's own",
        );
      }

      /* --- every dashboard write is same-origin checked -------------------- */
      {
        /*
         * DISCOVERED, NOT LISTED.
         *
         * This was a hand-maintained array of four paths. That made the check
         * useless against the thing it exists to catch: a NEW write route is
         * exactly the one somebody forgets, and a forgotten route was silently
         * unguarded while this block reported four passes. It now walks
         * dashboard/app/api and tests every route file exporting a mutating
         * handler, so a route is covered on the day it is written rather than
         * on the day it is remembered.
         */
        function routeFiles(dir: string, found: string[] = []): string[] {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) routeFiles(path, found);
            else if (/^route\.tsx?$/.test(entry.name)) found.push(path);
          }
          return found;
        }

        const MUTATING = /export\s+async\s+function\s+(POST|PATCH|PUT|DELETE)\b/;
        const writeRoutes = routeFiles("dashboard/app/api").filter((file) =>
          MUTATING.test(withoutComments(readFileSync(file, "utf8"))),
        );

        /*
         * A POSITIVE CONTROL ON THE WALK ITSELF.
         *
         * A walk that silently matched nothing would make every assertion below
         * vacuous — the suite would print a tidy row of passes for checks that
         * never ran, which is worse than no check at all. These are the write
         * routes that existed when this was written. The claim is that the walk
         * still finds them, NOT that the list is complete; completeness is the
         * walk's job and is precisely what stopped being hand-maintained.
         */
        for (const known of [
          "dashboard/app/api/session/route.ts",
          "dashboard/app/api/session/end/route.ts",
          "dashboard/app/api/approvals/[id]/decide/route.ts",
          "dashboard/app/api/agents/[id]/cap/route.ts",
        ]) {
          assert(writeRoutes.includes(known), `the write-route walk still finds ${known}`);
        }
        for (const file of writeRoutes) {
          const code = withoutComments(readFileSync(file, "utf8"));
          assert(
            /refuseCrossOrigin\(req\)/.test(code),
            `${file} runs the same-origin check`,
          );
          assert(
            /if \(blocked\) return blocked/.test(code),
            `${file} RETURNS on that check rather than computing it and carrying on`,
          );
        }

        /*
         * The guard is imported, never re-implemented. Four hand-written copies
         * of a CSRF check is three chances for one to drift into a weaker
         * version, which is why Commit C extracted it.
         */
        for (const file of writeRoutes) {
          const code = withoutComments(readFileSync(file, "utf8"));
          assert(
            !/headers\.get\(\s*["']origin["']\s*\)/i.test(code),
            `${file} does not read the Origin header itself — it uses the shared guard`,
          );
        }
      }

      /* --- redeeming an invite in a browser --------------------------------- */
      {
        /*
         * SOURCE ASSERTIONS, NOT A DRIVEN HANDLER, AND THE REASON IS STRUCTURAL.
         *
         * This route imports through the "@/" alias, which only Next resolves,
         * so it cannot be imported here — the same constraint middleware.ts
         * documents, and the reason middleware.ts alone uses a relative import.
         * Every other dashboard route handler is checked this way for the same
         * reason.
         *
         * WHAT THAT MEANS THESE DO NOT PROVE, said plainly rather than left for
         * somebody to discover: they read the file, so they establish the code
         * is WRITTEN in the right order, not that it RUNS that way. The same
         * honest limit the ApprovalDecision state-machine assertions carry. The
         * behaviour they stand in for is proven end to end by redeeming a real
         * invite in a real browser, which is a step in the live walkthrough.
         */
        const route = withoutComments(readFileSync("dashboard/app/api/signup/route.ts", "utf8"));

        /*
         * THE ORDER IS THE SECURITY PROPERTY.
         *
         * Fuel has no self-serve password reset, so the confirmation field
         * exists to stop somebody creating an account they cannot open. But
         * WHERE it is checked decides something else: checked before the call,
         * a typo costs nothing; checked after, every mistyped confirmation
         * spends one of five rate-limited attempts against a single-use token
         * the person legitimately holds, and enough typos lock them out of
         * their own invitation.
         */
        const mismatchAt = route.indexOf("password !== confirm");
        const callAt = route.indexOf("redeemInvite(");
        assert(mismatchAt !== -1, "the signup route compares the password against its confirmation");
        assert(callAt !== -1, "and reaches Fuel through redeemInvite");
        assert(
          mismatchAt < callAt,
          "and compares them BEFORE calling Fuel, so a typo cannot spend an attempt on the invite",
        );

        assert(
          /result\.setCookie/.test(route),
          "a created account relays the API's own Set-Cookie lines rather than minting a cookie here",
        );
        /*
         * EVERY line, not the first one. The API may send more than one
         * Set-Cookie, and a relay that takes `[0]` would look correct in every
         * test that only checks a session exists while silently dropping
         * whatever else the API decided to set.
         */
        assert(
          /for \(const line of setCookie\)/.test(route),
          "and relays every Set-Cookie line the API sent, not just the first",
        );
        assert(
          !/cookies\(\)\.set\(/.test(route),
          "and the dashboard never sets the session cookie itself — the API decides its attributes",
        );
        assert(
          /status:\s*303/.test(route),
          "every outcome is a 303, so a refresh cannot re-submit the invite and the password",
        );

        /*
         * THE TOKEN MUST NOT REACH A URL. It is a live single-use credential;
         * a redirect carrying it would persist in browser history and in every
         * access log on the way. Only the refusal CODE is ever put in a query.
         */
        assert(
          !/[?&]t(oken)?=\$\{/.test(route) && !/seeOther\([^)]*token/.test(route),
          "no redirect out of this route carries the invite token",
        );

        /* --- the page ------------------------------------------------------- */
        const pageRaw = readFileSync("dashboard/app/signup/page.tsx", "utf8");
        const page = withoutComments(pageRaw);

        assert(!/"use client"/.test(page), "the signup page ships no client JavaScript");
        assert(
          /method="post"/.test(page) && /action="\/api\/signup"/.test(page),
          "it is a real form post, so it works before hydration and with JavaScript off",
        );
        assert(
          !/\?t=|searchParams\.(token|t)\b/.test(page),
          "and it never reads an invite token out of the URL — the code is typed in, not linked",
        );

        /*
         * NO MESSAGE IS EVER RENDERED FROM THE QUERY STRING. The only thing
         * taken from it is a key, and the only text shown is this page's own.
         * Rendering `e` directly would let whoever writes the link put their
         * sentence on a genuine Fuel page, which is a phishing page we would
         * have built ourselves.
         */
        assert(
          /NOTICES\[raw\]/.test(page),
          "the notice is a lookup keyed by the query parameter, never the parameter itself",
        );
        assert(
          !/\{\s*raw\s*\}/.test(page),
          "and the raw query value is never rendered into the page",
        );

        /*
         * THE TWO VOCABULARIES CANNOT DRIFT.
         *
         * An unknown code renders nothing, so a code the server learns to send
         * and this page has never heard of shows a person a blank refusal —
         * they are told nothing at all about why their account was not created.
         * This is the assertion that stops that being discovered by a person
         * rather than by the suite.
         */
        const { SIGNUP_CODES } = await import("../src/auth/codes.js");
        const noticeKeys = new Set(
          [...pageRaw.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]),
        );
        for (const code of SIGNUP_CODES) {
          assert(noticeKeys.has(code), `the signup page has a notice for the server code ${code}`);
        }
        for (const own of ["mismatch", "unreachable"]) {
          assert(
            noticeKeys.has(own),
            `and for ${own}, which this page owns because Fuel never sends it`,
          );
        }
      }

      /* --- a sign-out is never reported as a server failure ---------------- */
      {
        /*
         * `redirect()` throws a sentinel for Next to unwind to, so ANY `catch`
         * between the Fuel call and the framework swallows it — and the handler
         * then answers with a 502 whose message is the literal string
         * NEXT_REDIRECT. The operator is told Fuel is broken when in fact their
         * session simply ended. Every catch on that path must re-throw it.
         */
        const onThePath = [
          "dashboard/app/api/approvals/[id]/decide/route.ts",
          "dashboard/app/api/agents/[id]/cap/route.ts",
          "dashboard/app/api/quickbooks/route.ts",
          "dashboard/app/api/exports/transactions/route.ts",
          "dashboard/app/approvals/page.tsx",
          "dashboard/lib/fuel.ts",
        ];
        for (const file of onThePath) {
          const code = withoutComments(readFileSync(file, "utf8"));
          const catches = code.match(/\bcatch\s*(\(|\{)/g) ?? [];
          const rethrows = code.match(/unstable_rethrow\(/g) ?? [];
          assert(
            rethrows.length > 0,
            `${file} re-throws Next's control-flow errors rather than swallowing a sign-out`,
          );
          assert(
            catches.length > 0,
            `(control) ${file} actually has a catch for that to matter`,
          );
        }

        /*
         * And in the browser, a redirect must not be followed. With the default
         * `redirect: "follow"` the sign-in page comes back as HTML and
         * `res.json()` throws a parse error — "Unexpected token '<'" where the
         * honest answer is "you have been signed out".
         */
        const clients = [
          "dashboard/components/ApprovalDecision.tsx",
          "dashboard/components/AgentsRoster.tsx",
          "dashboard/components/AccountingWorkbench.tsx",
        ];
        for (const file of clients) {
          const code = withoutComments(readFileSync(file, "utf8"));
          assert(/redirect: "manual"/.test(code), `${file} does not follow a sign-in redirect`);
          assert(/sendToSignIn\(res\)/.test(code), `${file} acts on it`);
        }
      }

      /* --- a decision cannot be fired twice from one page ------------------ */
      {
        /*
         * THE CLIENT-SIDE HALF OF THE RACE ABOVE. verify-migration proves that
         * two operators colliding produce one decision; this is the commoner
         * collision, which is ONE operator double-clicking Approve. The server
         * would answer the second press with a 409 and no harm done, but the
         * operator would then be shown a refusal for a decision that actually
         * succeeded, which reads as "it did not work" for something that did.
         *
         * The mechanism is that `send()` moves the row into `sending` BEFORE it
         * awaits anything, and the sending branch renders no button at all — so
         * there is nothing left to press while a decision is in flight.
         *
         * WHAT THIS PROVES AND WHAT IT DOES NOT. It is a source assertion, so
         * it proves the state machine has that shape. It does not execute React,
         * so it cannot prove React flushes the state update between two clicks
         * arriving in separate tasks. That is a framework property, and the
         * honest place it was checked is the live run, not here.
         */
        const control = readFileSync(
          join("dashboard", "components", "ApprovalDecision.tsx"),
          "utf8",
        );
        const body = withoutComments(control);

        const sendFn = body.slice(body.indexOf("async function send("));
        const firstStatement = sendFn.slice(0, sendFn.indexOf("try {"));
        assert(
          /setMode\(\{ kind: "sending" \}\)/.test(firstStatement),
          "the decide control marks the row in flight BEFORE it awaits anything",
        );

        const sendingBranch = body.slice(
          body.indexOf('if (mode.kind === "sending")'),
          body.indexOf('if (mode.kind === "confirm")'),
        );
        assert(sendingBranch.length > 40, "(control) the sending branch was actually found");
        assert(
          !/<button/.test(sendingBranch),
          "and while it is in flight there is no button left to press, so one operator cannot fire two decisions",
        );
        /*
         * The control for that control: the buttons do exist elsewhere in the
         * component, so the assertion above is not passing because the file
         * has no buttons in it at all.
         */
        assert(
          (body.match(/<button/g) ?? []).length >= 4,
          "(control) the component does render buttons in its other states",
        );
      }

      /* --- the shell claims nothing it cannot support ---------------------- */
      {
        /*
         * SECURITY REVIEW FOUND THIS ONE, AND IT IS THE RECURRING DEFECT IN
         * THIS PROJECT RATHER THAN A NEW KIND OF BUG: a comment describing a
         * property the code did not have. ViewerBadge's docblock said it stayed
         * silent when Fuel could not be asked; the component rendered the words
         * "Signed in" in exactly that branch.
         *
         * It reaches a real browser because AppShell draws navigation from the
         * PRESENCE of a cookie, not its validity — so anyone holding
         * `fuel_session=anything` got a full menu and an assurance they were
         * signed in, until the page body's own fetch redirected them. No data
         * leaked; the claim was still false.
         */
        const badge = withoutComments(
          readFileSync(join("dashboard", "components", "shell", "ViewerBadge.tsx"), "utf8"),
        );
        assert(
          !/>\s*Signed in\s*</.test(badge),
          "the shell does not tell an unidentified viewer that they are signed in",
        );
        assert(
          /viewer \? \(/.test(badge),
          "(control) it still has the branch that would render such a claim, so the check above is not passing for want of code to check",
        );
        assert(
          /getViewer\(\)/.test(badge),
          "(control) and it still asks who the viewer is",
        );
      }

      /* --- the Approvals page offers the control only where it can act ----- */
      {
        const page = withoutComments(readFileSync(join("dashboard", "app", "approvals", "page.tsx"), "utf8"));
        assert(
          /approval\.status === "pending" && \(\s*<ApprovalDecision/.test(page),
          "only a pending row gets Approve and Deny — a decided one would earn a 409, and a button whose only outcome is a refusal is not a capability",
        );
        assert(
          !/Deciding is not available/.test(page),
          "and the page no longer says deciding is unavailable, because it is",
        );
      }
    }
    console.log(`   ${checks} checks so far`);

    console.log(`   ${checks} checks so far`);
  } finally {
    server.close();
  }

  /* ---- the test database ------------------------------------------------ */
  /*
   * The suites used to copy `fuel.db`. They now build their own database
   * (scripts/lib/test-db.ts), and these checks keep it that way. TD-2, that
   * each suite really opened the database it built, runs in each suite at the
   * point it first imports the database.
   */
  console.log("\n== the test database");
  {
    // TD-1. No suite, and nothing the suites use to build their database,
    // READS the real one: copies it, opens it, or points FUEL_DB_PATH at it.
    // Naming it is allowed -- TD-3 below hands it to the guard to prove it is
    // refused. Comments are stripped first: plenty of them explain what
    // `fuel.db` used to be used for. A tripwire for the plain mistake, not a
    // proof: a path built some other way would pass it, which is why TD-4 makes
    // the fallback unreachable as well.
    const READS_REAL_DB =
      /\b(?:copyFileSync|cpSync|copyFile|DatabaseSync|readFileSync|openSync|createReadStream)\s*\([^;)]*?["'`](?:\.\/)?fuel\.db["'`]|\bFUEL_DB_PATH\s*[:=][^;\n]*?["'`](?:\.\/)?fuel\.db["'`]/;
    // Built from parts so this file does not itself contain what it forbids.
    const realName = JSON.stringify(["fuel", "db"].join("."));
    const dotName = JSON.stringify(["./fuel", "db"].join("."));
    assert(
      READS_REAL_DB.test(`copyFileSync(${realName}, scratch)`) &&
        READS_REAL_DB.test(`copyFileSync(join(ROOT, ${dotName}), scratch)`) &&
        READS_REAL_DB.test(`{ ...process.env, FUEL_DB_PATH: ${realName} }`) &&
        READS_REAL_DB.test(`process.env.FUEL_DB_PATH = join(ROOT, ${realName})`) &&
        !READS_REAL_DB.test(`claimNewTempFile(${realName})`),
      "TD-1: (control) the pattern recognises a copy, a joined path and an env assignment, and nothing else",
    );
    const testCode = [
      ...readdirSync("scripts").filter((f) => /^verify-[\w-]+\.ts$/.test(f)).map((f) => join("scripts", f)),
      ...readdirSync(join("scripts", "lib")).filter((f) => f.endsWith(".ts")).map((f) => join("scripts", "lib", f)),
    ];
    assert(
      ["verify-api", "verify-arc-lock", "verify-earning", "verify-migration", "verify-pins", "verify-quickbooks", "verify-rollup", "verify-startup", "lib/test-db", "lib/seed-test-db", "lib/test-db-path", "lib/startup-fixtures"]
        .every((name) => testCode.includes(join("scripts", `${name}.ts`))),
      "TD-1: (control) the scan covers all eight suites, the three test-database files and the startup fixtures",
    );
    for (const file of testCode) {
      assert(
        !READS_REAL_DB.test(withoutComments(readFileSync(file, "utf8"))),
        `TD-1: ${file} never copies, opens or points FUEL_DB_PATH at fuel.db`,
      );
    }

    // TD-3. The seeder opens nothing but a new file in the temp directory.
    //
    // FIRST, FROM THE SOURCE: the seeder claims its file before anything that
    // can open a database is imported. Checked before the seeder is run below.
    const seederCode = withoutComments(readFileSync(join("scripts", "lib", "seed-test-db.ts"), "utf8"));
    const claimed = seederCode.indexOf("claimNewTempFile(target)");
    const firstDbImport = seederCode.indexOf('await import("../../src/db/index.js")');
    assert(
      claimed > 0 && firstDbImport > claimed,
      "TD-3: the seeder claims its file before it first imports the database",
    );
    assert(
      !/from\s+["'][^"']*\/src\//.test(seederCode) &&
        !/from\s+["'][^"']*\/src\//.test(withoutComments(readFileSync(join("scripts", "lib", "test-db-path.ts"), "utf8"))),
      "TD-3: neither the seeder nor its guard statically imports anything from src/",
    );

    // THE GUARD ITSELF, in this process. Its module imports nothing that can
    // open a database, so even `fuel.db` can be handed to it here with nothing
    // in reach that could open it if the guard were wrong.
    const { claimNewTempFile } = await import("./lib/test-db-path.js");
    const refusal = (target: string): string => {
      try {
        claimNewTempFile(target);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };

    // Refused as outside the temp directory -- or, where the checkout itself
    // lives in the temp directory (the pre-push hook's worktree, some CI),
    // as inside the repository. Either way, refused before anything is opened.
    const realBefore = existsSync("fuel.db");
    assert(
      /^refusing to build a test database (outside|inside the repository)/.test(refusal("fuel.db")),
      "TD-3: the guard refuses fuel.db itself",
    );
    assertEqual(existsSync("fuel.db"), realBefore, "TD-3: and leaves it exactly where it was, present or absent");

    // A name in the filesystem root: outside the temp directory wherever this
    // checkout lives, and not writable by a normal user, so even a broken
    // guard could not leave a file there.
    const outside = join("/", `.td3-${randomUUID()}.db`);
    assert(/^refusing to build a test database outside/.test(refusal(outside)), "TD-3: the guard refuses any path outside the temp directory");
    assert(!existsSync(outside), "TD-3: and creates nothing there");

    // TMPDIR pointed at the repository would make "inside the temp directory"
    // meaningless. The repository is refused on its own terms.
    const inRepo = join(process.cwd(), `.td3-${randomUUID()}.db`);
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = process.cwd();
    const inRepoRefusal = refusal(inRepo);
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    assert(/^refusing to build a test database inside the repository/.test(inRepoRefusal), "TD-3: the guard refuses the repository even when TMPDIR points there");
    assert(!existsSync(inRepo), "TD-3: and creates nothing there either");

    const existing = join(dirname(scratch), "already-here.db");
    writeFileSync(existing, "not a database");
    assert(/^refusing to build over an existing file/.test(refusal(existing)), "TD-3: the guard refuses a file that already exists");
    assertEqual(readFileSync(existing, "utf8"), "not a database", "TD-3: and leaves that file as it was");

    // A dangling link passes "does it exist?" -- there is nothing at the end of
    // it -- and an ordinary open would follow it and create its destination,
    // wherever that is. The atomic claim refuses anything at the name.
    const elsewhere = join(mkdtempSync(join(tmpdir(), "fuel-td3-")), "redirected.db");
    const link = join(dirname(scratch), "dangling-link.db");
    symlinkSync(elsewhere, link);
    assert(/^refusing to build over an existing file or link/.test(refusal(link)), "TD-3: the guard refuses a dangling link");
    assert(!existsSync(elsewhere), "TD-3: and nothing is created where the link points");

    const fresh = join(dirname(scratch), "fresh.db");
    assertEqual(refusal(fresh), "", "TD-3: (control) a new file in the temp directory is accepted");

    // AND THE SEEDER USES IT: the real child process, as test-db.ts runs it,
    // refuses a path outside the temp directory and a file that exists.
    const seed = (target: string): { refused: boolean; out: string } => {
      try {
        execFileSync(process.execPath, ["--import", "tsx", join("scripts", "lib", "seed-test-db.ts"), target], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
        });
        return { refused: false, out: "" };
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string };
        return { refused: true, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    };
    const outsideRun = seed(outside);
    assert(
      outsideRun.refused && /refusing to build a test database outside/.test(outsideRun.out),
      "TD-3: the seeder refuses a path outside the temp directory",
    );
    assert(!existsSync(outside), "TD-3: and the seeder creates nothing there");
    const existingRun = seed(existing);
    assert(
      existingRun.refused && /refusing to build over an existing file/.test(existingRun.out),
      "TD-3: the seeder refuses to build over a file that already exists",
    );
    assertEqual(readFileSync(existing, "utf8"), "not a database", "TD-3: and the seeder leaves that file as it was");

    // TD-4. The `fuel.db` fallback in src/db/index.ts is unreachable from a
    // suite: test-db.ts points FUEL_DB_PATH at a temp file the moment it loads,
    // and it is the first thing each suite imports.
    const fallback = execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", 'await import("./scripts/lib/test-db.ts"); console.log(process.env.FUEL_DB_PATH ?? "unset")'],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } },
    ).trim().split("\n").at(-1)!;
    const tempRoot = realpathSync(tmpdir());
    assert(
      fallback !== "unset" && realpathSync(dirname(fallback)).startsWith(tempRoot),
      "TD-4: loading test-db.ts points FUEL_DB_PATH at the temp directory before any suite code runs",
    );
    for (const suite of ["verify-api", "verify-rollup", "verify-quickbooks", "verify-startup", "verify-pins", "verify-arc-lock"]) {
      const firstLocalImport = /^import[^;]*?from\s+["']([^"']+)["']/gm;
      const specifiers = [...withoutComments(readFileSync(join("scripts", `${suite}.ts`), "utf8")).matchAll(firstLocalImport)]
        .map((m) => m[1]!)
        .filter((spec) => !spec.startsWith("node:"));
      assertEqual(specifiers[0], "./lib/test-db.js", `TD-4: test-db.js is the first non-builtin import of ${suite}`);
    }
  }

  console.log(`\nAll ${checks} checks passed.`);
  console.log(`Test database: ${scratch} (fuel.db was never opened)`);
}

main().catch((error) => {
  console.error(`\n${(error as Error).message}`);
  process.exit(1);
});
