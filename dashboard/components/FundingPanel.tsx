"use client";

import { useState } from "react";
import { sendToSignIn } from "@/lib/signed-out";
import type { FuelFunding } from "@/lib/fuel";

/**
 * An agent's funding address, network and asset — fetched, and shown, only
 * after a click.
 *
 * THE NARROW EXCEPTION ADR 0019 DESCRIBES, AND NOTHING WIDER THAN IT. This is
 * the one place in the dashboard allowed to say "Base Sepolia" or "USDC" or
 * show an address; everywhere else, `scripts/qa-dashboard.ts` still refuses
 * both. Collapsed (the default on every page load) this component renders one
 * button and nothing else — no term on ADR 0005's banned list, no
 * address-shaped byte anywhere the page delivers.
 *
 * NO ADDRESS IS EVER PASSED IN AS A PROP, ON PURPOSE. `agents/[id]/page.tsx`
 * (a Server Component) hands this component only `agentId` and `available` —
 * a boolean, never the value itself. Next.js serialises every prop a Server
 * Component gives a Client Component into the page's own delivered bytes,
 * whether or not that component currently renders it: a prop is not a
 * boundary, the same lesson `app/api/agents/[id]/funding/route.ts`'s own
 * comment draws from 5A-1's security review (docs/decisions/0005). So the
 * actual funding data only exists anywhere in the browser after the click
 * fetches it from that route, on demand.
 *
 * WHY BEHIND A CLICK RATHER THAN JUST BEHIND THE API'S OPERATOR CHECK. An
 * operator viewing this page ordinarily has no reason to see a deposit
 * address — most visits are about spend, not funding. The click keeps the
 * common case of this page exactly as address-free as every other dashboard
 * route, the way it was before this slice.
 *
 * "FUNDING ADDRESS", NEVER "WALLET". The exception exists to convey network,
 * asset and address safely — there is no reason to also say "wallet", so it
 * stays off this screen the same as every other one.
 */
type State =
  | { kind: "collapsed" }
  | { kind: "loading" }
  | { kind: "shown"; funding: FuelFunding }
  | { kind: "error"; message: string };

export function FundingPanel({ agentId, available }: { agentId: string; available: boolean }) {
  const [state, setState] = useState<State>({ kind: "collapsed" });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // Nothing to offer, and nothing to say about why not — the surface simply
  // is not here for a viewer the API did not include it for.
  if (!available) return null;

  async function reveal() {
    setState({ kind: "loading" });
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/funding`, {
        redirect: "manual",
      });
      if (sendToSignIn(res)) return;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ kind: "error", message: body.error ?? "Failed to read funding details" });
        return;
      }
      setState({ kind: "shown", funding: body as FuelFunding });
    } catch {
      setState({ kind: "error", message: "Failed to read funding details" });
    }
  }

  if (state.kind === "collapsed" || state.kind === "error") {
    return (
      <>
        <button type="button" className="btn" onClick={reveal}>
          Show funding details
        </button>
        {state.kind === "error" && (
          <p className="note" role="alert">
            {state.message}
          </p>
        )}
      </>
    );
  }

  if (state.kind === "loading") {
    return (
      <span className="muted" role="status">
        Reading funding details…
      </span>
    );
  }

  const { funding } = state;

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(funding.address);
      setCopyState("copied");
    } catch {
      // A blocked clipboard (permissions, insecure context) is not this
      // component's problem to diagnose — the address is already on screen,
      // selectable and readable, so "select it yourself" is a real fallback.
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 2000);
  }

  return (
    <div className="panel panel-pad">
      <div className="notice notice-bad" role="status">
        <strong>Sending on the wrong network loses the money, permanently.</strong> Send only{" "}
        {funding.asset} on {funding.network} to the address below. Fuel cannot recover a transfer
        sent on a different network or in a different asset.
      </div>
      <dl className="record">
        <div>
          <dt>Network</dt>
          <dd>{funding.network}</dd>
        </div>
        <div>
          <dt>Asset</dt>
          <dd>{funding.asset}</dd>
        </div>
        <div>
          <dt>Funding address</dt>
          <dd className="mono">
            {funding.address}{" "}
            <button type="button" className="btn" onClick={copyAddress}>
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Select to copy" : "Copy"}
            </button>
          </dd>
        </div>
      </dl>
      <button type="button" className="btn" onClick={() => setState({ kind: "collapsed" })}>
        Hide funding details
      </button>
    </div>
  );
}
