/**
 * TEST ONLY. A network for verify-startup's API children in which the payment
 * facilitator is whatever the suite says it is, and nothing outside this
 * machine can be reached at all.
 *
 * Loaded with `node --import ./scripts/lib/offline-network.mjs`, before any of
 * the API's own modules, so every patch below is in place before the first
 * line of src/ runs. Nothing in src/, package.json or the env templates
 * refers to this file; verify-startup checks that.
 *
 * WHAT IT DOES:
 *
 *   - The facilitator. `fetch` to x402.org is answered here, according to the
 *     word in `$FUEL_TEST_NETWORK_DIR/mode`:
 *       down     -- refused exactly as undici refuses an unreachable host
 *       up       -- /supported answers with scripts/fixtures/x402-supported.json
 *       slow-up  -- the same, after SLOW_UP_MS
 *       hang     -- /supported never answers
 *       no-rail  -- /supported answers without exact payments on Base Sepolia
 *     /verify and /settle are refused in every mode. Nothing here can approve
 *     or settle a payment, so even if this file were ever loaded somewhere it
 *     should not be, the worst it could do is refuse service.
 *
 *   - Everything else off this machine is refused: other hosts through
 *     `fetch`, every non-loopback name through DNS, and every non-loopback
 *     literal address at the socket. The suite can never reach the internet.
 *
 *   - Every facilitator call and every DNS lookup is appended to
 *     `$FUEL_TEST_NETWORK_DIR/calls.log`, one JSON object per line. A lookup of
 *     a seller's hostname is how the suite sees that the gateway tried to
 *     contact the seller: every path to an origin resolves its name first.
 *
 * WHY NAMES ARE REFUSED AT DNS, NOT AT THE SOCKET: a name blocked before its
 * lookup would never appear in the log, and the suite's "the seller was not
 * contacted" check would be passing because it was blind. Literal addresses
 * never reach DNS, so those are refused at the socket instead.
 *
 * It refuses to load unless FUEL_DB_PATH is a file in the temp directory: an
 * API child under this preload always runs on a throwaway database.
 */
import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import dns from "node:dns";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const DIR = process.env.FUEL_TEST_NETWORK_DIR;
const DB = process.env.FUEL_DB_PATH;
const TEMP = realpathSync(tmpdir());
// The FILE is judged, not just its folder: a link in the temp directory that
// points at a real database is refused, and an existing file by where it really is.
const dbIsThrowaway = (path) => {
  const target = resolve(path);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) return false;
    return realpathSync(target).startsWith(TEMP + sep);
  }
  return realpathSync(dirname(target)).startsWith(TEMP + sep);
};
if (!DIR || !DB || !dbIsThrowaway(DB)) {
  throw new Error(
    "offline-network.mjs is a test preload: it needs FUEL_TEST_NETWORK_DIR and a FUEL_DB_PATH that is a file in the temp directory, not a link",
  );
}

export const SLOW_UP_MS = 2_500;
const FACILITATOR_HOST = "x402.org";
const RAIL = { x402Version: 2, scheme: "exact", network: "eip155:84532" };

const SUPPORTED = JSON.parse(
  readFileSync(new URL("../fixtures/x402-supported.json", import.meta.url), "utf8"),
).response;
const WITHOUT_RAIL = {
  ...SUPPORTED,
  kinds: SUPPORTED.kinds.filter(
    (k) => !(k.x402Version === RAIL.x402Version && k.scheme === RAIL.scheme && k.network === RAIL.network),
  ),
};

const record = (entry) => appendFileSync(`${DIR}/calls.log`, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const mode = () => {
  try {
    return readFileSync(`${DIR}/mode`, "utf8").trim();
  } catch {
    return "down";
  }
};

const isLoopbackAddress = (ip) => ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
const isLoopbackName = (host) => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || (net.isIP(h) !== 0 && isLoopbackAddress(h));
};

/** What undici throws for a host it cannot reach. */
const unreachable = (host) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }) });

/* ---- fetch ------------------------------------------------------------------ */

const realFetch = globalThis.fetch;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = async function offlineFetch(input, init) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.hostname === FACILITATOR_HOST) {
    const m = mode();
    const path = url.pathname.replace(/^\/facilitator/, "");
    record({ kind: "facilitator", path, mode: m });
    if (path === "/supported") {
      if (m === "up") return json(SUPPORTED);
      if (m === "no-rail") return json(WITHOUT_RAIL);
      if (m === "slow-up") {
        await new Promise((r) => setTimeout(r, SLOW_UP_MS));
        record({ kind: "facilitator-answered", path });
        return json(SUPPORTED);
      }
      if (m === "hang") return new Promise(() => {});
    }
    throw unreachable(FACILITATOR_HOST);
  }
  if (!isLoopbackName(url.hostname)) {
    record({ kind: "fetch-refused", host: url.hostname });
    throw unreachable(url.hostname);
  }
  return realFetch(input, init);
};

/* ---- DNS -------------------------------------------------------------------- */

const enotfound = (host) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host });

const realLookup = dns.lookup;
dns.lookup = function offlineLookup(hostname, options, callback) {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options;
  record({ kind: "lookup", host: hostname });
  if (isLoopbackName(hostname)) return realLookup.call(dns, hostname, opts, cb);
  process.nextTick(cb, enotfound(hostname));
  return {};
};

const realPromisesLookup = dns.promises.lookup;
dns.promises.lookup = async function offlinePromisesLookup(hostname, options) {
  record({ kind: "lookup", host: hostname });
  if (isLoopbackName(hostname)) return realPromisesLookup.call(dns.promises, hostname, options);
  throw enotfound(hostname);
};

// The resolver functions query DNS servers directly, bypassing lookup. Nothing
// in src/ uses them; refused anyway, so nothing can.
for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveTxt", "resolveSrv", "resolveMx", "resolveNs"]) {
  if (typeof dns[name] === "function") {
    dns[name] = (host, ...rest) => {
      record({ kind: "lookup", host, via: name });
      process.nextTick(rest.at(-1), enotfound(host));
    };
  }
  if (typeof dns.promises[name] === "function") {
    dns.promises[name] = async (host) => {
      record({ kind: "lookup", host, via: name });
      throw enotfound(host);
    };
  }
}

/* ---- sockets: literal addresses, which never reach DNS ---------------------- */

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function offlineConnect(...args) {
  const first = args[0];
  const opts = Array.isArray(first) ? first[0] : first;
  const host = typeof opts === "object" && opts !== null ? opts.host : typeof args[1] === "string" ? args[1] : undefined;
  const isPipe = typeof opts === "object" && opts !== null && typeof opts.path === "string";
  if (!isPipe && typeof host === "string" && net.isIP(host) !== 0 && !isLoopbackAddress(host)) {
    record({ kind: "connect-refused", host });
    process.nextTick(() => this.destroy(Object.assign(new Error(`connect EHOSTUNREACH ${host}`), { code: "EHOSTUNREACH" })));
    return this;
  }
  return realConnect.apply(this, args);
};

// ES-module imports of node:dns (src/lib/safe-fetch.ts binds `lookup` when it
// loads) see the patched functions only after this.
syncBuiltinESMExports();
