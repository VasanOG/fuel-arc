import { PageHeader } from "@/components/shell/PageHeader";

/**
 * Shown while a page of the ledger is read.
 *
 * Every filter change and every Next is a fresh navigation, so this is the
 * state an operator sees most often on this route — not just on first visit.
 */
export default function Loading() {
  return (
    <>
      <PageHeader title="Activity Ledger" description="Reading the ledger." />
      <p className="empty" role="status">
        Loading the ledger…
      </p>
    </>
  );
}
