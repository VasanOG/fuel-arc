/**
 * The words that leave Fuel in an alert (ADR 0021).
 *
 * THIS IS A PRODUCT SURFACE ON SOMEONE ELSE'S SCREEN. It goes to a channel the
 * owner chose, which may be read by people who have never seen Fuel, so two
 * rules from the dashboard apply in full: no crypto terms (CLAUDE.md), and
 * nothing beyond what the reader needs. A line is a label from a closed lookup,
 * a name, a dollar figure and a link. Never a reason an operator typed, an
 * address, a hash, a nonce, a resource URL or anybody's email.
 *
 * NAMES ARE OPERATOR-TYPED, AND SLACK-COMPATIBLE RECEIVERS INTERPRET TEXT.
 * An agent named `<!channel>` would page a whole channel; `<https://x|Open>`
 * would plant a link; a newline would forge a second alert line; `*` and `_`
 * restyle; a bidi override reverses what a reader sees. `safeName` neutralises
 * all of it, and does so ONLY here, at the boundary: the Overview gets raw
 * names from the API, or a person would read `&lt;` on their own dashboard.
 */
import { baseUnitsToDollars } from "../lib/money.js";
import type { AttentionGroup } from "./attention.js";
import { LABEL } from "./events.js";

/** Longest name kept in an alert, in characters, before escaping. */
export const MAX_NAME_CHARS = 80;
/**
 * Longest message, AFTER escaping. Under the ~2,000 some Slack-compatible
 * receivers accept, so a long or `&`-heavy name can never make every message
 * a permanent 4xx and falsely mark the webhook degraded.
 */
export const MAX_MESSAGE_CHARS = 1800;
/** Lines listed before "and N more". */
export const MAX_LINES = 8;

const ZERO_WIDTH_SPACE = "\u200B";

/**
 * A name made inert for a Slack-compatible receiver, on one line.
 *
 *   1. Control characters (newlines included) and bidi controls become spaces
 *      or vanish, then whitespace collapses: one name, one line, read in the
 *      order it was typed.
 *   2. Capped at MAX_NAME_CHARS.
 *   3. `&`, `<`, `>` escaped in ONE pass, so an `&` that is already part of an
 *      escape is never escaped twice. This is what stops `<!channel>`,
 *      `<!here>`, `<@U123>` and `<url|text>`.
 *   4. Backticks replaced, then the whole name wrapped in an inline code span,
 *      which stops `*bold*`, `_italic_`, `~strike~` and bare-URL linking.
 *   5. A zero-width space after every `@`, so a plain `@here` or `@channel`
 *      cannot notify on receivers (Mattermost, Rocket.Chat) that read mentions
 *      from plain text rather than from `<!here>`.
 */
export function safeName(raw: string | null): string {
  if (raw === null || raw === "") return "`an agent`";
  const oneLine = raw
    // C0 and C1 controls, including \n \r \t.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    // Bidi embeddings, overrides and isolates, the marks, and the word joiner.
    // Written as escapes: literal invisible characters in source are a review
    // hazard ("Trojan Source"), and a formatter can strip them unseen.
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const capped = [...oneLine].slice(0, MAX_NAME_CHARS).join("");
  const escaped = capped.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  const inert = escaped.replace(/`/g, "'").replace(/@/g, `@${ZERO_WIDTH_SPACE}`);
  return `\`${inert === "" ? "an agent" : inert}\``;
}

function dollars(baseUnits: bigint | null): string | null {
  return baseUnits === null ? null : `$${baseUnitsToDollars(baseUnits)}`;
}

/** One line for a group, built only from allowlisted fields. */
export function groupLine(g: AttentionGroup, origin: string): string {
  const label = g.items > 1 ? `${g.items} ${LABEL[g.event].many}` : LABEL[g.event].one;
  const who =
    g.agentName !== null
      ? ` for ${safeName(g.agentName)}`
      : g.teamName !== null
        ? ` for ${safeName(g.teamName)}`
        : "";
  const noun = g.event === "agent_throttled" ? "refusal" : "attempt";
  const money =
    g.amountBaseUnits !== null
      ? ` (${dollars(g.amountBaseUnits)})`
      : g.spentBaseUnits !== null && g.capBaseUnits !== null
        ? ` (${dollars(g.spentBaseUnits)} of ${dollars(g.capBaseUnits)})`
        : g.count !== null
          ? ` (${g.count} ${noun}${g.count === 1 ? "" : "s"})`
          : "";
  const link = g.href !== null ? ` ${origin}${g.href}` : "";
  return `• ${label}${who}${money}${link}`;
}

/**
 * The whole message: a heading, up to MAX_LINES lines, then "and N more".
 * Capped at MAX_MESSAGE_CHARS by dropping whole lines from the end, never by
 * cutting one in half: a half-cut line could end inside an escape and leave a
 * raw `&` or `<`.
 *
 * There is no separate digest of held-back items: an event a ceiling holds
 * stays pending and goes out as a line in a later message (src/db/alerts.ts).
 */
export function alertText(groups: AttentionGroup[], origin: string): string {
  const heading =
    groups.length === 1 ? "Fuel: something needs attention" : `Fuel: ${groups.length} things need attention`;
  const lines = groups.slice(0, MAX_LINES).map((g) => groupLine(g, origin));

  // "and N more" counts EVERY group not shown, whether past MAX_LINES or
  // dropped below to fit the length cap, so the number is always the truth.
  const build = (body: string[]) => {
    const tail: string[] = [];
    const omitted = groups.length - body.length;
    if (omitted > 0) tail.push(`…and ${omitted} more.`);
    tail.push(`Open Fuel: ${origin}/`);
    return [heading, ...body, ...tail].join("\n");
  };
  let body = lines;
  while (body.length > 0 && build(body).length > MAX_MESSAGE_CHARS) body = body.slice(0, -1);
  const text = build(body);
  // Only reachable with an absurd FUEL_DASHBOARD_URL: the heading and tail alone
  // are short. A hard cap keeps the promise either way.
  return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text;
}

/** The fixed test message. Carries no company data at all. */
export function testText(origin: string): string {
  return `Fuel test alert: alerts for your company will arrive here. Open Fuel: ${origin}/`;
}

/** The fixed notice sent to a destination that has just been replaced or removed. */
export function changedText(origin: string): string {
  return (
    "Fuel: an owner changed where this company's alerts are sent. Alerts will no longer arrive here. " +
    `If you did not expect this, open Fuel: ${origin}/`
  );
}
