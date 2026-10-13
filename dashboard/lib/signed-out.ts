/** Where the sign-in page lives, and the notice it should show. */
const SIGN_IN = "/login?e=expired";

/**
 * Recognises "your session ended" in a response to a client-side write, and
 * sends the browser to sign in again.
 *
 * WHY THIS IS NEEDED AT ALL. The dashboard's write routes call Fuel through
 * `fuelFetch`, which answers a 401 with `redirect("/login")`. In a page render
 * that is invisible and correct. In a route handler it becomes a 3xx response
 * to a `fetch()` — and with the default `redirect: "follow"` the browser would
 * quietly chase it, fetch the sign-in page, hand back HTML, and the caller's
 * `res.json()` would throw a JSON parse error. The operator would see
 * "Unexpected token '<'" where the honest answer is "you have been signed out".
 *
 * So every client-side write in the dashboard uses `redirect: "manual"`, which
 * makes a redirect visible as an opaque response instead of being followed,
 * and calls this. An opaque redirect exposes no status and no headers by
 * design, so it is identified by `type` and by its zeroed status — there is
 * nothing else to read, and nothing else needs reading: the only redirect any
 * of these routes can produce is this one.
 *
 * Returns true when it has taken over; the caller should stop.
 */
export function sendToSignIn(res: Response): boolean {
  const redirected = res.type === "opaqueredirect" || res.status === 0;
  if (!redirected) return false;
  window.location.href = SIGN_IN;
  return true;
}
