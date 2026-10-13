/**
 * The last thing an unexpected error meets before it could reach a caller.
 *
 * WITHOUT THIS, EXPRESS ANSWERS WITH THE ERROR ITSELF. Its default handler
 * writes the message and the stack trace into the response unless NODE_ENV is
 * "production": measured here, a route that threw returned an HTML page with
 * the SQLite message, the stack, and absolute paths on the machine. The first
 * route found reaching it was signup, founding a company under a name already
 * in use, which turned a database constraint into a cross-company oracle
 * (ADR 0018). The fix there removes the constraint; this makes sure the NEXT
 * unexpected error anywhere says nothing either.
 *
 * WHAT IT SAYS: 500 `{ "error": "internal error" }`, and nothing else. What
 * went wrong is logged here, on the server, as `name: message`: never the raw
 * error object, whose properties can carry a request, a credential or a token
 * (the rule src/lib/env.ts states for Intuit's errors).
 *
 * WHAT IT KEEPS: a request the body parser could not read is the CALLER's
 * mistake, so it stays a 4xx (malformed JSON is 400), answered generically
 * rather than with the parser's own words. If a response is already under way,
 * Express's default handler is the only thing that can end it, so it gets it.
 *
 * ONLY THE PARSER'S OWN ERRORS KEEP THEIR STATUS, recognised by the `type` the
 * parser stamps on them. Any other error that happens to carry a numeric
 * `status` (QboApiError does, and is caught before it gets here) is still an
 * unexpected error: relabelling it "malformed request" with its own status
 * would hide a server fault as the caller's, and let a status chosen deep in
 * some library reach the response. So it is a 500 like everything else.
 *
 * Mounted last, after every route, in src/server.ts. verify-api mounts it the
 * same way on its own app and asserts server.ts does.
 */
import type { NextFunction, Request, Response } from "express";

export function unhandledErrors(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = statusOf(error);
  if (status !== null && status >= 400 && status < 500) {
    res.status(status).json({ error: "malformed request" });
    return;
  }
  const name = error instanceof Error ? error.name : "non-error";
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[api] unhandled error on ${req.method} ${req.path}: ${name}: ${message}`);
  res.status(500).json({ error: "internal error" });
}

/**
 * The `type` values the JSON body parser (body-parser and raw-body) gives the
 * errors that are the caller's fault. Its other types are server-side (500).
 */
const PARSER_ERROR_TYPES = new Set([
  "charset.unsupported",
  "encoding.unsupported",
  "entity.parse.failed",
  "entity.too.large",
  "entity.verify.failed",
  "request.aborted",
  "request.size.invalid",
]);

/** The status a body-parser error carries (`status` or `statusCode`); null for any other error. */
function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const { type, status, statusCode } = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof type !== "string" || !PARSER_ERROR_TYPES.has(type)) return null;
  const candidate = status ?? statusCode;
  return typeof candidate === "number" ? candidate : null;
}
