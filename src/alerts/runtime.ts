/**
 * The one dispatcher this process runs, shared by the sweep loop (server.ts)
 * and the owner routes (api.ts), so the per-company and global slots are one
 * set of slots, not two.
 *
 * Bound to `strictWebhookSend` and nothing else: public addresses only, no
 * redirects, webhook rules re-checked on every send. There is no parameter
 * here through which a looser sender could be wired in, and verify-api pins
 * that (AL-S1).
 */
import { createDispatcher, strictWebhookSend } from "./dispatch.js";

export const alertDispatcher = createDispatcher({ send: strictWebhookSend, now: () => new Date() });
