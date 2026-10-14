/**
 * Runs the internal approver on loopback, with the operator key from its
 * environment and nothing else.
 *
 *   FUEL_API_KEY=... PORT=3230 npx tsx demo/try-it/approver-server.ts
 *
 * The bind address is not configurable: this process holds the operator key
 * and must never be reachable from outside the machine.
 */
import { createApproverApp } from "./approver.js";

const operatorKey = process.env.FUEL_API_KEY;
if (!operatorKey) {
  console.error("[try-it approver] not starting: FUEL_API_KEY is not set");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3230);
createApproverApp({ fuelUrl: process.env.FUEL_API_URL ?? "http://127.0.0.1:3200", operatorKey }).listen(port, "127.0.0.1", () => {
  console.log(`[try-it approver] listening on 127.0.0.1:${port}; approves only the demo agent's shop payments`);
});
