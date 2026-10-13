/**
 * The dashboard's origin, for links that leave Fuel (alerts, ADR 0021).
 *
 * A DELIBERATE DUPLICATE of `dashboardUrl()` in src/quickbooks/callback.ts,
 * not an import of it. Importing would pull a QuickBooks module, which is
 * money-adjacent code, into alerting for the sake of ten lines; editing it to
 * move the function would touch that module for an alert. verify-api asserts
 * the two return the same origin for the same environment (AL-A9), so the
 * duplicate cannot drift silently.
 *
 * FIXED CONFIGURATION, never anything from a request. Only the origin is used,
 * so a path or query in the setting is discarded and a link cannot be pointed
 * anywhere but the dashboard's own pages.
 */
export function dashboardOrigin(): string {
  const configured = process.env.FUEL_DASHBOARD_URL ?? "http://localhost:3100";
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad scheme");
    return url.origin;
  } catch {
    return "http://localhost:3100";
  }
}
