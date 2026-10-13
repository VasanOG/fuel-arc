import { PageHeader } from "@/components/shell/PageHeader";

export default function Loading() {
  return (
    <>
      <PageHeader title="Approvals" description="Reading the queue." />
      <p className="empty" role="status">
        Loading approvals…
      </p>
    </>
  );
}
