import { PageHeader } from "@/components/shell/PageHeader";

/**
 * Shown while both status reads (environment, QuickBooks) are in flight.
 */
export default function Loading() {
  return (
    <>
      <PageHeader title="Integrations" description="Checking connections." />
      <p className="empty" role="status">
        Reading connection status…
      </p>
    </>
  );
}
