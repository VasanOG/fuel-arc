/**
 * Visual and accessibility QA for the dashboard.
 *
 * Why a script rather than a test file: this project has no test framework and
 * deliberately so — scripts/verify-rollup.ts records the reasoning, that
 * introducing one "is a convention decision that should not ride in on a slice
 * that touches money". A UI slice is the right place to bring in a browser, and
 * it keeps the established shape: a main() that throws on an unmet expectation
 * and exits non-zero.
 *
 * Playwright is here for screenshots and scanning. It is not a test runner and
 * no assertions live in .spec files.
 *
 * It measures a PRODUCTION BUILD, and refuses to measure anything else.
 *
 * Not fussiness. The Next development server puts things in the page that never
 * ship: its dev-tools overlay sits in the tab order, and on the agent detail
 * page it puts the raw upstream API response — custody address and settlement
 * identifiers included — into the browser, regardless of what the page renders
 * or what dashboard/lib/fuel.ts picked out of it. Every server response is
 * clean in both modes; it appears only when a real browser loads the dev page.
 *
 * Measuring dev would mean reporting failures that are not in the product, and
 * getting used to ignoring them. So:
 *
 *   cd dashboard && npm run build && npm run start
 *   npm run qa-dashboard
 *
 * `--source-only` runs just the checks that read source files -- style class
 * names, the environment badge's source, the accounting contract -- and stops.
 * No server, no browser, no database, and neither .env file is loaded. That is
 * the part `npm test` runs; the rest needs a running dashboard and the QA
 * account, so it stays a separate, deliberate run.
 */

import { config as loadEnv } from "dotenv";
import { chromium, type Page } from "playwright";
import { readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
// No imports of its own (see that file's own comment), so importable here
// without dragging in `server-only` or anything Next-specific.
import { SESSION_COOKIE } from "../dashboard/lib/session-cookie.js";

/*
 * Browser globals, declared narrowly.
 *
 * These identifiers exist only inside page.evaluate callbacks, which run in the
 * page rather than in Node. The root tsconfig deliberately omits the DOM lib so
 * that backend code cannot reach for a browser global by accident; declaring
 * the handful this one script needs keeps that boundary intact instead of
 * widening `lib` for everything in src/.
 */
declare const document: any;
declare const window: any;
declare const getComputedStyle: (element: any) => any;

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "docs", "ui", "shots");
const BASE = process.env.FUEL_DASHBOARD_URL ?? "http://127.0.0.1:3100";
const SOURCE_ONLY = process.argv.includes("--source-only");

/*
 * The dashboard's own environment, not the API server's.
 *
 * FUEL_API_URL lives in dashboard/.env.local, because it is the dashboard that
 * needs to know where Fuel is. This suite has to reach the same API the page
 * reached in order to compare what the badge SAYS with what the server ANSWERS,
 * so it reads the same file the dashboard does. The root .env is loaded second
 * and does not override, so a value set for the dashboard wins for the check
 * that is measuring the dashboard.
 */
// Not in --source-only: those checks need neither file, and a run that is
// meant to need no secrets should not be holding them.
if (!SOURCE_ONLY) {
  loadEnv({ path: path.join(ROOT, "dashboard", ".env.local") });
  loadEnv({ path: path.join(ROOT, ".env") });
}

/**
 * `path` is resolved once per run rather than hardcoded where it cannot be:
 * the agent detail route needs a real id, and inventing one would either 404 or
 * test a page that no operator will ever see. It is discovered from the roster.
 */
interface Route {
  name: string;
  path: string | null;
}

const ROUTES: Route[] = [
  { name: "overview", path: "/" },
  { name: "agents", path: "/agents" },
  { name: "agent-detail", path: null },
  { name: "activity", path: "/activity" },
  // The ledger under a filter, because the filtered view is a different render:
  // it takes the empty-result branch, the Clear control appears, and the status
  // filter round-trips through the API's own vocabulary. Scanning only the
  // unfiltered page would leave all of that unscanned.
  { name: "activity-filtered", path: "/activity?status=blocked&order=oldest" },
  // The inbound half, which renders a branch the two routes above cannot reach:
  // the direction cell's accent, the signed amount, and a counterparty that is
  // an endpoint label rather than a merchant host. A ledger filtered to earn is
  // also the only view where every row takes the same branch, which is where a
  // colour-only distinction would have been easiest to miss.
  { name: "activity-earn", path: "/activity?direction=earn" },
  // New in 6B-3. Scanned like every other route: it introduces a table, a
  // status list and two new colour-carrying classes, and it is the one page
  // whose most important content (money served and never paid for) is rendered
  // conditionally — so an empty database and a populated one are different
  // renders and the populated one is what ships.
  { name: "earning", path: "/earning" },
  { name: "approvals", path: "/approvals" },
  // The default view is the pending queue, which is EMPTY in this database —
  // so the unfiltered route only ever exercises the empty state. This one has
  // rows, and takes the table branch, the decided-history labels and the
  // view-switcher's active state.
  { name: "approvals-all", path: "/approvals?status=all" },
  { name: "accounting", path: "/accounting" },
  { name: "integrations", path: "/integrations" },
  { name: "developer", path: "/developer" },
];

/**
 * Signs the dedicated QA test account in over HTTP and returns its session
 * cookie for Playwright to carry into every browser context.
 *
 * WHY THIS EXISTS AT ALL. Since ADR 0018 every dashboard route needs a
 * session cookie — middleware.ts bounces a signed-out visit to /login, and
 * because `page.goto` follows that redirect and reports the final page's
 * 200, every route this suite "checked" without this was silently scanning
 * the login page. Fixed here rather than left as a separate finding, because
 * nothing else in this file can mean anything until it is.
 *
 * A RAW FETCH TO THE REAL SIGN-IN ROUTE, not a scripted form fill. It posts
 * exactly what dashboard/app/login/page.tsx's form posts
 * (app/api/session/route.ts, the same body shape) — so this exercises the
 * real sign-in path rather than a shortcut around it, and is far less
 * brittle than driving the login page's DOM for a step every other check in
 * this file depends on.
 *
 * The account itself is scripts/seed-qa-dashboard.ts's — its own company,
 * never a real person's — and its handle/email/password are read from env
 * rather than looked up, the same way an actual person types them.
 */
async function signInAsQaDashboard(): Promise<{ name: string; value: string; url: string }> {
  const company = process.env.QA_DASHBOARD_COMPANY;
  const email = process.env.QA_DASHBOARD_EMAIL;
  const password = process.env.QA_DASHBOARD_PASSWORD;
  if (!company || !email || !password) {
    throw new Error(
      "QA_DASHBOARD_COMPANY, QA_DASHBOARD_EMAIL and QA_DASHBOARD_PASSWORD must all be set " +
        "(see .env.example). Run `npm run seed-qa-dashboard` first — it prints the handle to set.",
    );
  }

  const res = await fetch(`${BASE}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ company, email, password }),
    redirect: "manual",
  });
  if (res.status !== 303) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Signing in as ${email} at "${company}" answered ${res.status}, not the expected 303. ${body.slice(0, 200)}`,
    );
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const prefix = `${SESSION_COOKIE}=`;
  const line = setCookie.find((c) => c.startsWith(prefix));
  if (!line) {
    throw new Error(
      `Sign-in as ${email} at "${company}" reported success but set no ${SESSION_COOKIE} cookie.`,
    );
  }
  const value = decodeURIComponent(line.slice(prefix.length).split(";")[0]);
  return { name: SESSION_COOKIE, value, url: BASE };
}

/**
 * Reads the first agent link off the roster so the detail page can be scanned.
 *
 * Resolved ONCE, before the viewport loop, and waited for explicitly. The first
 * version resolved it per viewport with a bare querySelector, and on a
 * cold-started server the desktop pass found nothing and quietly skipped the
 * page — reporting a clean run that had not opened the route at all. A check
 * that can silently not happen is worse than no check.
 */
async function resolveAgentDetail(page: Page): Promise<string | null> {
  await page.goto(`${BASE}/agents`, { waitUntil: "networkidle" });
  try {
    await page.waitForSelector('a[href^="/agents/"]', { timeout: 10_000 });
  } catch {
    return null;
  }
  return page.evaluate(
    () => document.querySelector('a[href^="/agents/"]')?.getAttribute("href") ?? null,
  );
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844 },
];

/**
 * Crypto terminology, checked against RENDERED TEXT rather than source.
 *
 * The existing greps in verify-rollup.ts and verify-quickbooks.ts run over
 * serialized payloads, where every string is user-visible. Source code is a
 * different thing: "token" appears in design-token naming and "chain" in a CSS
 * class for the accounting page's step sequence, so grepping dashboard source
 * would produce false positives that train people to ignore the check.
 * document.body.innerText asks the question that actually matters — can a
 * person see a crypto term in the product — and answers it about the page.
 *
 * One deliberate difference from verify-quickbooks.ts: it bans bare "eip",
 * which is safe for a JSON payload but not for prose, because "receipt"
 * contains it. The rendered check looks for "eip155", the thing actually meant.
 */
const BANNED = [
  "0x",
  "usdc",
  "sepolia",
  "chain",
  "wallet",
  "eip155",
  "facilitator",
  "x402",
  // Added for 5C-1: the Integrations and Developer pages are the two most
  // likely places for this word to slip into prose, since one describes
  // custody-adjacent status and the other documents the payment API.
  "custody",
];
// "token" is checked separately so the failure message can name the trap.
const BANNED_TOKEN = "token";

let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`   FAIL  ${message}`);
  }
}

/** Serious and critical only. Minor axe findings are advisory, not a gate. */
/**
 * A demonstration-data claim appears only where a record carries the marker.
 *
 * Two halves. Every visible "Demo data" label must be the shared DemoTag pill,
 * which is rendered only from `isDemo` — so prose cannot smuggle the claim in.
 * And when no record on the page carries the marker, the page must not talk
 * about demonstration data at all.
 *
 * The second half is the one that matters. The Activity Ledger used to carry an
 * unconditional paragraph about demo rows, which meant a page of entirely real
 * payments still made a claim about demonstration data that nothing on it had
 * earned.
 */
async function checkDemoClaims(page: Page, label: string): Promise<void> {
  const { pills, text } = await page.evaluate(() => ({
    pills: document.querySelectorAll('[class*="pill-demo"]').length,
    text: document.body.innerText.toLowerCase(),
  }));

  const claims = ["demo data", "demonstration data", "seeded for demonstration"];
  if (pills === 0) {
    for (const claim of claims) {
      assert(
        !text.includes(claim),
        `${label}: nothing claims demonstration data when no record is marked`,
      );
    }
  } else {
    assert(text.includes("demo data"), `${label}: a marked record is labelled in words`);
  }
}

async function scanA11y(page: Page, label: string): Promise<void> {
  const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(async () => {
    return await window.axe.run(document, {
      resultTypes: ["violations"],
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  });

  const blocking = (results.violations as any[]).filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  for (const v of blocking) {
    console.error(`   FAIL  ${label}: ${v.id} (${v.impact}) — ${v.help}`);
    for (const node of v.nodes.slice(0, 3)) {
      console.error(`         ${node.target.join(" ")}`);
    }
  }
  assert(blocking.length === 0, `${label}: no serious or critical accessibility violations`);

  const advisory = (results.violations as any[]).filter(
    (v) => v.impact !== "serious" && v.impact !== "critical",
  );
  if (advisory.length > 0) {
    console.log(`   note  ${label}: ${advisory.length} advisory finding(s): ${advisory.map((v) => v.id).join(", ")}`);
  }
}

/**
 * Tabs through the page and checks that focus is both reachable and visible.
 *
 * There were no focus styles at all outside the accounting page before this
 * slice, so this is the check that keeps them from being dropped again.
 *
 * The question is asked per CONTROL, not per keypress. Chromium's
 * <input type="date"> is one control with several internal tab stops — three
 * date segments and a picker button — and while focus sits on the last of them
 * the host element stops reporting an outline. Asking once per keypress made
 * that look like a missing focus ring on a control that plainly has one.
 * Elements are identified by an expando stamped on first sight, and a control
 * passes if any of its stops showed an indicator.
 */
async function checkKeyboard(page: Page, label: string): Promise<void> {
  const controls = new Map<string, { tag: string; label: string; visible: boolean }>();

  for (let i = 0; i < 18; i += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      if (!el.__qaId) {
        window.__qaSeq = (window.__qaSeq ?? 0) + 1;
        el.__qaId = `e${window.__qaSeq}`;
      }
      const style = getComputedStyle(el);
      const outline =
        style.outlineStyle !== "none" && parseFloat(style.outlineWidth || "0") > 0;
      const ring = style.boxShadow !== "none" && style.boxShadow !== "";
      return {
        id: el.__qaId as string,
        tag: el.tagName.toLowerCase(),
        label: (el.textContent ?? "").trim().slice(0, 30),
        visible: outline || ring,
      };
    });
    if (!info) break;
    // Belt and braces: the suite refuses to run against a dev server, so this
    // overlay should never appear. Kept because if it ever does, silently
    // counting it as a product control would be the wrong failure.
    if (info.tag === "nextjs-portal") continue;

    const existing = controls.get(info.id);
    if (existing) existing.visible ||= info.visible;
    else controls.set(info.id, { tag: info.tag, label: info.label, visible: info.visible });
  }

  const reached = [...controls.values()];
  const blind = reached.filter((c) => !c.visible);
  for (const c of blind) {
    console.error(`   FAIL  ${label}: no focus indicator on <${c.tag}> "${c.label}"`);
  }

  assert(reached.length > 0, `${label}: keyboard focus reaches at least one control`);
  assert(blind.length === 0, `${label}: every focused control shows a visible focus indicator`);
  assert(
    reached[0]?.label.includes("Skip to content") ?? false,
    `${label}: the first tab stop is the skip link`,
  );
}

/**
 * Two questions, deliberately asked of two different things.
 *
 * What a person can SEE is a question about rendered text, so the terminology
 * list runs over innerText — source would false-positive on design-token naming
 * and a CSS class, and a check that cries wolf gets skipped.
 *
 * What LEAVES THE SERVER is a different question, and the 5A-1 security review
 * caught it being missed. Removing `walletAddress` from the dashboard's agent
 * type stopped it being rendered but not being transmitted: a TypeScript
 * annotation is erased at build time, so `return res.json()` still handed the
 * whole upstream object to a Client Component prop, and Next.js serialised it
 * into the page. Five addresses were arriving in the browser with nothing on
 * screen showing them, and an innerText check passes that every time.
 *
 * So the delivered bytes get their own check. It is a precise pattern rather
 * than the word list, because the full HTML legitimately contains hashed class
 * names and framework payload that the word list would trip over.
 *
 * `{40,}` and not `{40}`: a custody address is 40 hex characters but a
 * transaction hash is 64, and `GET /api/agents/:id` returns one on every
 * payment. The narrower pattern written in 5A-1 would have watched the agent
 * detail page ship 220 of them and reported all clear.
 */
const ADDRESS_SHAPED = /0x[0-9a-fA-F]{40,}/g;

/**
 * Every response body the page received, watched for custody identifiers.
 *
 * page.content() alone is not the question. It sees the settled DOM, which
 * misses anything the browser fetched and held without rendering — a prefetched
 * route payload, a background refresh, a response the framework caches. Those
 * reached the browser just as surely as the HTML did.
 *
 * Only textual bodies are read; pulling a PNG through text() would cost real
 * time and could never match.
 */
function watchResponses(page: Page): { hits: Map<string, number>; reset: () => void } {
  const hits = new Map<string, number>();
  page.on("response", (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (!/text\/|json|x-component/.test(type)) return;
    void response
      .text()
      .then((body) => {
        const found = body.match(ADDRESS_SHAPED);
        if (found) hits.set(new URL(response.url()).pathname, found.length);
      })
      .catch(() => {
        // A body that cannot be read cannot be scanned; redirects and aborted
        // requests land here and carry nothing.
      });
  });
  return { hits, reset: () => hits.clear() };
}

/**
 * The badge on screen must say what the SERVER says, or say nothing.
 *
 * This is the only check in the suite that talks to the Fuel API directly, and
 * it has to: the property being tested is agreement between two systems, and
 * neither half proves it alone. A badge reading "Sandbox" is not evidence of
 * anything if the dashboard could have written that word by itself.
 */
async function checkEnvironmentBadge(page: Page, label: string): Promise<void> {
  const badge = await page.evaluate(() => {
    const el = document.querySelector('[class*="env"][class*="Sandbox"], [class*="env"]');
    return el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : null;
  });

  const api = process.env.FUEL_API_URL;
  const key = process.env.FUEL_API_KEY;
  if (!api || !key) {
    assert(false, `${label}: FUEL_API_URL and FUEL_API_KEY must be set to verify the badge`);
    return;
  }

  const res = await fetch(`${api.replace(/\/$/, "")}/api/environment`, {
    headers: { Authorization: `Bearer ${key}` },
  }).catch(() => null);

  if (!res || !res.ok) {
    // Fuel could not be asked. The badge must then make NO CLAIM at all.
    assert(
      badge === null || !/sandbox|production/i.test(badge),
      `${label}: with no answer from Fuel, the shell claims no environment`,
    );
    return;
  }

  const verdict = (await res.json()) as { environment: string; label: string };
  assert(badge !== null, `${label}: the environment badge is present`);
  assert(
    badge !== null && badge.includes(verdict.label),
    `${label}: the badge says "${verdict.label}", which is the server's own label`,
  );
  // The one direction that must never happen: a screen calling it sandbox when
  // the server did not.
  if (verdict.environment !== "sandbox") {
    assert(
      badge !== null && !/sandbox/i.test(badge),
      `${label}: the badge does not say sandbox unless the server does`,
    );
  }
}

/**
 * The one route where a click is allowed to reveal crypto terms and an
 * address (ADR 0019), checked as narrowly as the exception is granted.
 *
 * Everything above this function's call site in the main loop already
 * proved the COLLAPSED state of this same page is exactly as clean as every
 * other route — checkVocabulary and the response watcher, unmodified, ran
 * first and were not told anything about this route being different. This
 * proves three further things, all scoped to the one click:
 *   1. the network response the click causes carries exactly one
 *      address-shaped value — this agent's own — and nothing else, so a
 *      second agent's address or a 64-character tx hash riding along would
 *      still fail this;
 *   2. the rendered, revealed page says exactly the terms this exception
 *      allows and none of the others, "wallet" included;
 *   3. hiding it again actually removes the address from the DOM, proving a
 *      real toggle rather than a one-way reveal.
 *
 * Ground truth comes from Fuel directly, with the SAME session cookie the
 * browser is using — not FUEL_API_KEY, which resolves to the bootstrap
 * company and would read another company's agent entirely for the
 * dedicated QA account scripts/seed-qa-dashboard.ts creates.
 */
async function checkFundingReveal(
  page: Page,
  label: string,
  sessionCookie: { value: string },
): Promise<void> {
  const idMatch = page.url().match(/\/agents\/([^/?#]+)/);
  const api = process.env.FUEL_API_URL;
  if (!idMatch || !api) {
    assert(false, `${label}: could not resolve an agent id or FUEL_API_URL to check the funding panel against`);
    return;
  }

  const truth = await fetch(`${api.replace(/\/$/, "")}/api/agents/${idMatch[1]}`, {
    headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionCookie.value)}` },
  }).catch(() => null);
  if (!truth || !truth.ok) {
    assert(false, `${label}: could not read this agent from Fuel directly to check the funding panel against`);
    return;
  }
  const verdict = (await truth.json()) as {
    funding?: { address: string; network: string; asset: string };
  };
  if (!verdict.funding) {
    // Nothing for this credential to reveal; the collapsed-state checks
    // above already covered this route in full.
    return;
  }
  const { address, network, asset } = verdict.funding;

  const showButton = page.getByRole("button", { name: "Show funding details" });
  await showButton.waitFor({ state: "visible" });
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes("/funding") && res.request().method() === "GET"),
    showButton.click(),
  ]);
  assert(response.ok(), `${label}: the funding fetch succeeds`);
  const deliveredAddresses = [...new Set((await response.text()).match(ADDRESS_SHAPED) ?? [])];
  assert(
    deliveredAddresses.length === 1 && deliveredAddresses[0] === address,
    `${label}: the funding response carries exactly this agent's address (${address}) and nothing ` +
      `else address-shaped (found: ${deliveredAddresses.join(", ") || "none"})`,
  );

  await page.waitForTimeout(150);
  const revealedText = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  // Exactly what this one state is allowed to say, and nothing this design
  // actually uses is exempted beyond it: "0x" (the address itself) and
  // "usdc"/"sepolia" (the asset and network names, spelled out on purpose —
  // see ADR 0019). "wallet", "chain" and everything else on BANNED stays
  // banned even here, because nothing in FundingPanel.tsx uses them.
  const allowedHere = new Set(["0x", "usdc", "sepolia"]);
  for (const term of BANNED) {
    if (allowedHere.has(term)) continue;
    assert(!revealedText.includes(term), `${label} (revealed): still says nothing about "${term}"`);
  }
  assert(
    !revealedText.includes(BANNED_TOKEN),
    `${label} (revealed): still says nothing about "${BANNED_TOKEN}"`,
  );
  assert(!revealedText.includes("wallet"), `${label} (revealed): never says "wallet" (ADR 0019)`);
  assert(revealedText.includes(network.toLowerCase()), `${label} (revealed): shows the real network`);
  assert(revealedText.includes(asset.toLowerCase()), `${label} (revealed): shows the real asset`);
  assert(revealedText.includes(address.toLowerCase()), `${label} (revealed): shows the real address`);

  const revealedContentAddresses = [...new Set((await page.content()).match(ADDRESS_SHAPED) ?? [])];
  assert(
    revealedContentAddresses.length === 1 && revealedContentAddresses[0] === address,
    `${label} (revealed): the delivered page carries exactly this agent's address (${address}) and ` +
      `nothing else address-shaped (found: ${revealedContentAddresses.join(", ") || "none"})`,
  );

  // Hide it again, and prove the collapse is real: the address actually
  // leaves the DOM rather than an overlay merely covering it.
  await page.getByRole("button", { name: "Hide funding details" }).click();
  await page.waitForTimeout(150);
  const hiddenText = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  assert(
    !hiddenText.includes(address.toLowerCase()),
    `${label}: hiding the panel actually removes the address from the page`,
  );
  for (const term of BANNED) {
    assert(!hiddenText.includes(term), `${label}: collapsed again, says nothing about "${term}"`);
  }
  assert(!hiddenText.includes(BANNED_TOKEN), `${label}: collapsed again, says nothing about "${BANNED_TOKEN}"`);
}

async function checkVocabulary(page: Page, label: string): Promise<void> {
  const text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  for (const term of BANNED) {
    assert(!text.includes(term), `${label}: nothing on screen says "${term}" (docs/decisions/0006)`);
  }
  assert(
    !text.includes(BANNED_TOKEN),
    `${label}: nothing on screen says "${BANNED_TOKEN}" (docs/decisions/0006)`,
  );

  const delivered = await page.content();
  const leaked = delivered.match(ADDRESS_SHAPED) ?? [];
  if (leaked.length > 0) {
    const unique = [...new Set(leaked)];
    console.error(
      `   FAIL  ${label}: ${unique.length} custody identifier(s) in the page, e.g. ${unique[0].slice(0, 6)}…${unique[0].slice(-4)}`,
    );
  }
  assert(
    leaked.length === 0,
    `${label}: no custody identifier in the delivered page (docs/decisions/0005)`,
  );
}

/**
 * The badge cannot claim an environment the server did not give it.
 *
 * Read once, from source, because the live check above can only observe the
 * state this deployment happens to be in — it sees "sandbox" agree with
 * "sandbox" and can say nothing about what would happen on the day the answer
 * is production, or unknown, or missing. These three properties are what make
 * those days safe, and they are visible in the code whether or not they are
 * reachable today.
 */
function checkBadgeSource(): void {
  const badge = readFileSync(path.join(ROOT, "dashboard/components/shell/EnvironmentBadge.tsx"), "utf8");
  const client = readFileSync(path.join(ROOT, "dashboard/lib/fuel.ts"), "utf8");
  // Comments explain the reasoning and would match every pattern below, which
  // is the "check that cries wolf" failure this codebase keeps having to avoid.
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  /*
   * The distinction that matters, and why this is not a blanket ban on the
   * word: comparing `environment.environment === "sandbox"` READS the server's
   * verdict to pick a colour, which is fine. Writing "Sandbox" as a string a
   * person sees ASSERTS it, which is the failure. The labels the server emits
   * are capitalised and its values are not, so case separates the two exactly.
   */
  assert(
    !/["'`](Sandbox|Production|Unknown)["'`]/.test(code(badge)),
    "the badge writes no environment name of its own — it renders the server's label",
  );
  assert(
    code(badge).includes("{environment.label}"),
    "the badge renders the label the server sent",
  );
  assert(
    code(badge).includes("if (!environment) return null;"),
    "the badge renders nothing when Fuel could not be asked, rather than guessing",
  );
  const fn = code(client).slice(code(client).indexOf("export async function getEnvironment"));
  assert(
    !/\?\?\s*["'`]sandbox["'`]/i.test(fn) && !/=\s*["'`]sandbox["'`]/i.test(fn),
    "nothing in the environment read defaults to sandbox",
  );
  assert(
    fn.includes("return null;"),
    "an unreachable or malformed answer becomes no claim, not a verdict",
  );
}

/**
 * Neither page may have written its own answer.
 *
 * Two things a source scan can prove that a live check cannot: that the
 * environment shown is the SAME VARIABLE the shell badge reads (so the two can
 * never quietly disagree), and that the QuickBooks fields these pages must not
 * have — a realm id, OAuth expiry timestamps, QuickBooks account ids — are not
 * referenced anywhere in the code path that builds them, not merely absent
 * from today's rendered output.
 *
 * Both /integrations and /accounting are covered here since ADR 0010, because
 * they now read the same contract and the thing worth protecting is that
 * neither goes around it.
 */
function checkAccountingContractSource(): void {
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const read = (rel: string) => code(readFileSync(path.join(ROOT, rel), "utf8"));

  const integrations = read("dashboard/app/integrations/page.tsx");
  const accounting = read("dashboard/app/accounting/page.tsx");
  const workbench = read("dashboard/components/AccountingWorkbench.tsx");
  const route = read("dashboard/app/api/quickbooks/route.ts");
  const lib = read("dashboard/lib/fuel.ts");

  for (const [name, src] of [
    ["/integrations", integrations],
    ["/accounting", accounting],
  ] as const) {
    assert(
      !/["'`](Sandbox|Production|Unknown)["'`]/.test(src),
      `${name} writes no environment name of its own — it renders the server's label`,
    );
  }
  assert(
    integrations.includes("{environmentLabel}"),
    "/integrations renders the same environment.label the shell badge reads",
  );
  assert(
    accounting.includes("getEnvironment()"),
    "/accounting takes its environment word from the server, not from this file",
  );

  // The raw passthrough. /integrations may not touch it at all; /accounting
  // still uses it for /postings, which is Fuel's own record, but never for the
  // connection status.
  assert(
    !integrations.includes("callQuickBooks"),
    "/integrations never calls the raw QuickBooks passthrough",
  );
  assert(
    !/callQuickBooks\("\/status"\)/.test(accounting),
    "/accounting reads the status through the contract, not the raw passthrough",
  );
  assert(
    route.includes("toAccountingStatus"),
    "the browser-facing proxy narrows /status before answering",
  );
  assert(
    route.includes("toAccountingActionResult"),
    "and narrows the action replies that also carry the connection object",
  );
  // Every allowlist entry states what happens to its body. `/status` was once
  // the only narrowed route while three others answered with the same raw
  // connection object; a per-entry field is what stops that recurring.
  const allowStart = route.indexOf("= [", route.indexOf("const ALLOWED"));
  const allowBody = route.slice(allowStart, route.indexOf("];", allowStart));
  for (const entry of allowBody.split("{ method:").slice(1)) {
    assert(
      /narrow:\s*"(status|action|none)"/.test(entry),
      `every proxy allowlist entry declares a narrowing (missing on: ${entry.slice(0, 50).trim()})`,
    );
  }

  // The forbidden fields, by name, in every file that could render one.
  const FORBIDDEN = [
    "realmId",
    "accessExpiresAt",
    "refreshExpiresAt",
    "expenseAccountId",
    "suspenseAccountId",
    "contraAccountId",
  ];
  for (const [name, src] of [
    ["/integrations", integrations],
    ["/accounting", accounting],
    ["AccountingWorkbench", workbench],
  ] as const) {
    for (const field of FORBIDDEN) {
      assert(!src.includes(field), `${name} cannot render "${field}" — it does not name it`);
    }
  }

  // The presenter itself: it must pick, and it must report failure as no claim.
  const at = lib.indexOf("export async function getAccountingStatus");
  assert(at !== -1, "fuel.ts exposes the narrowed accounting status");
  const fn = lib.slice(at, at + 800);
  for (const field of [...FORBIDDEN, "contraAccountKind", "rollupGrain"]) {
    assert(!fn.includes(field), `getAccountingStatus never reads "${field}" off the raw response`);
  }
  assert(fn.includes("return null;"), "getAccountingStatus reports failure as no claim");
  assert(
    fn.includes("toAccountingStatus"),
    "and narrows through the one shared contract rather than a second field list",
  );
}

/**
 * The one live number /integrations states about its own environment must
 * still be the server's, not merely absent from a hardcoded-literal scan.
 * Same shape of proof as checkEnvironmentBadge, against a different element.
 */
async function checkIntegrationsEnvironmentClaim(page: Page, label: string): Promise<void> {
  const shown = await page.evaluate(() => {
    const dts = [...document.querySelectorAll("dt")];
    const match = dts.find((el) => el.textContent?.trim() === "Environment");
    return match?.nextElementSibling?.textContent?.trim() ?? null;
  });

  const api = process.env.FUEL_API_URL;
  const key = process.env.FUEL_API_KEY;
  if (!api || !key) {
    assert(false, `${label}: FUEL_API_URL and FUEL_API_KEY must be set to verify this claim`);
    return;
  }
  const res = await fetch(`${api.replace(/\/$/, "")}/api/environment`, {
    headers: { Authorization: `Bearer ${key}` },
  }).catch(() => null);

  if (!res || !res.ok) {
    assert(
      shown === null || !/sandbox|production/i.test(shown),
      `${label}: with no answer from Fuel, the page claims no environment`,
    );
    return;
  }
  const verdict = (await res.json()) as { label: string };
  assert(shown !== null, `${label}: an environment value is shown`);
  assert(
    shown !== null && shown.includes(verdict.label),
    `${label}: it says "${verdict.label}", which is what the server says`,
  );
}

/**
 * The Overview and the Alerts panel, as the QA account (an owner) sees them
 * (ADR 0021).
 *
 * The Overview now renders the API's list. Against a running API, it must show
 * either lines or its "nothing needs a person" sentence, never the
 * could-not-read sentence, which would mean the page silently lost its source.
 *
 * The webhook field is write-only: a password field, autofill off, and empty
 * on every load, because the page never has the URL to put in it.
 */
async function checkOverviewAttention(page: Page, label: string): Promise<void> {
  const state = await page.evaluate(() => ({
    failed: document.body.innerText.includes("could not work out what needs attention"),
    lines: document.querySelectorAll("ul.attention > li").length,
    empty: document.body.innerText.includes("Nothing needs a person."),
  }));
  assert(!state.failed, `${label}: the Overview read what needs attention from Fuel`);
  assert(state.lines > 0 || state.empty, `${label}: and shows either its lines or that nothing needs a person`);
}

async function checkAlertsPanel(page: Page, label: string): Promise<void> {
  const field = await page.evaluate(() => {
    const el = document.querySelector("#alert-webhook") as { type: string; value: string; getAttribute(n: string): string | null } | null;
    return el ? { type: el.type, autocomplete: el.getAttribute("autocomplete"), value: el.value } : null;
  });
  assert(field !== null, `${label}: an owner sees the alert webhook field`);
  assert(
    field !== null && field.type === "password" && field.autocomplete === "off" && field.value === "",
    `${label}: the webhook field is a password field, autofill off, and empty`,
  );
}

/**
 * What the live QuickBooks connection actually holds, read from Fuel itself.
 *
 * The leak scan below has to look for the REAL values. Scanning for the string
 * "realmId" proves only that nobody shipped the key name; the identifier is
 * a bare number in a JSON body and would sail straight past. So this asks the
 * API what its own secrets are, once, and hunts for those.
 *
 * Returns null when there is nothing to hunt for — no connection, or Fuel is
 * unreachable — and the caller says so rather than silently scanning for
 * nothing and reporting a pass.
 */
async function liveProviderSecrets(): Promise<{ realmId: string; accountIds: string[]; expiries: string[] } | null> {
  const api = process.env.FUEL_API_URL;
  const key = process.env.FUEL_API_KEY;
  if (!api || !key) return null;
  const res = await fetch(`${api.replace(/\/$/, "")}/api/integrations/quickbooks/status`, {
    headers: { Authorization: `Bearer ${key}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const raw = (await res.json()) as any;
  if (!raw?.connected || typeof raw.realmId !== "string") return null;
  return {
    realmId: raw.realmId,
    accountIds: [raw.config?.expenseAccountId, raw.config?.suspenseAccountId, raw.config?.contraAccountId]
      .filter((v: unknown): v is string => typeof v === "string" && v.length > 0),
    expiries: [raw.accessExpiresAt, raw.refreshExpiresAt].filter(
      (v: unknown): v is string => typeof v === "string" && v.length > 0,
    ),
  };
}

/** Key names that describe a credential even when the credential is absent. */
const PROVIDER_KEYS = [
  "realmid",
  "accessexpiresat",
  "refreshexpiresat",
  "access_token",
  "refresh_token",
  "accesstoken",
  "refreshtoken",
  "clientid",
  "client_secret",
  "redirecturi",
  "redirect_uri",
  "expenseaccountid",
  "suspenseaccountid",
  "contraaccountid",
];

const TX_HASH_SHAPED = /\b0x[0-9a-fA-F]{64}\b/;

/**
 * Every response this page pulls, scanned for the provider's own data.
 *
 * Runs alongside watchResponses rather than inside it because the two answer
 * different questions and fail for different reasons: that one is about ADR
 * 0005 custody addresses, this one is about ADR 0010's provider boundary.
 *
 * ONE DELIBERATE EXEMPTION, named rather than quietly skipped: the posting
 * trace at `/postings/{id}/trace` carries `accountId` on purpose. It is the
 * key the workbench groups ledger lines by, and matching on the account NAME
 * instead was tried and was silently broken. That is a known, reported gap in
 * this boundary — the trace contract has not been narrowed and this slice did
 * not narrow it. Nothing else may carry an account id.
 */
function watchProviderLeaks(
  page: Page,
  secrets: { realmId: string; accountIds: string[]; expiries: string[] } | null,
): { hits: Map<string, string>; reset: () => void } {
  const hits = new Map<string, string>();
  page.on("response", (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (!/text\/|json|x-component/.test(type)) return;
    void response
      .text()
      .then((body) => {
        const where = new URL(response.url()).pathname + new URL(response.url()).search;
        const isTrace = /trace/.test(where);
        const lower = body.toLowerCase();

        for (const key of PROVIDER_KEYS) {
          if (lower.includes(key)) hits.set(`${where} :: key "${key}"`, key);
        }
        if (secrets) {
          if (body.includes(secrets.realmId)) {
            hits.set(`${where} :: the company's realm id`, secrets.realmId);
          }
          for (const expiry of secrets.expiries) {
            if (body.includes(expiry)) hits.set(`${where} :: an OAuth expiry timestamp`, expiry);
          }
          if (!isTrace) {
            for (const id of secrets.accountIds) {
              // Bounded, because an account id is a short number that would
              // otherwise match inside any amount or timestamp on the page.
              if (new RegExp(`"[^"]*[Aa]ccount[^"]*"\\s*:\\s*"?${id}\\b`).test(body)) {
                hits.set(`${where} :: a QuickBooks account id`, id);
              }
            }
          }
        }
        if (TX_HASH_SHAPED.test(body)) hits.set(`${where} :: a transaction-hash-shaped value`, "0x…");
        if (/https?:\/\/(sandbox-)?quickbooks|appcenter\.intuit|oauth\.platform/.test(lower)) {
          hits.set(`${where} :: a provider URL`, "intuit host");
        }
      })
      .catch(() => {
        // Unreadable bodies carry nothing: redirects and aborted requests.
      });
  });
  return { hits, reset: () => hits.clear() };
}

/**
 * The narrowed status, read the way the browser reads it.
 *
 * Fetched FROM INSIDE THE PAGE, so it goes through the same-origin check and
 * the same proxy route the workbench uses. This is the assertion that the
 * boundary is real rather than a property of the first render: /accounting's
 * props could be immaculate while every refetch after a Connect or a Post
 * handed the browser the raw object.
 */
async function checkAccountingStatusResponse(
  page: Page,
  label: string,
  sessionCookie: { value: string },
): Promise<void> {
  const result = await page.evaluate(async () => {
    const res = await fetch("/api/quickbooks?path=%2Fstatus");
    return { status: res.status, body: (await res.json()) as unknown };
  });

  if (result.status !== 200) {
    assert(
      result.status === 502 || result.status === 403,
      `${label}: an unnarrowable status is refused, never passed through (${result.status})`,
    );
    return;
  }

  const keys = Object.keys(result.body as Record<string, unknown>).sort();
  const expected = [
    "connected",
    "connectedAt",
    "currency",
    "currencyCheckedAt",
    "currencyVerified",
    "missing",
    "missingForRevenue",
    "readyToPost",
    "readyToPostRevenue",
  ];
  assert(
    keys.join(",") === expected.join(","),
    `${label}: the status the browser receives has exactly the contract's keys` +
      (keys.join(",") === expected.join(",") ? "" : ` — got ${keys.join(",")}`),
  );

  /*
   * The narrowing must not have DROPPED anything either.
   *
   * A closed-key check alone is passed by a contract that returns the right
   * key names holding nothing. Compared against the API's own answer, over
   * real HTTP, because the shipped bug was exactly this: the keys were all
   * present and the currency verification inside them had been reset to false.
   */
  const body = result.body as Record<string, unknown>;
  const api = process.env.FUEL_API_URL;
  if (!api) {
    assert(false, `${label}: FUEL_API_URL is not set, so the status cannot be compared with Fuel's own answer`);
    return;
  }
  /*
   * ASKED AS THE SAME PERSON THE BROWSER IS. This used to send the shared
   * operator key, which resolves to the BOOTSTRAP company. Since ADR 0018 the
   * page shows the signed-in viewer's own company, so once the QA account (its
   * own company, no QuickBooks connection) signed in, the two sides were
   * answering about different companies and five checks failed for a reason
   * that was the oracle's, not the page's. The session cookie is the viewer's
   * identity now, exactly as in checkFundingReveal.
   *
   * And an unreadable answer is a FAILURE, not a quiet return: the old early
   * return meant this half of the check could stop happening with nothing to
   * say so.
   */
  const upstream = await fetch(`${api.replace(/\/$/, "")}/api/integrations/quickbooks/status`, {
    headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionCookie.value)}` },
  }).catch(() => null);
  if (!upstream || !upstream.ok) {
    assert(false, `${label}: could not read the status from Fuel directly to compare the browser's answer against`);
    return;
  }
  const raw = (await upstream.json()) as any;

  assert(body.connected === raw.connected, `${label}: the connection state survives narrowing`);
  assert(body.readyToPost === raw.readyToPost, `${label}: so does ready-to-post`);
  assert(
    body.currency === (raw.accountingCurrency?.currency ?? null),
    `${label}: so does the currency — the narrowing drops nothing the page needs`,
  );
  assert(
    body.currencyVerified === (raw.accountingCurrency?.verified === true),
    `${label}: and its verification, which a non-idempotent narrowing silently reset`,
  );
  assert(
    JSON.stringify(body.missing) === JSON.stringify(raw.missing ?? []),
    `${label}: and the plain-English missing items, unchanged`,
  );
}

/**
 * Every `styles.x` a component reads is a class its CSS module actually defines.
 *
 * NEXT TYPES A CSS MODULE AS `any`, so `styles.dirctionIn` compiles, renders as
 * `className={undefined}`, and ships an unstyled element that looks almost
 * right. Nothing else in this project catches that: tsc passes, the page
 * renders, and the only symptom is a colour or a margin quietly missing.
 *
 * Static, and deliberately before the browser starts. It needs no server, it is
 * the cheapest check here, and a mistyped class is worth failing on before
 * spending a minute scanning pages styled by the class that does not exist.
 *
 * It is a one-way check. A class defined and never used is dead CSS, not a bug,
 * and flagging it would make every shared or state-dependent rule a failure.
 */
function checkStyleClassNames(): void {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) files.push(full);
    }
  };
  walk(path.join(ROOT, "dashboard", "app"));
  walk(path.join(ROOT, "dashboard", "components"));

  let scanned = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const importMatch = /import\s+styles\s+from\s+"(\.\/[^"]+\.module\.css)"/.exec(source);
    if (!importMatch) continue;

    const cssPath = path.resolve(path.dirname(file), importMatch[1]!);
    const rel = path.relative(ROOT, file);
    if (!existsSync(cssPath)) {
      assert(false, `${rel} imports a stylesheet that does not exist: ${importMatch[1]}`);
      continue;
    }

    const css = readFileSync(cssPath, "utf8");
    const defined = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]!));
    const used = new Set([...source.matchAll(/styles\.([A-Za-z]\w*)/g)].map((m) => m[1]!));
    const missing = [...used].filter((name) => !defined.has(name)).sort();

    assert(
      missing.length === 0,
      `${rel} reads styles.${missing.join(", styles.")}, which ${
        missing.length === 1 ? "is" : "are"
      } not defined in ${path.basename(cssPath)}`,
    );
    scanned += 1;
  }

  // A scan that finds nothing to scan prints a pass, which is the failure mode
  // this whole file exists to avoid.
  assert(scanned > 0, "no component imports a CSS module — this scan found nothing to check");
  console.log(`\nStyle class names: ${scanned} component(s) checked against their stylesheets.`);
}

async function main(): Promise<void> {
  // Before the server probe: these cost nothing and need nothing running.
  checkStyleClassNames();
  checkBadgeSource();
  checkAccountingContractSource();

  if (SOURCE_ONLY) {
    if (failures > 0) throw new Error(`${failures} of ${checks} source check(s) failed.`);
    console.log(`\nAll ${checks} checks passed. (source only: no server, browser or database)`);
    return;
  }

  const probe = await fetch(BASE).catch(() => null);
  if (!probe || !probe.ok) {
    throw new Error(
      `The dashboard is not answering at ${BASE}.\n` +
        `Start a production build with: cd dashboard && npm run build && npm run start`,
    );
  }

  // The dev overlay is the tell, and it is only ever served in development.
  if ((await probe.text()).includes("__next_devtools")) {
    throw new Error(
      `${BASE} is a development server, and this suite only measures production builds.\n` +
        `Dev injects a tools overlay into the tab order and echoes raw upstream API\n` +
        `responses into the page, so its results describe neither the product nor a bug.\n\n` +
        `  cd dashboard && npm run build && npm run start`,
    );
  }

  // Screenshots overwrite by name rather than the directory being wiped: the
  // one-off walkthrough shots (walkthrough-*.png, captured against a scratch
  // database copy so a real ledger could be exercised) are evidence from a
  // specific slice and are not regenerated by a routine run.
  mkdirSync(SHOTS, { recursive: true });

  // Read once, before any page loads, so every viewport hunts for the same
  // real values. Reported loudly when absent: a leak scan that quietly has
  // nothing to look for is worse than no scan, because it prints a pass.
  const secrets = await liveProviderSecrets();
  if (secrets === null) {
    console.log(
      "\nNo live QuickBooks connection — the provider-leak scan covers key NAMES and\n" +
        "shapes only this run, not the real realm id or account ids.",
    );
  } else {
    console.log(`\nProvider-leak scan armed with the live realm id and ${secrets.accountIds.length} account id(s).`);
  }

  const browser = await chromium.launch();

  try {
    // One sign-in for the whole run. Every browser context gets the same
    // cookie rather than signing in per viewport, so a throttled or slow
    // second sign-in can never make one viewport's pass see a different
    // account's data than another's.
    const sessionCookie = await signInAsQaDashboard();
    console.log(`\nSigned in as ${process.env.QA_DASHBOARD_EMAIL} for this run.`);

    // One resolution for the whole run, so every viewport measures the same
    // page and the check count is the same every time.
    const scoutContext = await browser.newContext();
    await scoutContext.addCookies([sessionCookie]);
    const scout = await scoutContext.newPage();
    const agentDetail = await resolveAgentDetail(scout);
    await scoutContext.close();
    if (agentDetail === null) {
      console.log("\nNo agents registered — the agent detail route is not covered by this run.");
    } else {
      console.log(`\nAgent detail route resolved to ${agentDetail}`);
    }

    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      await context.addCookies([sessionCookie]);
      const page = await context.newPage();
      const watcher = watchResponses(page);
      const leaks = watchProviderLeaks(page, secrets);

      for (const route of ROUTES) {
        const label = `${route.name} @ ${viewport.name}`;
        const target = route.path ?? agentDetail;
        if (target === null) continue;
        console.log(`\n== ${label}`);

        watcher.reset();
        leaks.reset();
        const response = await page.goto(`${BASE}${target}`, { waitUntil: "networkidle" });
        assert(response?.status() === 200, `${label}: responds 200`);

        const file = path.join(SHOTS, `${viewport.name}-${route.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`   shot  docs/ui/shots/${viewport.name}-${route.name}.png`);

        // The page body must never scroll sideways; wide content scrolls in its
        // own container instead.
        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        assert(!overflows, `${label}: the page does not scroll horizontally`);

        await checkVocabulary(page, label);
        await checkEnvironmentBadge(page, label);
        await checkDemoClaims(page, label);
        if (route.name === "integrations") {
          await checkIntegrationsEnvironmentClaim(page, label);
          await checkAlertsPanel(page, label);
        }
        if (route.name === "overview") {
          await checkOverviewAttention(page, label);
        }
        if (route.name === "accounting") {
          await checkAccountingStatusResponse(page, label, sessionCookie);
        }

        // Give any in-flight body reads a moment to resolve before judging.
        await page.waitForTimeout(150);
        for (const [path, count] of watcher.hits) {
          console.error(`   FAIL  ${label}: ${count} custody identifier(s) in the response for ${path}`);
        }
        assert(
          watcher.hits.size === 0,
          `${label}: no response to this page carries a custody identifier (docs/decisions/0005)`,
        );
        for (const [where, value] of leaks.hits) {
          console.error(`   FAIL  ${label}: ${where} (${value})`);
        }
        assert(
          leaks.hits.size === 0,
          `${label}: no response to this page carries provider identifiers or credential fields (docs/decisions/0010)`,
        );
        await scanA11y(page, label);
        await checkKeyboard(page, label);
        // LAST, DELIBERATELY. It clicks two buttons, which leaves keyboard
        // focus sitting on "Hide funding details" rather than at the top of
        // the page — harmless to the property it is checking, but it would
        // make checkKeyboard's very next Tab press start from the wrong
        // place and fail "the first tab stop is the skip link" for a reason
        // that has nothing to do with a real focus-order regression. Caught
        // by running this for real against the live dashboard.
        if (route.name === "agent-detail") {
          await checkFundingReveal(page, label, sessionCookie);
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${checks} checks, ${failures} failure(s).`);
  if (failures > 0) throw new Error(`${failures} QA check(s) failed.`);
  console.log("Dashboard QA clean.");
}

main().catch((error) => {
  console.error(`\n${(error as Error).message}`);
  process.exit(1);
});
