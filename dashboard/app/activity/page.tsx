import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import {
  ACTIVITY_FILTER_KEYS,
  FuelQueryError,
  listActivity,
  listAgents,
  listTeams,
  type ActivityQuery,
  type FuelActivityPage,
} from "@/lib/fuel";
import { PageHeader } from "@/components/shell/PageHeader";
import { DemoTag, StatusPill } from "@/components/ui";
import styles from "./activity.module.css";

// A live feed of money moving, both ways. A cached copy is a wrong answer.
export const dynamic = "force-dynamic";

/**
 * The Activity Ledger.
 *
 * Every movement of money across every agent, in BOTH directions and in the
 * order Fuel recorded them, with the policy context that explains the ones that
 * did not simply go through.
 *
 * ONE TABLE, NOT TWO STACKED. A direction column only earns its width if both
 * kinds of row actually appear in the same list; two tables side by side would
 * have made the column meaningless and the chronology impossible to read. The
 * cost is that every column has to mean something on both sides — which is why
 * "Paid to" became "Counterparty" and the amount carries a sign.
 *
 * A SERVER COMPONENT WITH NO CLIENT JAVASCRIPT. The filters are a plain GET
 * form and paging is a link, so the whole page is a URL — which is what an
 * operator wants from a ledger anyway. A filtered view can be bookmarked, sent
 * to someone else, or reloaded a week later and still mean the same thing.
 * Nothing here needs state that a query string cannot hold.
 */

/** UTC, to the minute. This data has 110 payments inside one working day; a
 *  date alone would render them as a wall of identical rows. */
function stamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Only the values the API accepts are forwarded. A stray query parameter is
 *  dropped here rather than sent on to earn a 400 the operator cannot explain. */
function queryFrom(params: Record<string, string | string[] | undefined>): ActivityQuery {
  const out: ActivityQuery = {};
  for (const key of ACTIVITY_FILTER_KEYS) {
    const value = params[key];
    const single = Array.isArray(value) ? value[0] : value;
    if (single) out[key] = single;
  }
  const cursor = Array.isArray(params.cursor) ? params.cursor[0] : params.cursor;
  if (cursor) out.cursor = cursor;
  return out;
}

/** The current filters as a query string, for the Next link. Never the cursor:
 *  the caller decides whether this page's cursor belongs on the next URL. */
function filterSearch(query: ActivityQuery): URLSearchParams {
  const search = new URLSearchParams();
  for (const key of ACTIVITY_FILTER_KEYS) {
    const value = query[key];
    if (value) search.set(key, value);
  }
  return search;
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = queryFrom(params);

  // The two reads that populate the filter menus. They are the same lists the
  // Agents page uses, and they name the ids the API will accept.
  const [agents, teams] = await Promise.all([listAgents(), listTeams()]);

  let result: FuelActivityPage | null = null;
  let queryError: string | null = null;
  try {
    result = await listActivity(query);
  } catch (error) {
    // A rejected filter is the operator's typo, not Fuel falling over. Handled
    // here so the form they mistyped stays on screen with the reason beside it,
    // instead of the whole route going to the error boundary.
    if (error instanceof FuelQueryError) queryError = error.message;
    else throw error;
  }

  const rows = result?.activity ?? [];
  const activeFilters = ACTIVITY_FILTER_KEYS.filter((key) => query[key]).length;

  /*
   * Refusals Fuel recorded before it had structured reasons.
   *
   * Counted for the whole page and stated once, above the table, rather than
   * repeated on every row. Filtering to Refused makes this the majority case —
   * every historical refusal predates the codes — and fifty identical
   * sentences down the page is noise that teaches an operator to stop reading
   * the line that is supposed to mean "this row needs explaining".
   *
   * The reason is still never guessed at. The prose those rows carry lives in a
   * column this API does not return, and parsing it would invent a record.
   */
  const unexplainedRefusals = rows.filter(
    (row) => row.status === "blocked" && !row.refusal,
  ).length;

  /* Counted from the structural marker alone — never from a name, a date, an
   * amount, a counterparty or free text. See DemoTag. */
  const demoShown = rows.filter((row) => row.isDemo).length;

  return (
    <>
      <PageHeader
        title="Activity Ledger"
        description="Every movement of money Fuel has recorded, in and out, newest first. Rows that a person had to approve, or that Fuel refused, say so and why."
      />

      <form method="get" action="/activity" className={styles.filters}>
        <p className={styles.filtersLabel} id="filters-heading">
          Narrow this ledger
        </p>
        <div className={styles.filterGrid} role="group" aria-labelledby="filters-heading">
          {/*
            First in the group, because it is the filter that changes what the
            others mean: an outcome reads differently depending on which way the
            money was going.
          */}
          <label className={styles.field}>
            <span>Direction</span>
            <select name="direction" defaultValue={query.direction ?? ""}>
              <option value="">In and out</option>
              {(result?.directionOptions ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === "spend" ? "Money out" : "Money in"}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>Agent</span>
            <select name="agentId" defaultValue={query.agentId ?? ""}>
              <option value="">Every agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>Team</span>
            <select name="teamId" defaultValue={query.teamId ?? ""}>
              <option value="">Every team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>Outcome</span>
            <select name="status" defaultValue={query.status ?? ""}>
              <option value="">Any outcome</option>
              {(result?.statusOptions ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>From</span>
            <input type="date" name="from" defaultValue={query.from ?? ""} />
          </label>

          <label className={styles.field}>
            <span>To</span>
            <input type="date" name="to" defaultValue={query.to ?? ""} />
          </label>

          <label className={styles.field}>
            <span>Data</span>
            <select name="demo" defaultValue={query.demo ?? ""}>
              <option value="">Real and demonstration</option>
              <option value="false">Real movements only</option>
              {/*
                Demonstration data exists only on the outbound side — nothing
                writes a demo receipt — so this option narrows to money out as
                well. Said here rather than left for an operator to notice that
                the earn rows vanished.
              */}
              <option value="true">Demonstration only (money out)</option>
            </select>
          </label>

          <label className={styles.field}>
            <span>Order</span>
            <select name="order" defaultValue={query.order ?? "newest"}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
        </div>

        <div className={styles.filterActions}>
          <button type="submit" className="btn btn-primary">
            Apply
          </button>
          {activeFilters > 0 && (
            <Link href="/activity" className={styles.clear}>
              Clear {activeFilters === 1 ? "filter" : "filters"}
            </Link>
          )}
        </div>
      </form>

      {queryError && (
        <p className={styles.queryError} role="alert">
          That filter was refused: {queryError}
        </p>
      )}

      {unexplainedRefusals > 0 && (
        <p className={styles.setNote}>
          {unexplainedRefusals === rows.length
            ? "Every refusal shown here"
            : `${unexplainedRefusals} of the refusals shown here`}{" "}
          {unexplainedRefusals === 1 ? "was" : "were"} recorded before Fuel stored a structured
          reason. The outcome is on the record; the reason is not, and Fuel will not guess at one.
        </p>
      )}

      <div className="panel">
        {rows.length === 0 ? (
          <p className="empty">
            {queryError
              ? "Nothing was read, because the filters above were refused."
              : activeFilters > 0
                ? "Nothing matches these filters."
                : "Fuel has not recorded any money moving yet."}
          </p>
        ) : (
          <div className="scroll-x">
            <table className="data-table">
              <caption className="visually-hidden">
                Money in and out across every agent, with the reason for any that were refused or
                needed approval.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Recorded (UTC)</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Agent</th>
                  {/*
                    "Counterparty", not "Paid to". The other party is a merchant
                    on one side of this table and the company's own endpoint on
                    the other, and a heading that is right for half its rows is
                    worse than a duller one that is right for all of them. The
                    accounting export took this same rename in 6B-1.
                  */}
                  <th scope="col">Counterparty</th>
                  <th scope="col" className="numeric">
                    Amount
                  </th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Reference</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  /*
                   * The second line, and the reason this page is worth having
                   * over the CSV. It is rendered only when there is something
                   * to say — most rows simply went through, and a row that
                   * always carried an explanation would train an operator to
                   * stop reading them.
                   */
                  const notes: ReactNode[] = [];

                  if (row.refusal) {
                    notes.push(
                      <span key="refusal" className={styles.noteBad}>
                        Refused: {row.refusal.label.toLowerCase()}.
                      </span>,
                    );
                  } else if (row.status !== "settled" && row.status !== "blocked") {
                    /*
                     * `settled` is the one status both directions share, and on
                     * both it means the same thing: the money moved, so there is
                     * nothing to explain. Every other unexplained state gets its
                     * sentence, which is how the inbound states that have no
                     * outbound analogue — a request served and never paid for —
                     * reach the operator without this page having to enumerate
                     * them. The backend owns the wording.
                     */
                    notes.push(<span key="meaning">{row.statusMeaning}</span>);
                  }

                  if (row.approval) {
                    notes.push(
                      <span key="approval">
                        A person approved this past the {row.approval.scope} ceiling
                        {row.approval.decidedAt ? ` on ${day(row.approval.decidedAt)}` : ""}. The
                        limit itself was not changed.
                      </span>,
                    );
                  }

                  const earned = row.direction === "earn";

                  return (
                    <Fragment key={`${row.direction}-${row.id}`}>
                      <tr>
                        <td>
                          {stamp(row.createdAt)}
                          {/*
                            A row books on the day it SETTLES, which can be a
                            different day from the one it was recorded on — the
                            accounting export dates rows that way and this ledger
                            does not, so an operator reconciling the two has to be
                            able to see the difference.

                            It belongs to the date rather than to the explanation
                            line beneath the row. Twenty of fifty rows in this
                            data settle on a later day, and giving each of them a
                            full-width band turned the table into stripes and
                            trained the eye to ignore the one device reserved for
                            rows that genuinely need a sentence.
                          */}
                          {day(row.ledgerDate) !== day(row.createdAt) && (
                            <span className={styles.booksTo}>books to {day(row.ledgerDate)}</span>
                          )}
                        </td>
                        {/*
                          Words, not an arrow or a colour alone. The sign on the
                          amount carries this too, and two independent renderings
                          of one fact is deliberate here: a sign is a single
                          character that a narrow column, a screen reader or a
                          bad print stylesheet can lose, and losing it would turn
                          revenue into spend silently.
                        */}
                        <td>
                          <span className={earned ? styles.directionIn : styles.directionOut}>
                            {earned ? "Money in" : "Money out"}
                          </span>
                        </td>
                        <td>
                          <Link href={`/agents/${row.agentId}`} className={styles.agentLink}>
                            {row.agentName}
                          </Link>
                          <span className={styles.team}>{row.teamName}</span>
                        </td>
                        <td>{row.counterparty}</td>
                        <td className="numeric">
                          {/*
                            A true minus sign (U+2212), not a hyphen: this column
                            is money and the hyphen renders too short to read as a
                            sign at this size. The API sends a magnitude and the
                            direction separately, so the sign is composed here
                            rather than shipped as a second money string that
                            could disagree with the first.
                          */}
                          <span className={earned ? styles.amountIn : undefined}>
                            {earned ? "+" : "\u2212"}${row.amount}
                          </span>
                        </td>
                        <td>
                          <StatusPill label={row.statusLabel} tone={row.statusTone} />
                          {row.isDemo && <DemoTag />}
                        </td>
                        <td className={styles.reference}>{row.id}</td>
                      </tr>
                      {notes.length > 0 && (
                        <tr className={styles.whyRow}>
                          <td colSpan={7} className={styles.why}>
                            {notes}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {result && rows.length > 0 && (
        <div className={styles.pager}>
          <p className={styles.pagerCount}>
            {rows.length} {rows.length === 1 ? "movement" : "movements"}
            {result.page.hasMore ? " on this page" : " — the end of this view"}
          </p>
          {/*
            Forward only, and honestly so. The API issues a cursor for the row
            after the last one on this page and no cursor for the row before the
            first, so there is no Back to offer. A disabled Back button would
            imply the ledger could go that way; a link to the start is a thing
            that actually works.
          */}
          {result.page.hasMore && result.page.nextCursor ? (
            <Link
              href={`/activity?${(() => {
                const next = filterSearch(query);
                next.set("cursor", result.page.nextCursor!);
                return next.toString();
              })()}`}
              className="btn"
            >
              Next {result.page.limit} →
            </Link>
          ) : null}
          {query.cursor && (
            <Link href={`/activity?${filterSearch(query).toString()}`} className={styles.clear}>
              Back to the start
            </Link>
          )}
        </div>
      )}

      {/*
        Said only when there is something to say. The demo sentence used to be
        unconditional, which meant a page of entirely real payments still carried
        a paragraph about demonstration data — a claim about records that had not
        earned it. It now appears when, and only when, a row on screen carries
        the marker.
      */}
      {demoShown > 0 && (
        <p className={styles.setNote}>
          {demoShown === rows.length
            ? "Every row shown here is"
            : `${demoShown} of the rows shown here ${demoShown === 1 ? "is" : "are"}`}{" "}
          seeded demonstration data, marked as such on the payment record. No money moved for
          {demoShown === 1 ? " it" : " them"}.
        </p>
      )}

      <p className="note">
        Amounts are shown to three decimal places because these movements are genuinely sub-cent;
        the accounting rollup gathers them until they cross a whole cent before anything is posted.
      </p>
    </>
  );
}
