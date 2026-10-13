/**
 * Shared helpers for the Phase 0 scripts and server.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/**
 * Turns an API error into one readable line.
 *
 * Reads ONLY the response body, which is server-originated. Never log the
 * error object itself: its `.request` holds the outgoing headers, which
 * include API keys and signed auth tokens. The raw object is also thousands
 * of lines of socket state.
 */
export function describe(error: unknown): string {
  const err = error as {
    response?: { statusCode?: number; status?: number; data?: unknown };
    code?: string;
    message?: string;
  };
  if (err?.response) {
    const status = err.response.statusCode ?? err.response.status;
    return `HTTP ${status} — ${JSON.stringify(err.response.data)}`;
  }
  return err?.code ? `${err.code}: ${err.message}` : (err?.message ?? String(error));
}
