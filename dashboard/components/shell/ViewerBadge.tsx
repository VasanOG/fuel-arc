import { getViewer } from "@/lib/fuel";
import styles from "./shell.module.css";

/**
 * Who is signed in, and the way out.
 *
 * Permanently in the nav, next to the environment badge, because from this
 * commit onward the answer changes what a click DOES. Before Stage 3 every
 * viewer of this dashboard was the same anonymous key holder and there was
 * nothing to show; now a decision made on the Approvals page is recorded
 * against the person named here. Someone about to approve a payment should be
 * able to see whose name goes on it without navigating anywhere.
 *
 * SILENCE WHEN FUEL CANNOT BE ASKED, the same discipline EnvironmentBadge
 * uses. `getViewer` returns null both when nobody is signed in and when the
 * API did not answer, and neither is a case for inventing a name.
 *
 * AND "SILENCE" MEANS SAYING NOTHING, WHICH THE FIRST VERSION OF THIS DID NOT.
 * It rendered the words "Signed in" in exactly that branch — a claim, made to
 * the two people who most need it not to be made: someone whose session is
 * invalid, and someone the API could not be asked about. Security review caught
 * it. It matters more than it looks, because AppShell draws the navigation from
 * the PRESENCE of a cookie rather than its validity, so a browser holding
 * `fuel_session=anything` reaches this component; the old version answered that
 * browser with a full menu and the assurance that it was signed in, until the
 * page body's own fetch got round to redirecting it. No data was exposed — the
 * API refuses every read — but the chrome asserted something false.
 *
 * The sign-out control still renders, because a person who wants out of a
 * session should not be blocked by the product being unsure who they are. A
 * control that offers to DO something is not a claim that anything is true.
 */
export async function ViewerBadge() {
  const viewer = await getViewer();

  return (
    <div className={styles.viewer}>
      {viewer ? (
        <>
          {/*
            The address in full, never truncated with an ellipsis. Two operators
            at one company are commonly alice@ and alice.smith@, and a name
            shortened for tidiness is a name that can be misread as somebody
            else's directly above an Approve button.
          */}
          <p className={styles.viewerEmail}>{viewer.email}</p>
          <p className={styles.viewerMeta}>
            {/* The API's word for the role, rendered as given — the same rule
                the environment badge follows about not re-labelling a verdict. */}
            {viewer.companyName ? `${viewer.companyName} · ` : ""}
            {viewer.role}
          </p>
          {/*
            The company's sign-in handle, on its own line and NOT uppercased
            like the line above: it is retyped exactly, and ACME-7K2Q is not
            what a person should copy. Shown here because this is where anyone
            in the company can find it to pass on with an invite (ADR 0018).
          */}
          {viewer.companyHandle && (
            <p className={styles.viewerHandle} title="Your company's sign-in handle">
              {viewer.companyHandle}
            </p>
          )}
        </>
      ) : (
        /*
          NOTHING. Not "Signed in", not "Unknown", not a dash. The only honest
          statement available here is none, and the sign-out control below is
          the one thing still worth offering.
        */
        null
      )}

      {/*
        A form, not a link: a GET that ends a session is something any other
        page on the internet can trigger by embedding it. It posts same-origin,
        and the route it posts to checks that too.
      */}
      <form method="post" action="/api/session/end">
        <button type="submit" className={styles.signOut}>
          Sign out
        </button>
      </form>
    </div>
  );
}

/**
 * Reserved space while the name is being fetched, for the reason
 * EnvironmentBadgeSkeleton records: the nav must not grow late and move a link
 * out from under a cursor already travelling towards it.
 */
export function ViewerBadgeSkeleton() {
  return <div className={`${styles.viewer} ${styles.viewerPending}`} aria-hidden="true" />;
}
