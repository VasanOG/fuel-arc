/**
 * The machine's one public listener: a small reverse proxy in front of the
 * dashboard and the Try-it door. Holds no secret and no key.
 *
 *   /try/*, /health  ->  the Try-it door   127.0.0.1:3221
 *   everything else  ->  the dashboard     127.0.0.1:3100
 *
 * WHY IT EXISTS. Fly's proxy reaches a machine only on an address that
 * listens on all interfaces, and the dashboard binds 127.0.0.1 by literal
 * (dashboard/lib/edge.mjs: nothing in the environment may widen it). Fuel's
 * own API (3200), the shop (3210) and the approver (3230) are never routed to
 * from here, so they stay reachable only from inside the machine.
 *
 * WHAT IT CHANGES. Only `Location` on responses: the dashboard runs behind
 * this proxy on plain http at 127.0.0.1:3100, and Next can build redirects
 * from that address. A redirect pointing there is rewritten to the public
 * origin, so a judge is never sent to localhost or to http. Request headers
 * pass through as sent (including Host, which the dashboard's same-origin
 * checks compare against Origin, and Fly-Client-IP, which the door's
 * per-visitor limit reads).
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 3220);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? "https://fuel-arc-demo.fly.dev";
const DOOR = { host: "127.0.0.1", port: Number(process.env.DOOR_PORT ?? 3221) };
const DASHBOARD = { host: "127.0.0.1", port: 3100 };
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Loopback addresses, and the public host on plain http (the dashboard's edge
// stamps x-forwarded-proto: http, so Next can build http:// redirects for it).
const INTERNAL_ORIGINS = [/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?/i, new RegExp(`^http://${PUBLIC_HOST}(?::\\d+)?`, "i")];

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"];

const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  const target = path === "/health" || path.startsWith("/try/") ? DOOR : DASHBOARD;
  const headers = { ...req.headers };
  for (const h of HOP_BY_HOP) delete headers[h];

  const upstream = http.request({ ...target, method: req.method, path, headers }, (up) => {
    const out = { ...up.headers };
    for (const h of HOP_BY_HOP) delete out[h];
    if (typeof out.location === "string") {
      for (const re of INTERNAL_ORIGINS) out.location = out.location.replace(re, PUBLIC_ORIGIN);
    }
    res.writeHead(up.statusCode ?? 502, out);
    up.pipe(res);
  });
  upstream.setTimeout(120_000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "That part of the demo is not answering right now." }));
  });
  req.pipe(upstream);
});

server.on("upgrade", (_req, socket) => socket.destroy());
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[front] listening on 0.0.0.0:${PORT}: /try and /health -> door ${DOOR.port}, everything else -> dashboard ${DASHBOARD.port}`);
});
