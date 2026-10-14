/**
 * The demo's internal approver: the only holder of the operator key, and it
 * does exactly one thing with it. Built as a factory so the lock suite can run
 * it offline (AL-8); ./approver-server.ts wires it to the real key and port.
 *
 * WHY A SEPARATE PROCESS. The Try-it door faces the internet and holds the
 * AGENT key, which can only pay. Approving is the other half of Fuel's
 * two-party control, and the door must not hold both halves: a bug in the
 * public process would then be a bug with the whole control. So the operator
 * key lives here, on loopback only, reachable by the door and nothing else,
 * and this process can approve but cannot pay.
 *
 * WHAT IT APPROVES. A pending approval request that belongs to the Arc demo
 * agent, for one of the shop's three prices. Nothing else: not another
 * agent's, not another amount, and never a deny, a cap, a freeze or any other
 * operator action. The demo company has no users, which is the one condition
 * under which Fuel lets a key decide (src/db/approvals.ts); if a person is
 * ever added, Fuel refuses this approver with 403 and the door says so.
 *
 * Stage 1 only. With the dashboard public (stage 2), approvals move to a
 * signed-in person and this process is retired.
 */
import express from "express";
import { MAINNET_DEMO } from "../../src/payments/arc-chain.js";
import { TRY_ITEMS } from "./policy.js";

const PRICES = new Set(Object.values(TRY_ITEMS).map((i) => i.amountBaseUnits.toString()));

export function createApproverApp(options: { fuelUrl: string; operatorKey: string; log?: (line: string) => void }): express.Express {
  const { fuelUrl, operatorKey } = options;
  const log = options.log ?? ((line) => console.log(line));

  async function fuel(method: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${fuelUrl}/api${path}`, { method, headers: { authorization: `Bearer ${operatorKey}` }, signal: AbortSignal.timeout(10_000) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1kb" }));

  app.post("/approve", async (req, res) => {
    const id = req.body?.approvalRequestId;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: "approvalRequestId must be an id" });

    let found;
    try {
      found = await fuel("GET", `/approvals/${id}`);
    } catch {
      return res.status(502).json({ error: "Fuel could not be reached" });
    }
    if (found.status !== 200) return res.status(404).json({ error: "no such approval request" });
    const a = found.json;
    if (a.agentId !== MAINNET_DEMO.agentId) return res.status(403).json({ error: "not the demo agent's request" });
    if (!PRICES.has(String(a.amountBaseUnits))) return res.status(403).json({ error: "not one of the shop's prices" });
    if (a.status !== "pending") return res.status(409).json({ error: `request is ${String(a.status)}` });

    let decided;
    try {
      decided = await fuel("POST", `/approvals/${id}/approve`);
    } catch {
      return res.status(502).json({ error: "Fuel could not be reached" });
    }
    if (decided.status !== 200) {
      log(`[try-it approver] approve ${id}: HTTP ${decided.status} ${JSON.stringify(decided.json).slice(0, 200)}`);
      // 403 from Fuel means the company now has a person who should decide instead: say so, as "unavailable".
      return res.status(decided.status === 403 ? 503 : 502).json({ error: "Fuel did not accept the approval" });
    }
    log(`[try-it approver] approved ${id} (${String(a.amount)})`);
    res.json({ approved: true, approvalRequestId: id });
  });

  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  return app;
}
