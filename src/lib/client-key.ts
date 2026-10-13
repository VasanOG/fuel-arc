/**
 * Which client a sign-in or signup attempt counts against.
 *
 * WHY THIS EXISTS. The dashboard calls Fuel server-side, so every browser's
 * sign-in and signup reaches the API from the dashboard's own address. Keyed on
 * the socket alone, one anonymous client could exhaust the per-address buckets
 * and lock every operator out. 7A-2c split the bucket in two, which contained
 * that but did not fix it (see the note above `byLoginAddress` in
 * src/auth/routes.ts, which this file replaces).
 *
 * THE RULE: a client address reported by someone else is believed ONLY from the
 * dashboard, and the dashboard is identified by two things together:
 *   - the relay credential (`X-Fuel-Relay-Key`, `FUEL_RELAY_KEY`), compared in
 *     constant time, AND
 *   - the TCP peer being in `FUEL_RELAY_PEERS`.
 * Neither alone is enough. On a shared host every local process and every
 * `curl` also arrives from 127.0.0.1, so the peer is not an identity; and a key
 * alone, if it leaked, would work from anywhere.
 *
 * A DIRECT CALLER NEVER CHOOSES ITS BUCKET. A request without the relay header
 * is keyed on its own socket peer, and any `X-Fuel-Client-Address` or
 * `X-Forwarded-For` it sends is never read. `trust proxy` is irrelevant here on
 * purpose: this reads `req.socket.remoteAddress`, never `req.ip`, so turning
 * that setting on one day cannot change what a bucket is keyed on.
 *
 * WHAT THE RELAY KEY IS NOT: an API credential. It is not in `roleFor` and
 * authenticates nothing. Its one power is "say which client this came from".
 * If it leaks, the holder can pick a fresh per-address bucket per request,
 * which defeats the per-address limit; the per-account and per-token limits and
 * the relayed ceiling (src/auth/routes.ts) are what still hold. ADR 0020.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Request } from "express";
import { MAX_TRACKED_KEYS } from "./buckets.js";
import { parseIPv6 } from "./safe-fetch.js";

/** Header names, as Node presents them (lowercase). */
export const RELAY_KEY_HEADER = "x-fuel-relay-key";
export const CLIENT_ADDRESS_HEADER = "x-fuel-client-address";

/** The relay key must be at least this long: it is a secret, not a label. */
export const MIN_RELAY_KEY_LENGTH = 32;
const DEFAULT_RELAY_PEERS = ["127.0.0.1", "::1"];
export const DEFAULT_RELAYED_CEILING = 500;

export interface RelayConfig {
  /** SHA-256 of the relay key, or null when the relay is off. */
  readonly keyHash: Buffer | null;
  /** Canonical addresses the relay may arrive from. Empty means nobody. */
  readonly peers: ReadonlySet<string>;
  /** Relayed attempts allowed per window across ALL relayed clients. */
  readonly relayedCeiling: number;
}

/**
 * The relay configuration, from the environment, refusing anything unsafe.
 *
 * Read once at boot (src/auth/routes.ts) so a bad value stops the server before
 * it serves anything, the same discipline src/lib/auth.ts applies to the API
 * keys.
 *
 * - No `FUEL_RELAY_KEY`: the relay is OFF and every request is keyed on its own
 *   peer, which is exactly the behaviour before this file. A safe degradation,
 *   not an outage. Set but EMPTY is refused, so a blank line cannot switch the
 *   fix off silently.
 * - A key shorter than 32 characters, or equal to either API key: refused.
 *   Equal keys would make one secret mean two things.
 * - `FUEL_RELAY_PEERS` unset: 127.0.0.1 and ::1. Set but EMPTY: nobody — never a
 *   silent fall-back to the default.
 * - The ceiling must stay below `MAX_TRACKED_KEYS`. That is the invariant that
 *   stops rotating addresses from flooding the per-account map until a
 *   victim's counter is evicted (see "THE RELAYED CEILING" in routes.ts).
 */
export function relayConfigFrom(env: Record<string, string | undefined>): RelayConfig {
  const key = env.FUEL_RELAY_KEY;
  let keyHash: Buffer | null = null;
  // Only an UNSET key means "relay off". Set but empty is refused: otherwise a
  // blank line in .env would switch the fix off with no error while the
  // dashboard went on sending relay headers the API silently ignored
  // (commit-1 review, F6).
  if (key !== undefined) {
    if (key.trim() === "") throw new Error("FUEL_RELAY_KEY is set but empty. Remove it to turn the relay off.");
    if (key.length < MIN_RELAY_KEY_LENGTH) {
      throw new Error(`FUEL_RELAY_KEY must be at least ${MIN_RELAY_KEY_LENGTH} characters.`);
    }
    if (key === env.FUEL_API_KEY || key === env.FUEL_AGENT_KEY) {
      throw new Error(
        "FUEL_RELAY_KEY must differ from FUEL_API_KEY and FUEL_AGENT_KEY. It vouches for a " +
          "client address and nothing else; sharing a value would make it an API credential too.",
      );
    }
    keyHash = sha256(key);
  }

  const rawPeers =
    env.FUEL_RELAY_PEERS === undefined
      ? DEFAULT_RELAY_PEERS
      : env.FUEL_RELAY_PEERS.split(",").map((p) => p.trim()).filter((p) => p !== "");
  const peers = new Set<string>();
  for (const raw of rawPeers) {
    const canonical = canonicalAddress(raw);
    if (canonical === null) throw new Error(`FUEL_RELAY_PEERS contains an invalid address: ${raw}`);
    peers.add(canonical);
  }

  const ceilingText = env.FUEL_RELAYED_CEILING;
  const relayedCeiling = ceilingText === undefined ? DEFAULT_RELAYED_CEILING : Number(ceilingText);
  if (!Number.isInteger(relayedCeiling) || relayedCeiling < 1 || relayedCeiling >= MAX_TRACKED_KEYS) {
    throw new Error(
      `FUEL_RELAYED_CEILING must be a whole number from 1 to ${MAX_TRACKED_KEYS - 1}: below the ` +
        "limiter's key cap, or rotating addresses could evict live per-account counters.",
    );
  }

  return { keyHash, peers, relayedCeiling };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * An address in one spelling, or null if it is not exactly one valid address.
 *
 * THE ORDER IS THE POINT (security review, F10). Shape is rejected first, then
 * `net.isIP` decides, and only then is anything parsed:
 *   - `%` is refused BEFORE `isIP`, because `isIP("fe80::1%en0")` is 6 — Node
 *     accepts zone IDs — and `parseIPv6` would silently drop the zone.
 *   - `,` is refused because it means several hops, or a header sent twice
 *     (Node joins repeats with ", ").
 *   - brackets, whitespace and newlines never belong in a bare address.
 *   - `isIP` then rejects leading zeros, ports, `1:::2` and everything else
 *     `parseIPv6`'s leniency would otherwise let through.
 *
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) becomes its IPv4, so one client cannot
 * be two clients by changing how it is written. Other IPv6 is written out as
 * eight lowercase groups, so `2001:DB8::1` and `2001:db8:0:0::1` agree.
 */
export function canonicalAddress(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 45) return null;
  if (/[,%[\]\s]/.test(raw)) return null;
  const family = isIP(raw);
  if (family === 4) return raw.split(".").map((part) => String(Number(part))).join(".");
  if (family !== 6) return null;

  const groups = parseIPv6(raw);
  if (groups === null) return null;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
  }
  return groups.map((g) => g.toString(16)).join(":");
}

/**
 * The bucket a relayed client counts against: the address for IPv4, the /64 for
 * IPv6.
 *
 * WHY /64. A single client is normally handed a whole /64, so keying on the full
 * IPv6 address would let it rotate through 2^64 buckets. /64 is the minimum, not
 * a real bound — providers often delegate a /56 or /48 — which is why the
 * relayed ceiling, not this key, is what bounds a rotating client (decision 4,
 * ADR 0020).
 */
export function clientBucketOf(raw: string): string | null {
  const canonical = canonicalAddress(raw);
  if (canonical === null) return null;
  if (!canonical.includes(":")) return canonical; // IPv4, or IPv4-mapped
  return `${canonical.split(":").slice(0, 4).join(":")}::/64`;
}

export type ClientResolution =
  /** No relay header, or the relay is off: keyed on the caller's own socket. */
  | { kind: "direct"; key: string }
  /** A trusted relay naming a valid client. */
  | { kind: "relayed"; key: string }
  /** A relay header that is wrong, repeated, or from a peer not allowed. */
  | { kind: "rejected"; peerKey: string }
  /** A trusted relay whose client address is missing, repeated or malformed. */
  | { kind: "malformed" };

/** Just the parts of a request this reads, so a stubbed socket can be tested. */
export interface RelayRequest {
  headers: Request["headers"];
  socket: { remoteAddress?: string | undefined };
}

/**
 * Decides whose bucket an attempt counts against.
 *
 * The `peer:` and `client:` prefixes keep the two key spaces apart: a browser
 * whose real address is 127.0.0.1 (a local user on the dashboard) never shares a
 * bucket with a local `curl`, which is a `peer:`.
 *
 * An undefined socket address never matches a peer — it becomes
 * `peer:unknown`, which is trusted by nobody.
 *
 * WHERE THE RELAYED CEILING DOES NOT REACH. It bounds RELAYED traffic only.
 * Direct callers have just their per-peer bucket, so the claim that rotating
 * addresses cannot evict a live per-account counter holds through the relay,
 * not for a direct caller holding many addresses. Today the API binds
 * 127.0.0.1, so no untrusted direct caller exists; ADR 0020 records the limit.
 */
export function resolveClient(req: RelayRequest, config: RelayConfig): ClientResolution {
  // A zone index is stripped from the SOCKET address only, never from header
  // input (where `%` is refused outright): it names the local interface, not
  // the caller, and left in place it would collapse every link-local peer into
  // `peer:unknown` (commit-1 review, F3).
  const remote = req.socket.remoteAddress?.split("%")[0];
  const peer = remote === undefined ? null : canonicalAddress(remote);
  // A direct IPv6 caller is keyed per /64 too, exactly like a relayed one, so
  // owning a /64 does not mean a fresh bucket per request (review F2). The
  // allowlist below still compares the FULL peer address.
  const peerKey = `peer:${peer === null ? "unknown" : (clientBucketOf(peer) ?? peer)}`;

  const presented = req.headers[RELAY_KEY_HEADER];
  if (config.keyHash === null || presented === undefined) {
    // A relay that is switched off ignores relay headers rather than refusing
    // them: the same treatment as any direct caller (security review, F7).
    return { kind: "direct", key: peerKey };
  }

  // Both checks always run, so timing does not say which one failed. A header
  // sent twice arrives joined ("k, k") and simply fails the comparison.
  const keyOk =
    typeof presented === "string" && timingSafeEqual(sha256(presented), config.keyHash);
  const peerOk = peer !== null && config.peers.has(peer);
  if (!keyOk || !peerOk) return { kind: "rejected", peerKey };

  const claimed = req.headers[CLIENT_ADDRESS_HEADER];
  const bucket = typeof claimed === "string" ? clientBucketOf(claimed) : null;
  if (bucket === null) return { kind: "malformed" };
  return { kind: "relayed", key: `client:${bucket}` };
}

/** One line for the server's startup banner. Names no secret. */
export function describeRelay(config: RelayConfig): string {
  if (config.keyHash === null) {
    return "client-address relay OFF (FUEL_RELAY_KEY unset): sign-in limits key on the socket peer";
  }
  const peers = [...config.peers].join(", ") || "nobody";
  return `client-address relay ON for peers ${peers}; relayed ceiling ${config.relayedCeiling}/15min`;
}
