/**
 * The Try-it door: the one public program that can make the Arc demo agent
 * pay. Built as a factory so the lock suite drives it offline (AL-8);
 * ./door-server.ts wires it to the real key, port and chain.
 *
 * A judge presses Buy on the proof page. The page calls this door; the door
 * asks Fuel's API, with the AGENT key, to pay for one of three fixed shop
 * items; Fuel's controls decide. The door then says, in plain words, what
 * Fuel decided, with the explorer link when money moved.
 *
 * WHAT A VISITOR CONTROLS: which of the three items. Nothing else. The URL
 * Fuel is asked to pay is built from the shop's configured origin and the
 * item's path from the table in ./policy.ts, never from request text. The
 * agent id is the literal in arc-chain.ts. A "complete" names an approval
 * request id, and only one this door itself received from Fuel is accepted.
 *
 * WHAT THIS PROCESS HOLDS: the agent key (pays; cannot approve, cannot change
 * a cap, cannot freeze). Approving is asked of ./approver.ts, on loopback.
 *
 * WHEN IT SAYS NO BEFORE ASKING FUEL: see ./policy.ts (pause file, daily cap,
 * per-visitor limit, low or unknown wallet balance). Every attempt that does
 * reach Fuel is appended to a log file first, so the daily cap survives a
 * restart and the proof page can show attempts the ledger never sees.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import express, { type Request } from "express";
import { Buckets } from "../../src/lib/buckets.js";
import { MAINNET_DEMO } from "../../src/payments/arc-chain.js";
import { type Balances, DailyMeter, doorVerdict, itemNamed, TRY_DAILY_CAP_BASE_UNITS, TRY_ITEMS, TRY_VISITOR_LIMIT, TRY_VISITOR_WINDOW_MS, type TryItem, utcDay } from "./policy.js";

export interface DoorOptions {
  fuelUrl: string;
  agentKey: string;
  shopUrl: string;
  approverUrl: string;
  /** The one web origin whose pages may call this door from a browser. */
  allowedOrigin: string;
  pauseFile: string;
  /** Append-only JSONL of every attempt forwarded to Fuel. */
  logFile: string;
  balances: () => Balances | null;
  clientAddress: (req: Request) => string;
  now?: () => number;
  log?: (line: string) => void;
}

/** What the page shows for one attempt. */
export interface Attempt {
  at: string;
  kind: "buy" | "complete";
  item: TryItem;
  amountUsd: string;
  outcome: "paid" | "held" | "refused-rate-limit" | "refused-cap" | "refused-frozen" | "refused-approval" | "failed";
  message: string;
  transaction: string | null;
  explorerUrl: string | null;
  approvalRequestId: string | null;
}

const usd = (b: bigint) => `$${(Number(b) / 1e6).toFixed(3)}`;

export function createDoorApp(options: DoorOptions): express.Express {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line) => console.log(line));
  const meter = new DailyMeter(now());
  const visitors = new Buckets(TRY_VISITOR_LIMIT, TRY_VISITOR_WINDOW_MS);
  /** Approval ids Fuel handed THIS door, each with its item. */
  const held = new Map<string, TryItem>();
  const recent: Attempt[] = [];

  // Replay today's log so a restart cannot reset the daily cap or forget a held id.
  if (existsSync(options.logFile)) {
    for (const line of readFileSync(options.logFile, "utf8").split("\n").filter(Boolean)) {
      let entry: Attempt & { day?: string };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (utcDay(Date.parse(entry.at)) === utcDay(now())) meter.count(TRY_ITEMS[entry.item].amountBaseUnits, now());
      if (entry.outcome === "held" && entry.approvalRequestId) held.set(entry.approvalRequestId, entry.item);
      if (entry.outcome === "paid" && entry.approvalRequestId) held.delete(entry.approvalRequestId);
    }
  }

  function record(attempt: Attempt): void {
    appendFileSync(options.logFile, `${JSON.stringify(attempt)}\n`, { mode: 0o600 });
    recent.unshift(attempt);
    if (recent.length > 20) recent.pop();
  }

  async function fuelPay(item: TryItem, approvalRequestId?: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${options.fuelUrl}/api/agents/${MAINNET_DEMO.agentId}/pay`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.agentKey}`, "content-type": "application/json" },
      body: JSON.stringify({ url: `${options.shopUrl}${TRY_ITEMS[item].path}`, ...(approvalRequestId ? { approvalRequestId } : {}) }),
      signal: AbortSignal.timeout(90_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  /** Fuel's answer, in the page's words. */
  function describe(kind: Attempt["kind"], item: TryItem, r: { status: number; json: Record<string, unknown> }): Attempt {
    const base = { at: new Date(now()).toISOString(), kind, item, amountUsd: usd(TRY_ITEMS[item].amountBaseUnits), transaction: null, explorerUrl: null, approvalRequestId: null };
    const j = r.json;
    switch (r.status) {
      case 200: {
        const tx = typeof j.transaction === "string" ? j.transaction : null;
        return { ...base, outcome: "paid", message: `Paid ${String(j.paid ?? base.amountUsd)} on ${MAINNET_DEMO.chain.label}.`, transaction: tx, explorerUrl: tx ? `${MAINNET_DEMO.chain.explorerUrl}/tx/${tx}` : null };
      }
      case 202:
        return { ...base, outcome: "held", message: String(j.message ?? "Held for a person to approve."), approvalRequestId: typeof j.approvalRequestId === "string" ? j.approvalRequestId : null };
      case 402:
        return j.scope === "approval"
          ? { ...base, outcome: "refused-approval", message: String(j.error ?? "The approval was not valid for this payment.") }
          : { ...base, outcome: "refused-cap", message: `${String(j.error ?? "Refused by a spend cap.")} (${String(j.scope ?? "cap")} cap ${String(j.spendCap ?? "?")}, spent ${String(j.spent ?? "?")})` };
      case 423:
        return { ...base, outcome: "refused-frozen", message: "Refused: an operator has stopped this agent." };
      case 429:
        return { ...base, outcome: "refused-rate-limit", message: `Refused: spending too fast (${String(j.spentInWindow ?? "?")} of ${String(j.limit ?? "?")} in the last ${String(j.windowSeconds ?? "60")} s). Try again in ${String(j.retryAfterSeconds ?? "60")} s.` };
      default:
        return { ...base, outcome: "failed", message: "Fuel could not complete this payment. If it was signed, the ledger holds it until an operator reconciles it." };
    }
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(express.json({ limit: "1kb" }));

  // CORS: exactly one origin, no credentials, and only the three routes below.
  app.use("/try", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === options.allowedOrigin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "content-type");
      res.set("Access-Control-Max-Age", "600");
    } else if (origin !== undefined) {
      return res.status(403).json({ error: "this origin may not use the demo" });
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/try/status", (_req, res) => {
    const verdict = doorVerdict({ pauseFile: options.pauseFile, forwardedTodayBaseUnits: meter.forwardedToday(now()), nextAmountBaseUnits: 0n, balances: options.balances(), now: now() });
    res.json({
      open: verdict.open,
      closedReason: verdict.open ? null : verdict.reason,
      closedDetail: verdict.open ? null : verdict.detail,
      network: MAINNET_DEMO.chain.label,
      agent: MAINNET_DEMO.address,
      shop: MAINNET_DEMO.payee,
      items: Object.entries(TRY_ITEMS).map(([name, i]) => ({ name, amountUsd: usd(i.amountBaseUnits), label: i.label })),
      forwardedTodayUsd: usd(meter.forwardedToday(now())),
      dailyCapUsd: usd(TRY_DAILY_CAP_BASE_UNITS),
      recent,
    });
  });

  /** The gate every forwarded request passes: visitor limit, then the door's verdict, then the meter. */
  function admit(req: Request, amount: bigint): { ok: true } | { ok: false; status: number; body: Record<string, unknown> } {
    if (visitors.exceeded(options.clientAddress(req), now())) {
      return { ok: false, status: 429, body: { error: `You have made ${TRY_VISITOR_LIMIT} attempts in ${TRY_VISITOR_WINDOW_MS / 60_000} minutes; please wait.`, closedReason: "visitor-limit" } };
    }
    const verdict = doorVerdict({ pauseFile: options.pauseFile, forwardedTodayBaseUnits: meter.forwardedToday(now()), nextAmountBaseUnits: amount, balances: options.balances(), now: now() });
    if (!verdict.open) return { ok: false, status: 503, body: { error: verdict.detail, closedReason: verdict.reason } };
    meter.count(amount, now());
    return { ok: true };
  }

  app.post("/try/buy", async (req, res) => {
    const item = itemNamed(req.body?.item);
    if (!item) return res.status(400).json({ error: "item must be basic, unusual or ceiling" });
    const gate = admit(req, TRY_ITEMS[item].amountBaseUnits);
    if (!gate.ok) return res.status(gate.status).json(gate.body);

    let attempt: Attempt;
    try {
      attempt = describe("buy", item, await fuelPay(item));
    } catch (error) {
      log(`[try-it] buy ${item}: ${(error as Error).message}`);
      attempt = describe("buy", item, { status: 0, json: {} });
    }
    if (attempt.outcome === "held" && attempt.approvalRequestId) held.set(attempt.approvalRequestId, item);
    record(attempt);
    res.status(attempt.outcome === "failed" ? 502 : 200).json(attempt);
  });

  app.post("/try/complete", async (req, res) => {
    const id = req.body?.approvalRequestId;
    const item = typeof id === "string" ? held.get(id) : undefined;
    if (!item) return res.status(404).json({ error: "that is not a payment this demo is holding" });
    const gate = admit(req, TRY_ITEMS[item].amountBaseUnits);
    if (!gate.ok) return res.status(gate.status).json(gate.body);

    let approved: Response;
    try {
      approved = await fetch(`${options.approverUrl}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalRequestId: id }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return res.status(503).json({ error: "The demo's approver could not be reached." });
    }
    if (!approved.ok) {
      const why = ((await approved.json().catch(() => ({}))) as { error?: string }).error ?? "not approved";
      return res.status(approved.status === 409 ? 409 : 503).json({ error: `The demo's approver refused: ${why}.` });
    }

    let attempt: Attempt;
    try {
      attempt = describe("complete", item, await fuelPay(item, id as string));
    } catch (error) {
      log(`[try-it] complete ${String(id)}: ${(error as Error).message}`);
      attempt = describe("complete", item, { status: 0, json: {} });
    }
    attempt.approvalRequestId = id as string;
    if (attempt.outcome === "paid" || attempt.outcome === "refused-approval") held.delete(id as string);
    record(attempt);
    res.status(attempt.outcome === "failed" ? 502 : 200).json(attempt);
  });

  app.get("/health", (_req, res) => res.json({ ok: true, commit: process.env.FUEL_COMMIT ?? null }));
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  return app;
}
