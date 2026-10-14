/**
 * The operator's switches for the live demo. Run on the machine that hosts
 * it (on Fly: `fly ssh console`), never from the internet.
 *
 *   npx tsx demo/try-it/control.ts pause      the door answers "closed" to everyone; nothing reaches Fuel
 *   npx tsx demo/try-it/control.ts resume     reopens the door
 *   npx tsx demo/try-it/control.ts freeze     Fuel refuses the agent's every payment (423), door or not
 *   npx tsx demo/try-it/control.ts unfreeze
 *   npx tsx demo/try-it/control.ts status     the door's view: open or why not, today's total, recent attempts
 *   npx tsx demo/try-it/control.ts cap 1.50   set the demo agent's Fuel spend cap (USD); the $5 lifetime limit in code still applies
 *   npx tsx demo/try-it/control.ts agent      the demo agent as Fuel sees it: cap, spent, frozen or not
 *
 * `pause` needs no key: it creates the pause file the door checks before every
 * request. The rest need FUEL_API_KEY (the operator key) in the environment
 * and act on the demo agent only, by its literal id.
 */
import { closeSync, openSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAINNET_DEMO } from "../../src/payments/arc-chain.js";

const pauseFile = process.env.TRYIT_PAUSE_FILE ?? join(homedir(), ".fuel-arc", "tryit.paused");
const door = process.env.TRYIT_DOOR_URL ?? "http://127.0.0.1:3220";
const fuel = process.env.FUEL_API_URL ?? "http://127.0.0.1:3200";

async function operator(path: string, method = "POST", body: Record<string, unknown> = { reason: "demo: operator stop" }): Promise<void> {
  const key = process.env.FUEL_API_KEY;
  if (!key) throw new Error("FUEL_API_KEY is not set");
  const res = await fetch(`${fuel}/api/agents/${MAINNET_DEMO.agentId}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  console.log(`${method} ${path || "/"}: HTTP ${res.status}`);
  if (!res.ok) {
    console.log(JSON.stringify(json).slice(0, 300));
    process.exit(1);
  }
  const { name, spendCap, spent, frozenAt } = json;
  console.log(JSON.stringify({ name, spendCap, spent, frozenAt }));
}

switch (process.argv[2]) {
  case "pause": {
    closeSync(openSync(pauseFile, "a", 0o600));
    // Say so only once the door itself reports it: a pause file the door is not watching pauses nothing.
    const s = (await fetch(`${door}/try/status`).then((r) => r.json()).catch(() => null)) as { closedReason?: string } | null;
    if (s?.closedReason === "paused") console.log(`paused: ${pauseFile} exists and the door reports it closed`);
    else {
      console.error(`${pauseFile} was created but the door does not report "paused" (it says ${JSON.stringify(s?.closedReason ?? null)}); is TRYIT_PAUSE_FILE the same for both? Use "fly machine stop" to be sure.`);
      process.exit(1);
    }
    break;
  }
  case "resume":
    rmSync(pauseFile, { force: true });
    console.log("resumed: the door is open (if its other stops allow)");
    break;
  case "freeze":
    await operator("/freeze");
    break;
  case "unfreeze":
    await operator("/unfreeze");
    break;
  case "cap": {
    const usd = process.argv[3];
    if (!usd || !/^\d+(\.\d{1,2})?$/.test(usd)) throw new Error("cap takes a dollar amount like 1.50");
    await operator("", "PATCH", { spendCapUsd: usd });
    break;
  }
  case "agent":
    await operator("", "GET", undefined as never);
    break;
  case "status": {
    const res = await fetch(`${door}/try/status`);
    console.log(JSON.stringify(await res.json(), null, 2));
    break;
  }
  default:
    console.error("usage: control.ts <pause|resume|freeze|unfreeze|status>");
    process.exit(2);
}
