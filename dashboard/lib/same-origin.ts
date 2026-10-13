import { NextResponse } from "next/server";

/**
 * Refuses a write that did not come from the page it claims to come from.
 *
 * EXTRACTED, NOT COPIED. This check lived inline in the cap route and was the
 * only one of its kind; Commit C adds three more write routes, and four
 * hand-written copies of a CSRF check is three chances for one of them to drift
 * into a subtly weaker version. The same reasoning moved `Buckets` out of the
 * gateway in Commit A.
 *
 * WHY IT IS COMPARED AGAINST `Host` AND NOT `req.nextUrl.origin`. Verified the
 * hard way in 5A-1: `nextUrl` normalises to `localhost` no matter how the
 * server was actually bound. This server binds `127.0.0.1`, a browser at
 * `http://127.0.0.1:3100` sends `Origin: http://127.0.0.1:3100`, and
 * `req.nextUrl.origin` still read `http://localhost:3100` — so the comparison
 * would have failed for every honest request and been "fixed" by deleting it.
 * `Host` is what the browser actually connected to.
 *
 * AN ABSENT `Origin` IS ALLOWED, for the same reason the API's
 * `sameOriginForSessions` allows it: non-browser clients send none, and the
 * attack this stops is one a browser performs on a victim's behalf, where the
 * header is always present. This is the second layer regardless — `SameSite=Lax`
 * on the session cookie is the first.
 *
 * `Sec-Fetch-Site` FIRST, added with alerting (security review of commit 2).
 * The QuickBooks proxy and the funding route already checked it; every write
 * route now does, here. A browser sends it on every request and a page cannot
 * forge it, so a cross-site or same-site request is refused even in a case
 * where an Origin comparison would not catch it. `none` is a person's own
 * navigation; an absent header is a non-browser client, as above.
 *
 * Returns a 403 response to return, or null to carry on.
 */
export function refuseCrossOrigin(req: Request): NextResponse | null {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return null;
  if (URL.parse(origin)?.host === host) return null;
  return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
}
