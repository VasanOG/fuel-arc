import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { setAgentCap } from "@/lib/fuel";
import { refuseCrossOrigin } from "@/lib/same-origin";

/**
 * Setting an agent's spend cap.
 *
 * It was the ONLY write path in the dashboard until Commit C, and the sentence
 * that used to sit here said it was "the one place FUEL_API_KEY gets used to
 * make a change". Both halves are now out of date and the second is the one
 * worth recording: the dashboard holds no key at all. This change is made with
 * the session cookie of the person who clicked, forwarded by lib/fuel.ts, and
 * Fuel resolves the company from THAT person's row rather than from a binding
 * baked into a shared secret.
 *
 * The browser still only ever calls this route and never Fuel directly.
 *
 * No confirmation logic here: the confirm step is a UI gate in
 * AgentsRoster.tsx, so that by the time a request reaches this route the
 * operator has already agreed to the number in the body. This route just
 * relays.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Nothing currently sends this cross-origin (PATCH isn't a CORS-simple
  // method, and this route sets no Access-Control-Allow-Origin, so a
  // preflight would block it) — but that protection is incidental, not
  // declared. spendCapUsd is the only spending control in the system, so this
  // route gets its own explicit check rather than depending on CORS defaults
  // staying as they are.
  //
  // The check itself moved to lib/same-origin.ts in Commit C, when three more
  // write routes needed it. Its reasoning — including why it compares against
  // the Host header and not req.nextUrl.origin — moved with it.
  const blocked = refuseCrossOrigin(req);
  if (blocked) return blocked;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const spendCapUsd = body?.spendCapUsd;
  if (typeof spendCapUsd !== "string") {
    return NextResponse.json({ error: "spendCapUsd (string) is required" }, { status: 400 });
  }

  try {
    const agent = await setAgentCap(id, spendCapUsd);
    return NextResponse.json(agent);
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to set cap" },
      { status: 502 },
    );
  }
}
