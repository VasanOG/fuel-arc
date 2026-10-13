import { NextRequest, NextResponse } from "next/server";
import { endSession } from "@/lib/fuel";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { refuseCrossOrigin } from "@/lib/same-origin";

/**
 * Sign-out.
 *
 * A POST AND NOT A LINK, because a GET that destroys something is a thing any
 * page on the internet can make a browser do by putting it in an `<img>` tag.
 * It is a form, so it needs no client JavaScript, and it carries the same
 * same-origin check as every other write here.
 *
 * SIGNING OUT REVOKES THE SESSION SERVER-SIDE, which is the half that matters:
 * Fuel marks the row revoked, so the token is dead everywhere it might have
 * been copied to, rather than merely being forgotten by this browser.
 *
 * It sends the person to the sign-in page WHATEVER HAPPENS. If Fuel refused or
 * could not be reached, the honest outcome is still to stop showing them a
 * signed-in product; the residual risk — a live session row that this browser
 * no longer holds a cookie for — expires on its own, and the alternative is
 * leaving somebody who asked to sign out looking at an error and still in.
 */
export async function POST(req: NextRequest) {
  const blocked = refuseCrossOrigin(req);
  if (blocked) return blocked;

  let setCookie: string[] = [];
  try {
    setCookie = (await endSession()).setCookie;
  } catch {
    /* Fuel unreachable. Still sign out locally — see above. */
  }

  /*
   * IF FUEL SENT NOTHING, DELETE THE COOKIE ANYWAY.
   *
   * The API only clears the cookie when it had a session to revoke; sign out
   * with one that already expired and it answers 400 and sets no header. The
   * browser would then keep a dead cookie, which is harmless to Fuel but not
   * to the person: middleware sees a cookie and lets them past, every page
   * then bounces them to sign in, and "Sign out" appears to have done nothing.
   *
   * This is the ONE place the dashboard writes this cookie itself, and it is a
   * deletion rather than a credential. `HttpOnly` and `Secure` are absent
   * because they protect a VALUE, and there is none — what has to match for a
   * browser to drop the right cookie is the name and the path, which is what
   * is written. Nothing here can create a session.
   */
  const headers = setCookie.length
    ? setCookie
    : [`${SESSION_COOKIE}=; Path=/; Max-Age=0`];

  const res = new NextResponse(null, { status: 303, headers: { Location: "/login?e=out" } });
  for (const line of headers) res.headers.append("set-cookie", line);
  return res;
}
