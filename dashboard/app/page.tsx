import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { getAttentionItems, getCompany, listAgents, listTeams } from "@/lib/fuel";
import { ExportPanel } from "@/components/ExportPanel";
import { PageHeader } from "@/components/shell/PageHeader";
import { StatusPill } from "@/components/ui";
import { attentionLine, type AttentionLine } from "@/lib/attention";
import { signedUsd } from "@/lib/presentation";

// An operator tool watching live spend; a cached copy would be a wrong answer.
export const dynamic = "force-dynamic";

/*
 * "NEEDS ATTENTION" IS NO LONGER WORKED OUT HERE (ADR 0021).
 *
 * This page used to build the list itself from agents, teams and pending
 * approvals, with its own arithmetic. Alerting needs the same list, and two
 * copies of one rule disagree the first time either is edited, so the rule
 * moved to the API (src/alerts/attention.ts). This page now renders
 * `GET /api/attention` exactly: one line per item, already collapsed per agent
 * and kind, with nothing filtered or added here. verify-api checks this file
 * computes nothing (AL-A2).
 *
 * A failed read says so. It does not become "nothing needs a person", which is
 * a claim, and a read that failed is no evidence for it.
 */

export default async function OverviewPage() {
  const [company, agents, teams, attention] = await Promise.all([
    getCompany(),
    listAgents(),
    listTeams(),
    getAttentionItems().catch((error: unknown) => {
      // A sign-out still goes to sign in; any other failure is shown in place.
      unstable_rethrow(error);
      return null;
    }),
  ]);

  const lines = attention === null ? null : attention.items.map(attentionLine);

  return (
    <>
      <PageHeader
        title="Overview"
        description="What Fuel is governing right now, and what needs a person."
      />

      {/*
        TWO BLOCKS, NAMED, NOT ONE ROW OF SEVEN FIGURES.
        
        The block below counts money that MIGHT move; the one after it counts
        money that DID. Their two "spent" figures are supposed to disagree —
        a payment in flight is in the first and not the second — so putting
        them in one grid would present a discrepancy where there is a
        definition. The eyebrow on each says which question it answers, and the
        P&L block carries the server's own sentence explaining the difference.
      */}
      <section className="section">
        <p className="eyebrow">Authority</p>
        <div className="panel">
          <div className="figures">
            <div className="figure">
              <span className="figure-label">Agents governed</span>
              <span className="figure-value">{agents.length}</span>
              <span className="figure-note">
                across {teams.length} {teams.length === 1 ? "team" : "teams"}
              </span>
            </div>
            <div className="figure">
              <span className="figure-label">Company authority</span>
              <span className="figure-value">${company.spendCap}</span>
              <span className="figure-note">{company.name}</span>
            </div>
            <div className="figure">
              <span className="figure-label">Spent</span>
              <span className="figure-value">${company.spent}</span>
              <span className="figure-note">counted against the cap</span>
            </div>
            <div className="figure">
              <span className="figure-label">Remaining</span>
              <span className="figure-value">${company.remaining}</span>
              <span className="figure-note">before the company ceiling</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <p className="eyebrow">Money that moved</p>
        <div className="panel">
          <div className="figures">
            <div className="figure">
              <span className="figure-label">Earned</span>
              <span className="figure-value">${company.ledger.earned}</span>
              <span className="figure-note">confirmed receipts only</span>
            </div>
            <div className="figure">
              <span className="figure-label">Spent</span>
              <span className="figure-value">${company.ledger.spent}</span>
              <span className="figure-note">payments that moved</span>
            </div>
            <div className="figure">
              <span className="figure-label">Net</span>
              {/*
                Rendered from the server's signed string rather than recomputed
                here. Two places doing this arithmetic is two places that can
                round differently, and the API already owns the one conversion
                from base units to dollars.
              */}
              <span className="figure-value">{signedUsd(company.ledger.net)}</span>
              <span className="figure-note">earned less spent</span>
            </div>
          </div>
        </div>
        <p className="note">{company.ledger.note}</p>
      </section>

      <section className="section">
        <p className="eyebrow">Needs attention</p>
        <div className="panel">
          {lines === null ? (
            <p className="empty" role="alert">
              Fuel could not work out what needs attention just now. This is not the same as
              nothing needing a person. Reload the page to try again.
            </p>
          ) : lines.length === 0 ? (
            <p className="empty">
              Nothing needs a person. No agent is frozen, rate-limited, or near or past its
              authority, and no payment is waiting on an approval or a confirmation.
            </p>
          ) : (
            <ul className="attention">
              {lines.map((line, i) => (
                <li key={`${line.kind}-${line.what}-${i}`}>
                  {line.href ? (
                    <Link href={line.href}>
                      <AttentionBody line={line} />
                      <span className="attention-go">{line.go}</span>
                    </Link>
                  ) : (
                    <span className="attention-static">
                      <AttentionBody line={line} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {attention?.truncated && (
          <p className="note">
            Showing the first {attention.items.length} of {attention.total} lines.
          </p>
        )}
        <p className="note">
          Every line here is computed from what Fuel actually recorded, and it is the same list
          alerts are sent from. Spending past a cap is allowed when a person approves the payment
          — it is listed because it leaves no headroom for the next one, not because something
          went wrong.{" "}
          <Link href="/agents" className="link-btn">
            See all {agents.length} agents →
          </Link>
        </p>
      </section>

      <details className="disclosure">
        <summary>Export payments</summary>
        <div className="disclosure-body">
          <ExportPanel />
        </div>
      </details>
    </>
  );
}

function AttentionBody({ line }: { line: AttentionLine }) {
  return (
    <>
      <StatusPill label={line.kind} tone={line.tone} />
      <span className="attention-what">{line.what}</span>
      {line.why && <span className="attention-why">{line.why}</span>}
    </>
  );
}
