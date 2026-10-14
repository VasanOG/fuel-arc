// The "Try it yourself" panel on the proof page. Talks to the Try-it door
// (demo/try-it/door.ts), the one public program that can make the demo agent
// pay. The page sends the name of an item and nothing else; the door builds
// the request to Fuel from its own table. Everything shown here is the door's
// answer, in Fuel's words.
(() => {
  const DOOR = "https://fuel-arc-demo.fly.dev";
  const root = document.getElementById("try-it");
  if (!root) return;
  const status = document.getElementById("try-status");
  const buttons = document.getElementById("try-buttons");
  const recent = document.getElementById("try-recent");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const tone = (o) => (o === "paid" ? "paid" : o === "held" ? "held" : "refused");
  const words = { paid: "Paid", held: "Held for approval", "refused-rate-limit": "Refused: spending too fast", "refused-cap": "Refused: over a spend cap", "refused-frozen": "Refused: agent frozen", "refused-approval": "Refused: approval not valid", failed: "Not completed" };
  let busy = false;
  let open = false;

  const call = (path, body) => fetch(DOOR + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, json: j })));

  function row(a) {
    const when = new Date(a.at).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    let extra = "";
    if (a.explorerUrl) extra = ' <a href="' + esc(a.explorerUrl) + '">view on the Arc explorer</a>';
    if (a.outcome === "held" && a.approvalRequestId) extra = ' <button class="try-complete" data-id="' + esc(a.approvalRequestId) + '">Complete payment</button> <span class="try-note">Approve it first in <a href="' + DOOR + '/approvals">Fuel\'s dashboard</a> (judge login below), then press Complete payment.</span>';
    return '<li class="' + tone(a.outcome) + '"><span class="try-when">' + esc(when) + "</span> " + esc(a.item) + " " + esc(a.amountUsd) + ": <b>" + esc(words[a.outcome] || a.outcome) + "</b> <span class='try-msg'>" + esc(a.message) + "</span>" + extra + "</li>";
  }

  function render(s) {
    open = !!s.open;
    status.textContent = open
      ? "The live demo is open. Today " + s.forwardedTodayUsd + " of its " + s.dailyCapUsd + " daily budget has been used. The agent pays on " + s.network + "."
      : "The live demo is closed right now: " + (s.closedDetail || "not available") + " The ledger and the explorer links on this page still work.";
    buttons.innerHTML = s.items.map((i) => '<button class="try-buy" data-item="' + esc(i.name) + '"' + (open && !busy ? "" : " disabled") + ">Buy " + esc(i.name) + " (" + esc(i.amountUsd) + ")<small>" + esc(i.label) + "</small></button>").join("");
    recent.innerHTML = (s.recent || []).map(row).join("") || "<li class='try-none'>No attempts through this page yet.</li>";
  }

  function refresh() {
    return call("/try/status").then((r) => render(r.json)).catch(() => {
      status.textContent = "The live demo is offline right now. The ledger and the explorer links on this page still work.";
      buttons.innerHTML = "";
    });
  }

  function act(path, body, label) {
    if (busy) return;
    busy = true;
    status.textContent = label + " Fuel is checking the agent's caps, then signing and settling on Arc; this takes a few seconds.";
    buttons.querySelectorAll("button").forEach((b) => (b.disabled = true));
    call(path, body)
      .then((r) => {
        if (r.json && r.json.outcome) status.textContent = words[r.json.outcome] + ". " + r.json.message;
        else status.textContent = (r.json && r.json.error) || "The demo did not answer.";
      })
      .catch(() => { status.textContent = "The demo could not be reached."; })
      .finally(() => { busy = false; setTimeout(refresh, 1200); });
  }

  root.addEventListener("click", (e) => {
    const buy = e.target.closest("button.try-buy");
    if (buy) return act("/try/buy", { item: buy.dataset.item }, "Asking Fuel to pay for " + buy.dataset.item + ".");
    const done = e.target.closest("button.try-complete");
    if (done) return act("/try/complete", { approvalRequestId: done.dataset.id }, "Checking the approval, then asking Fuel to pay.");
  });

  refresh();
  setInterval(refresh, 30000);
})();
