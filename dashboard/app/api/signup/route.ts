import { NextRequest, NextResponse } from "next/server";
import { isRelayRefusal, verifiedClientAddress } from "@/lib/client-address";
import { redeemInvite } from "@/lib/fuel";
import { refuseCrossOrigin } from "@/lib/same-origin";

/**
 * Redeeming an invite: an ordinary HTML form post, proxied to the Fuel API.
 *
 * A ROUTE HANDLER AND A REAL FORM, for the two reasons app/api/session/route.ts
 * records and one more of its own:
 *
 *   1. It works with JavaScript disabled, mid-hydration, and on a bad
 *      connection. This is somebody's first contact with Fuel; it should be the
 *      least clever page in the product.
 *   2. The API's `Set-Cookie` is relayed BYTE FOR BYTE. A server action would
 *      have to read the token and call `cookies().set()` with attributes chosen
 *      here, making the dashboard a second authority on `HttpOnly`, `SameSite`
 *      and `Secure`. See `redeemInvite` in lib/fuel.ts.
 *   3. The invite token is a live credential, and a form post keeps it in a
 *      body. Every outcome below is a 303 to a path with no token in it, so
 *      nothing lands in history, in the address bar, or in a proxy log.
 */
export async function POST(req: NextRequest) {
  const blocked = refuseCrossOrigin(req);
  if (blocked) return blocked;

  let token = "";
  let email = "";
  let password = "";
  let confirm = "";
  try {
    const form = await req.formData();
    token = String(form.get("token") ?? "").trim();
    email = String(form.get("email") ?? "");
    password = String(form.get("password") ?? "");
    confirm = String(form.get("confirm") ?? "");
  } catch {
    return seeOther("/signup?e=incomplete");
  }

  if (!token || !email || !password) return seeOther("/signup?e=incomplete");

  /*
   * THE CONFIRMATION IS CHECKED HERE, BEFORE FUEL IS CALLED, AND THE ORDER IS
   * THE POINT.
   *
   * Fuel has no self-serve password reset and sends no email, so a typo in the
   * password field is not a small mistake — it produces an account nobody can
   * open, recoverable only by someone with shell access running
   * scripts/set-password.ts. That is why a second field exists at all.
   *
   * Checking it first also means a typo costs the invite nothing: no redemption
   * is attempted, so no rate-limit slot is spent and the single-use token stays
   * unspent. Doing this after the call would let a mistyped confirmation burn
   * attempts against a token the person legitimately holds.
   */
  if (password !== confirm) return seeOther("/signup?e=mismatch");

  // No edge-verified address, no relay: see app/api/session/route.ts. The
  // invite is untouched, so the person can use it once the dashboard is fixed.
  const client = verifiedClientAddress(req.headers, process.env.FUEL_EDGE_PROOF);
  if (client === null) {
    console.error("signup refused: no edge-verified client address. Start the dashboard with server.mjs.");
    return seeOther("/signup?e=unreachable");
  }

  let result;
  try {
    result = await redeemInvite(token, email, password, client);
  } catch (err) {
    // Fuel unreachable, or the relay key is missing. Distinct from a refusal on
    // purpose: "we could not ask" and "your invitation is not valid" send a
    // person to do different things, and only one of them should make them
    // doubt their invite.
    console.error("signup could not reach Fuel:", err instanceof Error ? err.message : err);
    return seeOther("/signup?e=unreachable");
  }

  // A relay refusal is the dashboard's fault, never the invite's or the
  // person's: see app/api/session/route.ts.
  if (isRelayRefusal(result.code)) {
    console.error(`signup relay refused by Fuel (${result.code}): check FUEL_RELAY_KEY and FUEL_RELAY_PEERS.`);
    return seeOther("/signup?e=unreachable");
  }

  if (result.status === 201) {
    /*
     * Relayed unchanged, and note what is NOT done: the session token is never
     * read out of the header, never logged, and never put anywhere this process
     * can reach it again.
     */
    return seeOther("/", result.setCookie);
  }

  /*
   * THE CODE IS PASSED ALONG, NEVER THE SERVER'S SENTENCE. The page turns it
   * into one of its own messages through a closed lookup, so nothing Fuel sends
   * can put text on a Fuel-origin page. An unrecognised code is carried through
   * as-is and renders nothing, which is the safe direction: a blank notice is
   * better than an attacker-chosen one.
   */
  return seeOther(`/signup?e=${encodeURIComponent(result.code ?? "invite_unusable")}`);
}

/**
 * 303, not 302. After a POST, 303 tells the browser to follow up with a GET,
 * which is what stops a refresh from re-submitting the invite and the password.
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
