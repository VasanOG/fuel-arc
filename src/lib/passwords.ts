/**
 * How a password becomes something safe to store, and how it is checked again.
 *
 * THE ONLY PLACE `scrypt` IS CALLED. scripts/verify-api.ts asserts that, for the
 * same reason it asserts no route calls a `*Unscoped` accessor: a second hashing
 * site is how a weaker one gets introduced, and the weaker one is invisible
 * until someone reads both.
 *
 * WHY scrypt AND NOT A LIBRARY. bcrypt and argon2 are both defensible and both
 * are native dependencies; `node:crypto` ships scrypt, which is memory-hard,
 * standardised (RFC 7914) and already in the runtime. Fuel adds a dependency
 * when it must — see the reasoning in src/lib/secrets.ts about keeping the
 * credential surface small — and a password hash is not where to start.
 *
 * ASYNC, NEVER `scryptSync`. This is one process with one synchronous SQLite
 * connection, and that connection serialises every spend-cap check under
 * `BEGIN IMMEDIATE`. A synchronous 67ms KDF on the event loop would stall every
 * payment in flight behind whoever is logging in — turning the login form into
 * a way to slow down money movement. The async form runs on libuv's threadpool.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Cost parameters, MEASURED ON THIS MACHINE rather than copied from an article.
 *
 *   N=16384  32ms   16MB      N=65536  138ms  64MB
 *   N=32768  67ms   32MB      N=131072 286ms 128MB
 *
 * N=32768 is the pick: ~67ms is invisible to a person signing in and expensive
 * enough to make offline guessing against a stolen `fuel.db` painful, while
 * costing 32MB per hash in flight — which is the number that actually bounds
 * how many can run at once. See MAX_CONCURRENT_HASHES below.
 *
 * Stored with the digest, not assumed, so raising them later does not strand
 * every existing password: an old hash verifies against its own recorded cost.
 */
const N = 32768;
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/**
 * `maxmem` must exceed 128 * N * r or scrypt refuses outright. Set with headroom
 * so a future parameter bump fails a test rather than every login at runtime.
 */
const MAX_MEM = 256 * 1024 * 1024;

/**
 * How many hashes may run at once.
 *
 * MEMORY IS THE REASON, NOT CPU. Each in-flight hash holds ~32MB, so an
 * unbounded login route is a memory-exhaustion path: the work is deliberately
 * expensive, which means the route that triggers it is deliberately expensive to
 * call. Rate limits bound one caller and one email; they do not bound a
 * distributed burst all arriving in the same second. This does.
 *
 * Four is chosen to cap the hashing footprint at ~128MB, which a single-process
 * server can absorb. A caller beyond it is refused and told to retry — a queue
 * would hold the memory anyway and just add latency to the refusal.
 */
const MAX_CONCURRENT_HASHES = 4;
let hashesInFlight = 0;

/** Thrown when the ceiling above is reached. The route answers 503, never 401. */
export class HashingBusyError extends Error {
  constructor() {
    super("too many sign-in attempts are being processed; try again in a moment");
    this.name = "HashingBusyError";
  }
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  if (hashesInFlight >= MAX_CONCURRENT_HASHES) return Promise.reject(new HashingBusyError());
  hashesInFlight += 1;
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { N: n, r, p, maxmem: MAX_MEM }, (error, key) => {
      hashesInFlight -= 1;
      if (error) return reject(error);
      resolve(key);
    });
  });
}

/**
 * The shortest password Fuel accepts, and the only rule it has.
 *
 * NO COMPOSITION RULES, deliberately. Requiring a digit and a symbol pushes
 * people toward `Password1!` and buys nothing measurable; length is what
 * actually costs an attacker. 12 is NIST's floor for user-chosen secrets when
 * no other rule applies.
 */
export const MIN_PASSWORD_LENGTH = 12;

export class WeakPasswordError extends Error {
  constructor() {
    super(`a password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    this.name = "WeakPasswordError";
  }
}

/**
 * Password -> `v1.<N>.<r>.<p>.<salt>.<hash>`, base64url.
 *
 * Versioned and self-describing for the same reason `encryptSecret` is: a stored
 * blob with no version is one that cannot be migrated without guessing at its
 * format, and the cost parameters have to travel WITH the hash or raising them
 * invalidates every password already set.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.normalize("NFKC").length < MIN_PASSWORD_LENGTH) throw new WeakPasswordError();
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return ["v1", N, R, P, salt.toString("base64url"), key.toString("base64url")].join(".");
}

/**
 * Does this password produce that stored hash?
 *
 * Returns false rather than throwing on a malformed record: a corrupted row
 * must read as "wrong password", not as a 500 that tells a caller the account
 * exists and something about it is unusual. HashingBusyError still propagates,
 * because "we could not check" is not "you are wrong".
 *
 * `timingSafeEqual`, not `===`. The comparison is on derived keys rather than
 * the password, so the leak is narrow, but a byte-by-byte early exit is exactly
 * the thing the rest of this codebase already refuses to write (see
 * `roleFor` in src/lib/auth.ts).
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(".");
  if (parts.length !== 6 || parts[0] !== "v1") return false;
  const [, nRaw, rRaw, pRaw, saltPart, hashPart] = parts;

  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A record asking for more memory than we allow is refused rather than
  // attempted: scrypt would throw, and a throw here reads as a server fault.
  if (128 * n * r >= MAX_MEM) return false;

  const salt = Buffer.from(saltPart!, "base64url");
  const expected = Buffer.from(hashPart!, "base64url");
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;

  const actual = await derive(password, salt, n, r, p);
  return timingSafeEqual(actual, expected);
}

/**
 * A hash of nothing, burned on purpose when no account matches.
 *
 * WHY THIS EXISTS: if login skipped hashing for an unknown email it would answer
 * in ~1ms instead of ~67ms, and that difference is a free oracle for which
 * addresses have accounts — worth more to an attacker than it sounds, because it
 * turns a password-guessing problem into a much smaller targeted one. The route
 * calls this so every attempt costs the same.
 */
export async function burnHashingTime(password: string): Promise<void> {
  try {
    await derive(password, randomBytes(SALT_BYTES), N, R, P);
  } catch (error) {
    if (error instanceof HashingBusyError) throw error;
    // Anything else is swallowed: this call has no answer to give.
  }
}
