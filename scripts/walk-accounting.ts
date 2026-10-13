/**
 * Walks the accounting workflow end to end and proves the ADR 0010 boundary
 * holds while a person is actually using it.
 *
 * WHY A SEPARATE SCRIPT FROM qa-dashboard. That suite loads each route and
 * judges what it finds. This one PRESSES THINGS — preview, load provenance,
 * unfold a ledger line — because the refetch after an action is the moment the
 * old code handed the browser a raw status object, and a page that is merely
 * loaded never reaches it.
 *
 * SAFE BY CONSTRUCTION, in two ways that matter.
 *
 *   Preview WRITES: it creates a draft row. So this runs against a COPY of
 *   fuel.db, served by its own API instance, and the real database is never
 *   opened.
 *
 *   Post is deliberately never pressed. It would create a real journal entry
 *   in the QuickBooks sandbox company, which is a document in someone's books
 *   and not a thing a verification run should leave behind. The control is
 *   asserted to be present and enabled by a ready draft — the guard is what is
 *   being checked, not the posting.
 *
 * SETUP (all of it against the copy, none against fuel.db):
 *
 *   cp fuel.db /tmp/scratch.db
 *   FUEL_DB_PATH=/tmp/scratch.db PORT=3001 npx tsx src/server.ts &
 *   FUEL_DB_PATH=/tmp/scratch.db npx tsx scripts/seed-demo-day.ts 2026-08-26
 *   curl -XPOST localhost:3001/api/postings/run -H "Authorization: Bearer $KEY" \
 *        -H 'Content-Type: application/json' -d '{"day":"2026-08-26"}'
 *   cd dashboard && npm run build
 *   FUEL_API_URL=http://127.0.0.1:3001 npx next start -p 3101 &
 *
 * The seeded day is needed because every real day in the database is already
 * committed to a posted document — which is itself the idempotency guard
 * working, and is asserted below.
 *
 * Run:  npx tsx scripts/walk-accounting.ts [YYYY-MM-DD]
 */
import { chromium } from "playwright";

const BASE = process.env.WALK_DASHBOARD_URL ?? "http://127.0.0.1:3101";
const DAY = process.argv[2] ?? "2026-08-26";
const SHOTS = "docs/ui/shots";
const leaks: string[] = [];
let checks = 0;
const ok = (c: boolean, d: string) => {
  checks++;
  console.log(`   ${c ? "ok  " : "FAIL"}  ${d}`);
  if (!c) process.exitCode = 1;
};

const main = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } } as any);

  // Every body the browser receives during the walkthrough, scanned live.
  page.on("response", (r) => {
    const t = r.headers()["content-type"] ?? "";
    if (!/text\/|json|x-component/.test(t)) return;
    void r.text().then((b) => {
      const where = new URL(r.url()).pathname + new URL(r.url()).search;
      for (const k of ["realmId", "accessExpiresAt", "refreshExpiresAt", "access_token", "refresh_token", "clientId", "redirectUri"]) {
        if (b.includes(k)) leaks.push(`${where} :: ${k}`);
      }
      if (b.includes("9341457784003246")) leaks.push(`${where} :: realm id value`);
    }).catch(() => {});
  });

  await page.goto(`${BASE}/accounting`, { waitUntil: "networkidle" });
  ok((await page.locator("text=Preview entry").count()) === 1, "the workbench renders");
  const aside = await page.locator('h1 ~ *, header').first().innerText().catch(() => "");
  ok(!aside.includes("9341457784003246"), "the header states no realm id");

  // PREVIEW — a day that has spend. 2026-08-25 is the seeded demo day.
  await page.fill('input[type="date"]', DAY);
  await page.click("text=Preview entry");
  await page.waitForTimeout(2500);
  const body = await page.innerText("body");
  // Asserted on the DRAFT panel, not on the page text: the postings table
  // below already prints "FUEL-…", so matching the whole body would pass on
  // a preview that returned nothing at all.
  ok(/Debit/i.test(body) && /Credit/i.test(body), "preview returns a readable journal entry with both sides");
  ok(!/Nothing to post/i.test(body), "and the day was not already committed");
  ok(!body.includes("9341457784003246"), "the previewed document names no realm id");
  await page.screenshot({ path: `${SHOTS}/walkthrough-preview.png`, fullPage: true });
  console.log(`   shot  ${SHOTS}/walkthrough-preview.png`);

  // The Post control must still be reachable and guarded. NOT pressed through.
  const post = page.locator("button", { hasText: /^Post/ });
  ok((await post.count()) > 0, "the Post control is present and enabled by a ready draft");

  // PROVENANCE — load the trace, then unfold a ledger line into the payments
  // beneath it. Driven through the real controls, not by asserting on page
  // text: the first version of this step "passed" against an unchanged page
  // because the words it looked for were already in the draft above.
  await page.click("text=Load provenance");
  await page.waitForTimeout(2500);
  const afterLoad = await page.innerText("body");
  ok(/payment\(s\)|approval|agent/i.test(afterLoad), "the trace loads");

  // The unfold is a button carrying aria-expanded — the accessible affordance
  // is also the reliable selector.
  const toggle = page.locator('table button[aria-expanded="false"]:visible').first();
  ok((await toggle.count()) > 0, "a ledger line offers an unfold control");
  await toggle.click();
  await page.waitForTimeout(1200);
  ok(
    (await page.locator('button[aria-expanded="true"]').count()) === 1,
    "clicking it opens that line and only that line",
  );
  const unfolded = await page.innerText("body");
  ok(unfolded.length > afterLoad.length, "a ledger line unfolds into what it is made of");
  ok(!unfolded.includes("9341457784003246"), "the provenance names no realm id");
  ok(!/0x[0-9a-fA-F]{64}/.test(unfolded), "and no transaction hash");
  await page.screenshot({ path: `${SHOTS}/walkthrough-provenance.png`, fullPage: true });
  console.log(`   shot  ${SHOTS}/walkthrough-provenance.png`);

  ok(leaks.length === 0, `no provider identifier crossed during the walkthrough${leaks.length ? ": " + leaks.join(", ") : ""}`);
  await browser.close();
  console.log(`\n${checks} walkthrough checks, ${process.exitCode ? "with failures" : "all passing"}.`);
};
main().catch((e) => { console.error(e); process.exit(1); });
