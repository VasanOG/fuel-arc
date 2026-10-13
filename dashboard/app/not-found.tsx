import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";

export default function NotFound() {
  return (
    <>
      <PageHeader
        title="No such page"
        description="That address does not match anything in Fuel."
      />
      <p>
        <Link href="/" className="link-btn">
          Go to Overview
        </Link>
      </p>
    </>
  );
}
