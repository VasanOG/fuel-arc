import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { callQuickBooks } from "@/lib/fuel";
import { toAccountingActionResult, toAccountingStatus } from "@/lib/accounting-status";

/**
 * Relays QuickBooks integration calls from the operator's browser to the Fuel
 * API. It held FUEL_API_KEY until Stage 3 so the key never reached client
 * JavaScript; there is no key now, and what it relays is the session cookie of
 * the person viewing the page.
 *
 * ONE ROUTE, WITH AN ALLOWLIST. A catch-all proxy over `/api/integrations/*`
 * would be shorter and considerably worse: the browser would decide which Fuel
 * endpoints exist, and every route added to the API later would be reachable
 * from a page without anyone choosing that. The allowlist below is the whole
 * surface this page is permitted to reach, and adding to it is a deliberate
 * edit.
 *
 * The same-origin check follows the pattern the exports route already
 * established: `Sec-Fetch-Site` first, because a browser omits `Origin` on some
 * requests, with an Origin-vs-Host comparison as the fallback. `req.nextUrl` is
 * deliberately not used for it — that property normalises to `localhost`
 * regardless of how the server is actually bound, which was verified the hard
 * way when it broke same-origin saves on the cap route.
 */
/**
 * How each endpoint's response is narrowed before the browser sees it.
 *
 *   "status"  — the seven-key connection contract.
 *   "action"  — that contract plus a company display name and account NAMES.
 *   "none"    — Fuel's own records, carrying no provider identifier.
 *
 * REQUIRED ON EVERY ENTRY, deliberately. The first version of this file
 * narrowed `/status` alone, with the narrowing written as an `if` further
 * down — so the three OTHER routes that answer with the same raw connection
 * object went out unnarrowed and nobody had to decide that. Making it a field
 * here means a new endpoint cannot be added without saying what happens to its
 * body, and "none" has to be typed out rather than fallen into.
 */
type Narrowing = "status" | "action" | "none";

const ALLOWED: { method: "GET" | "POST" | "PATCH"; pattern: RegExp; narrow: Narrowing }[] = [
  { method: "GET", pattern: /^\/status$/, narrow: "status" },
  { method: "GET", pattern: /^\/drafts$/, narrow: "none" },
  { method: "GET", pattern: /^\/postings$/, narrow: "none" },
  { method: "GET", pattern: /^\/postings\/[\w-]+\/trace$/, narrow: "none" },
  { method: "POST", pattern: /^\/connect$/, narrow: "none" },
  { method: "POST", pattern: /^\/disconnect$/, narrow: "none" },
  // These three spread presentQboStatus into their replies — see src/api.ts.
  { method: "POST", pattern: /^\/setup-accounts$/, narrow: "action" },
  { method: "POST", pattern: /^\/verify-currency$/, narrow: "action" },
  { method: "PATCH", pattern: /^\/config$/, narrow: "action" },
  { method: "POST", pattern: /^\/preview$/, narrow: "none" },
  { method: "POST", pattern: /^\/post$/, narrow: "none" },
  { method: "POST", pattern: /^\/postings\/[\w-]+\/reconcile$/, narrow: "none" },
  { method: "POST", pattern: /^\/postings\/[\w-]+\/reverse$/, narrow: "none" },
  // Owner-only at the API (requireOwner). The viewer's own session is what is
  // forwarded, so an operator reaching this through the proxy is refused there,
  // not here -- this list decides what may be relayed, not who may do it.
  { method: "POST", pattern: /^\/postings\/[\w-]+\/abandon$/, narrow: "none" },
];

function rejectCrossOrigin(req: NextRequest): NextResponse | null {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && URL.parse(origin)?.host !== host) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  return null;
}

async function relay(req: NextRequest, method: "GET" | "POST" | "PATCH") {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;

  const path = req.nextUrl.searchParams.get("path") ?? "";
  const allowed = ALLOWED.find((entry) => entry.method === method && entry.pattern.test(path));
  if (!allowed) {
    return NextResponse.json({ error: "not an allowed endpoint" }, { status: 404 });
  }

  const body = method === "GET" ? undefined : await req.json().catch(() => ({}));

  try {
    const result = await callQuickBooks(path, { method, body });

    /*
     * Narrowed here, at the door, not in the component.
     *
     * This is the boundary that actually matters. The page's first render was
     * already picking its fields — but the workbench refetches `/status` after
     * connect, account setup, post and disconnect, and it presses
     * `/setup-accounts` directly. Those are plain HTTP responses the browser
     * can read in its network tab whatever the component does with them
     * afterwards. Narrowing only the props would have left the realm id, the
     * OAuth expiry timestamps and three account ids being handed over several
     * times a session.
     *
     * A 200 that will not narrow is reported as a failure rather than as an
     * empty object: `null` here would deserialise into "not connected", which
     * is a confident wrong answer about someone's books. 502 leaves the
     * component holding the last status it trusted. See ADR 0010.
     */
    if (allowed.narrow !== "none" && result.status === 200) {
      const safe =
        allowed.narrow === "status"
          ? toAccountingStatus(result.body)
          : toAccountingActionResult(result.body);
      if (!safe) {
        return NextResponse.json(
          { error: "Fuel returned a connection status this dashboard does not recognise" },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );
      }
      return NextResponse.json(safe, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    return NextResponse.json(result.body, {
      status: result.status,
      // An accounting view is a point-in-time answer; a cached copy served
      // later is a wrong one.
      headers: { "Cache-Control": "no-store" },
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
    return NextResponse.json({ error: "Fuel API unreachable" }, { status: 502 });
  }
}

export const GET = (req: NextRequest) => relay(req, "GET");
export const POST = (req: NextRequest) => relay(req, "POST");
export const PATCH = (req: NextRequest) => relay(req, "PATCH");
