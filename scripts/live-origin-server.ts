/**
 * A customer's origin, for the one walkthrough that needs a real one.
 *
 * THE ONLY THING IN THIS PROJECT EVER REACHABLE FROM THE PUBLIC INTERNET, and
 * only for the few minutes `walk-revenue.ts` takes. That is why it serves
 * exactly two paths and answers everything else 404 with no body: no static
 * directory, no body parser, and an error handler that is explicitly silent
 * rather than absent (see the NODE_ENV note below — absent was the bug). The
 * surface is the two things src/gateway/probes.ts actually looks for, and
 * nothing beside them.
 *
 * It binds 127.0.0.1, never 0.0.0.0. Reaching it from outside requires a
 * tunnel the operator starts and stops deliberately; the server itself is not
 * the thing that decides it is public.
 *
 * WHAT IT IS PRETENDING TO BE. A customer who has asked Fuel to put a paywall
 * in front of an API they already run. Fuel cannot enforce anything on someone
 * else's server (probes.ts says so at length), so the customer's side has two
 * obligations, and this file is the smallest honest implementation of both:
 *
 *   1. Prove the origin is theirs, by serving the nonce Fuel issued at
 *      /.well-known/fuel-origin-verification.
 *   2. Refuse traffic that did not come through Fuel, by verifying the
 *      X-Fuel-Signature header — including refusing a signature that is
 *      present but wrong, which is the half a careless implementation misses
 *      and which probes.ts probes for separately.
 *
 * `verifySignature` is IMPORTED from src/gateway/signing.ts rather than
 * reimplemented here. That file ships it precisely so a customer's reference
 * implementation is the code Fuel's own tests exercise; rewriting HMAC
 * verification in a walkthrough script would be proving that two
 * implementations agree, which is not the thing under test.
 *
 * Run:
 *   FUEL_ORIGIN_NONCE=<the ownership nonce walk-revenue printed> \
 *   FUEL_ORIGIN_SECRET=<the forward secret walk-revenue printed> \
 *   npx tsx scripts/live-origin-server.ts
 *
 * Then expose port 8899 with a tunnel, and STOP THE TUNNEL as soon as the
 * walkthrough's post step reports its QuickBooks id.
 */
import express from "express";
import { SIG_HEADER, TIMESTAMP_HEADER, NONCE_HEADER, verifySignature } from "../src/gateway/signing.js";
import { requireEnv } from "../src/lib/env.js";

/*
 * SET BEFORE express() IS CALLED, AND NOT LEFT TO THE OPERATOR'S SHELL.
 *
 * Express's default error handler is `finalhandler`, which puts `err.stack`
 * into the RESPONSE BODY whenever `process.env.NODE_ENV !== "production"`
 * (finalhandler/index.js:73 reads the env, :160 writes the stack). The default
 * when the variable is unset is "development". So any handler that throws on
 * this server — the one thing in this project ever exposed to the public
 * internet — would answer an anonymous caller with local file paths, package
 * versions and internals.
 *
 * An earlier version of this file's header comment claimed that could not
 * happen because "no error handler that echoes a stack" was registered. That
 * had it exactly backwards: registering none is what selects the one that does.
 * Found in review. The instinct to fix it by documenting `NODE_ENV=production`
 * in the run instructions was the wrong one — an instruction is something an
 * operator can forget at 11pm with a tunnel already open. Setting it here, plus
 * the explicit handler below, makes the claim true whatever the shell says.
 */
process.env.NODE_ENV = "production";

const PORT = Number(process.env.FUEL_ORIGIN_PORT ?? 8899);

/** What Fuel issued at registration. Serving it proves this origin is ours. */
const OWNERSHIP_NONCE = requireEnv("FUEL_ORIGIN_NONCE");

/** The per-endpoint forward secret, shown once by the registration route. */
const FORWARD_SECRET = requireEnv("FUEL_ORIGIN_SECRET");

/** The paid resource's path. Must match what the endpoint was registered with. */
const RESOURCE_PATH = "/revenue-demo";

const app = express();

// No body parser, no logger, no static middleware. Nothing is mounted that the
// two routes below do not need.
app.disable("x-powered-by");

app.get("/.well-known/fuel-origin-verification", (_req, res) => {
  res.type("text/plain").send(OWNERSHIP_NONCE);
});

app.get(RESOURCE_PATH, (req, res) => {
  const valid = verifySignature({
    secret: FORWARD_SECRET,
    method: "GET",
    path: RESOURCE_PATH,
    headers: {
      [SIG_HEADER]: req.header(SIG_HEADER) ?? undefined,
      [TIMESTAMP_HEADER]: req.header(TIMESTAMP_HEADER) ?? undefined,
      [NONCE_HEADER]: req.header(NONCE_HEADER) ?? undefined,
    },
  });

  // 401 covers both probe variants: no signature at all, and a well-formed
  // signature computed with the wrong secret. An origin that distinguished
  // them would be telling an attacker which half it checks.
  if (!valid) {
    console.log(`  refused an unsigned or badly-signed request to ${RESOURCE_PATH}`);
    return res.status(401).json({ error: "this API is served through Fuel" });
  }

  console.log(`  served a Fuel-signed request to ${RESOURCE_PATH}`);
  res.json({
    resource: "revenue-demo",
    fact: "This body was produced by a customer origin and paid for over x402.",
    servedAt: new Date().toISOString(),
  });
});

// Everything else. No body, nothing about what does exist here.
app.use((_req, res) => res.status(404).end());

/*
 * The belt to NODE_ENV's braces. Four arguments, because that arity is what
 * makes Express treat this as an error handler rather than ordinary middleware
 * — drop `_next` and it silently stops being one.
 *
 * The stack goes to the operator's terminal, where it is useful. The caller
 * gets a bare 500, the same "say nothing" policy as the 404 above.
 */
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[origin] handler threw:", error);
  res.status(500).end();
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Toy origin on http://127.0.0.1:${PORT}`);
  console.log(`  GET /.well-known/fuel-origin-verification  -> the ownership nonce`);
  console.log(`  GET ${RESOURCE_PATH}                          -> paid resource, signature required`);
  console.log(`  everything else                            -> 404`);
  console.log();
  console.log("Expose this port with a tunnel now, and take the tunnel down as soon");
  console.log("as the walkthrough reports its QuickBooks id.");
});
