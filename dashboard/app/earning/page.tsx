import Link from "next/link";
import { getAttention, listAgents, listEarningEndpoints } from "@/lib/fuel";
import { PageHeader } from "@/components/shell/PageHeader";
import { StatusPill } from "@/components/ui";
import { day } from "@/lib/presentation";
import styles from "./earning.module.css";

// Live: an endpoint can be switched on, and revenue can arrive, between reads.
export const dynamic = "force-dynamic";

/**
 * The Earning page.
 *
 * What a company has put behind Fuel's paywall, what each endpoint charges,
 * whether it is actually live, and what it has taken in.
 *
 * TWO RULES THIS PAGE IS BUILT AROUND.
 *
 * It projects nothing. No run rate, no forecast, no "at this pace". Every
 * figure here is money that has already arrived, and a page about revenue is
 * the easiest place in this product to start implying a future — which would be
 * Fuel telling a customer what they are going to earn.
 *
 * And it cannot hide the unpaid. `earned` counts confirmed receipts only, so an
 * endpoint serving work that never settles reports $0 and looks merely idle.
 * The stuck count travels beside every revenue figure, and the unresolved rows
 * get their own section above the table rather than below it, because a total
 * that looks healthy is at its most misleading exactly when those rows are
 * piling up.
 *
 * READ-ONLY, DELIBERATELY. Registering an endpoint sets a price and names a
 * host Fuel will send traffic to, and enabling one opens a paid route to the
 * public internet. Both are money policy, and CLAUDE.md wants plan mode for
 * that rather than a form that arrived with a layout change. The API has had
 * both actions since 6A-2; this page shows what they did.
 */

export default async function EarningPage() {
  const [endpoints, agents, attention] = await Promise.all([
    listEarningEndpoints(),
    listAgents(),
    getAttention(),
  ]);

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "an agent";

  const live = endpoints.filter((e) => e.enabled).length;

  return (
    <>
      <PageHeader
        title="Earning"
        description="What this company charges for, and what it has actually been paid. Every figure is money that has already arrived — Fuel does not forecast revenue."
      />

      {/*
        THE UNRESOLVED ROWS, ABOVE THE REVENUE, NOT BELOW IT.
        
        `served, not paid` means a customer's origin did the work and no money
        came. It is the one state on this side of the product that costs someone
        something, and it has no outbound analogue — so nothing else on this
        page would hint at it. Putting it under the endpoints table would make
        it the thing an operator scrolls past to reach a healthy-looking total.
      */}
      {attention.receipts.length > 0 && (
        <section className="section">
          <p className="eyebrow">Needs a person</p>
          <div className="panel">
            <ul className={styles.attention}>
              {attention.receipts.map((receipt) => (
                <li key={receipt.id}>
                  <StatusPill label={receipt.statusLabel} tone={receipt.statusTone} />
                  <span className={styles.attentionWhat}>
                    ${receipt.amount} on {agentName(receipt.agentId)}
                  </span>
                  <span className={styles.attentionWhy}>
                    {receipt.statusMeaning} Recorded {day(receipt.createdAt)}.
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="note">
            {/*
              Named as read-only rather than silently lacking a button. An
              operator who cannot see why a row is not actionable will assume
              the page is broken; one who is told where the action lives can go
              and take it.
            */}
            Resolving one of these asks the payment network whether the money
            actually arrived. Fuel does that through its API today — this page
            reports the state rather than offering to change it.
          </p>
        </section>
      )}

      <section className="section">
        <p className="eyebrow">Endpoints</p>
        <div className="panel">
          {endpoints.length === 0 ? (
            <p className="empty">
              Nothing is behind Fuel&rsquo;s paywall yet. An endpoint is registered through the
              Fuel API, proved to belong to you, and only then can it be switched on.
            </p>
          ) : (
            <div className="scroll-x" tabIndex={0} role="region" aria-label="Earning endpoints">
              <table className="data-table">
                <caption className="visually-hidden">
                  Every endpoint behind Fuel&rsquo;s paywall, with its price, whether it is live,
                  and what it has been paid.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Endpoint</th>
                    <th scope="col">Agent</th>
                    <th scope="col" className="numeric">
                      Price
                    </th>
                    <th scope="col">State</th>
                    <th scope="col" className="numeric">
                      Earned
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {endpoints.map((endpoint) => (
                    <tr key={endpoint.id}>
                      <th scope="row" className="cell-name">
                        {endpoint.label}
                        {/*
                          The customer's own origin, under the label it is known
                          by in the books. Shown because an operator checking why
                          an endpoint is not earning needs to know which host
                          Fuel is calling; it is their own URL, not a credential.
                        */}
                        <span className={styles.origin}>{endpoint.originUrl}</span>
                      </th>
                      <td>
                        <Link href={`/agents/${endpoint.agentId}`} className={styles.agentLink}>
                          {agentName(endpoint.agentId)}
                        </Link>
                      </td>
                      <td className="numeric">${endpoint.priceUsd}</td>
                      <td>
                        {endpoint.enabled ? (
                          <StatusPill label="Live" tone="good" />
                        ) : (
                          <StatusPill label="Not live" tone="quiet" />
                        )}
                        {/*
                          The blocker is the API's sentence, not a recomputed
                          one. What makes an endpoint safe to switch on is
                          decided by the checks that prove it, and a second
                          opinion rendered here could disagree with the server
                          that actually enforces it.
                        */}
                        {endpoint.blocker && (
                          <span className={styles.blocker}>{endpoint.blocker}</span>
                        )}
                      </td>
                      <td className="numeric">
                        {endpoint.earned === "0" ? (
                          <span className="muted">$0</span>
                        ) : (
                          `$${endpoint.earned}`
                        )}
                        {endpoint.stuck > 0 && (
                          <span className={styles.stuck}>
                            {endpoint.stuck} unpaid or unconfirmed
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {endpoints.length > 0 && (
          <p className="note">
            {live === endpoints.length
              ? `All ${endpoints.length} ${endpoints.length === 1 ? "endpoint is" : "endpoints are"} live.`
              : `${live} of ${endpoints.length} live.`}{" "}
            Earned counts confirmed payments only. A request that was served but never settled is
            not revenue — counting it would overstate what this company earned, and that figure
            leaves Fuel permanently once it reaches the books.
          </p>
        )}
      </section>

      {/*
        The outbound half of the same question, shown here because the API
        surfaces it on the same route and an operator triaging money that did
        not resolve should not have to know which direction it was going to find
        it. Kept visually subordinate: this page is about earning.
      */}
      {attention.payments.length > 0 && (
        <section className="section">
          <p className="eyebrow">Also unresolved, on the way out</p>
          <div className="panel">
            <ul className={styles.attention}>
              {attention.payments.map((payment) => (
                <li key={payment.id}>
                  <StatusPill label={payment.statusLabel} tone="watch" />
                  <span className={styles.attentionWhat}>
                    ${payment.amount} from {payment.agentName}
                  </span>
                  <span className={styles.attentionWhy}>
                    {payment.statusMeaning} Recorded {day(payment.createdAt)}.
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}
