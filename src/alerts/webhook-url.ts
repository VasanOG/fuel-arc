/**
 * A company's alert webhook: what a valid one looks like, and how it is kept.
 *
 * THE URL IS A CREDENTIAL. A Slack incoming-webhook URL lets anyone who holds
 * it post into that channel, and its secret is the path. So it is stored the
 * way QuickBooks tokens are (src/lib/secrets.ts, AES-256-GCM), returned by no
 * route, written to no log, and never put into an error message: every refusal
 * below is a fixed sentence that does not echo what was sent.
 */
import { isIP } from "node:net";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";

/** Why a webhook URL was refused. A closed set, and none of them quotes the URL. */
export type WebhookUrlProblem =
  | "not_a_url"
  | "not_https"
  | "has_credentials"
  | "non_default_port"
  | "ip_literal"
  | "too_long";

export class WebhookUrlError extends Error {
  constructor(readonly problem: WebhookUrlProblem) {
    super(WEBHOOK_URL_MESSAGES[problem]);
    this.name = "WebhookUrlError";
  }
}

/** The sentences an owner sees. Fixed, so a URL can never be reflected through one. */
export const WEBHOOK_URL_MESSAGES: Record<WebhookUrlProblem, string> = {
  not_a_url: "That is not a valid web address.",
  not_https: "The webhook must use https.",
  has_credentials: "The webhook address must not contain a username or password.",
  non_default_port: "The webhook must use the standard https port.",
  ip_literal: "The webhook must use a host name, not a numeric address.",
  too_long: "That webhook address is too long.",
};

const MAX_URL_LENGTH = 2048;

/**
 * The rules a webhook URL must meet. Returns the normalised `href`.
 *
 * RUN AT SET TIME AND AGAIN AT SEND TIME (security review, F5). The route is
 * not the only thing that can put a row in alert_webhooks: a script, a seed, a
 * restored backup can too. Checking again before every send means a row that
 * never passed through the route still cannot send anywhere the route would
 * have refused.
 *
 * WHAT THIS IS NOT: the SSRF control. A host name that resolves to 127.0.0.1
 * or 169.254.169.254 passes here, and is refused at connect time by
 * safe-fetch's DNS hook, which checks every address the name resolves to, at
 * the moment the socket opens. These rules make the URL a webhook; that hook
 * makes it a public one.
 *
 *   - https only: the URL is a secret, and so is what it carries.
 *   - no `user:pass@`: credentials in a URL end up in logs and error messages.
 *   - the default port only: a webhook has no business on a numbered port, and
 *     allowing one would let an owner probe ports through the test button.
 *   - a name, never a numeric host: a webhook is a service, and refusing every
 *     literal closes the decimal, hex and IPv6 spellings in one rule. IPv6
 *     literals keep their brackets in `URL.hostname`, and `isIP("[::1]")` is
 *     false, so they are stripped first, as safe-fetch.ts does.
 */
export function assertWebhookUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new WebhookUrlError("not_a_url");
  if (raw.length > MAX_URL_LENGTH) throw new WebhookUrlError("too_long");
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new WebhookUrlError("not_a_url");
  }
  if (parsed.protocol !== "https:") throw new WebhookUrlError("not_https");
  if (parsed.username !== "" || parsed.password !== "") throw new WebhookUrlError("has_credentials");
  if (parsed.port !== "") throw new WebhookUrlError("non_default_port");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "" || isIP(host) !== 0) throw new WebhookUrlError("ip_literal");
  if (parsed.href.length > MAX_URL_LENGTH) throw new WebhookUrlError("too_long");
  return parsed.href;
}

/** What is sealed. `purpose` and `companyId` are checked on every open. */
interface Sealed {
  purpose: "alert_webhook";
  companyId: string;
  url: string;
  host: string;
}

/** The webhook URL and its host, sealed for one company. */
export function sealWebhook(companyId: string, href: string): string {
  const sealed: Sealed = { purpose: "alert_webhook", companyId, url: href, host: new URL(href).hostname };
  return encryptSecret(JSON.stringify(sealed));
}

/** The ciphertext did not decrypt, or decrypted to something that is not this company's webhook. */
export class WebhookUnreadableError extends Error {
  constructor() {
    super("the stored alert webhook could not be read");
    this.name = "WebhookUnreadableError";
  }
}

/**
 * Opens a sealed webhook, refusing anything that is not THIS company's.
 *
 * WHY THE COMPANY IS INSIDE THE CIPHERTEXT. `encryptSecret` takes no
 * associated data, so on its own a ciphertext copied from company A's row onto
 * company B's would decrypt perfectly and B's alerts would go to A's channel.
 * GCM authenticates the plaintext, so a company id INSIDE it cannot be edited
 * without the key, and checking it here turns that copy into a refusal.
 * `purpose` does the same for a blob moved into some other `_enc` column.
 */
export function openWebhook(companyId: string, stored: string): { url: string; host: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(stored));
  } catch {
    throw new WebhookUnreadableError();
  }
  const s = parsed as Partial<Sealed>;
  if (
    s === null ||
    typeof s !== "object" ||
    s.purpose !== "alert_webhook" ||
    s.companyId !== companyId ||
    typeof s.url !== "string" ||
    typeof s.host !== "string"
  ) {
    throw new WebhookUnreadableError();
  }
  return { url: s.url, host: s.host };
}
