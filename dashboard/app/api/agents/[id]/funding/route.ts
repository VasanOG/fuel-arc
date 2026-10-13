import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { getAgent } from "@/lib/fuel";

/**
 * Relays one agent's funding address, network and asset, and nothing else
 * about it — ON DEMAND, when the "Show funding details" click asks for it
 * (ADR 0019, narrowing 0005's now-closed exception).
 *
 * WHY THIS IS ITS OWN ROUTE RATHER THAN THE AGENT PAGE PASSING
 * `agent.funding` STRAIGHT INTO `FundingPanel` AS A PROP. Next.js serialises
 * every prop a Server Component hands to a Client Component into the page's
 * own delivered bytes (the flight/RSC payload), whether or not that
 * component currently renders it — the exact mechanism 5A-1's security
 * review caught once already (see docs/decisions/0005: "Five addresses were
 * arriving in the browser with nothing on screen showing them"). A prop is
 * not a boundary; a request the browser has not yet made is. So
 * `agents/[id]/page.tsx` hands `FundingPanel` only this agent's id and a
 * boolean (does a funding address exist for it to show at all) — never the
 * address — and this route is what the click itself calls. The address is
 * therefore not present in any response the browser receives until a person
 * asks for it, matching the collapsed-state guarantee
 * `scripts/qa-dashboard.ts` checks for every other route.
 *
 * Reuses `getAgent`, the same read the agent detail page already makes,
 * rather than adding a second upstream Fuel route for one field: this is a
 * low-frequency, person-initiated click, not a hot path worth its own.
 *
 * Cross-origin: the same defense as the accounting export
 * (app/api/exports/transactions/route.ts), and for the same reason — a GET
 * is not CORS-simple-blocked the way the cap route's PATCH is, so it needs
 * its own check rather than the PATCH-only `refuseCrossOrigin`. Sec-Fetch-Site
 * is primary because a browser sends it on requests an Origin-only check
 * would miss; Origin/Host is the fallback for a client that omits it.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && URL.parse(origin)?.host !== host) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const agent = await getAgent(id);
    if (!agent) return NextResponse.json({ error: "no such agent" }, { status: 404 });
    if (!agent.funding) {
      return NextResponse.json({ error: "no funding details available" }, { status: 404 });
    }
    // Field by field, not a spread of `agent` — the same discipline
    // `presentFunding` uses server-side, kept here rather than trusted to
    // stay true one layer up.
    return NextResponse.json(
      { address: agent.funding.address, network: agent.funding.network, asset: agent.funding.asset },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    /*
     * A SIGN-OUT MUST NOT COME BACK AS A 502. See cap/route.ts's identical
     * note: fuelFetch turns a 401 into a thrown redirect, and a bare catch
     * here would report it as a broken funding read rather than an ended
     * session.
     */
    unstable_rethrow(error);
    return NextResponse.json({ error: "Failed to read funding details" }, { status: 502 });
  }
}
