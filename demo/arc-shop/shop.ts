/**
 * The founder's demo shop on Arc: three priced items, sold through x402.
 *
 * OPERATED BY THE FOUNDER. Its wallet is the founder's, so every payment Fuel's
 * demo agent makes here moves the founder's money from one of their wallets to
 * another. The prices are chosen so each one shows a Fuel control at work:
 *
 *   /item/basic    $0.001  an ordinary payment
 *   /item/unusual  $0.005  unusual after five ordinary ones -> held for approval
 *   /item/ceiling  $0.01   Fuel's per-payment ceiling; two in a minute hit the
 *                          $0.02-a-minute rate limit
 *
 * Built as a function so the lock suite can run it offline with a fake
 * settler; ./server.ts wires the real one.
 *
 * Two lessons from Fuel's own paid routes are built in from the start:
 *   - HEAD is refused (7A-9): a HEAD would run the handler and drop the body.
 *   - Conditional and range request headers are removed before payment
 *     (the 7A-10 finding): Express would otherwise answer a paid request that
 *     carries If-None-Match with an empty 304 AFTER the payment settled.
 */
import express, { type Express } from "express";
import type { FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExpressAdapter, paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/express";
import type { ArcChain } from "../../src/payments/arc-chain.js";
import type { ShopPrice } from "./settler.js";

export const SHOP_PRICES = [
  { path: "/item/basic", amount: "1000" },
  { path: "/item/unusual", amount: "5000" },
  { path: "/item/ceiling", amount: "10000" },
] as const satisfies readonly ShopPrice[];

/** Request headers that can turn a paid 200 into an empty 304 or a partial 206. */
export const CONDITIONAL_HEADERS = ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range", "range"];

/** Seconds a signed payment stays spendable. Fuel requires at least 120. */
export const SHOP_MAX_TIMEOUT_SECONDS = 300;

export function createShopApp(options: { chain: ArcChain; payTo: `0x${string}`; facilitator: FacilitatorClient }): {
  app: Express;
  initialize: () => Promise<void>;
} {
  const { chain, payTo, facilitator } = options;
  const network = chain.network as `${string}:${string}`;

  const routes = Object.fromEntries(
    SHOP_PRICES.map((p) => [
      `GET ${p.path}`,
      {
        accepts: {
          scheme: "exact",
          network,
          payTo,
          maxTimeoutSeconds: SHOP_MAX_TIMEOUT_SECONDS,
          price: { amount: p.amount, asset: chain.asset, extra: { name: chain.domainName, version: chain.domainVersion } },
        },
        description: `Fuel founder demo shop: ${p.path.slice("/item/".length)}`,
      },
    ]),
  );

  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
  const http = new x402HTTPResourceServer(resourceServer, routes);
  const isPaid = (req: express.Request) =>
    http.requiresPayment({ adapter: new ExpressAdapter(req), path: req.path, method: "GET" });

  const app = express();
  app.disable("x-powered-by");

  app.get("/", (_req, res) => {
    res.json({
      shop: "Fuel founder demo shop",
      operatedBy: "the founder of Fuel; payments here move between the founder's own wallets",
      network: chain.label,
      items: SHOP_PRICES.map((p) => ({ path: p.path, priceUsd: (Number(p.amount) / 1e6).toFixed(3) })),
    });
  });

  // HEAD to a paid item: refused before anything else, as Fuel's own paid routes do.
  app.use((req, res, next) => {
    if (req.method.toUpperCase() !== "HEAD" || !isPaid(req)) return next();
    res.set("Allow", "GET");
    res.status(405).json({ error: "GET only" });
  });

  // A paid answer is never conditional or partial: the payer gets the whole body.
  app.use((req, _res, next) => {
    if (isPaid(req)) for (const name of CONDITIONAL_HEADERS) delete req.headers[name];
    next();
  });

  app.use(paymentMiddlewareFromHTTPServer(http, undefined, undefined, false));

  for (const p of SHOP_PRICES) {
    app.get(p.path, (_req, res) => {
      res.set("Cache-Control", "private, no-store");
      res.json({ item: p.path.slice("/item/".length), paidUsd: (Number(p.amount) / 1e6).toFixed(3), servedAt: new Date().toISOString() });
    });
  }

  return { app, initialize: () => http.initialize() };
}
