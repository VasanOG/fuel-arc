/**
 * Turning "what needs a person" into alerts (ADR 0021).
 *
 * READS existing tables (through `attentionFor`) and WRITES only alert_*.
 * Nothing here changes a payment, a cap, an approval or a posting, and nothing
 * here is called from a money path.
 */
import { listCompanies } from "../db/companies.js";
import { applySweep, batchIfDue, getWebhookRow, markSweepRan, openEvents, pruneAlerts, type SweepChanges } from "../db/alerts.js";
import { attentionFor } from "./attention.js";
import { ceilingOf, COOLDOWN_MS } from "./events.js";
import { toPayload, type Dispatcher } from "./dispatch.js";

export interface CompanySweep {
  opened: number;
  reopened: number;
  resolved: number;
  /** Whether this sweep wrote anything at all. */
  wrote: boolean;
}

/**
 * One company, SYNCHRONOUSLY, and typed to stay that way.
 *
 * Not `async`, returns no promise, and contains no `await`: its one
 * transaction (in `applySweep`) opens and closes in a single JavaScript turn,
 * so it cannot capture a request's statements or nest inside another
 * transaction on the shared connection. verify-api checks this structurally,
 * not with a regex (AL-A5).
 *
 * A WRITE ONLY WHEN SOMETHING CHANGED (security review, F3). Most sweeps find
 * the world as it was a minute ago, and those take no write lock at all, so a
 * script writing to the same file is not made to wait once a minute for
 * nothing.
 */
export function sweepCompany(companyId: string, now: Date): CompanySweep {
  const wanted = new Map(
    attentionFor(companyId, now).map((item) => [
      `${item.event}|${item.subjectKey}`,
      {
        event: item.event,
        severity: item.severity,
        ceiling: ceilingOf(item.event),
        subjectKey: item.subjectKey,
        payloadJson: JSON.stringify(toPayload(item)),
      },
    ]),
  );
  const open = new Map(openEvents(companyId).map((e) => [`${e.event}|${e.subjectKey}`, e]));

  const changes: SweepChanges = { open: [], resolve: [], update: [] };
  for (const [key, w] of wanted) {
    const existing = open.get(key);
    if (existing === undefined) changes.open.push(w);
    else if (existing.payloadJson !== w.payloadJson) changes.update.push({ id: existing.id, payloadJson: w.payloadJson });
  }
  for (const [key, e] of open) if (!wanted.has(key)) changes.resolve.push(e.id);

  const changed = changes.open.length > 0 || changes.resolve.length > 0 || changes.update.length > 0;
  const applied = changed
    ? applySweep({ companyId, now, changes, cooldownMs: COOLDOWN_MS })
    : { opened: 0, reopened: 0, resolved: 0 };

  // EVERY sweep of a company with a webhook asks whether a message is due, not
  // only a sweep that found something new: an event held by a ceiling must go
  // out once its hour frees, whether or not anything else ever happens (review
  // of commit 1, F-1). Without a webhook, events wait as `pending`, and setting
  // one baselines them. `batchIfDue` reads first and writes only if it sends.
  const batched = getWebhookRow(companyId) !== null ? batchIfDue(companyId, now) : null;
  return { ...applied, wrote: changed || batched !== null };
}

/**
 * Every company, then delivery.
 *
 * ONE COMPANY CANNOT STOP THE OTHERS: each has its own try/catch, so a row that
 * makes one company's sweep throw leaves every other company's alerting
 * running (security review, F3).
 *
 * IT YIELDS BETWEEN COMPANIES, never inside one. The per-company work is
 * synchronous and holds the event loop while it runs; yielding between
 * companies bounds how long any one request can wait behind the sweep to one
 * company's work, rather than all of it (AL-D7 measures that).
 */
export async function sweepAll(options: {
  now: () => Date;
  dispatcher: Dispatcher | null;
  onCompanyError?: (companyId: string) => void;
}): Promise<{ companies: number; failed: number }> {
  let failed = 0;
  const companies = listCompanies().map((c) => c.id);
  for (const companyId of companies) {
    try {
      sweepCompany(companyId, options.now());
    } catch {
      failed += 1;
      // The company id only. A sweep error is a database or code fault, and its
      // message is not something to put in a log next to tenant data.
      options.onCompanyError?.(companyId);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  try {
    pruneAlerts(options.now());
  } catch {
    // Housekeeping; the next sweep tries again.
  }
  try {
    markSweepRan(options.now());
  } finally {
    // Delivery is not held hostage by bookkeeping (review of commit 1, F-8).
    options.dispatcher?.pump();
  }
  return { companies: companies.length, failed };
}
