/**
 * Alert settings, as an owner sees them on /integrations (ADR 0021).
 *
 * WHAT NEVER ARRIVES HERE: the webhook URL. A Slack incoming-webhook URL is a
 * credential (its secret is the path), and the API returns no route that
 * carries it. What an owner gets is whether one is set, its HOST, and how
 * delivery is going. The pickers below copy those named fields and nothing
 * else, so if the API ever sent more, the browser still would not receive it.
 *
 * OUTCOMES ARE THE API'S COLLAPSED WORDS. "unreachable" covers both a refused
 * private address and a network failure, deliberately (security review, F5):
 * the test button must not be a way to learn which internal names exist. The
 * sentences below explain each word and never add the distinction back.
 *
 * Plain module, no "server-only": the client panel renders these sentences,
 * and verify-api imports the pickers to check they drop unknown fields.
 */

export type WebhookState = "not_configured" | "not_yet_used" | "healthy" | "degraded" | "unreadable";

const STATES: readonly WebhookState[] = ["not_configured", "not_yet_used", "healthy", "degraded", "unreadable"];

export interface FuelAlertWebhook {
  configured: boolean;
  /** The host alone, e.g. hooks.slack.com. Never the path. */
  host: string | null;
  setAt: string | null;
  state: WebhookState;
  lastOutcome: string | null;
  lastAttemptAt: string | null;
  sweeperLastRunAt: string | null;
  /** Fuel has not looked for new alerts in a while: a stopped check must not look like a quiet one. */
  sweeperStale: boolean;
}

export interface FuelAlertRecord {
  label: string;
  agentName: string | null;
  teamName: string | null;
  amount: string | null;
  openedAt: string;
  resolvedAt: string | null;
  /** pending | batched | baseline | silent */
  notice: string;
  /** An outcome word, or a delivery status while one is under way. */
  delivery: string | null;
  /** The stored row could not be read: its kind and time are known, its details are not. */
  unreadable: boolean;
}

export interface FuelAlertSettings {
  webhook: FuelAlertWebhook;
  alerts: FuelAlertRecord[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function toAlertWebhook(raw: unknown): FuelAlertWebhook | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.configured !== "boolean" || !STATES.includes(o.state as WebhookState)) return null;
  return {
    configured: o.configured,
    host: str(o.host),
    setAt: str(o.setAt),
    state: o.state as WebhookState,
    lastOutcome: str(o.lastOutcome),
    lastAttemptAt: str(o.lastAttemptAt),
    sweeperLastRunAt: str(o.sweeperLastRunAt),
    sweeperStale: o.sweeperStale === true,
  };
}

export function toAlertSettings(raw: unknown): FuelAlertSettings | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const webhook = toAlertWebhook(o.webhook);
  if (webhook === null || !Array.isArray(o.alerts)) return null;
  const alerts: FuelAlertRecord[] = [];
  for (const entry of o.alerts) {
    if (entry === null || typeof entry !== "object") return null;
    const a = entry as Record<string, unknown>;
    const label = str(a.label);
    const openedAt = str(a.openedAt);
    const notice = str(a.notice);
    if (label === null || openedAt === null || notice === null) return null;
    alerts.push({
      label,
      agentName: str(a.agentName),
      teamName: str(a.teamName),
      amount: str(a.amount),
      openedAt,
      resolvedAt: str(a.resolvedAt),
      notice,
      delivery: str(a.delivery),
      unreadable: a.unreadable === true,
    });
  }
  return { webhook, alerts };
}

/** What the test button reports. */
export interface TestResult {
  delivered: boolean;
  outcome: string;
}

export function toTestResult(raw: unknown): TestResult | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.delivered !== "boolean" || typeof o.outcome !== "string") return null;
  return { delivered: o.delivered, outcome: o.outcome };
}

/**
 * What the proxy says when Fuel refuses a change, by Fuel's refusal code.
 *
 * THE DASHBOARD'S OWN SENTENCES, so the proxy never relays text from an error
 * body at all (security review of commit 2). The six URL sentences are Fuel's
 * `WEBHOOK_URL_MESSAGES` word for word, and verify-api holds them equal
 * (AL-P3), so an owner reads the same thing whichever side refused.
 */
export const REFUSAL_SENTENCE: Record<string, string> = {
  not_a_url: "That is not a valid web address.",
  not_https: "The webhook must use https.",
  has_credentials: "The webhook address must not contain a username or password.",
  non_default_port: "The webhook must use the standard https port.",
  ip_literal: "The webhook must use a host name, not a numeric address.",
  too_long: "That webhook address is too long.",
  throttled: "Too many changes or tests. Wait a minute and try again.",
  unreadable: "The webhook could not be stored securely. Whoever runs Fuel needs to check its encryption key.",
  not_configured: "Set a webhook first.",
  busy: "An alert is being sent right now. Try again in a few seconds.",
};

/** The test button's answer, one sentence per outcome word. */
const TEST_SENTENCE: Record<string, string> = {
  delivered: "Test alert delivered. Check the channel for a message from Fuel.",
  unreachable: "Fuel could not reach that webhook. It must be a public https address that accepts connections.",
  redirected: "The webhook answered with a redirect, and Fuel does not follow redirects. Use the final URL.",
  timed_out: "The webhook did not answer within 5 seconds.",
  rejected: "The webhook refused the message. Check that the URL is still current.",
  receiver_error: "The webhook's server had an error. Real alerts are retried; try the test again in a minute.",
  invalid_address: "The stored webhook is no longer a valid address. Replace it.",
  unreadable: "Fuel could not read the stored webhook. Whoever runs Fuel needs to check its encryption key.",
};

export function testSentence(outcome: string): string {
  return TEST_SENTENCE[outcome] ?? "The test alert was not delivered.";
}

/** The same outcomes, short, for a line in the history. */
const SHORT: Record<string, string> = {
  unreachable: "could not reach the webhook",
  redirected: "the webhook redirected",
  timed_out: "the webhook did not answer in time",
  rejected: "the webhook refused it",
  receiver_error: "the webhook had an error",
  invalid_address: "the stored webhook is invalid",
  unreadable: "the stored webhook could not be read",
};

export function outcomeShort(outcome: string): string {
  return SHORT[outcome] ?? outcome.replace(/_/g, " ");
}

/**
 * Whether one alert went out, in words.
 *
 * `baseline` and `silent` are the two ways an alert is recorded and
 * deliberately not sent, and both are said plainly, so an owner who sees a
 * line here and no message in Slack knows why rather than suspecting a fault.
 */
export function deliveryWords(record: FuelAlertRecord, configured: boolean): string {
  switch (record.notice) {
    case "baseline":
      return "Not sent: it was already open when alerts were set up";
    case "silent":
      return "Not sent: it came back within the hour";
    case "pending":
      return configured ? "Waiting to send" : "Not sent: no webhook is set";
    case "batched":
      if (record.delivery === "delivered") return "Sent";
      if (record.delivery === null || record.delivery === "due" || record.delivery === "sending") return "Sending";
      // Not "the webhook was removed": a delivery is also set aside when its
      // message could not be built (src/alerts/dispatch.ts), and the API sends
      // both as "cancelled". Saying which would be a guess.
      if (record.delivery === "cancelled") return "Not sent";
      if (record.delivery === "failed") return "Not delivered";
      return `Not delivered: ${outcomeShort(record.delivery)}`;
    default:
      return record.notice;
  }
}

/**
 * Whether a typed value may be sent to Fuel as a webhook at all.
 *
 * Deliberately loose (Fuel applies the real rules) and deliberately run in the
 * browser: its job is to keep a password a browser autofilled into the
 * password-type webhook field from ever leaving the page. See AlertsPanel.
 */
export function isHttpsAddress(value: string): boolean {
  return /^https:\/\/\S/i.test(value.trim());
}

/** "2026-10-09 14:05 UTC". Dates elsewhere are days; a delivery is worth the minute. */
export function moment(iso: string | null): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "—";
}
