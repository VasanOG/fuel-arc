/**
 * The dashboard's server: Next, behind an edge that records who is calling
 * (ADR 0020).
 *
 *   node server.mjs dev     (npm run dev)
 *   node server.mjs start   (npm start, after npm run build)
 *
 * This replaces `next dev` and `next start`. Running either of those directly
 * still serves pages, but sign-in and signup refuse ("Fuel could not be
 * reached"), because no edge stamped the request. See lib/client-address.ts
 * for why that refusal is deliberate.
 *
 * `dev` IS AN ARGUMENT, NEVER INFERRED FROM NODE_ENV. A stray NODE_ENV in a
 * shell would otherwise decide whether production serves the development
 * build. Here it is set FROM the argument, before Next is loaded, because Next
 * reads it at import time.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { EDGE_HOST, EDGE_PORT, EDGE_PROOF_ENV, stampEdgeHeaders } from "./lib/edge.mjs";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("usage: node server.mjs dev|start");
  process.exit(1);
}
const dev = mode === "dev";
process.env.NODE_ENV = dev ? "development" : "production";

/*
 * THE EDGE PROOF: 32 random bytes, made fresh every time this process starts,
 * and never written anywhere but this process's environment. Route handlers
 * read it from `process.env` at request time. Next inlines only `NEXT_PUBLIC_`
 * variables and the `env` key of next.config into a build, so this is never
 * baked into a bundle and never reaches a browser. It is set BEFORE Next loads
 * `.env.local`, and Next never overrides a variable that is already set, so a
 * value in a file cannot replace it either.
 */
const proof = randomBytes(32).toString("hex");
process.env[EDGE_PROOF_ENV] = proof;

const { default: next } = await import("next");

const server = createServer();
/*
 * `httpServer` is passed so Next attaches its own `upgrade` listener to THIS
 * server (it does so on the first request: `setupWebSocketHandler` in
 * node_modules/next/dist/server/next.js). Adding a second listener here would
 * handle every upgrade twice. Upgrades are the dev server's hot-reload socket
 * and never reach a route handler, so leaving them unstamped protects nothing
 * less.
 */
const app = next({ dev, dir: import.meta.dirname, hostname: EDGE_HOST, port: EDGE_PORT, httpServer: server });
const handle = app.getRequestHandler();
await app.prepare();

server.on("request", (req, res) => {
  stampEdgeHeaders(req.headers, req.socket.remoteAddress, proof);
  handle(req, res).catch((err) => {
    console.error("dashboard: request failed", err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

server.listen(EDGE_PORT, EDGE_HOST, () => {
  console.log(`Fuel dashboard on http://${EDGE_HOST}:${EDGE_PORT} (${mode}), behind its edge`);
});
