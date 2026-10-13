import { callQuickBooks, getAccountingStatus, getEnvironment, getViewer } from "@/lib/fuel";
import { AccountingWorkbench } from "@/components/AccountingWorkbench";
import { PageHeader } from "@/components/shell/PageHeader";
import styles from "./accounting.module.css";

// An operator tool watching live spend; a cached copy would be a wrong answer.
export const dynamic = "force-dynamic";

export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string }>;
}) {
  // Set by the OAuth callback when it sends the operator back here, so the
  // connection confirms itself on the page they started from rather than on a
  // stray tab they have to close.
  //
  // Its VALUE is deliberately not rendered. The callback puts the realm id
  // there, and the operator does not need to read their own company's
  // QuickBooks identifier to be told the connection worked — its presence is
  // the whole signal.
  const { connected } = await searchParams;

  // Three reads, none of them raw.
  //
  // `status` narrows through the safe contract (ADR 0010); `/postings` is
  // still the passthrough because a posting record is Fuel's own row — a doc
  // number, a status, the QuickBooks journal-entry id that makes it
  // reconcilable — and carries no credential or company identifier.
  //
  // Rendered even when the API is unreachable: an operator arriving at a
  // broken page should see what is wrong, not a stack trace.
  const [status, postingsRes, environment, viewer] = await Promise.all([
    getAccountingStatus(),
    callQuickBooks("/postings").catch(() => null),
    getEnvironment(),
    getViewer(),
  ]);

  // Whether to OFFER the write-off. Display only: the API refuses anyone but a
  // signed-in owner whatever this says, so a stale or wrong value can at worst
  // show a button that answers 403 -- never let someone through.
  const isOwner = viewer?.role === "owner";

  const postings = postingsRes?.status === 200 ? ((postingsRes.body as any).postings ?? []) : [];

  // Yesterday: a day that has finished is the one with a complete rollup.
  const suggested = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  // The environment word is the server's, never this file's. A hardcoded
  // "Sandbox" here would keep saying "Sandbox" on the day it stopped being
  // true; an unreachable API means no environment claim at all, not a
  // reassuring guess. Same rule as the shell badge — see 5B-6.
  // Three states, not two. A null status means Fuel could not be asked, which
  // is a DIFFERENT fact from a company that is not connected — and the worse
  // one to get wrong, because "Not connected" would tell an operator their
  // books are unmanaged when the truth is that nobody knows. /integrations
  // already draws this distinction; this page now agrees with it.
  const connectionLabel =
    status === null ? "Connection unknown" : status.connected ? "Connected" : "Not connected";
  const aside = environment ? `${environment.label} · ${connectionLabel}` : connectionLabel;

  return (
    <>
      <PageHeader
        title="Accounting"
        description="Agent spend, rolled into a journal entry you can read before it is posted — and open back up afterwards."
        aside={<span className={styles.env}>{aside}</span>}
      />

      {/*
        Shown only when the URL says we just came back from Intuit AND Fuel
        itself confirms the connection. The query parameter alone is not
        evidence: anyone can open /accounting?connected=1, and a banner that
        believed it would announce a connection that does not exist — directly
        contradicting the badge above it, which reads the real status.
      */}
      {connected && status?.connected && (
        <p className={styles.connected}>Connected to QuickBooks. You can set up accounts now.</p>
      )}

      <AccountingWorkbench
        initialStatus={status}
        initialPostings={postings}
        suggestedDay={suggested}
        isOwner={isOwner}
      />
    </>
  );
}
