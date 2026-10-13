"use client";

import { PageHeader } from "@/components/shell/PageHeader";

/**
 * The error boundary the app never had.
 *
 * Before this, an unreachable Fuel API meant `listAgents()` threw and the
 * operator got Next's default crash screen. The one thing that actually goes
 * wrong here is configuration, so the copy names it instead of apologising.
 *
 * IT USED TO NAME FUEL_API_KEY TOO. That advice is now actively misleading —
 * the dashboard holds no key, and someone following it would add a variable
 * that nothing reads and conclude their real problem was something else. Being
 * signed out is not this boundary's business either: lib/fuel.ts turns Fuel's
 * 401 into a redirect to the sign-in page, so it never arrives here as a crash.
 */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <>
      <PageHeader
        title="This page could not load"
        description="Fuel could not reach its API. That is usually the API server being down, or FUEL_API_URL missing from dashboard/.env.local."
      />
      <p className="error-text">{error.message}</p>
      <p>
        <button type="button" className="link-btn" onClick={reset}>
          Try again
        </button>
      </p>
    </>
  );
}
