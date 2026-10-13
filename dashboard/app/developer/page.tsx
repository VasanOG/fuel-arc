import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";
import styles from "./developer.module.css";

/**
 * The integration contract that exists today — read-only, and static.
 *
 * No data is fetched here. Everything on this page is either a fact about the
 * API's shape (verified against src/api.ts and src/payments/pay.ts, not
 * paraphrased from memory) or a link to a page that shows the real thing.
 * A worked example with live numbers belongs on /activity and /agents, which
 * already exist for exactly that job — this page explains what those numbers
 * mean, not a second copy of them.
 *
 * THIS IS NOT A CREDENTIAL PORTAL. There is nothing to copy, rotate, or
 * revoke here, because Fuel does not have those things yet — see the notice
 * below, which is load-bearing and not a footnote.
 */
export default function DeveloperPage() {
  return (
    <>
      <PageHeader
        title="Developer"
        description="How an agent connects to Fuel today, and what happens to a payment once it asks to make one."
      />

      <section className="section">
        <p className="eyebrow">The flow</p>
        <div className="panel panel-pad">
          <ol className={styles.steps}>
            <li>
              <p className={styles.stepTitle}>An operator registers the agent.</p>
              <p className={styles.stepBody}>
                A name, the team it belongs to, and a starting spend cap. Fuel creates the
                agent&apos;s identity and gives it that much authority to spend — nothing until
                this happens.
              </p>
            </li>
            <li>
              <p className={styles.stepTitle}>The agent asks to pay for something.</p>
              <p className={styles.stepBody}>
                One call, naming what it wants to pay for. The agent does not decide whether it
                may — it finds out from what Fuel returns.
              </p>
            </li>
            <li>
              <p className={styles.stepTitle}>Fuel checks its authority, in order.</p>
              <p className={styles.stepBody}>
                The agent&apos;s own cap, then its team&apos;s, then its company&apos;s, then
                whether the amount is unusual for this agent, then whether it is spending too
                fast. The first check that fails decides the outcome — a payment produces at most
                one thing for a human to look at, never several.
              </p>
            </li>
            <li>
              <p className={styles.stepTitle}>Fuel returns a real outcome.</p>
              <p className={styles.stepBody}>
                Paid, waiting on a person, refused, or not completed — see the table below for
                exactly what each one means and what an operator will see.
              </p>
            </li>
            <li>
              <p className={styles.stepTitle}>An operator watches and decides.</p>
              <p className={styles.stepBody}>
                The <Link href="/activity">Activity Ledger</Link> shows every attempt. The{" "}
                <Link href="/approvals">Approvals</Link> queue shows what is waiting on a person.{" "}
                <Link href="/accounting">Accounting</Link> shows what it became in the books. An
                agent&apos;s own page shows what it is currently allowed to spend.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="section">
        <p className="eyebrow">Registering an agent</p>
        <div className="panel panel-pad">
          <p className={styles.lede}>
            An operator credential registers the agent. This is not something an agent does for
            itself.
          </p>
          <pre className={styles.code} tabIndex={0} role="region" aria-label="Example: registering an agent">
            <code>{`POST /api/agents
Authorization: Bearer <your FUEL_API_KEY>

{
  "name": "billing-agent",
  "teamId": "<a team id from GET /api/teams>",
  "spendCapUsd": "5.00"
}`}</code>
          </pre>
          <p className={styles.caption}>
            The response is the same record shape the <Link href="/agents">Agents</Link> roster
            reads: an id, the spend cap just granted, and nothing spent yet. That id is what the
            agent uses to ask for payments.
          </p>
        </div>
      </section>

      <section className="section">
        <p className="eyebrow">Asking to pay</p>
        <div className="panel panel-pad">
          <p className={styles.lede}>
            The agent&apos;s own credential makes this call — the operator credential is
            deliberately barred from it, so the party that can spend is never the same party that
            approves an exception to spending.
          </p>
          <pre className={styles.code} tabIndex={0} role="region" aria-label="Example: requesting a payment">
            <code>{`POST /api/agents/<agent-id>/pay
Authorization: Bearer <your FUEL_AGENT_KEY>

{
  "url": "https://vendor.example/resource-to-pay-for"
}`}</code>
          </pre>
          <p className={styles.caption}>
            <code>url</code> is illustrative — Fuel pays whatever endpoint is named here, and
            reports back who it paid without repeating the address itself anywhere an operator
            reads later.
          </p>
        </div>
      </section>

      <section className="section">
        <p className="eyebrow">What Fuel returns</p>
        <div className="panel">
          <div
            className="scroll-x"
            tabIndex={0}
            role="region"
            aria-label="Every outcome POST /api/agents/:id/pay can return"
          >
            <table className="data-table">
              <caption className="visually-hidden">
                Every outcome POST /api/agents/:id/pay can return, the HTTP status it carries, and
                what an operator sees afterwards.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">What happened</th>
                  <th scope="col">What an operator sees</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={styles.httpOk}>200</td>
                  <td className={styles.prose}>The payment went through.</td>
                  <td className={styles.prose}>
                    <span className="pill pill-good">Paid</span> in the Activity Ledger.
                  </td>
                </tr>
                <tr>
                  <td className={styles.httpWait}>202</td>
                  <td className={styles.prose}>
                    Held for a person — over a ceiling above the agent, or unusual for it. Retry
                    the same call with the returned <code>approvalRequestId</code> once it is
                    decided.
                  </td>
                  <td className={styles.prose}>
                    <span className="pill pill-watch">Refused</span> in the Ledger and a row in{" "}
                    <span className="pill pill-watch">Needs a decision</span> in Approvals, until
                    retried.
                  </td>
                </tr>
                <tr>
                  <td className={styles.httpBad}>402</td>
                  <td className={styles.prose}>Refused — over the agent&apos;s own cap, or an approval that no longer applies.</td>
                  <td className={styles.prose}>
                    <span className="pill pill-bad">Refused</span> in the Activity Ledger, with the
                    reason stated.
                  </td>
                </tr>
                <tr>
                  <td className={styles.httpBad}>423</td>
                  <td className={styles.prose}>
                    Refused — an operator has stopped this agent. Usually refused before anything
                    is written down; there may be no new record for the attempt at all.
                  </td>
                  <td className={styles.prose}>Nothing new, or a stated refusal if the freeze landed mid-attempt.</td>
                </tr>
                <tr>
                  <td className={styles.httpBad}>429</td>
                  <td className={styles.prose}>Refused — spending too quickly. The response says how long to wait.</td>
                  <td className={styles.prose}>
                    <span className="pill pill-bad">Refused</span> in the Activity Ledger.
                  </td>
                </tr>
                <tr>
                  <td className={styles.httpBad}>502</td>
                  <td className={styles.prose}>Did not complete.</td>
                  <td className={styles.prose}>
                    <span className="pill pill-bad">Not completed</span>, or{" "}
                    <span className="pill pill-watch">Awaiting confirmation</span> if Fuel signed
                    the payment but could not confirm what happened next.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <p className="note">
          These are the same words the Activity Ledger prints — src/lib/payment-presentation.ts
          owns this vocabulary for every surface, and this page uses no words of its own for an
          outcome a record can have.
        </p>
      </section>

      <section className="section">
        <p className="eyebrow">Credentials, honestly</p>
        <div className={styles.notice}>
          <p className={styles.noticeLead}>
            Fuel currently uses environment-managed integration credentials in this internal
            sandbox. Per-agent credentials, rotation, revocation, user login, and tenant isolation
            are not built yet.
          </p>
          <p className={styles.noticeBody}>
            Concretely: there is one shared credential every agent&apos;s calls use, and one
            separate shared credential every operator action uses. Fuel tells the two apart by
            which secret was presented, not by anything the caller claims about itself. Neither
            can be issued, copied, or revoked from this dashboard — both are set once, as
            environment variables, when Fuel is deployed.
          </p>
        </div>
      </section>
    </>
  );
}
