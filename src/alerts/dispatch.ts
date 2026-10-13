/**
 * Sending alerts to a company's webhook (ADR 0021).
 *
 * THREE PROMISES THIS FILE KEEPS, and the code is arranged around them:
 *
 *   1. IT NEVER THROWS INTO ANYTHING ELSE. A webhook is a third party's server,
 *      and it may be slow, down, hostile or wrong. Every attempt ends in one of
 *      a closed set of outcome codes, and every asynchronous path ends in a
 *      catch that cannot itself throw: this process has no `unhandledRejection`
 *      handler, so one escaped rejection would take the API, and payments with
 *      it, down (security review, F3).
 *   2. IT NEVER WRITES THE URL ANYWHERE. Not to a log, not to a column, not to
 *      an error. safe-fetch embeds the URL in three of its messages, so errors
 *      are classified by CLASS and their messages are never read.
 *   3. IT ONLY REACHES PUBLIC ADDRESSES, WITHOUT REDIRECTS. The production
 *      sender is bound to `allowLoopback: false` and `safeFetchNoRedirect`,
 *      whose DNS hook refuses any private address at the moment the socket
 *      opens. There is no environment switch; a local receiver needs a public
 *      tunnel, which is what the guard is for.
 */
import { BlockedUrlError, RedirectRefusedError, safeFetchNoRedirect, type Resolver } from "../lib/safe-fetch.js";
import { dashboardOrigin } from "../lib/dashboard-origin.js";
import {
  cancelDelivery,
  claimDue,
  completeDelivery,
  getWebhookRow,
  openEventsForDelivery,
  recordWebhookOutcome,
  webhookForDelivery,
  type AlertOutcome,
  type ClaimedDelivery,
} from "../db/alerts.js";
import { collapse, type AttentionItem } from "./attention.js";
import { SEVERITY, type AlertEvent } from "./events.js";
import { alertText, changedText, testText } from "./text.js";
import { assertWebhookUrl, openWebhook } from "./webhook-url.js";

export interface SendResult {
  outcome: AlertOutcome;
  /** Worth trying again later: a timeout, a 5xx, a 408 or 429, a network error. */
  retryable: boolean;
}

/** Sends one alert body to one URL. Never throws. */
export type Send = (url: string, text: string, signal: AbortSignal) => Promise<SendResult>;

const PERMANENT = (outcome: AlertOutcome): SendResult => ({ outcome, retryable: false });
const RETRY = (outcome: AlertOutcome): SendResult => ({ outcome, retryable: true });

/**
 * A sender, from a policy.
 *
 * A FACTORY SO THE REAL MAPPING IS WHAT THE TESTS RUN. Positive delivery cannot
 * be tested against the production instance, which correctly refuses every
 * local receiver; a test builds its own sender with `allowLoopback: true` and a
 * lenient URL rule for that. But the SSRF tests build theirs with the
 * production policy and an injected resolver, so the code that turns a 3xx into
 * `redirect_refused` and a refused address into `blocked_address` is the code
 * that runs in production, not a copy.
 */
export function createWebhookSender(policy: {
  allowLoopback: boolean;
  checkUrl: (url: string) => string;
  resolver?: Resolver;
}): Send {
  return async (url, text, signal) => {
    let target: string;
    try {
      target = policy.checkUrl(url);
    } catch {
      return PERMANENT("invalid_url");
    }
    try {
      const response = await safeFetchNoRedirect(
        target,
        { allowLoopback: policy.allowLoopback, resolver: policy.resolver },
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal,
        },
      );
      // The receiver's body is never read: there is nothing in it Fuel needs,
      // and nothing in it that should reach a log. Cancelled, so the socket is
      // released either way (security review, F5).
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      if (status >= 200 && status < 300) return { outcome: "ok", retryable: false };
      if (status >= 500) return RETRY("http_5xx");
      // 408 and 429 are "later", not "never".
      if (status === 408 || status === 429) return RETRY("http_4xx");
      return PERMANENT("http_4xx");
    } catch (error) {
      if (error instanceof BlockedUrlError) return PERMANENT("blocked_address");
      if (error instanceof RedirectRefusedError) return PERMANENT("redirect_refused");
      if (signal.aborted) return RETRY("timeout");
      const name = (error as { name?: unknown }).name;
      if (name === "AbortError" || name === "TimeoutError") return RETRY("timeout");
      return RETRY("network_error");
    }
  };
}

/**
 * THE production sender: public addresses only, no redirects, and the webhook
 * rules re-checked on every send. `server.ts` wires exactly this, and
 * verify-api pins that it does (AL-S1).
 */
export const strictWebhookSend: Send = createWebhookSender({ allowLoopback: false, checkUrl: assertWebhookUrl });

export interface DispatcherOptions {
  send: Send;
  now: () => Date;
  /** Per attempt. 5 seconds in production; a test passes something short. */
  timeoutMs?: number;
  /** Deliveries in flight at once, across every company. */
  globalSlots?: number;
}

export interface Dispatcher {
  /** Claims due deliveries into free slots and starts them. Synchronous; never throws. */
  pump(): void;
  /** Sends the fixed test message now, sharing the company's slot. */
  sendTest(companyId: string): Promise<SendResult | "busy" | "not_configured">;
  /** Best effort, once, unretried: tells a replaced or removed destination. */
  notifyChanged(companyId: string, oldSecretEnc: string): void;
  /** Resolves when nothing is in flight. For tests. */
  idle(): Promise<void>;
  /** In flight right now, for tests. */
  inFlight(): { total: number; companies: string[] };
}

/**
 * One dispatcher per process.
 *
 * AT MOST ONE DELIVERY PER COMPANY AND `globalSlots` IN ALL (2 by default).
 * Two, not more, because DNS lookups run on libuv's thread pool, which async
 * scrypt for sign-in shares: four webhooks with hung resolvers could otherwise
 * stall every sign-in (security review, F7). Oldest due first, so one tenant's
 * slow webhook cannot starve another's.
 */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const timeoutMs = options.timeoutMs ?? 5000;
  const globalSlots = options.globalSlots ?? 2;
  const busy = new Set<string>();
  let running = 0;
  const waiters: (() => void)[] = [];

  /** Change notices outstanding, by company: at most one each (review of commit 1, F-2). */
  const notices = new Set<string>();

  const releaseSlot = () => {
    running -= 1;
    if (running === 0) for (const w of waiters.splice(0)) w();
  };
  const release = (companyId: string) => {
    busy.delete(companyId);
    releaseSlot();
  };

  async function deliver(claim: ClaimedDelivery): Promise<void> {
    const hook = webhookForDelivery(claim.id);
    if (hook === null) {
      cancelDelivery(claim.id, claim.companyId);
      return;
    }
    let url: string;
    try {
      url = openWebhook(claim.companyId, hook.secretEnc).url;
    } catch {
      // A wrong key, a tampered row, or a blob that belongs to another company
      // or purpose (WebhookUnreadableError): the same answer for all, and never
      // a retry, since waiting will not make a ciphertext readable.
      completeDelivery({
        id: claim.id,
        companyId: claim.companyId,
        outcome: "secret_unreadable",
        retryable: false,
        attempts: claim.attempts,
        now: options.now(),
      });
      return;
    }

    // Built at SEND time from what is still open: an approval decided while a
    // webhook was down is not news by the time it comes back.
    //
    // A message that cannot be built (a payload this build cannot read, a
    // label missing after a vocabulary change) is SET ASIDE, not retried: it
    // would fail the same way every time (review of commit 1, F-7).
    // The read is OUTSIDE the guard: a transient database error is a failed
    // attempt like any other (the lease brings it back), not a reason to set
    // the message aside for good. Each event is read on its own, so one
    // unreadable payload costs one line, never the whole message.
    const rows = openEventsForDelivery(claim.id, claim.companyId);
    const items: AttentionItem[] = [];
    for (const row of rows) {
      try {
        items.push(fromPayload(row.payloadJson));
      } catch {
        console.error("[alerts] an alert event could not be read; it is left out of its message");
      }
    }
    if (items.length === 0) {
      cancelDelivery(claim.id, claim.companyId);
      return;
    }
    let text: string;
    try {
      text = alertText(collapse(items), dashboardOrigin());
    } catch {
      console.error("[alerts] a delivery's message could not be built; it is set aside, not retried");
      cancelDelivery(claim.id, claim.companyId);
      return;
    }
    const result = await options.send(url, text, AbortSignal.timeout(timeoutMs));
    completeDelivery({
      id: claim.id,
      companyId: claim.companyId,
      outcome: result.outcome,
      retryable: result.retryable,
      attempts: claim.attempts,
      now: options.now(),
    });
  }

  function pump(): void {
    try {
      const free = globalSlots - running;
      if (free <= 0) return;
      for (const claim of claimDue(options.now(), free, busy)) {
        busy.add(claim.companyId);
        running += 1;
        // The last resort. `deliver` handles its own outcomes; this catches
        // only what nothing else could (a database error writing an outcome),
        // and it cannot throw: no rejection ever escapes this file.
        deliver(claim)
          .catch(() => {
            console.error("[alerts] a delivery could not record its outcome; it will be retried after its lease");
          })
          .finally(() => release(claim.companyId));
      }
    } catch {
      console.error("[alerts] could not claim deliveries this round");
    }
  }

  async function sendTest(companyId: string): Promise<SendResult | "busy" | "not_configured"> {
    if (busy.has(companyId) || running >= globalSlots) return "busy";
    const hook = getWebhookRow(companyId);
    if (hook === null) return "not_configured";
    busy.add(companyId);
    running += 1;
    try {
      let url: string;
      try {
        url = openWebhook(companyId, hook.secretEnc).url;
      } catch {
        recordWebhookOutcome(companyId, "secret_unreadable", options.now().toISOString());
        return PERMANENT("secret_unreadable");
      }
      const result = await options.send(url, testText(dashboardOrigin()), AbortSignal.timeout(timeoutMs));
      recordWebhookOutcome(companyId, result.outcome, options.now().toISOString());
      return result;
    } finally {
      release(companyId);
    }
  }

  function notifyChanged(companyId: string, oldSecretEnc: string): void {
    // AT MOST ONE OUTSTANDING PER COMPANY, AND INSIDE THE GLOBAL SLOTS (review
    // of commit 1, F-2). The first version ran outside both, so an owner looping
    // PUT and DELETE could make Fuel post to hosts of their choosing without
    // limit, each DNS lookup holding a libuv thread sign-in also needs. The
    // routes are rate-limited too. A notice waits a bounded time for a slot
    // rather than being dropped while the queue is merely busy; never retried
    // and never recorded: if the old destination is gone, so be it.
    if (notices.has(companyId)) return;
    notices.add(companyId);
    void (async () => {
      try {
        const deadline = Date.now() + 30_000;
        while (running >= globalSlots) {
          if (Date.now() > deadline) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        running += 1;
        try {
          const { url } = openWebhook(companyId, oldSecretEnc);
          await options.send(url, changedText(dashboardOrigin()), AbortSignal.timeout(timeoutMs));
        } finally {
          releaseSlot();
        }
      } catch {
        // Best effort, by design.
      } finally {
        notices.delete(companyId);
      }
    })().catch(() => {});
  }

  return {
    pump,
    sendTest,
    notifyChanged,
    idle: () => (running === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
    inFlight: () => ({ total: running, companies: [...busy] }),
  };
}

/** What `alert_events.payload_json` holds: alert-safe fields only. */
export interface AlertPayload {
  event: AlertEvent;
  agentId: string | null;
  agentName: string | null;
  teamName: string | null;
  amountBaseUnits: string | null;
  spentBaseUnits: string | null;
  capBaseUnits: string | null;
  count: number | null;
  href: string | null;
}

/** Longest name stored, before escaping. The capped name is what is kept. */
const STORED_NAME_CHARS = 80;
const cap = (s: string | null) => (s === null ? null : [...s].slice(0, STORED_NAME_CHARS).join(""));

/**
 * An item reduced to what may leave Fuel, for storage. PICKED, field by
 * field: no `frozenReason`, no subject ids beyond the agent's, no timestamps a
 * reader does not need. BigInts become strings here, at the boundary, because
 * JSON cannot carry them.
 */
export function toPayload(item: AttentionItem): AlertPayload {
  return {
    event: item.event,
    agentId: item.agentId,
    agentName: cap(item.agentName),
    teamName: cap(item.teamName),
    amountBaseUnits: item.amountBaseUnits?.toString() ?? null,
    spentBaseUnits: item.spentBaseUnits?.toString() ?? null,
    capBaseUnits: item.capBaseUnits?.toString() ?? null,
    count: item.count,
    href: item.href,
  };
}

/** A stored payload back into an item, for collapsing and wording. */
export function fromPayload(json: string): AttentionItem {
  const p = JSON.parse(json) as AlertPayload;
  if (p === null || typeof p !== "object" || !(p.event in SEVERITY)) {
    throw new Error("unrecognised alert payload");
  }
  const big = (s: string | null) => (s === null ? null : BigInt(s));
  return {
    event: p.event,
    severity: SEVERITY[p.event],
    subjectKey: "",
    agentId: p.agentId,
    agentName: p.agentName,
    teamName: p.teamName,
    amountBaseUnits: big(p.amountBaseUnits),
    spentBaseUnits: big(p.spentBaseUnits),
    capBaseUnits: big(p.capBaseUnits),
    count: p.count,
    since: null,
    until: null,
    scope: null,
    frozenReason: null,
    href: p.href,
  };
}
