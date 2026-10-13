import { NextRequest, NextResponse } from "next/server";
import { isRelayRefusal, verifiedClientAddress } from "@/lib/client-address";
import { startSession } from "@/lib/fuel";
import { refuseCrossOrigin } from "@/lib/same-origin";

/**
 * Sign-in: an ordinary HTML form post, proxied to the Fuel API.
 *
 * WHY A ROUTE HANDLER AND A REAL FORM, rather than a server action and client
 * JavaScript. Two reasons, and the second is the one that decided it:
 *
 *   1. Sign-in is the one page an operator reaches when something is already
 *      wrong. It works here with JavaScript disabled, mid-hydration, and on a
 *      slow connection, because it is a form and a redirect.
 *   2. The API's `Set-Cookie` can be relayed BYTE FOR BYTE. A server action
 *      would have to take the token and call `cookies().set()` with attributes
 *      chosen here — making the dashboard a second authority on `HttpOnly`,
 *      `SameSite` and `Secure`. See `startSession` for why that is the wrong
 *      shape.
 *
 * THE PASSWORD IS IN A POST BODY AND NEVER IN A URL. On both outcomes the
 * browser is sent away with a 303, so what ends up in history, in the address
 * bar and in any proxy log is a path, never the credential.
 */
export async function POST(req: NextRequest) {
  const blocked = refuseCrossOrigin(req);
  if (blocked) return blocked;

  let company = "";
  let email = "";
  let password = "";
  try {
    const form = await req.formData();
    company = String(form.get("company") ?? "");
    email = String(form.get("email") ?? "");
    password = String(form.get("password") ?? "");
  } catch {
    return seeOther("/login?e=refused");
  }
  // The company too: an address can have an account at more than one
  // company, and the handle is what says which (ADR 0018).
  if (!company || !email || !password) return seeOther("/login?e=refused");

  /*
   * NO VERIFIED ADDRESS, NO SIGN-IN (ADR 0020, decision 3). Null means this
   * request did not come through server.mjs's edge: the dashboard was started
   * with `next start` or `next dev`. Forwarding anyway would mean forwarding
   * nothing, which Fuel would count against the dashboard itself, the shared
   * bucket one browser could exhaust for everyone. Refusing is loud and
   * fixable, and the log line says exactly what to fix.
   */
  const client = verifiedClientAddress(req.headers, process.env.FUEL_EDGE_PROOF);
  if (client === null) {
    console.error("sign-in refused: no edge-verified client address. Start the dashboard with server.mjs.");
    return seeOther("/login?e=unreachable");
  }

  let result;
  try {
    result = await startSession(company, email, password, client);
  } catch (err) {
    // Fuel unreachable, or the relay key is missing. Distinct from a refusal on
    // purpose: "we could not ask" and "that is not your password" send a person
    // to do different things.
    console.error("sign-in could not reach Fuel:", err instanceof Error ? err.message : err);
    return seeOther("/login?e=unreachable");
  }

  /*
   * A RELAY REFUSAL IS THE DASHBOARD'S FAULT, NEVER THE PERSON'S, and is
   * checked before the status. Fuel refused the dashboard's relay key or peer,
   * or the address it sent. Telling the person their password was wrong, or
   * that THEY tried too often, would send them to fix something that is not
   * broken. A rejected relay that keeps trying is throttled with a 429, and
   * that 429 still carries `relay_rejected` for exactly this reason.
   */
  if (isRelayRefusal(result.code)) {
    console.error(`sign-in relay refused by Fuel (${result.code}): check FUEL_RELAY_KEY and FUEL_RELAY_PEERS.`);
    return seeOther("/login?e=unreachable");
  }
  if (result.status === 429) return seeOther("/login?e=throttled");
  if (result.status === 503) return seeOther("/login?e=busy");
  if (result.status !== 200) return seeOther("/login?e=refused");

  /*
   * Relayed unchanged. Note what is NOT done here: the token is never read out
   * of the header, never logged, and never put anywhere this process can see
   * it again.
   */
  return seeOther("/", result.setCookie);
}

/**
 * 303, not 302. After a POST, 303 tells the browser to follow up with a GET —
 * which is what stops a refresh on the landing page from re-submitting the
 * password.
 *
 * A RELATIVE `Location` for the reason middleware.ts records: an absolute URL
 * built from this framework's idea of its own origin normalises to `localhost`
 * and would move the browser to a different cookie host than the one it is on,
 * losing the cookie this response is carrying.
 */
function seeOther(location: string, setCookie: string[] = []): NextResponse {
  const res = new NextResponse(null, { status: 303, headers: { Location: location } });
  for (const line of setCookie) res.headers.append("set-cookie", line);
  return res;
}
