import { notFound } from "next/navigation";
import Link from "next/link";
import { getAgent, listApprovals, listTeams } from "@/lib/fuel";
import { PageHeader } from "@/components/shell/PageHeader";
import { AgentStatus, Authority, DemoTag, StatusPill } from "@/components/ui";
import { FundingPanel } from "@/components/FundingPanel";
import { day, signedUsd } from "@/lib/presentation";

// An operator tool watching live spend; a cached copy would be a wrong answer.
export const dynamic = "force-dynamic";

/*
 * The bound now lives in the API.
 *
 * This page used to slice an unbounded response client-side, because
 * GET /api/agents/:id returned an agent's whole history — 220 rows for the
 * busiest agent here. 5B-2 bounded it at the route and made it report how many
 * exist, so the page states what it is showing from the server's own count
 * rather than from the length of whatever arrived.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [agent, teams, approvals] = await Promise.all([
    getAgent(id),
    listTeams(),
    listApprovals(),
  ]);
  if (!agent) notFound();

  const team = teams.find((t) => t.id === agent.teamId);

  /*
   * Which payments a person had to authorise.
   *
   * Approvals carry the payment they released, so the join runs this way round.
   * A payment with no approval is not unauthorised — it fitted inside every
   * cap, which is itself a decision, just not one that needed a human. That
   * distinction is the product's whole argument, so it is drawn explicitly
   * rather than left as a blank cell.
   */
  const approvedPayments = new Map(
    approvals.filter((a) => a.paymentId !== null).map((a) => [a.paymentId!, a]),
  );

  const demoCount = agent.payments.filter((p) => p.isDemo).length;

  return (
    <>
      <PageHeader
        title={agent.name}
        description="Financial record — what this agent may spend, what it has spent, what it has earned, and who allowed it."
        aside={<AgentStatus frozen={agent.frozen} />}
      />

      <p className="crumb">
        <Link href="/agents" className="link-btn">
          ← All agents
        </Link>
      </p>

      {agent.frozen && (
        <div className="notice notice-bad" role="status">
          <strong>Frozen{agent.frozenAt ? ` since ${day(agent.frozenAt)}` : ""}.</strong>{" "}
          {agent.frozenReason ?? "No reason was recorded."} This agent cannot pay for anything.
          {agent.frozenAttempts > 0 && (
            <>
              {" "}
              It has tried {agent.frozenAttempts}{" "}
              {agent.frozenAttempts === 1 ? "time" : "times"} since — the freeze is holding.
            </>
          )}
        </div>
      )}

      <section className="section">
        <p className="eyebrow">Authority</p>
        <div className="panel panel-pad">
          <Authority spent={agent.spent} cap={agent.spendCap} remaining={agent.remaining} />
        </div>
      </section>

      {/*
        THE P&L, IN ITS OWN SECTION, BETWEEN AUTHORITY AND RECORD.
        
        Not folded into the Record list below, where "Spent" already appears as
        the CAP figure. Two rows both labelled "Spent" in one definition list,
        holding different numbers, is precisely the presentation the roadmap
        named as the way this slice goes wrong. Its own eyebrow, its own panel,
        and the server's own sentence underneath.
      */}
      <section className="section">
        <p className="eyebrow">Money that moved</p>
        <div className="panel">
          <dl className="record">
            <div>
              <dt>Earned</dt>
              <dd className="mono">${agent.ledger.earned}</dd>
            </div>
            <div>
              <dt>Spent</dt>
              <dd className="mono">${agent.ledger.spent}</dd>
            </div>
            <div>
              <dt>Net</dt>
              <dd className="mono">{signedUsd(agent.ledger.net)}</dd>
            </div>
          </dl>
        </div>
        <p className="note">{agent.ledger.note}</p>
      </section>

      <section className="section">
        <p className="eyebrow">Record</p>
        <div className="panel">
          <dl className="record">
            <div>
              <dt>Team</dt>
              <dd>{team ? team.name : "—"}</dd>
            </div>
            <div>
              <dt>Spend cap</dt>
              <dd className="mono">${agent.spendCap}</dd>
            </div>
            <div>
              {/* The CAP figure, and named as such so it cannot be read as the
                  one in the section above. */}
              <dt>Spent against the cap</dt>
              <dd className="mono">${agent.spent}</dd>
            </div>
            <div>
              <dt>Remaining</dt>
              <dd className="mono">${agent.remaining}</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd className="mono">
                {agent.balance === null ? (
                  <span className="muted">unknown</span>
                ) : (
                  `$${agent.balance}`
                )}
              </dd>
            </div>
            <div>
              <dt>Registered</dt>
              <dd className="mono">{day(agent.createdAt)}</dd>
            </div>
          </dl>
        </div>
      </section>

      {/*
        A DELIBERATE, NARROW EXCEPTION (ADR 0019). Everywhere else in this
        product, funding and balances are dollar figures with no network,
        asset or address attached — see docs/architecture.md's
        no-crypto-surface rule. This is the one panel allowed to say
        otherwise, and only after a click; see FundingPanel's own comment for
        why.
      */}
      <section className="section">
        <p className="eyebrow">Fund this agent</p>
        {/*
          `available`, NOT `agent.funding`. Passing the funding object itself
          here would hand its address to Next.js's serializer regardless of
          what FundingPanel goes on to render — see that component's own
          comment. Only a boolean and this agent's id cross into it.
        */}
        <FundingPanel agentId={agent.id} available={agent.funding !== null} />
      </section>

      <section className="section">
        <p className="eyebrow">Payments</p>
        {agent.payments.length === 0 ? (
          <div className="panel">
            <p className="empty">
              This agent has not tried to pay for anything yet.
            </p>
          </div>
        ) : (
          <>
            <div className="panel">
              <div className="scroll-x" tabIndex={0} role="region" aria-label="Payments">
                <table className="data-table">
                  <caption className="visually-hidden">
                    The {agent.paymentsShown} most recent payment attempts by {agent.name}.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Vendor</th>
                      <th scope="col" className="numeric">
                        Amount
                      </th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Authorised by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agent.payments.map((payment) => {
                      const approval = approvedPayments.get(payment.id);
                      return (
                        <tr key={payment.id}>
                          <td className="mono">{day(payment.createdAt)}</td>
                          <td className="mono">{payment.vendor}</td>
                          <td className="numeric">${payment.amount}</td>
                          <td>
                            <StatusPill label={payment.statusLabel} tone={payment.statusTone} />
                            {/* Only refusals recorded since 5B-2 carry a code.
                                Older ones show the outcome and nothing else. */}
                            {payment.refusal && (
                              <span className="cell-note">{payment.refusal.label}</span>
                            )}
                          </td>
                          <td>
                            {approval ? (
                              <StatusPill
                                label={`A person · ${approval.blockedScope}`}
                                tone="watch"
                              />
                            ) : (
                              <span className="muted">Within caps</span>
                            )}
                            {payment.isDemo && (
                              <>
                                {" "}
                                <DemoTag />
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="note">
              Showing the {agent.paymentsShown} most recent of {agent.paymentsTotal}. Refusals
              recorded before Fuel stored a structured reason show no reason at all rather than
              one guessed from free text.
              {demoCount > 0 && (
                <>
                  {" "}
                  {demoCount} of these were seeded for demonstration and are marked{" "}
                  <DemoTag />.
                </>
              )}
            </p>
          </>
        )}
      </section>
    </>
  );
}
