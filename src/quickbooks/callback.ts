import type { RequestHandler } from "express";
import {
  RealmAlreadyConnectedError,
  UnresolvedPostingsError,
  redeemOAuthState,
  saveConnection,
} from "../db/qbo.js";
import { sessionFromRequest } from "../lib/auth.js";
import { grantReachesRealm } from "./client.js";
import { exchangeCode, grantedRealm } from "./oauth.js";

/**
 * The OAuth callback Intuit redirects the operator's browser to.
 *
 * WHY THIS IS ITS OWN MODULE. It lived inline in src/server.ts, which calls
 * listen() at import time — so importing it to test it starts a server on a
 * real port, and no verification suite could drive this route at all. It is
 * the one route in the system with NO AUTHENTICATION, which makes it the one
 * that least deserves to be untested.
 *
 * Mounted outside the /api router deliberately: a browser arriving from Intuit
 * carries no bearer token and so cannot pass `authenticate`. Since 7A-3 item 4
 * it does check who is calling, though not through that middleware: the
 * session cookie the browser carries must belong to the person who started the
 * link (see below, and ADR 0017).
 */

/**
 * Where the operator is sent afterwards.
 *
 * FIXED CONFIGURATION, never anything from the request. Echoing a
 * caller-supplied return URL here would be an open redirect on an
 * unauthenticated route.
 */
export function dashboardUrl(): string {
  const configured = process.env.FUEL_DASHBOARD_URL ?? "http://localhost:3100";
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad scheme");
    return url.origin;
  } catch {
    console.warn(`[quickbooks] FUEL_DASHBOARD_URL is not a valid URL; using the default`);
    return "http://localhost:3100";
  }
}

/**
 * The success destination.
 *
 * `connected=1` and not `connected=<realmId>`. The realm id is the customer's
 * QuickBooks company identifier, and putting it here wrote it into the address
 * bar, the browser's history, and any screenshot of the moment a connection
 * succeeded — to tell the operator something a bare flag tells them just as
 * well. Its PRESENCE is the whole signal; its value was never read.
 *
 * The realm id is still stored, because Fuel genuinely needs it to address the
 * company's API. It is stored server-side, which is where it belongs. See
 * ADR 0010.
 */
export const CONNECTED_REDIRECT_PATH = "/accounting?connected=1";

export const quickBooksCallback: RequestHandler = async (req, res) => {
  const { code, state, realmId, error } = req.query;

  // Intuit reports a declined consent screen this way. Not a failure worth a
  // 500 — the operator simply said no.
  if (typeof error === "string") {
    return res.status(400).type("text/plain").send(`QuickBooks authorization was declined: ${error}`);
  }

  if (typeof code !== "string" || typeof state !== "string" || typeof realmId !== "string") {
    return res.status(400).type("text/plain").send("Missing code, state or realmId.");
  }

  // Redeemed BEFORE the code is exchanged. A state that cannot be consumed
  // means this callback was not one we initiated, and nothing should be spent
  // finding out what Intuit thinks of its code.
  const redemption = redeemOAuthState(state);
  if (!redemption.ok) {
    return res
      .status(400)
      .type("text/plain")
      .send(`This authorization link is ${redemption.reason}. Start again from the dashboard.`);
  }

  /*
   * ONLY THE PERSON WHO STARTED THE LINK MAY FINISH IT (7A-3 item 4, ADR 0017).
   *
   * The state proves Fuel issued this link to a company. It does not prove who
   * is holding it. Without this check, an operator at one company could press
   * Connect, hand the Intuit link to someone at another company that has not
   * connected yet, and the books THAT person consented for would be saved here:
   * readable by the first company, and never connectable by their real owner,
   * because a QuickBooks company belongs to one Fuel company. No realm proof
   * can catch it, the ID token check below included: the grant really is for
   * those books, because their holder consented.
   *
   * So the browser that brings the code back must carry the session of the
   * person who started the link. It works because Intuit's redirect is a
   * top-level GET to this host, and the SameSite=Lax session cookie is sent on
   * exactly that. It is the person, not the company: a colleague finishing
   * someone else's link is refused too, which keeps "who connected these books"
   * a single answer.
   *
   * BEFORE THE EXCHANGE, and after the redemption. The state is spent either
   * way, so a link refused here is dead. The code is never exchanged and no
   * books are read for a person who is not entitled to them. A state that
   * names nobody (from before this was recorded) is refused, never "anyone".
   *
   * The message names no company, books or person. Whoever is holding a link
   * they did not start learns only whose job it is.
   */
  const caller = sessionFromRequest(req);
  if (
    redemption.createdBy === null ||
    caller === null ||
    caller.user.id !== redemption.createdBy ||
    caller.user.companyId !== redemption.companyId
  ) {
    // Says which rule refused it and nothing else: no company, books or
    // person. This is the line an operator looks for when a link "just fails".
    console.warn(
      "[quickbooks] refused a connection: it was not finished by the signed-in person who started it; no code was exchanged",
    );
    return res
      .status(400)
      .type("text/plain")
      .send(
        "Finish connecting QuickBooks in the browser you started from, signed in as the person who started it. " +
          "Start again from the dashboard.",
      );
  }

  try {
    const grant = await exchangeCode(code);

    /*
     * THE REALM IS PROVED BEFORE IT IS BELIEVED, AND BY INTUIT'S OWN WORD.
     * `realmId` arrived in the query string, so it is whatever the browser sent.
     * Without proof, someone could consent for their own books, edit the realm
     * id to another business's, and (with one Fuel company per QuickBooks
     * company) lock that business out of Fuel for good.
     *
     * THE PROOF IS THE ID TOKEN'S `realmid` (7A-3 item 4, ADR 0017), not a read.
     * The read below was the proof until the live sandbox showed that a token
     * asked for ANOTHER company its Intuit user can reach is answered 200, with
     * the token's own company. So a read only proves the user can reach those
     * books. Worse, a saved mismatch would mean every later request "for" the
     * named books is served by the granted ones. This check is on values
     * already in hand, so it runs first: a refused realm is never read.
     *
     * ORDER: prove, then save. Only a save can say "already connected", so that
     * answer is only ever given to someone whose grant Intuit issued for those
     * books -- never to a caller probing realm ids to learn which businesses use
     * Fuel. The code is spent either way; refused tokens are simply not kept.
     */
    let granted: string;
    try {
      granted = grantedRealm(grant.idToken);
    } catch (idError) {
      // Names the failed check (IdTokenError's message), never the token.
      console.warn(`[quickbooks] refused a connection: ${(idError as Error).message}`);
      return res
        .status(502)
        .type("text/plain")
        .send("Could not confirm the QuickBooks company. Start again from the dashboard.");
    }
    if (granted !== realmId) {
      console.warn(
        "[quickbooks] refused a connection: Intuit granted a different QuickBooks company from the one the callback names",
      );
      return res
        .status(400)
        .type("text/plain")
        .send("This authorization does not match the QuickBooks company it names. Start again from the dashboard.");
    }

    // A LIVENESS CHECK NOW, not the proof: the new token works on these books.
    const reach = await grantReachesRealm(grant.accessToken, realmId);
    if (reach !== "authorized") {
      console.warn(
        `[quickbooks] refused a connection: the granted token ${
          reach === "refused" ? "cannot read" : "could not be checked against"
        } the QuickBooks company named in the callback`,
      );
      return reach === "refused"
        ? res
            .status(400)
            .type("text/plain")
            .send("This authorization does not match the QuickBooks company it names. Start again from the dashboard.")
        : res
            .status(502)
            .type("text/plain")
            .send("Could not confirm the QuickBooks company. Start again from the dashboard.");
    }

    // ONE FUEL COMPANY PER QUICKBOOKS COMPANY. Enforced by the realm UNIQUE
    // inside saveConnection, which throws RealmAlreadyConnectedError (answered
    // 409 below, naming no one). No separate look-up first: it would run with
    // no await between it and this write, so it could only ever agree with the
    // constraint -- and a check that can never change an outcome is one nobody
    // can test.
    saveConnection({
      companyId: redemption.companyId,
      realmId,
      accessToken: grant.accessToken,
      accessExpiresAt: grant.accessExpiresAt,
      refreshToken: grant.refreshToken,
      refreshExpiresAt: grant.refreshExpiresAt,
    });

    console.log(`[quickbooks] connected to sandbox company ${realmId} (the company Intuit's ID token names)`);
    res.redirect(`${dashboardUrl()}${CONNECTED_REDIRECT_PATH}`);
  } catch (caught) {
    if (caught instanceof RealmAlreadyConnectedError || caught instanceof UnresolvedPostingsError) {
      return res.status(409).type("text/plain").send(caught.message);
    }
    // Only the message, never the error object: its `.request` carries the
    // client secret and the authorization code. See src/lib/env.ts.
    const message = (caught as Error).message;
    console.error(`[quickbooks] token exchange failed: ${message}`);
    res.status(502).type("text/plain").send("Could not complete the QuickBooks connection.");
  }
};
