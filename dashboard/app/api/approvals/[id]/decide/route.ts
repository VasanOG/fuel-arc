import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { decideApproval } from "@/lib/fuel";
import { refuseCrossOrigin } from "@/lib/same-origin";

/**
 * Approve or deny one held payment.
 *
 * THE SECOND WRITE PATH IN THE DASHBOARD, and the first that decides money
 * rather than a limit. `docs/ui/phase-5-blueprint.md` deferred this control
 * until the roles governing it existed; Stage 3 is that, and this route is only
 * defensible now because the request it makes carries a PERSON. Before Commit
 * C the dashboard held a shared operator key, so "who approved this payment"
 * had no answer worth recording — two-party control where both parties are the
 * same anonymous secret is one party.
 *
 * NO DECISION LOGIC LIVES HERE, deliberately. This route does not check the
 * approval's status, its company, or whether it has expired, and adding any of
 * that would be building a second opinion about money next to the real one.
 * The Fuel API re-reads the row through a company-scoped getter, guards the
 * state change inside the UPDATE itself, and answers 409 if the decision
 * changed nothing — including when a second operator raced the first. This
 * route relays.
 *
 * NOR IS THERE A CONFIRMATION STEP HERE. The confirm gate is in the UI, in
 * ApprovalDecision.tsx, the same arrangement the cap editor uses: by the time
 * a request arrives the operator has already been shown the amount, the agent
 * and the word for what they are about to do.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const blocked = refuseCrossOrigin(req);
  if (blocked) return blocked;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const decision = body?.decision;

  /*
   * An allowlist of two words, checked here rather than passed through.
   * `decideApproval` narrows it again by type and chooses the path from a
   * literal, so nothing a caller sends can steer which API route is called —
   * but a rejected value should be a 400 from the dashboard rather than a
   * confusing 404 from Fuel.
   */
  if (decision !== "approve" && decision !== "deny") {
    return NextResponse.json({ error: 'decision must be "approve" or "deny"' }, { status: 400 });
  }

  try {
    const approval = await decideApproval(id, decision);
    return NextResponse.json(approval);
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
    /*
     * 502 and the API's own sentence. Fuel's refusals here are things an
     * operator needs to read unchanged — "cannot approve a request that is
     * denied" is the whole explanation for why the button did nothing, and a
     * generic message would send them to look for a bug that is not there.
     */
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to record the decision" },
      { status: 502 },
    );
  }
}
