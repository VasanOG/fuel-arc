import { PageHeader } from "@/components/shell/PageHeader";

/** Matches the other routes: this page is force-dynamic, so every visit reads. */
export default function Loading() {
  return (
    <>
      <PageHeader title="Earning" description="Reading the endpoints." />
      <p className="empty" role="status">
        Loading the endpoints…
      </p>
    </>
  );
}
