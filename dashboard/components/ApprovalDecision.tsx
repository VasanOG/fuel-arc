"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendToSignIn } from "@/lib/signed-out";
import styles from "@/app/approvals/approvals.module.css";

/**
 * Approve or deny, from the queue.
 *
 * THE CONTROL docs/ui/phase-5-blueprint.md DEFERRED. Its reason for waiting was
 * that the roles governing it did not exist — the dashboard held one shared
 * operator key, so an approval made here would have been made by nobody in
 * particular. Stage 3 built the identity; this is the surface that uses it.
 *
 * THE SAME TWO-STEP SHAPE AS THE CAP EDITOR, deliberately and not as a
 * coincidence of taste. A per-row state machine, one row in flight at a time,
 * and a confirm step that restates the amount and the agent in a sentence
 * before anything is sent. Approving is irreversible in the direction that
 * matters — it lets a real payment through a ceiling that stopped it — so the
 * operator reads what they are doing after they have decided to do it.
 *
 * WHAT THIS COMPONENT DOES NOT DO: decide anything. It has no view on whether
 * this approval is still pending, whose company it belongs to, or whether it
 * has expired. Fuel re-reads the row through a company-scoped getter and guards
 * the transition inside the UPDATE, so a stale page whose row was decided by
 * somebody else a moment ago gets a refusal and shows it, rather than this code
 * guessing from a status it rendered minutes earlier.
 */

type Mode =
  | { kind: "idle"; error?: string }
  | { kind: "confirm"; decision: "approve" | "deny" }
  | { kind: "sending" };

export function ApprovalDecision({
  approvalId,
  agentName,
  amount,
}: {
  approvalId: string;
  agentName: string;
  amount: string;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const router = useRouter();

  async function send(decision: "approve" | "deny") {
    setMode({ kind: "sending" });
    try {
      const res = await fetch(`/api/approvals/${approvalId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
        /*
         * See lib/signed-out.ts. Without this the browser would silently follow
         * the sign-in redirect and hand back an HTML page for `res.json()` to
         * choke on, turning "you are signed out" into a parse error.
         */
        redirect: "manual",
      });
      if (sendToSignIn(res)) return;

      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Failed to record the decision");

      /*
       * The whole row is re-read from the server rather than patched in place.
       * A decision changes the status, the decided timestamp AND, on an
       * approval, the expiry — and `router.refresh()` also picks up anything
       * another operator changed while this page was open. Merging the response
       * into local state would leave a row that is right about the one field
       * this component knows about and quietly stale about the rest.
       */
      setMode({ kind: "idle" });
      router.refresh();
    } catch (error) {
      setMode({
        kind: "idle",
        error: error instanceof Error ? error.message : "Failed to record the decision",
      });
    }
  }

  if (mode.kind === "sending") {
    return (
      <span className="muted" role="status">
        Recording…
      </span>
    );
  }

  if (mode.kind === "confirm") {
    const verb = mode.decision === "approve" ? "Approve" : "Deny";
    return (
      <span className={styles.decide}>
        <span className={styles.decideAsk}>
          {/*
            The amount and the agent, restated. The operator chose this row from
            a table; the sentence is what makes sure they chose the row they
            meant, since every row in this queue looks alike at a glance.
          */}
          {verb} ${amount} for {agentName}?
        </span>
        <span className={styles.decideRow}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => send(mode.decision)}
          >
            {verb}
          </button>
          <button type="button" className="btn" onClick={() => setMode({ kind: "idle" })}>
            Cancel
          </button>
        </span>
      </span>
    );
  }

  return (
    <span className={styles.decide}>
      <span className={styles.decideRow}>
        <button
          type="button"
          className="btn"
          onClick={() => setMode({ kind: "confirm", decision: "approve" })}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setMode({ kind: "confirm", decision: "deny" })}
        >
          Deny
        </button>
      </span>
      {mode.error && <span className="error-text">{mode.error}</span>}
    </span>
  );
}
