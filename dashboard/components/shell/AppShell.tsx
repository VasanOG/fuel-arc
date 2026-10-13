import { cookies } from "next/headers";
import { Suspense, type ReactNode } from "react";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { SideNav } from "./SideNav";
import { EnvironmentBadge, EnvironmentBadgeSkeleton } from "./EnvironmentBadge";
import { ViewerBadge, ViewerBadgeSkeleton } from "./ViewerBadge";
import styles from "./shell.module.css";

/**
 * The frame every Fuel page renders inside.
 *
 * A Server Component holding a Client Component: only the nav needs the current
 * path and the mobile disclosure, so only the nav ships JavaScript.
 *
 * The environment badge and the signed-in badge are async Server Components
 * passed INTO the nav as slots. A client component cannot await anything, but
 * it can render children a server parent already resolved — so both are fetched
 * on the server, the session never moves into the browser, and the nav still
 * owns its own interactivity.
 *
 * Each is suspended behind a same-height placeholder so a slow or hanging Fuel
 * API delays that badge and nothing else. Without the boundaries these fetches
 * would block the whole document, and every page in the product would wait on
 * furniture.
 *
 * NO NAVIGATION FOR A SIGNED-OUT VISITOR. The sign-in page is the only page
 * anyone can reach without a session, and wrapping it in the application frame
 * would offer eight links that all bounce straight back to it.
 *
 * THE TEST IS THE COOKIE'S PRESENCE, NOT WHETHER IT IS VALID, and that is on
 * purpose. Asking Fuel would mean the navigation disappeared during any API
 * blip — the product would look signed-out because the network hiccuped. The
 * cookie is the local, always-available signal for "is this a person who has
 * signed in", and the same reasoning middleware.ts records applies: nothing is
 * being guarded here, so nothing is lost by trusting a name.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const signedIn = (await cookies()).has(SESSION_COOKIE);

  if (!signedIn) {
    return (
      <>
        <a href="#content" className={styles.skip}>
          Skip to content
        </a>
        <div id="content">{children}</div>
      </>
    );
  }

  return (
    <div className={styles.app}>
      <a href="#content" className={styles.skip}>
        Skip to content
      </a>
      <SideNav>
        <Suspense fallback={<ViewerBadgeSkeleton />}>
          <ViewerBadge />
        </Suspense>
        <Suspense fallback={<EnvironmentBadgeSkeleton />}>
          <EnvironmentBadge />
        </Suspense>
      </SideNav>
      <div className={styles.main}>
        <main id="content" className={styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}
