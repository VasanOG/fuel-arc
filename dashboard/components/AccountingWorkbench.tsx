"use client";

import { Fragment, useCallback, useState } from "react";
import styles from "@/app/accounting/accounting.module.css";
import { toAccountingStatus, type AccountingStatus } from "@/lib/accounting-status";
import { sendToSignIn } from "@/lib/signed-out";

/**
 * The QuickBooks workbench: preview a day's rollup, read the document it would
 * post, open any line to see what it is made of, then post it deliberately.
 *
 * All state is local and re-fetched on demand. There is no polling and nothing
 * happens on a timer — posting to someone's books is a decision, so the only
 * thing that starts it is a person choosing it.
 */

/*
 * The connection this workbench acts on.
 *
 * Imported, not declared here. This component used to describe the raw
 * `/status` response in its own words — a realm id, an environment string, a
 * config block — and describing it was what made it available to render, which
 * is how the customer's QuickBooks company identifier ended up printed in the
 * setup line below. The contract now has one definition, in
 * lib/accounting-status.ts, and it is the narrow one. See ADR 0010.
 */
type Status = AccountingStatus;

interface JournalLine {
  Amount: number;
  Description: string;
  JournalEntryLineDetail: {
    PostingType: "Debit" | "Credit";
    AccountRef: { value: string };
  };
}

interface Draft {
  draftId: string;
  docNumber: string;
  day: string;
  lineCount: number;
  payloadHash: string;
  payload: { TxnDate: string; DocNumber: string; PrivateNote: string; Line: JournalLine[] };
  readiness: { ok: boolean; reason?: string };
}

/**
 * HAND-WRITTEN OVER A JSON FETCH, WHICH IS WHY THIS DRIFTED.
 *
 * Nothing connects these declarations to the backend types they mirror -- no
 * compile error links them, so a rename on one side leaves the other reading
 * `undefined` and rendering blank cells with no build failure and no throw.
 * 6B-1 renamed four of these fields and only a grep found it. If a shared
 * contract ever exists, this is the block that should stop being hand-written;
 * until then verify-api asserts the route's keys match what is declared here.
 */
interface TraceSource {
  sourceId: string;
  /** Which table `sourceId` names, so a label never has to be guessed. */
  sourceKind: "payment" | "receipt";
  agent: string;
  amount: string;
  appliedToThisLine: string;
  date: string;
  status: string;
  /** Always null for a receipt: money arriving was nobody at Fuel's decision. */
  authorizedBy: { approvalId: string; blockedScope: string; decidedAt: string | null } | null;
}

interface TraceLine {
  lineId: string;
  agent: string;
  counterparty: string;
  direction: "spend" | "earn";
  account: string;
  /** The QuickBooks account id, so a ledger row joins to its provenance exactly. */
  accountId: string | null;
  amount: string;
  sources: TraceSource[];
}

interface Trace {
  summary: {
    lines: number;
    sources: number;
    requiredHumanApproval: number;
    agents: number;
    counterparties: number;
  };
  lines: TraceLine[];
}

interface Posting {
  postingId: string;
  status: string;
  docNumber: string;
  quickBooksId: string | null;
  correctsPostingId: string | null;
  postedAt: string | null;
  detail: string | null;
  /** Set when an owner wrote it off (7A-3 item 3). `status` stays "pending". */
  abandonedAt?: string | null;
  abandonReason?: string | null;
  /** The owner's email; null when the API may not say who. */
  abandonedBy?: string | null;
}

async function api(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`/api/quickbooks?path=${encodeURIComponent(path)}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    /*
     * See lib/signed-out.ts. `fuelFetch` answers Fuel's 401 with a redirect to
     * the sign-in page; followed automatically that arrives here as HTML and
     * `res.json()` fails with a parse error, which is the least useful way to
     * be told a session ended. Manual makes it visible.
     */
    redirect: "manual",
  });
  /*
   * Throws rather than returning a shape, because there is no honest shape to
   * return. Every call site here reads `body` to report the state of someone's
   * books, and an empty object would render as a confident "not connected".
   * The browser is already navigating to the sign-in page; the throw just stops
   * this call from painting a wrong answer on the way out.
   */
  if (sendToSignIn(res)) throw new Error("Your session has ended.");
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

const money = (n: number) => n.toFixed(2);

/**
 * Groups a trace's per-agent lines under the QuickBooks account they landed in.
 *
 * Keyed on the account ID, not its name. Matching on the label looked fine and
 * was quietly broken: the ledger row reads "Unconfirmed agent payments" while
 * the account is called "Suspense - Unconfirmed Agent Payments", so a prefix
 * match found nothing and the suspense line silently refused to open.
 */
function byAccount(trace: Trace | null): Map<string, TraceLine[]> {
  const map = new Map<string, TraceLine[]>();
  for (const line of trace?.lines ?? []) {
    if (!line.accountId) continue;
    const existing = map.get(line.accountId) ?? [];
    existing.push(line);
    map.set(line.accountId, existing);
  }
  return map;
}

export function AccountingWorkbench({
  initialStatus,
  initialPostings,
  suggestedDay,
  isOwner,
}: {
  initialStatus: Status | null;
  initialPostings: Posting[];
  suggestedDay: string;
  /** Only decides whether "Write off…" is offered. The API is the authority. */
  isOwner: boolean;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [postings, setPostings] = useState(initialPostings);
  const [day, setDay] = useState(suggestedDay);
  /*
   * WHICH DIRECTION THIS PREVIEW IS FOR.
   *
   * A document holds ONE direction — 0012 settled that spend and revenue may
   * never share a JournalEntry — so this is a choice the operator has to make
   * before a draft exists, not a filter applied to one afterwards. Defaults to
   * spend: it is the direction every company has, and the one a company with no
   * income account can actually post.
   */
  const [direction, setDirection] = useState<"spend" | "earn">("spend");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** The posting whose write-off panel is open, and what has been typed into it. */
  const [writingOff, setWritingOff] = useState<string | null>(null);
  const [writeOffReason, setWriteOffReason] = useState("");
  const [writeOffConfirm, setWriteOffConfirm] = useState("");

  const refresh = useCallback(async () => {
    const [s, p] = await Promise.all([api("/status"), api("/postings")]);
    // Narrowed again on the way in. The proxy route already applies the same
    // contract to the response, so this is the second of two locks on one
    // door — deliberately, because the first render and every refetch after it
    // must put the SAME shape into this state. A component whose state is safe
    // only until the operator presses a button is not safe.
    // Null when Fuel could not be asked or answered unrecognisably — and null
    // is SET, not swallowed. Keeping the previous status would leave a stale
    // "Connected. Accounts are set." on screen after a Disconnect whose
    // follow-up read failed, which is a confident wrong answer about someone's
    // books. Null renders as "Connection unknown" and disables Preview, which
    // is the honest state for "the last thing we tried did not come back".
    setStatus(s.ok ? toAccountingStatus(s.body) : null);
    if (p.ok) setPostings(p.body.postings ?? []);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onPreview = () =>
    run(async () => {
      setDraft(null);
      setTrace(null);
      setOpen(null);
      setConfirming(false);
      // `direction` is REQUIRED by the backend and has no default (6B-1), and
      // 6B-3 is where the operator finally chooses it. Still sent explicitly on
      // every call rather than omitted when it happens to be spend: a default
      // that does not exist on the server must not be invented by the client.
      const res = await api("/preview", { method: "POST", body: { day, direction } });
      if (!res.ok) throw new Error(res.body.error ?? `Preview failed (${res.status})`);
      setDraft(res.body);
    });

  const onPost = () =>
    run(async () => {
      if (!draft) return;
      const res = await api("/post", { method: "POST", body: { draftId: draft.draftId } });
      if (!res.ok) {
        // A posting that may have landed is a different problem from one that
        // definitely did not, and the operator needs to know which.
        const suffix = res.body.mayHavePosted
          ? " The entry may still have been created — reconcile it before trying again."
          : "";
        throw new Error((res.body.error ?? `Posting failed (${res.status})`) + suffix);
      }
      setConfirming(false);
      setDone(`Posted ${res.body.docNumber} to QuickBooks (id ${res.body.quickBooksId}).`);
      await loadTrace(res.body.postingId);
      await refresh();
    });

  /**
   * Starts the OAuth handshake.
   *
   * The API returns the consent URL rather than a redirect, so the navigation
   * happens here, in the browser that will carry the operator's Intuit session.
   * A full navigation, not a popup: Intuit's consent screen refuses to be
   * framed, and a popup that a blocker eats looks identical to a broken button.
   */
  const onConnect = () =>
    run(async () => {
      const res = await api("/connect", { method: "POST" });
      if (!res.ok) throw new Error(res.body.error ?? `Could not start the connection (${res.status})`);
      window.location.href = res.body.authorizeUrl;
    });

  /**
   * Creates the three accounts in the connected company.
   *
   * Deliberately a button and not a side effect of previewing: this writes to
   * the customer's chart of accounts, which is their document, not ours.
   */
  const onSetupAccounts = () =>
    run(async () => {
      const res = await api("/setup-accounts", { method: "POST" });
      if (!res.ok) throw new Error(res.body.error ?? `Account setup failed (${res.status})`);
      const { created = [], reused = [] } = res.body;
      setDone(
        `${res.body.quickBooksCompany}: ${created.length} account(s) created` +
          (reused.length ? `, ${reused.length} already existed.` : "."),
      );
      await refresh();
    });

  const onDisconnect = () =>
    run(async () => {
      const res = await api("/disconnect", { method: "POST" });
      if (!res.ok) throw new Error(res.body.error ?? `Disconnect failed (${res.status})`);
      setDraft(null);
      setTrace(null);
      setDone("Disconnected. Posted entries are untouched.");
      await refresh();
    });

  const openWriteOff = (postingId: string | null) => {
    setWritingOff(postingId);
    setWriteOffReason("");
    setWriteOffConfirm("");
  };

  /**
   * Writes off a posting whose QuickBooks books are gone (7A-3 item 3).
   *
   * Fuel asks QuickBooks once more before writing anything, so this can come
   * back 409 with the posting resolved instead: QuickBooks answered, and that
   * answer is used. That is reported as what happened, not as a failure.
   */
  const onWriteOff = (p: Posting) =>
    run(async () => {
      const res = await api(`/postings/${p.postingId}/abandon`, {
        method: "POST",
        body: { reason: writeOffReason.trim(), confirmDocNumber: writeOffConfirm.trim() },
      });
      if (res.status === 409 && res.body.posting) {
        openWriteOff(null);
        await refresh();
        throw new Error(res.body.error ?? "QuickBooks answered, so nothing was written off.");
      }
      if (!res.ok) throw new Error(res.body.error ?? `Write-off failed (${res.status})`);
      openWriteOff(null);
      setDone(
        `Wrote off ${p.docNumber}. Its outcome stays unknown and its spend is held; ` +
          "you can now disconnect or connect a different QuickBooks company.",
      );
      await refresh();
    });

  const loadTrace = async (postingId: string) => {
    const res = await api(`/postings/${postingId}/trace`);
    if (res.ok) setTrace(res.body);
  };

  const grouped = byAccount(trace);
  const lines = draft?.payload.Line ?? [];
  const debits = lines.filter((l) => l.JournalEntryLineDetail.PostingType === "Debit");
  const credits = lines.filter((l) => l.JournalEntryLineDetail.PostingType === "Credit");
  const debitTotal = debits.reduce((s, l) => s + l.Amount, 0);
  const creditTotal = credits.reduce((s, l) => s + l.Amount, 0);

  return (
    <>
      {/* The chain, as a sequence — the order carries information here. */}
      <ol className={styles.chain}>
        <li className={`${styles.step} ${styles.stepDone}`}>
          <p className={styles.stepLabel}>Agents paid for things</p>
          <p className={styles.stepDetail}>
            Each payment checked against its agent, team and company caps, then settled.
          </p>
        </li>
        <li className={`${styles.step} ${styles.stepDone}`}>
          <p className={styles.stepLabel}>Fuel rolled sub-cent spend into whole cents</p>
          <p className={styles.stepDetail}>
            Payments of $0.001 cannot be booked one by one — accounting systems store two decimals.
          </p>
        </li>
        <li className={`${styles.step} ${draft ? styles.stepDone : ""}`}>
          <p className={styles.stepLabel}>You review the exact document</p>
          <p className={styles.stepDetail}>
            Nothing is sent yet. The entry below is frozen — posting sends these bytes, not a
            recalculation.
          </p>
        </li>
        <li className={`${styles.step} ${done ? styles.stepDone : ""}`}>
          <p className={styles.stepLabel}>You post it, and it stays traceable</p>
          <p className={styles.stepDetail}>
            Every figure in QuickBooks opens back up into the payments and approvals beneath it.
          </p>
        </li>
      </ol>

      {/* Setup comes first in practice even though it reads second: you cannot
          review a document until Fuel can reach a company and knows which
          accounts to write to. It collapses to one line once connected. */}
      <div className={styles.bar}>
        {!status?.connected ? (
          <>
            <button className={styles.button} onClick={onConnect} disabled={busy}>
              {busy ? "Working\u2026" : "Connect QuickBooks Sandbox"}
            </button>
            <span className={styles.stepDetail}>
              {status === null
                ? "Fuel could not be reached to check this connection, so its state is unknown — not necessarily disconnected. Try again before connecting."
                : "Sends you to Intuit to grant access. Sandbox company only."}
            </span>
          </>
        ) : (
          <>
            <button
              className={styles.button}
              onClick={onSetupAccounts}
              disabled={busy}
            >
              {busy ? "Working\u2026" : status.readyToPost ? "Re-check accounts" : "Set up accounts"}
            </button>
            <button
              className={`${styles.button} ${styles.buttonQuiet}`}
              onClick={onDisconnect}
              disabled={busy}
            >
              Disconnect
            </button>
            <span className={styles.stepDetail}>
              {status.readyToPost
                ? "Connected. Expense, suspense and contra accounts are set."
                : `Connected. Missing: ${status.missing.join(", ")}.`}
            </span>
            {/* The currency claim states its evidence. "Verified" is only ever
                shown for a reading of QuickBooks' own Preferences — an
                unchecked company says so plainly rather than showing a
                reassuring default. */}
            <span className={styles.stepDetail}>
              {status.currencyVerified
                ? `Books verified as ${status.currency} — read from this company's QuickBooks Preferences${
                    status.currencyCheckedAt ? ` on ${status.currencyCheckedAt.slice(0, 10)}` : ""
                  }.`
                : status.currency
                  ? `This company keeps its books in ${status.currency}. Fuel posts USD only and does not convert.`
                  : "Accounting currency not verified yet — run account setup. Fuel posts USD only."}
            </span>
          </>
        )}
      </div>

      <div className={styles.bar}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="day">
            Rollup day
          </label>
          <input
            id="day"
            className={styles.input}
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="direction">
            Direction
          </label>
          <select
            id="direction"
            className={styles.input}
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value as "spend" | "earn");
              // A draft belongs to the direction it was built for. Leaving one
              // on screen after the choice changed would offer a Post button
              // posts the other direction's entry.
              setDraft(null);
              setTrace(null);
              setConfirming(false);
            }}
          >
            <option value="spend">Money out (expenses)</option>
            <option value="earn">Money in (revenue)</option>
          </select>
        </div>
        <button
          className={styles.button}
          onClick={onPreview}
          disabled={busy || !status?.readyToPost || (direction === "earn" && !status?.readyToPostRevenue)}
        >
          {busy ? "Working…" : "Preview entry"}
        </button>
        {status === null && (
          <span className={styles.stepDetail}>
            Fuel could not be reached, so there is nothing to preview against yet.
          </span>
        )}
        {status !== null && !status.connected && (
          <span className={styles.stepDetail}>
            Connect QuickBooks first — this is the sandbox company, not live books.
          </span>
        )}
        {status?.connected && !status.readyToPost && (
          <span className={styles.stepDetail}>Set up accounts before previewing.</span>
        )}
        {/*
          THE DEGRADE, SAID OUT LOUD.
          
          A company connected before the earning side existed has no income
          account, and 0012 chose to let spend keep posting rather than stop
          everything until someone re-ran setup. That is only honest if the page
          says which half is waiting and why — otherwise a working integration
          reads as broken, or worse, the operator picks Revenue and gets a
          refusal with no explanation.
        */}
        {status?.connected && status.readyToPost && !status.readyToPostRevenue && (
          <span className={styles.stepDetail}>
            Expenses are posting normally. Revenue is waiting on{" "}
            {status.missingForRevenue.join(", ") || "one more account"} — re-run account setup to
            add it.
          </span>
        )}
      </div>

      {error && <div className={`${styles.notice} ${styles.noticeError}`}>{error}</div>}
      {done && <div className={`${styles.notice} ${styles.noticeGood}`}>{done}</div>}

      {draft && (
        <>
          <section className={styles.ledger} aria-label="Journal entry preview">
            <header className={styles.ledgerHead}>
              <div>
                <p className={styles.ledgerTitle}>Journal entry</p>
                <p className={styles.ledgerDate}>{draft.payload.TxnDate}</p>
              </div>
              <div className={styles.docNumber}>
                Document
                <strong>{draft.docNumber}</strong>
              </div>
            </header>

            <div
              className={styles.tableScroll}
              tabIndex={0}
              role="region"
              aria-label="Journal entry lines"
            >
              <table className={styles.ledgerTable}>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col" className={styles.amountCol}>
                    Debit
                  </th>
                  <th scope="col" className={styles.amountCol}>
                    Credit
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => {
                  const accountId = line.JournalEntryLineDetail.AccountRef.value;
                  const key = `${i}-${accountId}`;
                  const detail = grouped.get(accountId);
                  const expandable = Boolean(detail && detail.length > 0);
                  const isOpen = open === key;

                  return (
                    <Fragment key={key}>
                      <tr>
                        <td>
                          <button
                            className={styles.lineToggle}
                            onClick={() => setOpen(isOpen ? null : key)}
                            disabled={!expandable}
                            aria-expanded={expandable ? isOpen : undefined}
                          >
                            {expandable && (
                              <span
                                className={`${styles.caret} ${isOpen ? styles.caretOpen : ""}`}
                                aria-hidden="true"
                              >
                                ▶
                              </span>
                            )}
                            {!expandable && <span className={styles.caret} aria-hidden="true" />}
                            {line.Description}
                          </button>
                        </td>
                        <td className={`${styles.amount} ${styles.debit}`}>
                          {line.JournalEntryLineDetail.PostingType === "Debit"
                            ? money(line.Amount)
                            : ""}
                        </td>
                        <td className={`${styles.amount} ${styles.credit}`}>
                          {line.JournalEntryLineDetail.PostingType === "Credit"
                            ? money(line.Amount)
                            : ""}
                        </td>
                      </tr>

                      {isOpen && detail && (
                        <tr className={styles.provenance}>
                          <td colSpan={3}>
                            <div className={styles.provenanceInner}>
                              <p className={styles.provenanceHead}>
                                What this figure is made of
                              </p>
                              <table className={styles.payments}>
                                <thead>
                                  <tr>
                                    {/*
                                      A document holds one direction, so the
                                      first line's kind names the whole table.
                                      Hardcoding "Payment" here would have put a
                                      receipt under it on the very first revenue
                                      posting -- the same false statement 0012
                                      objects to in the CSV header, one layer
                                      out.
                                    */}
                                    <th scope="col">
                                      {detail[0]?.direction === "earn" ? "Receipt" : "Payment"}
                                    </th>
                                    <th scope="col">Agent</th>
                                    <th scope="col">Counterparty</th>
                                    <th scope="col">Applied</th>
                                    <th scope="col">Authorised by</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {detail.flatMap((l) =>
                                    l.sources.map((p) => (
                                      <tr key={p.sourceId}>
                                        <td className={styles.mono}>
                                          {p.sourceId.slice(0, 8)}
                                        </td>
                                        <td>{p.agent}</td>
                                        <td className={styles.mono}>{l.counterparty}</td>
                                        <td className={styles.mono}>${p.appliedToThisLine}</td>
                                        <td>
                                          {p.authorizedBy ? (
                                            <span
                                              className={`${styles.auth} ${styles.authHuman}`}
                                              title={`Approval ${p.authorizedBy.approvalId}`}
                                            >
                                              Human approval · {p.authorizedBy.blockedScope}
                                            </span>
                                          ) : (
                                            <span className={`${styles.auth} ${styles.authAuto}`}>
                                              {p.sourceKind === "receipt"
                                                ? "Not applicable"
                                                : "Within caps"}
                                            </span>
                                          )}
                                        </td>
                                      </tr>
                                    )),
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}

                <tr className={styles.totalRow}>
                  <td>
                    Total{" "}
                    {debitTotal === creditTotal && (
                      <span className={styles.balanced}>· balanced</span>
                    )}
                  </td>
                  <td className={`${styles.amount} ${styles.debit}`}>{money(debitTotal)}</td>
                  <td className={`${styles.amount} ${styles.credit}`}>{money(creditTotal)}</td>
                </tr>
              </tbody>
              </table>
            </div>
          </section>

          {trace && (
            <p className={styles.stepDetail} style={{ marginBottom: "1rem" }}>
              {trace.summary.sources}{" "}
              {trace.lines[0]?.direction === "earn" ? "receipts" : "payments"} ·{" "}
              {trace.summary.agents} agents · {trace.summary.counterparties} counterparties ·{" "}
              <strong>{trace.summary.requiredHumanApproval} needed a human approval</strong>
            </p>
          )}

          {!draft.readiness.ok ? (
            <div className={`${styles.notice} ${styles.noticeError}`}>
              {draft.readiness.reason}. Preview again to pick up the change.
            </div>
          ) : confirming ? (
            <div className={styles.confirm}>
              <span>
                Post {draft.docNumber} to the QuickBooks <strong>sandbox</strong> company?
              </span>
              <button className={`${styles.button} ${styles.buttonPost}`} onClick={onPost} disabled={busy}>
                Post to QuickBooks Sandbox
              </button>
              <button
                className={`${styles.button} ${styles.buttonQuiet}`}
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className={styles.bar}>
              <button
                className={`${styles.button} ${styles.buttonPost}`}
                onClick={() => setConfirming(true)}
                disabled={busy}
              >
                Post to QuickBooks Sandbox
              </button>
              <button
                className={`${styles.button} ${styles.buttonQuiet}`}
                onClick={() => loadTrace(draft.draftId)}
                disabled={busy}
              >
                Load provenance
              </button>
            </div>
          )}
        </>
      )}

      <section style={{ marginTop: "2.5rem" }}>
        <p className={styles.eyebrow}>Posted to QuickBooks</p>
        {postings.length === 0 ? (
          <p className={styles.empty}>
            Nothing posted yet. Preview a day above to see the entry Fuel would create.
          </p>
        ) : (
          <div
            className={styles.tableScroll}
            tabIndex={0}
            role="region"
            aria-label="Posted documents"
          >
            <table className={styles.history}>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Status</th>
                <th scope="col">QuickBooks id</th>
                <th scope="col">Posted</th>
                {isOwner && (
                  <th scope="col">
                    <span className={styles.visuallyHidden}>Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {postings.map((p) => {
                // WRITTEN OFF IS NOT RESOLVED. The status is still "pending":
                // the document may exist in books Fuel can no longer reach. So
                // it is labelled for what it is, and not as "needs reconciling"
                // -- advice nobody can take once its books are gone.
                const writtenOff = p.status === "pending" && !!p.abandonedAt;
                const canWriteOff = isOwner && p.status === "pending" && !writtenOff;
                const panelOpen = writingOff === p.postingId;
                return (
                  <Fragment key={p.postingId}>
                    <tr>
                      <td className={styles.mono}>
                        {p.docNumber}
                        {p.correctsPostingId && (
                          <span className={styles.lineNote}>reverses an earlier entry</span>
                        )}
                      </td>
                      <td>
                        <span
                          className={`${styles.pill} ${
                            p.status === "posted"
                              ? styles.pillPosted
                              : p.status === "pending"
                                ? styles.pillPending
                                : ""
                          }`}
                        >
                          {writtenOff
                            ? "written off, outcome unknown"
                            : p.status === "pending"
                              ? "needs reconciling"
                              : p.status}
                        </span>
                        {writtenOff && (
                          <span className={styles.writtenOffNote}>
                            {p.abandonedBy ? `By ${p.abandonedBy}` : "Written off"} on{" "}
                            {p.abandonedAt?.slice(0, 10)}: {p.abandonReason}
                          </span>
                        )}
                      </td>
                      <td className={styles.mono}>{p.quickBooksId ?? "—"}</td>
                      <td className={styles.mono}>{p.postedAt?.slice(0, 10) ?? "—"}</td>
                      {isOwner && (
                        <td>
                          {canWriteOff && !panelOpen && (
                            <button
                              className={`${styles.button} ${styles.buttonQuiet}`}
                              onClick={() => openWriteOff(p.postingId)}
                              disabled={busy}
                            >
                              Write off…
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                    {canWriteOff && panelOpen && (
                      <tr>
                        <td colSpan={5} className={styles.writeOffCell}>
                          <div className={styles.writeOff} role="group" aria-label={`Write off ${p.docNumber}`}>
                            <p className={styles.writeOffLead}>
                              Write off {p.docNumber} only if the QuickBooks company it was sent to is
                              gone for good.
                            </p>
                            <ul className={styles.writeOffFacts}>
                              <li>
                                Fuel asks QuickBooks once more first. If it answers, that answer is used
                                and nothing is written off.
                              </li>
                              <li>
                                Writing it off lets you disconnect or connect a different QuickBooks
                                company.
                              </li>
                              <li>
                                Its spend is not posted again: the entry may already be in the old books.
                                Book it by hand if it is not.
                              </li>
                            </ul>
                            <div className={styles.field}>
                              <label className={styles.fieldLabel} htmlFor={`wo-reason-${p.postingId}`}>
                                Reason, kept with the record
                              </label>
                              <textarea
                                id={`wo-reason-${p.postingId}`}
                                className={`${styles.input} ${styles.textarea}`}
                                value={writeOffReason}
                                onChange={(e) => setWriteOffReason(e.target.value)}
                                maxLength={500}
                                rows={3}
                              />
                            </div>
                            <div className={styles.field}>
                              <label className={styles.fieldLabel} htmlFor={`wo-confirm-${p.postingId}`}>
                                Type {p.docNumber} to confirm
                              </label>
                              <input
                                id={`wo-confirm-${p.postingId}`}
                                className={styles.input}
                                value={writeOffConfirm}
                                onChange={(e) => setWriteOffConfirm(e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </div>
                            <div className={styles.bar}>
                              <button
                                className={styles.button}
                                onClick={() => onWriteOff(p)}
                                disabled={
                                  busy ||
                                  writeOffReason.trim().length < 10 ||
                                  writeOffConfirm.trim() !== p.docNumber
                                }
                              >
                                Write off {p.docNumber}
                              </button>
                              <button
                                className={`${styles.button} ${styles.buttonQuiet}`}
                                onClick={() => openWriteOff(null)}
                                disabled={busy}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
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
      </section>
    </>
  );
}
