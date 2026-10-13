import { PageHeader } from "@/components/shell/PageHeader";

/**
 * Reading the roster fans out one custody call per agent to fetch balances, so
 * this is a real wait rather than a theoretical one.
 */
export default function Loading() {
  return (
    <>
      <PageHeader title="Agents" description="Reading spend and balances." />
      <p className="empty" role="status">
        Loading agents…
      </p>
    </>
  );
}
