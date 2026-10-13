# 0020 — Sign-in limits key on the browser the dashboard vouches for

**Status:** accepted
**Date:** 2026-10-07
**Reverses, narrowly, two rules stated in code rather than in an ADR:**
- `addressOf` in `src/auth/routes.ts` read "the socket peer, never a header".
  The API now believes a client address from someone else, but only from the
  dashboard, identified by a secret AND by where it connects from.
- The header of `dashboard/lib/fuel.ts` read "the dashboard no longer holds a
  credential of its own". The dashboard now holds one secret, the relay key,
  which is not an API credential (decision 1).

**Does not touch:** the per-account and per-token limits, the gateway's own
limiter (`src/gateway/limiter.ts`), sessions or roles (ADR 0018), or anything
that moves money.

Commits: `54ed1ed` (the API), `160f541` (the dashboard), and this one.

## The problem

The dashboard calls Fuel from its own server, so every browser's sign-in and
signup reached the API from one address: the dashboard's. The per-address
limits (20 attempts per 15 minutes, `byLoginAddress` and `bySignupAddress`)
therefore counted every browser together. One anonymous browser could spend
them and lock every operator out of signing in. Slice 7A-2c split the counter
in two, which contained the damage but did not fix it, and its comment said
the fix would need exactly the reversal recorded here.

The dashboard could not simply pass the browser's address on, because it did
not know it. Next 15 never shows a route handler the socket, and it fills
`X-Forwarded-For` with `??=` (`base-server.js` in Next 15.5.22), so a value
the browser sent is kept. A route handler reading that header reads whatever
an attacker wrote.

## Decision

**The dashboard's own edge server records the browser's address from the TCP
socket, and the API believes that address only when it arrives with the relay
key from an allowed peer. Nobody else can choose which bucket an attempt
counts against.**

1. **The relay key (`FUEL_RELAY_KEY`) vouches for an address and does nothing
   else.** It is not in `roleFor`; as a Bearer token it gets 401. The same
   value lives in `.env` and `dashboard/.env.local`. The API refuses to boot
   if it is set but empty, shorter than 32 characters, or equal to
   `FUEL_API_KEY` or `FUEL_AGENT_KEY`. Unset at the API, the relay is off and
   limits count per caller as before: a safe fallback, not an outage. In the
   dashboard only `startSession` and `redeemInvite` send it; `fuelFetch`
   never does.
2. **The API believes a forwarded address only from key AND peer**
   (`resolveClient` in `src/lib/client-key.ts`). The key is compared as
   SHA-256 digests in constant time. The peer is the socket address, never
   `req.ip`, so turning on `trust proxy` one day cannot change it, and it must
   be in `FUEL_RELAY_PEERS` (default `127.0.0.1,::1`; set but empty means
   nobody). Neither alone is enough: every local process also connects from
   127.0.0.1, and a key alone would work from anywhere if it leaked.
   - A direct caller, meaning anyone without the relay header, is keyed on its
     own socket (`peer:`). Any address header it sends is never read.
   - A wrong key, or the right key from a disallowed peer, gets 403
     `relay_rejected`. It is counted against that peer, and once the peer is
     spent it gets 429, still `relay_rejected`.
   - A trusted relay naming no usable address gets 400
     `malformed_client_address`, never a fallback.
   - A trusted relay naming a valid address is keyed on that address
     (`client:`). The two prefixes keep a browser on 127.0.0.1 apart from a
     local `curl`.
3. **The dashboard runs behind `dashboard/server.mjs`, which owns the
   origin headers.** On every request, before Next sees it, it:
   - deletes `X-Fuel-Client-Address`, `X-Fuel-Edge-Proof`, `X-Forwarded-For`,
     `-Host`, `-Proto`, `-Port`, `Forwarded` and `X-Real-IP`;
   - writes the socket address into `X-Fuel-Client-Address` and
     `X-Forwarded-For`, and nothing at all if the socket has gone;
   - adds `X-Fuel-Edge-Proof`, a 32-byte random value made fresh each time the
     process starts and kept only in its environment.

   It binds the fixed address `127.0.0.1:3100`. `npm start` and `npm run dev`
   both run it. Development mode comes from the command's argument, never
   from `NODE_ENV`.
4. **Without the edge, sign-in and signup refuse.** Under plain `next start`
   nothing strips the headers, so a browser could write its own address.
   `verifiedClientAddress` therefore requires the edge proof, and first
   requires the proof to be a real secret, so an unset or empty one can never
   match. With no proof there is no address, and the relay answers "Fuel could
   not be reached" and logs why.
5. **Addresses are written one way before they are compared.** IPv4 is keyed
   per address. IPv4-mapped IPv6 becomes its IPv4. Other IPv6 is keyed per
   /64, because one client normally holds a whole /64. The shape check comes
   before `net.isIP`, which accepts zone IDs (`fe80::1%en0`); commas,
   brackets and whitespace are refused too. There is one parser, `parseIPv6`
   from `src/lib/safe-fetch.ts`.
6. **A ceiling across ALL relayed attempts: 500 per 15 minutes per route**
   (`FUEL_RELAYED_CEILING`). This is what bounds a leaked relay key: password
   spraying (one guess each at many accounts), hashing work, and churn in the
   per-account counters. It must stay below the limiter's 10,000-key cap,
   which the API checks at boot, so rotating addresses cannot push a victim's
   per-account counter out of memory.
7. **A relay refusal never reads as the person's fault.** The dashboard maps
   `relay_rejected` and `malformed_client_address` to "Fuel could not be
   reached", never to "wrong password" or "too many attempts". Login's
   credential refusal stays one code-less 401, as before.

## Two departures from the approved plan, and why

Both were forced by what Next actually does, read from its source in 15.5.22,
not assumed. Both were checked by the commit-2 security review.

**1. `X-Forwarded-Host` copies the browser's own `Host` header instead of
being hardcoded to `127.0.0.1:3100`.** The plan said to write the edge's own
bind, so the browser could no longer control the header. Two facts made that
wrong:
- Next's middleware redirect moves a browser that arrived at `127.0.0.1` to
  `localhost` (measured, and recorded in `dashboard/middleware.ts`). So real
  operators browse at `localhost:3100`.
- Next's Server Actions protect against cross-site requests by comparing the
  request's `Origin` with `X-Forwarded-Host`
  (`app-render/action-handler.js`). A hardcoded `127.0.0.1:3100` would never
  match `Origin: http://localhost:3100`, so the first Server Action anyone
  added would fail for every real operator. The dashboard has none today,
  which is exactly why that would have been a trap, not a visible bug.

Copying `Host` is precisely what Next does itself with no proxy in front
(`x-forwarded-host ??= host`). What the edge still removes is a client making
the two differ, which is the only part of the header worth spoofing. A
cross-site browser cannot forge `Host`. The review noted one thing this does
not close: DNS rebinding, where `attacker.example` resolves to 127.0.0.1. It
passes this check and the existing `refuseCrossOrigin` alike, because both
compare against `Host`. It carries no Fuel cookie, so the most it can do is
spend the victim's own sign-in allowance. That is an existing weakness of
Host-based checks, not a new one. Revisit it before adding Server Actions or
exposing the dashboard beyond loopback.

**2. Next handles WebSocket upgrades itself; the edge adds no `upgrade`
handler.** The plan said the edge would pass upgrades (development hot reload)
on to Next. Next's custom-server mode already attaches its own `upgrade`
listener to the server on the first request (`setupWebSocketHandler` in
`next/dist/server/next.js`). A second listener would handle every upgrade
twice. `server.mjs` passes `httpServer` so Next attaches to the right server,
and leaves upgrades to it. Upgrades never reach a route handler, so not
stamping them protects nothing less.

**Smaller departures, for the record:**
- **The API's throttled relay refusal now carries `relay_rejected`** (commit
  2; on signup it said `throttled`, on login nothing). The commit-1 review
  pointed out that, without it, a misconfigured dashboard would show people
  "too many attempts" after 20 refusals.
- **The dashboard keeps its own copy of the relay codes**
  (`RELAY_REFUSAL_CODES` in `dashboard/lib/client-address.ts`), and verify-api
  asserts it equals `RELAY_CODES`. The dashboard compiles nothing from outside
  its own directory.
- **The edge tests are numbered E1–E6, not the planned D1–D4,** because ADR
  0018 already uses D1–D5 in the same file.

## Hosting: the edge server constrains where the dashboard can run

A custom Next server is a deliberate trade, and this one binds where the
dashboard can be hosted. Checked against current docs on 2026-10-07:

- **The Next.js 14 docs said it outright:** "A custom server **cannot** be
  deployed on Vercel", and it "will remove important performance
  optimizations, like serverless functions and Automatic Static
  Optimization" ([Next.js 14, Custom
  Server](https://nextjs.org/docs/14/pages/building-your-application/configuring/custom-server)).
- **The current docs (16.3.8) no longer mention Vercel.** They still warn
  that a custom server "should only be used when the integrated router of
  Next.js can't meet your app requirements", and that standalone output mode
  "does not trace custom server files … These cannot be used together"
  ([Next.js, Custom
  Server](https://nextjs.org/docs/app/guides/custom-server)).
- **Vercel's own guide (2026-08-04)** says a normal Next.js app deploys
  natively, but "a Next.js app wrapped in a custom server is the one
  exception, and it moves as a container like the rest", via a
  `Dockerfile.vercel`. "The container path is currently in beta." The server
  "has to listen on `$PORT`", and containers are stateless with no durable
  disk
  ([Vercel KB](https://vercel.com/kb/guide/migrate-containers-from-aws-to-vercel)).

**What that means for Fuel:**
- The dashboard cannot use Vercel's native Next.js hosting while it depends
  on `server.mjs`. The only Vercel option today is a beta container.
- The edge's fixed bind (`127.0.0.1:3100`) is incompatible with a platform
  that assigns `$PORT`.
- Behind any hosting proxy the edge would no longer see the browser's socket
  (see "Zero trusted hops").

**None of this blocks the beta**, which runs the dashboard and API side by
side on one host. **It is a precondition of the hosted-deployment slice in
Phase 7:** that slice must either host a Node process (a VM or a container
platform), or replace the edge with the platform's own trustworthy client
address and drop `server.mjs`. Either is a new decision, not a config change.

## Residuals, stated plainly

- **Tunnels and reverse proxies quietly bring the shared bucket back.** If
  port 3100 is put behind a tunnel (an `ngrok` archive sits untracked in the
  repo root) or any reverse proxy, the edge sees the proxy as the socket peer
  and stamps `127.0.0.1` for every visitor. Every browser then shares one
  bucket again, which is the original outage, though not a bypass. The user
  has undertaken (2026-10-06) **not to tunnel port 3100 without saying so
  first**, so that this ADR's assumption is revisited before it stops being
  true.
- **Zero trusted hops only.** The edge takes the socket peer as the client.
  Putting a load balancer in front of the dashboard needs a configured hop
  count, taking the address from the right of `X-Forwarded-For`. That is not
  built, and it must be built before any proxy goes in front.
- **Distributed lockout.** 25 or more coordinated browsers can exhaust the
  relayed ceiling and block sign-in for everyone for 15 minutes. That is the
  price of decision 6; it now takes a distributed attacker, not one browser.
- **The ceiling covers relayed traffic only.** Direct callers have just their
  per-peer bucket. That is safe today only because the API binds 127.0.0.1,
  so no untrusted direct caller exists.
- **/64 is the minimum, not a real bound.** Providers often delegate a /56 or
  /48, so one client can rotate across many /64s. The ceiling, not the
  per-address key, bounds that.
- **NAT64 (`64:ff9b::/96`) and IPv4-compatible addresses** collapse many
  clients into one bucket. Both are rare in front of a dashboard.
- **Eviction.** A client holding more than 10,000 /64s can churn its own
  per-address counter out of memory. The per-account and per-token maps are
  protected by the ceiling invariant; the per-address map is not.
- **Relay on or off is observable.** A caller sending a wrong key learns
  whether the relay is configured (403 versus an ordinary answer). It learns
  nothing about any account.
- **The relay key crosses loopback in plain text.** If the dashboard and API
  ever run on separate hosts, TLS between them is a prerequisite.
- **A known account can still be locked for 15 minutes** with five bad
  attempts. That predates this ADR, which neither changes nor claims to fix
  it.
- **The proof that Next builds a route's headers from the edge-stamped
  request is live-only.** The suite proves the edge's stamping (E1, E4 over a
  real socket), not Next's request adapter. A Next upgrade could change that
  adapter silently. Repeat the live spoof test below after any Next upgrade.

## Proof

**Tests** (`scripts/verify-api.ts`):
- **The API, R1–R22:** direct callers forging `X-Fuel-Client-Address` or
  `X-Forwarded-For`; a wrong key; the right key from a disallowed peer; one
  client not throttling another (R5, which failed on the old code first);
  every malformed shape; /64 sharing; mapped and differently spelled
  addresses; the per-account and per-token limits holding across rotating
  addresses; the ceiling; flooding unable to evict a victim's counter;
  repeated headers; an empty peer list; the relay off; and throttled relay
  refusals keeping their code.
- **The dashboard, E1–E6:** the edge replaces every forged origin header; no
  genuine proof means no address, including unset, empty and short proofs;
  forging every header at once over a real socket; the edge, dashboard and
  API agreeing on names and codes; and source checks on who sends the key,
  refusal order, the npm scripts, the bind, and stamping before Next runs.

**Break tests: 32, each failing its own named check.** Commit 1: 18 (B1–B11,
B14–B20). Commit 2: 14 (B12, B13, B21–B31 including B22s). One commit-2 break
first tripped the check before its own, because the edit rewrote the line
that earlier check reads. It was redesigned as a realistic bug (a stray
`NODE_ENV` winning through `??=`) and then failed its own check.

**Suites:** api 4719, migration 231, rollup 211, quickbooks 357, earning 132;
both typechecks clean; production build clean, and the relay key appears
nowhere in `.next`.

**Security review:** on the plan (eleven findings, all taken), on commit 1
(five fixed, two recorded as residuals above), and on commit 2 (nothing
blocking; its cheap notes applied).

**Live, 2026-10-07, against the real running stack** (API restarted first,
then the dashboard through `server.mjs`). No backup was taken, because failed
sign-ins write nothing to `fuel.db`.
1. **Listening:** the dashboard process (`node server.mjs start`) listened on
   `127.0.0.1:3100` and nothing else; the API on `127.0.0.1:3000` only.
2. **`next start` run directly** (port 3101) refused sign-in and signup with
   "could not reach Fuel", including with a forged 64-character proof, and
   logged why. Nothing reached the API.
3. **The spoof test.** 21 sign-ins through the real dashboard, each with a
   different nonexistent email and different forged `X-Forwarded-For`,
   `X-Fuel-Client-Address` (sent twice), `X-Fuel-Edge-Proof`, `Forwarded` and
   `X-Real-IP`. Attempts 1–20 were refused as wrong credentials and the 21st
   was throttled. Because every email differed, only the per-address bucket
   could have done it: every forged header was ignored, the relay was
   believed, and all 21 counted as one browser.
4. **The bucket was `client:`, not `peer:`.** A direct call to the API
   straight afterwards got an ordinary 401, not 429.
5. **The API was restarted to clear that allowance**, and its banner again
   read `client-address relay ON for peers 127.0.0.1, 0:0:0:0:0:0:0:1;
   relayed ceiling 500/15min`. (`0:0:0:0:0:0:0:1` is `::1` in the single
   form every address is normalised to before comparison.)
6. **A real, successful sign-in through the edge.** `qa-dashboard` signed in
   with its own dedicated test account (`qa-dashboard@fuel.local`, in its own
   company; `scripts/seed-qa-dashboard.ts`) through the dashboard's real
   sign-in form route, so through the edge, the relay key and the API's
   relayed path. It then used that session for all 1032 of its checks across
   three viewports: 1014 passed. The 18 failures are the same six
   accounting-status checks on each viewport that slice 7A-4 recorded as
   failing before this work. This ADR touches no accounting code.
   **The owner did not sign in by hand.** They chose to let the QA account's
   sign-in stand as the proof of a successful sign-in, so a person's browser
   signing in through the edge has not itself been observed.

## What this does not cover

- Hosting the dashboard anywhere but beside the API on one host (see
  "Hosting").
- A configurable trusted-hop count for a proxy in front of the dashboard.
- Per-person lockout protection for a known account, beyond the existing
  five-attempt limit.
- The gateway's limiter for paid endpoints, which is not behind the
  dashboard.
