/**
 * Outbound fetch with an SSRF guard.
 *
 * `POST /api/agents/:id/pay` takes a caller-supplied URL and fetches it twice
 * — once to read the 402 terms, once carrying the payment. Without this guard
 * that is a request forgery primitive: cloud metadata (169.254.169.254),
 * anything on the private network, or a non-http scheme.
 *
 * Three things drive the design, each learned by watching a guard fail:
 *
 *   1. Literal IPs skip DNS entirely. `net.connect` only calls the `lookup`
 *      hook for names, so a DNS-level guard alone lets `http://169.254.169.254`
 *      straight through. Literal hosts are therefore checked up front.
 *   2. Redirects. A resource server can look public on the first request and
 *      302 the second — the one carrying the payment header — somewhere
 *      internal. So redirects are followed here, one hop at a time, and every
 *      hop is re-validated instead of being handled invisibly by fetch.
 *   3. DNS rebinding. A name that resolves public when you check it can
 *      resolve private a moment later when the socket actually opens. So
 *      names are validated inside the lookup itself, at connect time — the
 *      address we approve is the address the socket gets.
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import {
  Agent,
  Headers,
  Response,
  fetch as undiciFetch,
  type RequestInit,
} from "undici";

/**
 * Whether loopback may be reached, decided per call.
 *
 * IT USED TO BE A CONSTANT, AND THE JUSTIFICATION HAS EXPIRED. The old comment
 * read: "Acceptable while /api is itself behind a shared secret and bound to
 * 127.0.0.1; revisit if Fuel ever fetches URLs from a less trusted source than
 * an authenticated operator." The earning gateway is that condition arriving —
 * it dereferences a customer-supplied origin on behalf of an anonymous payer,
 * so the premise the exemption rested on is simply no longer true.
 *
 * Loopback stays reachable for exactly one caller: `payForAgent`, which pays
 * Fuel's own /paid-hello on localhost, and that is how the payment loop stays
 * demonstrable in one process.
 *
 * REQUIRED, WITH NO DEFAULT, DELIBERATELY. A default is a value somebody
 * inherits without deciding; every call site has to say which side it is on,
 * and the compiler will not let a new one skip the question. The gateway
 * forward and both registration probes pass `false` — that is the case this
 * whole parameter exists to protect, because `origin_url` is a durable
 * artifact later dereferenced by an anonymous-facing path.
 */
export interface FetchPolicy {
  /** True only for callers that legitimately reach Fuel's own loopback services. */
  allowLoopback: boolean;
  /**
   * Refuse a response body past this many bytes, counted off the stream rather
   * than read from `content-length` — which the origin controls and can lie
   * about. Omit for no cap (the payment path, which talks to a resource server
   * it already chose).
   */
  maxBytes?: number;
}

function isBlockedIPv4(ip: string, allowLoopback: boolean): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable — fail closed
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 127) return !allowLoopback;

  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // RFC1918
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. the cloud metadata IP
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 192 && b === 0) || // 192.0.0.0/24 protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved/broadcast
  );
}

/**
 * Expand an IPv6 address to its eight 16-bit groups, or null if unparseable.
 *
 * Matching IPv6 as text does not work: `new URL()` canonicalizes hosts to
 * compressed hex before any guard sees them, so `[::ffff:169.254.169.254]`
 * arrives as `::ffff:a9fe:a9fe`. A guard looking for dotted quads never fires
 * and the address sails through. Compare numbers, not spellings.
 */
export function parseIPv6(input: string): number[] | null {
  let text = input.toLowerCase().split("%")[0]!; // drop any zone index

  // A trailing dotted quad (::ffff:10.0.0.1) contributes the last two groups.
  let tail: number[] = [];
  const dotted = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    tail = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    text = text.slice(0, dotted.index);
  }

  const groups = (part: string) =>
    part
      .split(":")
      .filter((g) => g !== "")
      .map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));

  const halves = text.split("::");
  if (halves.length > 2) return null;

  let parts: number[];
  if (halves.length === 2) {
    const head = groups(halves[0]!);
    const mid = groups(halves[1]!);
    const fill = 8 - tail.length - head.length - mid.length;
    if (fill < 0) return null;
    parts = [...head, ...Array<number>(fill).fill(0), ...mid, ...tail];
  } else {
    parts = [...groups(halves[0]!), ...tail];
  }

  return parts.length === 8 && parts.every((n) => Number.isInteger(n)) ? parts : null;
}

function isBlockedIPv6(ip: string, allowLoopback: boolean): boolean {
  const h = parseIPv6(ip);
  if (!h) return true; // unparseable — fail closed

  const zeroThrough = (n: number) => h.slice(0, n).every((g) => g === 0);
  const embeddedV4 = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

  if (zeroThrough(7) && h[7] === 1) return !allowLoopback; // ::1

  // Forms that carry a v4 address inside them are judged as that v4 address,
  // in every spelling: IPv4-mapped/compatible, 6to4, NAT64.
  if (zeroThrough(5) && (h[5] === 0xffff || h[5] === 0)) {
    return isBlockedIPv4(embeddedV4(h[6]!, h[7]!), allowLoopback);
  }
  if (h[0] === 0x2002) return isBlockedIPv4(embeddedV4(h[1]!, h[2]!), allowLoopback); // 6to4
  // NAT64 is 64:ff9b::/96 specifically — the wider 64:ff9b::/32 (RFC 8215
  // local-use) must fall through to default-deny rather than be judged on its
  // trailing 32 bits.
  if (h[0] === 0x0064 && h[1] === 0xff9b && h.slice(2, 6).every((g) => g === 0)) {
    return isBlockedIPv4(embeddedV4(h[6]!, h[7]!), allowLoopback);
  }
  // Teredo (2001::/32) embeds a v4 address and sits inside the allowed
  // 2000::/3, so it needs an explicit refusal.
  if (h[0] === 0x2001 && h[1] === 0x0000) return true;

  // Default deny: everything except global unicast (2000::/3) is refused, so
  // unique-local, link-local, multicast and every unassigned range are blocked
  // without needing a rule each.
  return (h[0]! & 0xe000) !== 0x2000;
}

/** True if connecting to this literal address should be refused. */
export function isBlockedAddress(ip: string, allowLoopback: boolean): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIPv4(ip, allowLoopback);
  if (family === 6) return isBlockedIPv6(ip, allowLoopback);
  return true; // not an IP at all — fail closed
}

export class BlockedUrlError extends Error {}

/**
 * A dispatcher whose DNS lookup refuses blocked addresses.
 *
 * The callback shape has to match how `net` called us: with `autoSelectFamily`
 * (on by default since Node 20) it passes `all: true` and expects the array
 * back, otherwise it expects `(address, family)` scalars. Returning the wrong
 * one fails only on the *allow* path — the reject path short-circuits on the
 * error argument — so getting this wrong looks like a working guard.
 */
/** Backstop only; the precise deadline is the caller's AbortSignal. */
const AGENT_TIMEOUT_MS = 30_000;

/**
 * The resolver a guarded agent asks. `dnsLookup` everywhere in production.
 *
 * A parameter only so a test can make a name resolve to 169.254.169.254 and
 * watch THIS hook refuse it at connect time. Offline, nothing else can make a
 * hostname resolve to the metadata address, and a send-time guard nobody can
 * exercise is a guard nobody has proved (alerting, ADR 0021).
 */
export type Resolver = typeof dnsLookup;

function makeGuardedAgent(allowLoopback: boolean, resolver: Resolver = dnsLookup): Agent {
  return new Agent({
    // Backstops, not the precise deadline — callers pass an AbortSignal for
    // that. These exist so a caller that forgets one still cannot be held open
    // forever by an origin that accepts a connection and then goes quiet.
    // guardedAgent previously set neither.
    headersTimeout: AGENT_TIMEOUT_MS,
    bodyTimeout: AGENT_TIMEOUT_MS,
    connect: {
      lookup(hostname, options, callback) {
        resolver(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err, "", 0);

          // Reject if ANY resolved address is blocked, not just the one we would
          // use. A name answering with a mix of public and private addresses is
          // what a rebinding attempt looks like.
          for (const entry of addresses) {
            if (isBlockedAddress(entry.address, allowLoopback)) {
              return callback(
                new BlockedUrlError(
                  `Refusing to connect to ${hostname}: ${entry.address} is not a public address`,
                ),
                "",
                0,
              );
            }
          }

          const first = addresses[0];
          if (!first) return callback(new BlockedUrlError(`${hostname} did not resolve`), "", 0);

          if ((options as { all?: boolean }).all) return callback(null, addresses as never, 0);
          return callback(null, first.address, first.family);
        });
      },
    },
  });
}

/**
 * TWO agents, because the lookup hook is where DNS rebinding is defeated and it
 * closes over its policy. One shared agent could not answer "is loopback
 * allowed" differently for two callers, and the whole point of the policy
 * parameter is that two callers now answer it differently.
 */
const loopbackAgent = makeGuardedAgent(true);
const strictAgent = makeGuardedAgent(false);

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Credentials and payment proof must not follow a redirect to a new origin. */
const SENSITIVE_HEADERS = /^(authorization|cookie|proxy-authorization|x-payment|payment)/i;

/**
 * Validates the parts of a URL we can judge without connecting: the scheme,
 * and the host when it is already a literal IP (in which case no DNS lookup
 * will happen, so the lookup guard would never see it).
 */
function assertUrlAllowed(url: string, allowLoopback: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${url}`);
  }

  // Everything else — file:, ftp:, data:, gopher: — is refused before any
  // connection is attempted.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedUrlError(`Refusing ${parsed.protocol} — only http and https are allowed`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // URL keeps IPv6 brackets
  if (isIP(host) && isBlockedAddress(host, allowLoopback)) {
    throw new BlockedUrlError(`Refusing to connect to ${host}: not a public address`);
  }

  return parsed;
}

/** Raised when an origin sends more than the caller said it would accept. */
export class ResponseTooLargeError extends Error {}

/**
 * Reads a body with a hard byte ceiling and hands back an equivalent Response.
 *
 * COUNTED OFF THE STREAM, NOT READ FROM `content-length`. That header is
 * written by the party we are defending against: an origin can understate it,
 * omit it, or send chunked and never declare a length at all. Trusting it would
 * make the cap advisory, which is the same as not having one.
 *
 * Reading to a buffer rather than passing the stream through is deliberate too.
 * Every capped caller (the gateway, the registration probes) has to hold the
 * whole body anyway — the gateway cannot start writing bytes to a payer before
 * settlement confirms — so streaming would only defer the allocation, not avoid
 * it, while making the ceiling much harder to enforce.
 */
async function capBody(response: Response, maxBytes: number): Promise<Response> {
  const body = response.body;
  if (!body) return response;

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Cancel rather than drain: there is no reason to keep pulling bytes
        // we have already decided to refuse.
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(
          `Refusing a response body over ${maxBytes} bytes from ${response.url || "the origin"}`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }

  return new Response(joined, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }) as unknown as Response;
}

/**
 * fetch(), but it will not reach private network space — on the first request
 * or on any redirect it follows.
 *
 * Compatible with the global fetch for the ways payments use it (status, ok,
 * headers.get, text, json, clone).
 */
export async function safeFetch(
  url: string,
  policy: FetchPolicy,
  init: RequestInit = {},
): Promise<Response> {
  const { allowLoopback } = policy;
  let current = assertUrlAllowed(url, allowLoopback);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);

  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await undiciFetch(current.href, {
        ...init,
        method,
        headers,
        body,
        dispatcher: allowLoopback ? loopbackAgent : strictAgent,
        redirect: "manual", // we follow them ourselves, validating each hop
      });
    } catch (error) {
      // fetch flattens connect-time failures into a bare "fetch failed". Our
      // lookup rejection is the interesting part, so surface it rather than
      // leaving an operator to guess why a payment was refused.
      const cause = (error as { cause?: unknown }).cause;
      if (cause instanceof BlockedUrlError) throw cause;
      throw error;
    }

    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return policy.maxBytes === undefined ? response : await capBody(response, policy.maxBytes);
    }

    if (hop >= MAX_REDIRECTS) {
      throw new BlockedUrlError(`Too many redirects (more than ${MAX_REDIRECTS}) from ${url}`);
    }

    const next = assertUrlAllowed(new URL(location, current).href, allowLoopback);

    // Same rule browsers apply to Authorization: a redirect to a different
    // origin does not get to carry the payment signature with it.
    if (next.origin !== current.origin) {
      for (const name of [...headers.keys()]) {
        if (SENSITIVE_HEADERS.test(name)) headers.delete(name);
      }
    }

    // 303 always becomes GET; 301/302 do so for anything that isn't already
    // a safe method. 307/308 deliberately preserve the method. The body has to
    // go with the method — fetch rejects a GET that still carries one.
    if (response.status === 303 || (response.status < 307 && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
    }

    current = next;
  }
}

/** A 3xx answered to a caller that does not follow redirects. */
export class RedirectRefusedError extends Error {}

/**
 * One request, and a redirect is an ANSWER, never a destination.
 *
 * WHY A SECOND FUNCTION RATHER THAN A FLAG ON `safeFetch`. Alert webhooks
 * (src/alerts/dispatch.ts) must not follow redirects at all: a receiver that
 * answers 302 is either misconfigured or trying to bounce Fuel somewhere, and
 * neither is a place to send a company's alerts. `safeFetch` already follows
 * redirects for its three callers, each re-validated per hop, and adding an
 * option to it would put an alerting decision inside the payment path's fetch.
 * A separate function leaves every existing caller byte-for-byte as it was.
 *
 * The SAME guards: `assertUrlAllowed` before connecting, and a guarded agent
 * whose DNS hook refuses private addresses at connect time. The dispatcher is
 * passed EXPLICITLY, which is also what keeps `HTTP_PROXY`/`HTTPS_PROXY` and
 * any global dispatcher out of it: undici consults neither when one is given.
 *
 * Throws `RedirectRefusedError` on any 3xx, after cancelling its body.
 */
export async function safeFetchNoRedirect(
  url: string,
  policy: { allowLoopback: boolean; resolver?: Resolver },
  init: RequestInit = {},
): Promise<Response> {
  const target = assertUrlAllowed(url, policy.allowLoopback);
  const dispatcher =
    policy.resolver === undefined
      ? policy.allowLoopback
        ? loopbackAgent
        : strictAgent
      : makeGuardedAgent(policy.allowLoopback, policy.resolver);

  let response: Response;
  try {
    response = await undiciFetch(target.href, { ...init, dispatcher, redirect: "manual" });
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof BlockedUrlError) throw cause;
    throw error;
  } finally {
    // A resolver-specific agent exists for this one call; do not leak sockets.
    if (policy.resolver !== undefined && dispatcher !== loopbackAgent && dispatcher !== strictAgent) {
      void dispatcher.close().catch(() => {});
    }
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new RedirectRefusedError(`redirect refused (${response.status})`);
  }
  return response;
}
