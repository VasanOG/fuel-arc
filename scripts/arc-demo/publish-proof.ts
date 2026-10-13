/**
 * Writes the public, read-only proof page for the Arc founder demo.
 *
 *   npx tsx scripts/arc-demo/publish-proof.ts [--repo https://github.com/<owner>/<repo>]
 *
 * Mainnet  -> docs/arc/index.html (served by GitHub Pages once the repo is public)
 * Rehearsal -> ~/.fuel-arc/rehearsal-proof/index.html (never published)
 *
 * TWO SOURCES, LABELLED APART, and that is the point of the page:
 *   - THE LEDGER: every attempt Fuel recorded for the demo agent, read straight
 *     from the demo instance's database (read-only), with an Arc explorer link
 *     for each payment that moved money.
 *   - THE DEMO RUNNER'S LOG: refusals that happen before Fuel reserves anything
 *     write no ledger row (a frozen agent only bumps a counter), so those are
 *     shown from the runner's own log and say so.
 *
 * The page names Arc, USDC and wallet addresses on purpose: it exists to let a
 * stranger check the payments on the chain. Fuel's product surfaces stay in
 * dollars only.
 *
 * Reads nothing secret: the database's payment and approval rows, the runner's
 * log, and the two public addresses.
 *
 * ALSO WRITES TWO CSVS, for the same reason the page shows two tables:
 *   - ledger-export.csv is Fuel's own accounting export, UNMODIFIED -- the
 *     same route a real operator would call (GET /exports/transactions.csv),
 *     run here against the demo database and saved verbatim. It carries no
 *     transaction hash, wallet address or network name, on purpose (ADR
 *     0006) -- that is the shape of a file meant to leave Fuel and land in a
 *     company's real books.
 *   - proof.csv is built only for this page. It is the evidence file: one row
 *     per attempt, with the transaction hash and explorer link this page
 *     shows, so the claims here are checkable without reading HTML.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ARC_LIFETIME_LIMIT_BASE_UNITS, ARC_MAX_PER_PAYMENT_BASE_UNITS, ARC_TESTNET, MAINNET_DEMO } from "../../src/payments/arc-chain.js";

const args = process.argv.slice(2);
const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1]! : "https://github.com/VasanOG/fuel";

const chain = MAINNET_DEMO.chain;
const rehearsal = chain.chainId === ARC_TESTNET.chainId;
const dir = join(homedir(), ".fuel-arc");
const dbPath = join(dir, rehearsal ? "rehearsal.db" : "fuel-arc.db");
const logPath = join(dir, `${rehearsal ? "rehearsal" : "mainnet"}-runlog.jsonl`);
const outDir = rehearsal ? join(dir, "rehearsal-proof") : join("docs", "arc");

const db = new DatabaseSync(dbPath, { readOnly: true });

interface Row {
  id: string;
  amount_base_units: number;
  resource_url: string;
  status: string;
  tx_hash: string | null;
  refusal_code: string | null;
  created_at: string;
  settled_at: string | null;
  approval_status: string | null;
  approval_decided_at: string | null;
  approval_decided_by: string | null;
}
const rows = db
  .prepare(
    `SELECT p.id, p.amount_base_units, p.resource_url, p.status, p.tx_hash, p.refusal_code, p.created_at, p.settled_at,
            ar.status AS approval_status, ar.decided_at AS approval_decided_at, ar.decided_by AS approval_decided_by
     FROM payments p
     LEFT JOIN approval_requests ar ON ar.payment_id = p.id
     WHERE p.agent_id = ?
     ORDER BY p.created_at ASC, p.rowid ASC`,
  )
  .all(MAINNET_DEMO.agentId) as unknown as Row[];

// Held payments: the blocked row that raised the approval request, by agent/url/amount and time.
const held = db
  .prepare("SELECT id, status, blocked_scope, decided_at, decided_by, payment_id, created_at FROM approval_requests WHERE agent_id = ? ORDER BY created_at")
  .all(MAINNET_DEMO.agentId) as unknown as { id: string; status: string; blocked_scope: string; decided_at: string | null; decided_by: string | null; payment_id: string | null; created_at: string }[];

const log = existsSync(logPath)
  ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  : [];
const noLedgerRow = log.filter((e) => e.status === 423);

const REFUSAL: Record<string, string> = {
  AGENT_FROZEN: "the agent was frozen",
  APPROVAL_INVALID: "the approval could not be redeemed",
  AGENT_CAP: "over the agent's own cap",
  TEAM_CAP: "over the team's cap",
  COMPANY_CAP: "over the company's cap",
  VELOCITY: "too many payments too quickly",
  ANOMALY: "an unusual amount for this agent",
};
const HELD = new Set(["ANOMALY", "TEAM_CAP", "COMPANY_CAP"]);

/** Whole cents as $0.01, tenths of a cent as $0.001, anything finer to six places. */
const usd = (units: number | bigint) => {
  const n = Number(units);
  return `$${(n / 1e6).toFixed(n % 10_000 === 0 ? 2 : n % 1000 === 0 ? 3 : 6)}`;
};
const item = (url: string) => url.replace(/^.*\/item\//, "");
const when = (iso: string) => iso.replace("T", " ").slice(0, 19) + " UTC";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const txLink = (hash: string) =>
  !TX_HASH.test(hash)
    ? "recorded hash is not a transaction hash"
    : `<a href="${chain.explorerUrl}/tx/${hash}">${hash.slice(0, 10)}…${hash.slice(-6)}</a> <span class="live" data-tx="${hash}"></span>`;
const addrLink = (a: string) => `<a href="${chain.explorerUrl}/address/${a}"><code>${a}</code></a>`;

function decision(r: Row): { text: string; tone: string; chain: string } {
  const nothing = "stopped before signing; nothing on chain";
  if (r.status === "settled") {
    const approved = r.approval_status === "consumed" ? ` after approval (operator key, ${when(r.approval_decided_at ?? r.created_at)})` : "";
    return { text: `Paid${approved}`, tone: "paid", chain: r.tx_hash ? txLink(r.tx_hash) : "no transaction recorded" };
  }
  if (r.status === "blocked") {
    const why = REFUSAL[r.refusal_code ?? ""] ?? "reason not recorded";
    return HELD.has(r.refusal_code ?? "")
      ? { text: `Held for approval: ${why}`, tone: "held", chain: nothing }
      : { text: `Refused: ${why}`, tone: "refused", chain: nothing };
  }
  if (r.status === "failed") return { text: "Not completed: refused before a signature existed; budget released", tone: "refused", chain: nothing };
  if (r.status === "unreconciled") return { text: "Signed, settlement not confirmed (budget kept)", tone: "held", chain: r.tx_hash ? txLink(r.tx_hash) : "check the agent's wallet on the explorer" };
  return { text: "In progress", tone: "held", chain: "" };
}

const paid = rows.filter((r) => r.status === "settled");
const paidTotal = paid.reduce((s, r) => s + Number(r.amount_base_units), 0);
// Held rows are blocked rows too, but they are counted as held, not refused.
const refusedRows = rows.filter((r) => (r.status === "blocked" && !HELD.has(r.refusal_code ?? "")) || r.status === "failed");
const unconfirmed = rows.filter((r) => r.status === "unreconciled");

const ledgerRows = rows
  .map((r) => {
    const d = decision(r);
    return `<tr class="${d.tone}"><td>${when(r.created_at)}</td><td>${esc(item(r.resource_url))}</td><td class="num">${usd(r.amount_base_units)}</td><td>${esc(d.text)}</td><td>${d.chain}</td></tr>`;
  })
  .join("\n");
const logRows = noLedgerRow
  .map((e) => `<tr class="refused"><td>${when(String(e.at))}</td><td>${esc(String(e.item ?? ""))}</td><td>Refused: the agent was frozen by the operator (HTTP 423)</td></tr>`)
  .join("\n");

/** RFC 4180: quote a field only when it needs it, doubling internal quotes. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function toCsv(header: string[], data: string[][]): string {
  return [header, ...data].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

const proofCsv = toCsv(
  ["When (UTC)", "Item", "Amount (USD)", "Fuel's decision", "Transaction hash", "Explorer URL"],
  [
    ...rows.map((r) => {
      const d = decision(r);
      const plainDecision = d.text.replace(/<[^>]+>/g, "");
      return [when(r.created_at), item(r.resource_url), usd(r.amount_base_units), plainDecision, r.tx_hash ?? "", r.tx_hash && TX_HASH.test(r.tx_hash) ? `${chain.explorerUrl}/tx/${r.tx_hash}` : ""];
    }),
    ...noLedgerRow.map((e) => [when(String(e.at)), String(e.item ?? ""), "", "Refused: the agent was frozen by the operator (HTTP 423) -- no ledger row; from the demo runner's log, not Fuel's ledger", "", ""]),
  ],
);

const title = rehearsal ? "Fuel on Arc: rehearsal (Arc testnet, not real money)" : "Fuel on Arc: governed agent payments on Arc mainnet";
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fuel on Arc</title>
<meta name="description" content="An AI agent's real USDC payments on Arc, each one checked by Fuel's spend controls first, with explorer links.">
<style>
  :root { --bg:#fafaf7; --ink:#14171f; --muted:#5b6170; --line:#dcdcd4; --paid:#0b6b4f; --held:#9a5b00; --refused:#a12a2a; --card:#ffffff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1218; --ink:#e8e9ec; --muted:#9aa0ad; --line:#2a2f3a; --paid:#4cc79c; --held:#e2a04a; --refused:#ef7a7a; --card:#161a22; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 1.7rem; line-height:1.25; margin: 0 0 8px; }
  h2 { font-size: 1.05rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 40px 0 12px; }
  p { max-width: 70ch; }
  .lead { font-size: 1.1rem; }
  .note { border-left: 3px solid var(--held); background: var(--card); padding: 12px 16px; max-width: 75ch; }
  .facts { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .fact { background:var(--card); border:1px solid var(--line); padding: 12px 14px; }
  .fact b { display:block; font-size:1.4rem; }
  .fact span { color:var(--muted); font-size:.9rem; }
  .wrap { overflow-x:auto; border:1px solid var(--line); background:var(--card); }
  table { border-collapse: collapse; width:100%; font-size:.92rem; }
  th, td { text-align:left; padding: 8px 10px; border-bottom:1px solid var(--line); vertical-align: top; }
  th { color:var(--muted); font-weight:600; white-space:nowrap; }
  td.num { font-variant-numeric: tabular-nums; white-space:nowrap; }
  tr.paid td:nth-child(4) { color: var(--paid); }
  tr.held td:nth-child(4) { color: var(--held); }
  tr.refused td:nth-child(4) { color: var(--refused); }
  code { font-size: .85em; word-break: break-all; }
  a { color: inherit; }
  ul { padding-left: 20px; max-width: 75ch; }
  .live { color: var(--paid); font-size: .85rem; white-space: nowrap; }
  .live-panel { color: var(--muted); font-size: .92rem; }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="lead">Fuel is a wallet and spend-control layer for AI agents. Here, one agent pays for items in ${rehearsal ? "test" : "real"} USDC on ${esc(chain.label)}, and every payment passes Fuel's controls first: spend caps, a hold for unusual amounts that a person must approve, a rate limit, a freeze switch, and a ledger of every attempt.</p>
<p class="note"><strong>Who is who.</strong> The agent, its wallet, the shop and the shop's wallet are all mine (the founder of Fuel). Every payment below moves my own ${rehearsal ? "test " : ""}USDC from my agent's wallet to my shop's wallet. The shop is a three-item demo I operate so the controls have something real to pay for. No customer funds are involved.</p>

<h2>At a glance</h2>
<div class="facts">
  <div class="fact"><b>${paid.length}</b><span>payments that moved money (${usd(paidTotal)} in total)</span></div>
  <div class="fact"><b>${held.length}</b><span>held for a person to approve (${held.filter((h) => h.status === "consumed").length} approved and then paid)</span></div>
  <div class="fact"><b>${refusedRows.length + noLedgerRow.length}</b><span>refused before anything was signed</span></div>
  ${unconfirmed.length ? `<div class="fact"><b>${unconfirmed.length}</b><span>signed but not confirmed by the shop: money may have moved, so Fuel counts it as spent</span></div>` : ""}
  <div class="fact"><b>${usd(ARC_MAX_PER_PAYMENT_BASE_UNITS)} / ${usd(ARC_LIFETIME_LIMIT_BASE_UNITS)}</b><span>hard limits in code: per payment, and in total over the agent's life</span></div>
</div>

<h2>Wallets and network</h2>
<p id="live-status" class="live-panel">Checking ${esc(chain.label)} from your browser…</p>
<ul>
  <li>Agent wallet: ${addrLink(MAINNET_DEMO.address)} <span class="live" data-balance="${MAINNET_DEMO.address}"></span></li>
  <li>Shop wallet (mine): ${addrLink(MAINNET_DEMO.payee)} <span class="live" data-balance="${MAINNET_DEMO.payee}"></span></li>
  <li>Network: ${esc(chain.label)}, chain id ${chain.chainId}. USDC at <code>${chain.asset}</code>; Arc charges its network fees in USDC too, paid here by the shop's wallet when it settles each payment.</li>
</ul>

<h2>From Fuel's ledger</h2>
<p>Every attempt Fuel recorded for this agent, read from the demo instance's database. A paid row links to its transaction on the Arc explorer; a held or refused row has no transaction, because Fuel stopped it before a signature existed.</p>
<div class="wrap"><table>
<thead><tr><th>When</th><th>Item</th><th>Amount</th><th>Fuel's decision</th><th>On chain</th></tr></thead>
<tbody>
${ledgerRows || '<tr><td colspan="5">No payments yet.</td></tr>'}
</tbody></table></div>

<h2>From the demo runner's log (not the ledger)</h2>
<p>Some refusals happen before Fuel reserves anything, so they leave no row in the ledger: a frozen agent is turned away at the door, and Fuel only counts the attempt. These come from the log kept by the script that drove the demo, not from Fuel's ledger.</p>
<div class="wrap"><table>
<thead><tr><th>When</th><th>Item</th><th>What happened</th></tr></thead>
<tbody>
${logRows || '<tr><td colspan="3">None.</td></tr>'}
</tbody></table></div>

<h2>How the lock works</h2>
<ul>
  <li>Exactly one agent may pay on Arc. It is named in code by its id, its company's id and its wallet address. Every other agent and company in Fuel stays on test money (Base Sepolia), with every testnet guard unchanged.</li>
  <li>That agent's signer signs only a USDC transfer on Arc, from its own wallet, to my shop's wallet, of at most ${usd(ARC_MAX_PER_PAYMENT_BASE_UNITS)}, and only while its lifetime total stays at or under ${usd(ARC_LIFETIME_LIMIT_BASE_UNITS)}.</li>
  <li>The shop settles each payment itself, submitting the signed transfer to Arc, and its settler can submit nothing else.</li>
  <li>An automated test suite (<code>scripts/verify-arc-lock.ts</code>, run on every change) checks all of the above. Before going live, each part of the lock was also deliberately broken, one way at a time, and each break was caught by its own check.</li>
</ul>

<h2>Download</h2>
<ul>
  <li><a href="proof.csv">proof.csv</a> — every row above, with the transaction hash and explorer link, built for this page.</li>
  <li><a href="ledger-export.csv">ledger-export.csv</a> — Fuel's own accounting export, unmodified, for the same agent: no transaction hashes, wallet addresses or network names, by design (<a href="${esc(repo)}/blob/main/docs/decisions/0006-accounting-export-omits-crypto-identifiers.md">ADR 0006</a>).</li>
</ul>

<h2>Source</h2>
<p>Code: <a href="${esc(repo)}">${esc(repo)}</a>. The Arc pieces are <code>src/payments/arc-chain.ts</code>, <code>src/payments/arc-demo.ts</code>, <code>demo/arc-shop/</code> and <code>scripts/verify-arc-lock.ts</code>.</p>
<p style="color:var(--muted);font-size:.85rem">Generated ${when(new Date().toISOString())} from the demo instance's ledger and runner log. The balances and confirmations marked live are read from ${esc(chain.label)} by your browser when the page opens (${esc(chain.rpcUrl)}), not by Fuel.</p>
</main>
<script>
// Reads the chain directly from the visitor's browser: nothing here talks to Fuel.
(() => {
  const RPC = ${JSON.stringify(chain.rpcUrl)}, USDC = ${JSON.stringify(chain.asset)}, CHAIN = ${chain.chainId};
  const call = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
  const status = document.getElementById("live-status");
  Promise.all([call("eth_chainId", []), call("eth_blockNumber", [])]).then(([id, block]) => {
    const ok = parseInt(id, 16) === CHAIN;
    status.textContent = ok ? "Live from " + ${JSON.stringify(chain.label)} + ", block " + parseInt(block, 16).toLocaleString() + ", read by your browser just now." : "The RPC answered for chain " + parseInt(id, 16) + ", not " + CHAIN + ".";
    if (!ok) return;
    document.querySelectorAll("[data-balance]").forEach((el) => {
      const data = "0x70a08231" + el.dataset.balance.slice(2).toLowerCase().padStart(64, "0");
      call("eth_call", [{ to: USDC, data }, "latest"]).then((v) => { el.textContent = "balance now $" + (Number(BigInt(v)) / 1e6).toFixed(6); }).catch(() => {});
    });
    const txs = [...document.querySelectorAll("[data-tx]")];
    let i = 0;
    const next = () => {
      const el = txs[i++]; if (!el) return;
      call("eth_getTransactionReceipt", [el.dataset.tx]).then((r) => {
        el.textContent = !r ? "not found" : r.status === "0x1" ? "confirmed, block " + parseInt(r.blockNumber, 16).toLocaleString() : "reverted";
      }).catch(() => {}).finally(next);
    };
    for (let k = 0; k < 4; k++) next();
  }).catch(() => { status.textContent = "Could not reach " + ${JSON.stringify(chain.label)} + " from your browser; the explorer links below still work."; });
})();
</script>
</body>
</html>
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.html"), html);
writeFileSync(join(outDir, "proof.csv"), proofCsv);
console.log(`${join(outDir, "index.html")}: ${rows.length} ledger rows (${paid.length} paid), ${noLedgerRow.length} from the runner's log`);
console.log(`${join(outDir, "proof.csv")}: ${rows.length + noLedgerRow.length} rows`);
if (!rehearsal && !existsSync(join(outDir, "ledger-export.csv"))) {
  console.log(`note: ${join(outDir, "ledger-export.csv")} does not exist yet -- fetch it from GET /exports/transactions.csv (operator key) before this page's download link will work`);
}
