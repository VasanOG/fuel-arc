import { NextRequest, NextResponse } from "next/server";
// A RELATIVE IMPORT, NOT THE "@/" ALIAS THE REST OF THE APP USES. The alias is
// resolved by Next, so a module that uses it can only be loaded by Next — and
// this gate is worth testing outside a browser and outside a build. One
// relative path keeps scripts/verify-api.ts able to import it and ask it real
// questions about real paths.
//
// AND NO ".js" ON THE END, which the first version had. TypeScript accepts it
// under "bundler" resolution, so the typecheck passed; Next's webpack does not,
// and the production build failed. Both mistakes are now caught automatically
// and in opposite directions: switch to "@/" and verify-api can no longer
// import this file, add ".js" back and `next build` refuses it.
import { SESSION_COOKIE } from "./lib/session-cookie";

/**
 * Sends a signed-out visitor to the sign-in page.
 *
 * THIS IS NOT A SECURITY BOUNDARY, AND IT IS IMPORTANT THAT NOBODY LATER
 * BELIEVES IT IS. All it checks is that a cookie with the right NAME exists.
 * It does not validate the session, and it cannot: the value is a token whose
 * only meaning is a row in Fuel's database, in another process. Anyone can put
 * `fuel_session=anything` in their own browser and get past this line.
 *
 * What they reach is a set of pages whose every piece of data comes from the
 * Fuel API, which validates the session properly, resolves the company from
 * the user's own row, and refuses. The boundary is there and has always been
 * there. This is routing: it turns "a page that renders an error" into "the
 * page you actually needed", which is a usability job, not a guard.
 *
 * WHY NOT VALIDATE HERE. Middleware could call `GET /api/auth/me` on every
 * navigation and redirect on a real 401. It was considered and rejected: it
 * adds a network round trip to every request in the product, it still would
 * not be a boundary (the API would have to be asked again by the page anyway),
 * and it couples the dashboard's ability to ROUTE to Fuel's availability — an
 * API blip would bounce a signed-in operator to a sign-in page that then
 * refuses to sign them in. The narrower case of a cookie that exists but has
 * stopped being valid is handled where the real answer arrives: `fuelFetch` in
 * lib/fuel.ts turns Fuel's 401 into the same redirect.
 */
export function middleware(req: NextRequest) {
  if (req.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  /*
   * THE ORIGIN OF THIS REDIRECT IS NEXT'S TO DECIDE, NOT OURS. Measured against
   * a real production build, because two earlier attempts here were wrong.
   *
   * Attempt one returned a RELATIVE `Location` ("/login"), which is legal HTTP
   * and sidesteps the origin question entirely. Next's middleware runtime parses
   * the header as a URL and threw ERR_INVALID_URL, so every signed-out request
   * became a 500. The unit test missed it: calling `middleware()` directly and
   * reading the header never reaches that parse.
   *
   * Attempt two built an absolute URL from the `Host` header, because
   * `req.url` and `req.nextUrl.origin` both report `localhost` for a request
   * that was actually made to 127.0.0.1, and cookies are scoped by host. That
   * computed the right URL and set it — and Next REWROTE IT afterwards. What it
   * does, measured by sending different Host headers to a running build:
   *
   *     Host: example.test:3400   ->  http://example.test:3400/login
   *     Host: 127.0.0.1:3400      ->  http://localhost:3400/login
   *
   * So Next honours the Host header in general and special-cases the loopback
   * IP into `localhost`. In production that is simply correct. In development it
   * means a browser opened at 127.0.0.1 is moved to localhost the first time it
   * is redirected, and stays there — a different cookie host, but a CONSISTENT
   * one, so signing in works and nothing loops. Reading the header ourselves
   * bought nothing, so it is gone: code that looks like it controls something it
   * does not is worse than code that admits the framework owns it.
   *
   * The path is a constant, so nothing a caller sends can point this anywhere
   * but our own sign-in page.
   */
  return NextResponse.redirect(new URL("/login", req.url), 307);
}

export const config = {
  /*
   * Everything except Next's own assets and the pages that HAND OUT a cookie.
   * Gating any of the latter is a redirect loop by construction: the visitor is
   * sent to /login to obtain the very cookie /login would then demand.
   *
   * That is why signup is here too. It is the one page whose entire audience is
   * people who have no account yet, so it is the page most certain to be
   * visited without a cookie — and gating it would mean an invited person could
   * never reach the form that turns their invite into an account.
   */
  /*
   * EACH EXCLUSION IS ANCHORED TO A WHOLE PATH SEGMENT, and the anchors are the
   * load-bearing part. Security review caught the version without them: a bare
   * alternation inside this lookahead is a PREFIX match, so `/signup-secret`,
   * `/login-as` and `/api/session-refresh` would all have inherited the
   * unauthenticated status of the page whose name they happen to start with.
   * No such route exists today, which is exactly what made it dangerous — it
   * would have failed silently, with no build error and no test failure, on the
   * day somebody added `/signup-embed` in front of the only surface in the
   * product that mints identities.
   */
  matcher: [
    "/((?!_next/static(?:/|$)|_next/image(?:/|$)|favicon.ico$|login$|signup$|api/session(?:/|$)|api/signup$).*)",
  ],
};
