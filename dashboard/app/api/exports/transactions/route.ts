import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { fetchTransactionsCsv } from "@/lib/fuel";

/**
 * Relays the accounting export from the Fuel API to the operator's browser.
 *
 * The browser cannot call Fuel directly — it has no credential, and giving it
 * one would put the operator key in client JavaScript. So this route holds the
 * key server-side and streams the file back, the same shape as the cap route's
 * write path.
 *
 * A read, so unlike the cap route it changes nothing — but it needs a stronger
 * cross-origin check than that route, not a weaker one.
 *
 * The cap route is a PATCH with a JSON body, which is not CORS-simple, so a
 * preflight blocks a cross-site attempt before it is ever sent; its Origin
 * check is belt to that braces. This route is a GET, and a plain top-level GET
 * navigation is something any page on the internet can trigger. Worse, the
 * browser does NOT send an Origin header on such a navigation — which is
 * precisely how ExportPanel's own <form method="get"> reaches here. An
 * Origin-only check would therefore skip itself on exactly the vector it is
 * meant to catch.
 *
 * So the primary check is Sec-Fetch-Site, which browsers DO send on top-level
 * navigations:
 *   same-origin  the dashboard's own form            → allow
 *   none         typed or bookmarked by the operator → allow
 *   cross-site / same-site  someone else's page      → refuse
 *
 * What this actually prevents is narrow but real: an external page cannot read
 * the response (this route sets no CORS headers), so the exposure is a forced
 * download of the company's payment history onto the operator's disk rather
 * than exfiltration of it. Refusing outright costs one header check and does
 * not depend on that CORS reasoning staying true.
 *
 * The Origin comparison is kept as a fallback for any client that omits
 * Sec-Fetch-Metadata. It compares against the Host header rather than
 * req.nextUrl.origin, which normalizes to "localhost" regardless of how the
 * server was bound — see the longer note in app/api/agents/[id]/cap/route.ts.
 */
export async function GET(req: NextRequest) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }

  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    const originHost = URL.parse(origin)?.host;
    if (originHost !== host) {
      return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
    }
  }

  // Only the parameters the API defines are forwarded. Copying the whole query
  // string would let a caller append anything the API later starts honouring.
  const incoming = req.nextUrl.searchParams;
  const query = new URLSearchParams();
  for (const key of ["from", "to", "include"]) {
    const value = incoming.get(key);
    if (value) query.set(key, value);
  }

  try {
    const upstream = await fetchTransactionsCsv(query);

    if (!upstream.ok) {
      // Validation errors (400) are the operator's to see and fix; anything
      // else is ours, and its text is not theirs to debug.
      const body = await upstream.json().catch(() => ({}));
      const status = upstream.status === 400 ? 400 : 502;
      return NextResponse.json(
        { error: status === 400 ? (body.error ?? "Invalid export request") : "Export failed" },
        { status },
      );
    }

    // Content-Disposition is taken from upstream so the filename is decided in
    // one place — the API, which knows the date range it actually applied.
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "text/csv; charset=utf-8",
        "Content-Disposition":
          upstream.headers.get("content-disposition") ?? 'attachment; filename="transactions.csv"',
        // An accounting export is a point-in-time answer; a cached copy served
        // later is a wrong one.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    /*
     * A SIGN-OUT MUST NOT COME BACK AS A 502.
     *
     * Since Commit C every Fuel call goes through `fuelFetch`, which turns a
     * 401 into `redirect("/login")` — and `redirect` works by THROWING a
     * sentinel for the framework to unwind to. A bare `catch` swallows it,
     * and this handler would answer with a 502 whose message is the literal
     * string NEXT_REDIRECT: an operator whose session quietly expired would
     * be told Fuel is broken. `unstable_rethrow` re-throws exactly Next's own
     * control-flow errors and nothing else, so every real failure below is
     * still handled here.
     */
    unstable_rethrow(error);
    return NextResponse.json({ error: "Export failed" }, { status: 502 });
  }
}
