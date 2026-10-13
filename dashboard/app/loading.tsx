import { PageHeader } from "@/components/shell/PageHeader";

export default function Loading() {
  return (
    <>
      <PageHeader title="Overview" description="Reading budgets and agents." />
      <p className="empty" role="status">
        Loading…
      </p>
    </>
  );
}
