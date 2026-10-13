import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { APPROVAL_STATUS_VALUES, listApprovals, type FuelApproval } from "@/lib/fuel";
import { ApprovalDecision } from "@/components/ApprovalDecision";
import { PageHeader } from "@/components/shell/PageHeader";
import { DemoTag, StatusPill } from "@/components/ui";
import styles from "./approvals.module.css";

// An operator queue. A cached copy would show a decision that has been made.
export const dynamic = "force-dynamic";

/**
 * The approvals queue.
 *
 * IT CAN DECIDE, AS OF STAGE 3 COMMIT C. Until then this page said outright
 * that deciding was not available from here, on the principle that a control
 * which looks live and is not is worse than an absent one. What was missing was
 * never the button: it was an identity to record against the decision. The
 * dashboard held one shared operator key, so "who approved this payment" had no
 * answer. It now carries the viewer's own session, so it does.
 *
 * STILL A SERVER COMPONENT, and the JavaScript is confined to the decide
 * control on pending rows. The status filter is a set of links, so a view is
 * still a URL: "what was waiting on Tuesday" can be sent to someone.
 *
 * ONLY A PENDING ROW OFFERS THE CONTROL. A decided one shows what was decided
 * and nothing to press — the API would refuse a second decision with a 409, and
 * a button whose only outcome is a refusal is not a capability.
 */

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

function stamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * The one status this page names itself, and why that is not a second
 * vocabulary.
 *
 * Everything a person reads ABOUT A RECORD comes off the record: `statusLabel`,
 * `statusTone`, `scopeLabel`, all decided by src/lib/payment-presentation.ts.
 * This string is not about a record — it is the name of a view, describing what
 * the section contains and what an operator is here to do.
 *
 * It exists because the API can only supply a status's words by returning a row
 * that has that status, and there are no pending approvals in this database
 * today. A filter that could not name its own default view would be worse than
 * one page-authored heading. See the report in docs/roadmap.md for the gap.
 */
const PENDING_VIEW = "Needs a decision";

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.status) ? params.status[0] : params.status;

  /*
   * Anything not in the route's own enum is dropped, not passed through.
   * The API would refuse it anyway; refusing here means a mistyped URL lands on
   * the default view instead of an error, which is the right outcome for a
   * queue somebody may have bookmarked wrong.
   */
  const status =
    raw && (APPROVAL_STATUS_VALUES as readonly string[]).includes(raw) ? raw : "pending";
  const showingAll = raw === "all";
  const requested = showingAll ? undefined : status;

  /*
   * Two reads, in parallel.
   *
   * `shown` is server-filtered — the status goes to the API, which applies it in
   * SQL. `all` exists only to count and NAME the other views: a filter link can
   * say "Denied (6)" because a denied row carried the word "Denied" with it. It
   * is not rendered as rows.
   *
   * Both are unpaginated, which listApprovalRequests documents as deliberate:
   * an approval row is created only when a ceiling refuses a payment, so the
   * table grows with exceptions rather than with traffic (20 rows against 267
   * payments today).
   */
  let shown: FuelApproval[] = [];
  let all: FuelApproval[] = [];
  let error: string | null = null;
  try {
    [shown, all] = await Promise.all([listApprovals(requested), listApprovals()]);
  } catch (cause) {
    /*
     * A SIGNED-OUT VIEWER MUST NOT BE TOLD FUEL IS DOWN. `listApprovals` now
     * answers a 401 by redirecting to the sign-in page, and `redirect` works by
     * throwing — so without this line that redirect lands in `error` and the
     * page renders "Fuel could not be reached", which is false in a way that
     * sends an operator to check a service that is working perfectly.
     */
    unstable_rethrow(cause);
    error = cause instanceof Error ? cause.message : "Fuel could not be reached.";
  }

  // Counts and labels for the filter, built from rows that exist. A status with
  // no rows is not offered, because there would be nothing to offer and no word
  // from the server to call it.
  const views = new Map<string, { label: string; count: number }>();
  for (const approval of all) {
    const existing = views.get(approval.status);
    views.set(approval.status, {
      label: approval.statusLabel,
      count: (existing?.count ?? 0) + 1,
    });
  }
  views.delete("pending");

  const demoShown = shown.filter((a) => a.isDemo).length;
  const pendingCount = all.filter((a) => a.status === "pending").length;

  function href(value: string): string {
    return value === "pending" ? "/approvals" : `/approvals?status=${value}`;
  }
  const current = showingAll ? "all" : status;

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Payments a ceiling above the agent refused, held for a person to decide. Approving one lets a single payment through — it does not raise any limit."
      />

      {error ? (
        <p className={styles.error} role="alert">
          Fuel could not be reached, so this queue is not being shown. Nothing has changed, and no
          payment has been decided. {error}
        </p>
      ) : (
        <>
          <nav className={styles.views} aria-label="Filter by decision">
            <Link
              href="/approvals"
              className={current === "pending" ? `${styles.view} ${styles.viewOn}` : styles.view}
              aria-current={current === "pending" ? "page" : undefined}
            >
              {PENDING_VIEW}
              <span className={styles.count}>{pendingCount}</span>
            </Link>
            {[...views].map(([value, view]) => (
              <Link
                key={value}
                href={href(value)}
                className={current === value ? `${styles.view} ${styles.viewOn}` : styles.view}
                aria-current={current === value ? "page" : undefined}
              >
                {view.label}
                <span className={styles.count}>{view.count}</span>
              </Link>
            ))}
            <Link
              href="/approvals?status=all"
              className={current === "all" ? `${styles.view} ${styles.viewOn}` : styles.view}
              aria-current={current === "all" ? "page" : undefined}
            >
              Everything
              <span className={styles.count}>{all.length}</span>
            </Link>
          </nav>

          {demoShown > 0 && (
            <p className={styles.demoNote}>
              {demoShown === shown.length
                ? "Every request below is"
                : `${demoShown} of the requests below ${demoShown === 1 ? "is" : "are"}`}{" "}
              demonstration data, seeded to show the flow. {demoShown === 1 ? "It" : "They"} did not
              hold a real payment.
            </p>
          )}

          <div className="panel">
            {shown.length === 0 ? (
              <div className={styles.empty}>
                {current === "pending" ? (
                  <>
                    <p className={styles.emptyLead}>No payment is waiting for a decision.</p>
                    <p className={styles.emptyWhy}>
                      A request appears here only when a team or company ceiling refuses a payment,
                      or when an amount is unusual for the agent that asked. An agent&apos;s own cap
                      is never queued — a payment that does not fit the budget its operator set for
                      it is not an exception worth asking about.
                    </p>
                  </>
                ) : (
                  <p className={styles.emptyLead}>Nothing to show in this view.</p>
                )}
              </div>
            ) : (
              <div className="scroll-x">
                <table className="data-table">
                  <caption className="visually-hidden">
                    Payments held for a human decision, with the agent that asked, the amount, the
                    ceiling that refused it, and the decision so far.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Requested (UTC)</th>
                      <th scope="col">Agent</th>
                      <th scope="col">Paid to</th>
                      <th scope="col" className="numeric">
                        Amount
                      </th>
                      <th scope="col">Refused by</th>
                      <th scope="col">Decision</th>
                      <th scope="col">Decided</th>
                      <th scope="col">
                        <span className="visually-hidden">Approve or deny</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((approval) => (
                      <tr key={approval.id}>
                        <td>{stamp(approval.createdAt)}</td>
                        <td>
                          <Link href={`/agents/${approval.agentId}`} className={styles.agentLink}>
                            {approval.agentName}
                          </Link>
                          <span className={styles.team}>{approval.teamName}</span>
                        </td>
                        <td>{approval.vendor}</td>
                        <td className="numeric">${approval.amount}</td>
                        {/* The server's words for the ceiling. Never mapped here. */}
                        <td>{approval.scopeLabel}</td>
                        <td>
                          <StatusPill label={approval.statusLabel} tone={approval.statusTone} />
                          {approval.isDemo && <DemoTag />}
                        </td>
                        <td>
                          {day(approval.decidedAt)}
                          {/*
                            WHO decided it, under WHEN. Shown only once there is
                            a decision, and only when a name exists: a request
                            still waiting has nobody to name, and one a shared
                            key decided before accounts existed has no answer.
                            The blank is deliberate — "system" or the owner's
                            address would be inventing an audit trail.
                          */}
                          {approval.decidedBy && (
                            <span className={styles.decidedBy}>{approval.decidedBy}</span>
                          )}
                          {/*
                            An approved request is redeemable once and expires.
                            Until it is used, when it runs out is the operative
                            fact — it is the difference between a permission that
                            still exists and one that quietly does not.
                          */}
                          {approval.status === "approved" && approval.approvalExpiresAt && (
                            <span className={styles.expiry}>
                              expires {stamp(approval.approvalExpiresAt)}
                            </span>
                          )}
                        </td>
                        <td>
                          {approval.status === "pending" && (
                            <ApprovalDecision
                              approvalId={approval.id}
                              agentName={approval.agentName}
                              amount={approval.amount}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <div className={styles.footnotes}>
        <p className="note">
          <strong>What approving does.</strong> It lets one specific payment through the ceiling
          that refused it, once, and only until the approval expires. No limit is changed, the
          spend still counts against every budget, and the agent&apos;s own cap and its rate limit
          are never waived. An unusual-amount approval waives only that check — every budget still
          applies to it.
        </p>
        <p className="note">
          <strong>Who decided.</strong> A decision made here is recorded against the person signed
          in, not against a shared key — which is why deciding was not offered from this page until
          accounts existed. Approving cannot be undone from here: a request that has been decided is
          refused a second decision, so the decision is asked for twice before it is sent.
        </p>
      </div>
    </>
  );
}
