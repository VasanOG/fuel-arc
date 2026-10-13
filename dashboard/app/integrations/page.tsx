import Link from "next/link";
import { getAccountingStatus, getAlertSettings, getEnvironment, getViewer } from "@/lib/fuel";
import { PageHeader } from "@/components/shell/PageHeader";
import { AlertsPanel } from "@/components/AlertsPanel";
import styles from "./integrations.module.css";

// A status page. A cached copy could report a connection as live after it
// was disconnected.
export const dynamic = "force-dynamic";

/**
 * How Fuel is connected to the systems around it.
 *
 * A status page for QuickBooks and payments — no Connect, Disconnect, or Setup
 * here. Those are mutations and stay on /accounting, which already owns the
 * QuickBooks OAuth flow and account setup. This page answers one question
 * honestly: what can Fuel currently prove about its own connections?
 *
 * ONE EXCEPTION, ADR 0021: alerts. Where alerts go is a connection to an
 * outside system like the others, and it has no other home, so its one form
 * lives here, shown to an owner only (components/AlertsPanel.tsx).
 *
 * EVERY VALUE HERE HAS A SOURCE, named in the comment above it. Nothing is
 * inferred and nothing is asserted because it would be a reasonable guess —
 * an unreachable status is reported as unreachable, not folded into "not
 * connected", which is a different and better-sounding fact than the truth.
 *
 * Built from the same devices the rest of the shell uses — .section,
 * .eyebrow, .panel, the record `<dl>` from the agent page — rather than a
 * parallel status-card component. A page whose whole job is to be trustworthy
 * should look exactly like the other pages that are.
 */
export default async function IntegrationsPage() {
  const [environment, accounting, viewer] = await Promise.all([
    getEnvironment(),
    getAccountingStatus(),
    getViewer(),
  ]);

  // Alert settings are an owner's (ADR 0021): where this company's data is
  // sent is their decision. They are not even asked for on an operator's
  // visit, so a failing webhook is not something an operator learns here.
  const isOwner = viewer?.role === "owner";
  const alertSettings = isOwner ? await getAlertSettings() : null;

  const environmentLabel = environment ? environment.label : "Unknown — Fuel could not be asked";

  return (
    <>
      <PageHeader
        title="Integrations"
        description="How Fuel is connected to the systems around it, and exactly what each connection can currently prove about itself."
      />

      <section className="section">
        <p className="eyebrow">Accounting — QuickBooks</p>
        <div className="panel">
          {accounting === null ? (
            // Not "disconnected" — Fuel could not be asked, which is a
            // different and less certain fact. Conflating the two would tell
            // an operator their books are unmanaged when the truth is Fuel
            // simply has no current answer.
            <p className={styles.unknown} role="status">
              Fuel could not reach its own API to check this connection. Its state is unknown, not
              disconnected — try again, or open{" "}
              <Link href="/accounting" className={styles.link}>
                Accounting
              </Link>{" "}
              directly.
            </p>
          ) : (
            <div className="panel-pad">
              <dl className="record">
                <div>
                  {/* Source: GET /api/environment — the top-level verdict,
                      the same fact the shell badge shows. */}
                  <dt>Environment</dt>
                  <dd>{environmentLabel}</dd>
                </div>
                <div>
                  {/* Source: GET /api/integrations/quickbooks/status → connected */}
                  <dt>Connection</dt>
                  <dd>
                    {accounting.connected ? (
                      <span className={styles.ok}>Connected</span>
                    ) : (
                      <span className={styles.pending}>Not connected</span>
                    )}
                    {accounting.connected && accounting.connectedAt && (
                      <span className={styles.since}>
                        since {accounting.connectedAt.slice(0, 10)}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  {/*
                    Source: same route → readyToPost, missing[], and
                    accountingCurrency.currency/.verified.

                    One cell, not two. Currency verification is one of the
                    facts `readyToPost` is already an AND of — `missing`
                    includes "USD verification" whenever it is the blocker —
                    so a separate "Currency" cell would either repeat this one
                    or, worse, disagree with it if the two were ever built
                    from different reads. Keeping it here is a second reason,
                    not just tidiness: four facts do not divide evenly into
                    this grid's three columns, and a cell holding two related
                    facts is the honest fix, not a wider grid or a fact left
                    off.

                    "verified" is reserved for a reading of QuickBooks' own
                    Preferences (ADR 0008) — an unchecked company reports "not
                    yet verified" rather than a hopeful "USD".
                  */}
                  <dt>Ready to post</dt>
                  <dd>
                    {accounting.readyToPost ? (
                      <span className={styles.ok}>Yes</span>
                    ) : (
                      <span className={styles.pending}>
                        Not yet
                        {accounting.missing.length > 0 && (
                          <span className={styles.since}>
                            — needs {accounting.missing.join(", ")}
                          </span>
                        )}
                      </span>
                    )}
                    {accounting.currencyVerified && (
                      <span className={styles.since}>
                        {accounting.currency}, verified from QuickBooks
                      </span>
                    )}
                  </dd>
                </div>
              </dl>

              <p className={styles.explain}>
                When connected, Fuel turns agent spend into journal entries an accountant can
                review before anything posts. Every posted figure opens back up into the payments
                and approvals it was built from — nothing is summarised away.
              </p>
            </div>
          )}
        </div>
        <Link href="/accounting" className={styles.cta}>
          Open the accounting workflow →
        </Link>
      </section>

      <section className="section">
        <p className="eyebrow">Alerts</p>
        <div className="panel">
          {viewer === null ? (
            // Not the operator note: Fuel could not say who is viewing, and
            // telling an owner "an owner chooses" would hide their own settings
            // behind a wrong answer (review of commit 2).
            <p className={styles.unknown} role="status">
              Fuel could not confirm who is signed in just now, so alert settings are not shown.
              Reload the page to try again.
            </p>
          ) : !isOwner ? (
            <p className={styles.unknown}>
              An owner of this company chooses where alerts go. Everything an alert would say is
              on the Overview.
            </p>
          ) : alertSettings === null ? (
            // Not "alerts are off": Fuel could not be asked, which is less
            // certain, and saying off would be a confident wrong answer.
            <p className={styles.unknown} role="status">
              Fuel could not read the alert settings just now. Whether alerts are on is not known
              from here. Try again in a moment.
            </p>
          ) : (
            <AlertsPanel webhook={alertSettings.webhook} alerts={alertSettings.alerts} />
          )}
        </div>
        {/*
          Said here rather than left to be discovered. Each is a real gap,
          recorded in ADR 0021, and an owner relying on alerts should know it
          before relying on them, not after.
        */}
        <p className="note">
          Alerts tell this company&apos;s owner when something on the Overview starts needing a
          person, at most a few times an hour. They do not yet cover:
        </p>
        <ul className={styles.notCovered}>
          <li>a QuickBooks connection that fails to refresh (only one that has expired, or is about to)</li>
          <li>problems with sign-in, which belong to whoever runs Fuel, not to one company</li>
          <li>anything that resolves itself before the next check, about once a minute</li>
        </ul>
      </section>

      <section className="section">
        <p className="eyebrow">Payment execution</p>
        <div className="panel">
          <div className="panel-pad">
            <dl className="record">
              <div>
                {/* Source: GET /api/environment, top-level verdict. */}
                <dt>Environment</dt>
                <dd>{environmentLabel}</dd>
              </div>
            </dl>

            <p className={styles.explain}>
              Fuel checks an agent&apos;s authority before any payment is attempted: its own
              spend cap, its team&apos;s, its company&apos;s, an anomaly check against its recent
              history, and a rate limit — in that order. Every attempt is recorded, whether it
              goes through or is refused, and every refusal states which check stopped it.
            </p>
          </div>
        </div>
        <Link href="/activity" className={styles.cta}>
          See real outcomes in the Activity Ledger →
        </Link>
      </section>
    </>
  );
}
