# 0021 — Fuel tells a company's owner when something needs them

**Status:** accepted
**Date:** 2026-10-09
**Moves:** the Overview's "Needs attention" rules, from
`dashboard/app/page.tsx` into the API (`src/alerts/attention.ts`). The
Overview now renders the API's list and computes nothing.

**Does not touch:** any money path. `reserveIfUnderCap`, `pay.ts`,
`postings.ts`, `qbo*.ts` and `src/quickbooks/` are unchanged. The sweeper reads
existing tables through their existing company-scoped functions and writes
only to the five new `alert_*` tables.

Commits: `a7eeef9` (the engine and API), `184524e` (the dashboard), and this one.

## The problem

Everything that needs a person already shows on the Overview: a frozen agent,
a payment held for approval, an agent past its cap. But only if somebody opens
the dashboard. A payment held for approval waits up to 24 hours and then
expires, whether anyone looked or not.

Two facts shaped the answer:

1. **The Overview's list was not a shared definition.** page.tsx built it from
   three API calls and its own arithmetic. An alert built from a second copy
   of those rules would disagree with the screen the first time either was
   edited.
2. **Two of the requested events leave no record**, so they cannot be
   detected from existing data:
   - **QuickBooks failing.** A refresh failure throws in
     `src/quickbooks/client.ts` and is never stored. Detecting it needs a write
     in money-adjacent code, which is its own slice.
   - **`relay_rejected` (ADR 0020).** It is an in-memory refusal that fires
     before sign-in knows the company, so no company's webhook can own it.

## Decision

### 1. One definition, for the screen and for alerts

`attentionFor(companyId, now)` is the only place that decides what needs a
person. `GET /api/attention` returns it, collapsed per agent and kind; the
Overview renders that, and the sweeper alerts from it. The two cannot disagree,
because there is one list.

The five kinds the Overview already had keep their exact sentences: frozen,
awaiting approval, over authority, no authority left, and team at its ceiling.
verify-api compares them word for word with the old templates (AL-A2). Nine
kinds are new:
- an anomaly hold;
- an unconfirmed payment;
- a stuck incoming payment;
- a QuickBooks entry needing reconciliation;
- a frozen agent still trying to pay;
- QuickBooks expired, and, as its own kind, QuickBooks expiring within 7 days;
- an agent rate-limited in the last 10 minutes;
- an agent at 80% or more of its cap.

**Collapsed per agent and kind.** "26 payments, $0.026 in all, from
research-bot" is one line, not 26. Holding the agent key is enough to create
any number of pending approvals by varying a URL. Collapsing in the API means a
flood can't bury the screen, and can't become a flood of alert lines.

### 2. Alerts reach each company's owner, and nobody else

This is the user's first addition to the approved plan.

A company's webhook is set by **that company's owner**, and its alerts carry
only that company's data. Nothing is sent to whoever runs Fuel.

**So this does not tell the Fuel operator when a tester's system breaks.** If a
beta tester's agent is frozen at 3 a.m., their owner hears about it. Fuel's
operator does not, unless they are that owner.

**Follow-up, not built here: platform-level monitoring.** One place where
whoever runs Fuel hears about every company, and about the signals that
belong to no company. It should start with:
- `relay_rejected`: a misconfigured sign-in relay, which no company can own;
- `quickbooks_failing`: a refresh failure, once it is recorded at all;
- the sweeper itself not running (today only an owner sees "Fuel has not
  checked for alerts since…", in their own panel).

### 3. The sweeper runs on its own timer

`startSweepLoop` in `src/alerts/loop.ts` runs once a minute, separately from
the reaper's `setInterval`. This is the user's second addition. A tick that
arrives while a sweep is still running is skipped and counted, never queued.

**Proven:** a slow, a throwing and an overlapping sweep each run alongside a
counted reaper-like timer, and the reaper never misses a tick (AL-L1). `reap()`
never calls the sweeper (AL-L2). Break tests that move the sweep into `reap()`,
or remove the overlap guard, fail those checks.

**What separate timers do not fix:** one company's sweep is synchronous. It
holds the event loop while it runs, by design: see "Contention" below. The
sweeper yields between companies, so a request waits behind one company's
sweep at most, never behind all of them. Measured with 5,000 open events (AL-D7):

| Sweep | Time |
|---|---|
| Opening 5,000 events | about 1.3 s |
| Nothing changed | about 26 ms |

### 4. Delivery

**The webhook.** A per-company, Slack-compatible incoming webhook. The body is
`{ "text": … }` and nothing else.

**Retries.** A failed delivery is retried after 1, 2, 4, 8 and 16 minutes,
then marked failed:
- 5xx, 408, 429, timeouts and network errors are retried;
- any other 4xx is permanent.

**Degraded.** Three consecutive failures mark the webhook *degraded*. After
that it gets at most one new message every 15 minutes, so a dead receiver isn't
hammered.

**Limits on each send:**
- a 5-second timeout;
- at most one delivery in flight per company, and two in total;
- two, not four, because DNS lookups share libuv's four threads with sign-in's
  password hashing.

**Crashes.** Each send holds a 2-minute lease, claimed with a conditional
UPDATE. A crash mid-send is retried after the lease runs out, and never sent
twice in parallel (AL-D6).

**Failures never escape.** Delivery runs after its transaction commits, and
never throws into the sweep, a request or the reaper.

### 5. The URL is a credential

A Slack incoming-webhook URL lets anyone holding it post to that channel, and
its secret is the path. So:

- **It is stored encrypted, like the QuickBooks tokens.** The sealed value also
  records the company and a purpose, both checked when it is opened. A
  ciphertext copied onto another company's row is refused (AL-S6).
- **No route returns it, and nothing logs it** (AL-S5):
  - an owner sees the host only;
  - every refusal is a fixed sentence;
  - errors are caught by class, never by message, because several messages in
    `safe-fetch.ts` contain the URL.
- **It is validated twice:** when it is set, and again before every send
  (AL-S4, AL-S7). The rules:
  - https only;
  - no username or password;
  - the default port only;
  - a name, never a numeric address.
- **It is SSRF-guarded at connect time.** `safeFetchNoRedirect`, with loopback
  and private ranges blocked, checks every address a name resolves to when the
  socket opens (AL-S1, AL-S2). The usual development exemption for loopback
  does not apply here.
  - Redirects are never followed (AL-S3).
  - The request's dispatcher is set explicitly, so `HTTPS_PROXY` cannot route it
    (AL-S8).
- **The dashboard holds it once and drops it.**
  - The Alerts panel's field is a password field that starts empty and is
    cleared after saving.
  - The browser itself refuses to send anything that is not an `https://`
    address. A browser that autofills the owner's sign-in password into that
    field therefore never sends it anywhere.
  - The proxy picks every response field. A refusal is answered with the
    dashboard's own sentence for Fuel's code, never with text from an error
    body (AL-P1–P3).
  - Every dashboard write route now refuses a request the browser marks as
    same-site or cross-site (`Sec-Fetch-Site`), in the shared
    `refuseCrossOrigin` (security review of commit 2).

**Owners see failures in collapsed words.** "Unreachable" covers both a refused
private address and a network failure. Otherwise the test button would be a way
to learn which internal names exist.

### 6. What a message carries

It carries:
- the event's label, from a closed lookup;
- the agent's or team's name, made safe;
- a dollar amount;
- a link into the dashboard.

It never carries:
- a resource URL, which can hold a credential;
- an address, hash or nonce;
- an email;
- a freeze reason, which is an operator's free text;
- crypto vocabulary.

Checked with seeded sentinel values in AL-D5.

**How names are made safe:**
- control and bidirectional characters are stripped;
- `&`, `<` and `>` are escaped;
- each name sits in a code span;
- a zero-width space follows every `@`, so `<!channel>`, `@here` and forged
  lines are neutralised;
- names are capped at 80 characters, and a message at 1,800.

### 7. Noise

**One message per sweep.** At most one message per company per sweep, with up
to 8 lines. Anything beyond that is counted ("and N more").

**Three hourly ceilings per company:**

| Ceiling | Messages per hour |
|---|---|
| Money | 10 |
| Approvals and anomaly holds | 6 |
| Watch | 4 |

They are three, not two, because anyone holding the agent key can create
approvals. Sharing the money ceiling would let a flood of approvals hold back
an unconfirmed payment (security review of commit 1, F-1).

**Nothing is dropped.** An event held by a ceiling stays *pending* and goes in
the next message its ceiling allows.

**No repeats:**
- a condition that clears and comes back within an hour reopens silently;
- object events (an approval, a payment) cannot recur once resolved.

**Setting the first webhook is a baseline.** Everything already open at that
moment is marked *baseline* and never sent. Only what opens afterwards alerts
(AL-A8). Without this, the first sweep would have sent every old condition in
the database to a third party.

## Contention on the single SQLite connection

**Inside the process there is no lock contention, by construction.** Fuel has
one synchronous connection (`DatabaseSync`). Every transaction, the sweeper's
included, opens and closes in one JavaScript turn, and none spans an `await`.
So a sweep can neither interleave with a payment's reservation nor nest inside
one. AL-A5 checks that the sweep is not async; AL-F1 checks that a sweep
throwing mid-transaction leaves reservations working.

**What the sweeper does add:**
- **Event-loop time,** measured above.
- **Two small writes on every sweep:** the last-run time, and the prune, which
  usually deletes nothing. Each holds the file's write lock for milliseconds.
  A company's own sweep writes only when something changed. Another process
  writing to `fuel.db` at the same moment waits behind these, within SQLite's
  5-second busy timeout.

## The Overview, before and after

Captured before page.tsx changed (the user's third addition):
- *before* is the old page.tsx rules at commit `4840964`;
- *after* is the new list, worded by `dashboard/lib/attention.ts`;
- both ran on byte-identical copies of `fuel.db`; the real file was never
  opened.

| Company | Before | After |
|---|---|---|
| Default Company | 4 lines | 6 lines: the same 4, word for word, plus 2 new |
| Second sign-up (no agents) | nothing | nothing |
| Fuel QA Dashboard | nothing | nothing |

The two new lines are old test payments, authorised in August and never
confirmed:
- one of $0.001 from `empty-balance-test-agent`;
- 26 from `research-bot`, $0.026 in all, shown as one line.

They can be cleared with `POST /api/payments/:id/reconcile`. The dashboard has
no button for it.

**One existing case reads differently.** A payment held by the anomaly check
used to show as "Awaiting approval … blocked at the anomaly ceiling". It is now
its own kind, "Held as unusual … unusual for this agent, so a person decides".
The real data has no such payment today.

## Departures from the approved plan

- **Three ceilings, not two** (section 7).
- **No *suppressed* state.** An event over a ceiling stays *pending* and goes
  later; the plan's *suppressed* was a dead end once the digest was cut.
- **The breaker probe was kept, lightly. The recovery digest was cut.** This is
  the user's fifth addition, said out loud as it asked.
  - **The breaker:** a degraded webhook gets at most one new message per 15
    minutes. There is no separate probe.
  - **No digest message on recovery.** What covers the same need: held events
    stay *pending* and join the next message, and every message's text is
    built when it is sent, from what is still open. A message after an outage
    therefore says what is true now, not what was true then.
- **No `too_large` outcome.** Messages are capped at 1,800 characters before
  sending, so a receiver never sees one too large to accept.
- **Deliveries carry no event list.** Each event points at its delivery
  (`delivery_id`), which keeps one source of truth for what a message covers.

## Residuals, stated plainly

- **A hung DNS lookup outlives the 5-second timeout.** The request is
  abandoned, but `getaddrinfo` holds one of libuv's four threads until the
  system gives up.
- **An agent that keeps creating money-severity events can delay other money
  alerts by up to an hour.** The ceiling still lets a real one out, but behind
  whatever is already pending, oldest first. Everything stays on the Overview
  meanwhile.
- **The cost of reading spend per agent is not measured beyond the tested
  sizes.** It is one query per agent, every minute.
- **Owners only** (section 2). Platform monitoring is the follow-up.
- **QuickBooks failing and `relay_rejected` are not detected**, as explained
  under "The problem".
- **Agent and team names leave Fuel**, to the receiver the owner chose. That is
  the point of an alert. It is also why the payload is a closed set of fields.
- **`FUEL_TOKEN_ENCRYPTION_KEY` is now needed to set a webhook.** Without it,
  setting one fails with a fixed sentence, and nothing else breaks.

## Proof

**Suites:** verify-api 5,477; verify-migration 234; verify-rollup 211;
verify-quickbooks 357; verify-earning 132. Every new check is named `AL-…`:

| Group | Checks | What they cover |
|---|---|---|
| Detection | A1–A9 | detection |
| SSRF and secrets | S1–S8 | the guards in section 5 |
| Delivery | D1–D8 | retries, leases, noise, tenancy |
| Routes | R1–R4 | owner-only routes |
| Loop | L1–L2 | the sweeper's own timer |
| Failures | F1–F2 | failures stay contained |
| Dashboard panel | P1–P3 | what the panel never holds |

**Break tests:** commit 1, 47; commit 2, 30. Each failed its own
named check.

**Security reviews:** the plan, commit 1 (with a re-check after fixes) and
commit 2.

**Live, on 2026-10-10.** Sandbox, against the real `fuel.db`, which was
backed up first as `fuel.db.bak-adr0021-20261008T204149Z`.

- **The owner's own company.**
  - The owner saved a webhook for Default Company in the Alerts panel at 09:48
    UTC. The change log records it replaced three times by 09:52. The test
    alert arrived.
  - The baseline held. All 31 conditions already open were marked *baseline*
    at that moment: the four Overview lines, plus 27 unconfirmed August test
    payments. Not one has been sent; Default Company has no real deliveries.
- **The single-alert check ran on the QA company only.** Neither of the two
  test agents was touched.
  - Alerts go to a company's own owner, so the QA company needed a webhook of
    its own. The owner signed in as the QA account and saved one at 11:45:16
    UTC.
  - At 11:45:35, a QA-owner session from the real sign-in route froze
    `qa-dashboard-agent` through the real freeze route. That agent has no
    payments, and the freeze moved no money. The freeze reason carried a
    sentinel string.

| Time (UTC) | What happened |
|---|---|
| 11:46:10 sweep | One `agent_frozen` event opened, and one delivery was sent. The receiver accepted it on the first attempt (`ok`). |
| 11:47–11:51 | Five sweeps with the agent still frozen. No further delivery. |
| 11:51 | The agent was unfrozen. |
| 11:52:10 sweep | The event resolved. |
| 11:52 and 11:53 | Nothing sent, because resolving never sends. |

- **What the message said:** the kind, the agent's name and a link:
  "Frozen for `qa-dashboard-agent`". The sentinel from the freeze reason
  appears in neither the message nor the stored payload.
- **The webhook's state:** both webhooks are healthy, with last outcome `ok`
  and no failures.
- **Sweep time on the real data,** measured on a copy:
  - 3.4 ms for the first sweep, which opened the 31 events;
  - 0.7 ms after that.

The one alert's arrival is proved by Fuel's record: one delivery, which the
receiver accepted with a 2xx. The owner read the test alert in the channel.

## What this does not cover

- Platform-level monitoring (section 2).
- Email, SMS or anything that is not a Slack-compatible webhook.
- More than one destination per company, or per-person preferences.
- A message when something resolves. The Overview is where "it's fine now" is
  read.
