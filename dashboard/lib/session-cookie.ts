/**
 * The name of the cookie the Fuel API sets when someone signs in.
 *
 * ITS OWN MODULE, WITH NO IMPORTS, for one structural reason: `lib/fuel.ts` is
 * marked `server-only` and `middleware.ts` cannot import a `server-only`
 * module. Without this file the name would have to be written out a second
 * time in the middleware, and a cookie name that exists in two places is one
 * rename away from a gate that silently stops gating.
 *
 * It must equal `SESSION_COOKIE` in src/lib/auth.ts. The two live in different
 * processes and cannot import each other, so scripts/verify-api.ts asserts
 * they are the same string rather than trusting that they stay in step.
 */
export const SESSION_COOKIE = "fuel_session";
