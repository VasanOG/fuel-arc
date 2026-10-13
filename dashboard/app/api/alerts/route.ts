import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { callAlertWebhook } from "@/lib/fuel";
import { REFUSAL_SENTENCE, toAlertWebhook, toTestResult } from "@/lib/alerts";
import { refuseCrossOrigin } from "@/lib/same-origin";

/**
 * Where a company's alerts go: set, remove, and test (ADR 0021).
 *
 *   PUT    { url }  sets or replaces the webhook
 *   DELETE          stops alerts
 *   POST            sends a test alert
 *
 * Owner-only, and that is decided by Fuel, not here: the viewer's own session
 * is what is forwarded, so an operator who reaches this route is refused by
 * the API's requireOwner. This route decides only what may be relayed.
 *
 * THE URL GOES ONE WAY. It arrives from the browser, is handed to Fuel in a
 * request body, and is never written to a log, an error or a response. Every
 * answer below is picked field by field (`toAlertWebhook`, `toTestResult`) and
 * none of Fuel's fields is the URL, so nothing here can send it back.
 *
 * NO TEXT FROM AN ERROR BODY IS EVER RELAYED. A refusal is answered with the
 * dashboard's own sentence for Fuel's `code` (`REFUSAL_SENTENCE`), or a generic
 * one for a code it does not know. Fuel's sentences are fixed and never quote
 * what was sent, but this route does not depend on that.
 */

/** Longer than this is refused here without asking Fuel. Fuel's own limit. */
const MAX_URL_LENGTH = 2048;

function refusal(status: number, body: unknown): NextResponse {
  const o = (body ?? {}) as Record<string, unknown>;
  const known = typeof o.code === "string" && Object.hasOwn(REFUSAL_SENTENCE, o.code);
  const error = known
    ? REFUSAL_SENTENCE[o.code as string]
    : status === 403
      ? "Only an owner can change where alerts go."
      : "Fuel could not make that change.";
  return NextResponse.json(
    { error, code: known ? o.code : null },
    { status: status >= 400 ? status : 502, headers: { "Cache-Control": "no-store" } },
  );
}

async function relay(req: NextRequest, action: "set" | "remove" | "test"): Promise<NextResponse> {
  const blocked = refuseCrossOrigin(req);
  if (blocked) return blocked;

  let url: string | undefined;
  if (action === "set") {
    const body = await req.json().catch(() => null);
    const value = (body ?? {}).url;
    if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
      return NextResponse.json({ error: REFUSAL_SENTENCE.not_a_url, code: "not_a_url" }, { status: 400 });
    }
    url = value;
  }

  try {
    const result = await callAlertWebhook(action, url);
    if (result.status !== 200) return refusal(result.status, result.body);
    const safe = action === "test" ? toTestResult(result.body) : toAlertWebhook(result.body);
    if (safe === null) {
      return NextResponse.json(
        { error: "Fuel answered in a shape this dashboard does not recognise." },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(safe, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // A sign-out must not come back as a 502. See cap/route.ts.
    unstable_rethrow(error);
    return NextResponse.json({ error: "Fuel API unreachable" }, { status: 502 });
  }
}

export const PUT = (req: NextRequest) => relay(req, "set");
export const DELETE = (req: NextRequest) => relay(req, "remove");
export const POST = (req: NextRequest) => relay(req, "test");
