"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FuelAgent, FuelBudget } from "@/lib/fuel";
import { sendToSignIn } from "@/lib/signed-out";
import { AgentStatus, Authority } from "@/components/ui";

/**
 * The agent roster.
 *
 * The cap editor is carried over from 5A-1 unchanged in behaviour: the same
 * PATCH to the same dashboard route, the same per-row state machine, the same
 * two-step confirm before anything is sent. Only its trigger changed — see
 * CapCell.
 *
 * No new money-moving logic. Freeze and unfreeze are NOT here: the API has both
 * routes, but the dashboard has no route handler for them, and adding one is a
 * new mutation surface that needs its own slice and its own review. So an
 * agent's frozen state is reported and not offered.
 */

/** Same shape dollarsToBaseUnits accepts server-side — checked here only to
 * avoid a pointless round trip for obviously invalid input. The server is
 * still the real validator. */
const VALID_USD = /^\d+(\.\d+)?$/;

type RowMode =
  | { kind: "view" }
  | { kind: "edit"; draft: string; error?: string }
  | { kind: "confirm"; value: string }
  | { kind: "saving"; value: string };

export function AgentsRoster({
  initialAgents,
  teams,
}: {
  initialAgents: FuelAgent[];
  teams: FuelBudget[];
}) {
  const [agents, setAgents] = useState(initialAgents);
  const [modes, setModes] = useState<Record<string, RowMode>>({});
  const router = useRouter();

  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? "—";

  function modeFor(id: string): RowMode {
    return modes[id] ?? { kind: "view" };
  }
  function setMode(id: string, mode: RowMode) {
    setModes((prev) => ({ ...prev, [id]: mode }));
  }

  async function commit(agent: FuelAgent, value: string) {
    setMode(agent.id, { kind: "saving", value });
    try {
      const res = await fetch(`/api/agents/${agent.id}/cap`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spendCapUsd: value }),
    /*
     * See lib/signed-out.ts. `fuelFetch` answers Fuel's 401 with a redirect to
     * the sign-in page; followed automatically that arrives here as HTML and
     * `res.json()` fails with a parse error, which is the least useful way to
     * be told a session ended. Manual makes it visible.
     */
    redirect: "manual",
      });
      if (sendToSignIn(res)) return;

      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to set cap");

      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, ...body } : a)));
      setMode(agent.id, { kind: "view" });
      // Balance and spend can change independently of anything this page did —
      // pull the rest of the row's numbers fresh rather than trusting the PATCH
      // response for everything.
      router.refresh();
    } catch (error) {
      setMode(agent.id, {
        kind: "edit",
        draft: value,
        error: error instanceof Error ? error.message : "Failed to set cap",
      });
    }
  }

  if (agents.length === 0) {
    return (
      <p className="empty">
        No agents yet. Registering one gives it a Fuel account and a spend limit it cannot
        exceed without a person saying so.
      </p>
    );
  }

  return (
    <div className="scroll-x" tabIndex={0} role="region" aria-label="Agents">
      <table className="data-table">
        <caption className="visually-hidden">
          Every agent Fuel governs, with its team, spend authority, earnings, balance and status.
        </caption>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Team</th>
            <th scope="col">Authority used</th>
            <th scope="col" className="numeric">
              Remaining
            </th>
            {/*
              EARNED, AND DELIBERATELY NOT SPENT OR NET.
              
              Every other money column here is the CAP basis, which counts
              payments that might still move. A ledger-basis "Spent" beside
              "Authority used" would put two differently-defined figures in one
              row under names that read as synonyms, and "Net" cannot be shown
              without implying the spent figure it was computed from.
              
              "Earned" has no such twin: APPEARS_IN_RECEIPT_LEDGER is the only
              basis Fuel has for revenue, so the column means exactly one thing
              wherever it appears. The full earned/spent/net triple, with the
              sentence that separates the bases, is on the agent's own page.
            */}
            <th scope="col" className="numeric">
              Earned
            </th>
            <th scope="col" className="numeric">
              Balance
            </th>
            <th scope="col">Status</th>
            <th scope="col" className="numeric">
              Cap
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id}>
              <th scope="row" className="cell-name">
                <Link href={`/agents/${agent.id}`} className="row-link">
                  {agent.name}
                </Link>
              </th>
              <td>{teamName(agent.teamId)}</td>
              <td>
                <Authority
                  spent={agent.spent}
                  cap={agent.spendCap}
                  remaining={agent.remaining}
                />
              </td>
              <td className="numeric">${agent.remaining}</td>
              <td className="numeric">
                {/* Muted at zero: most agents have no endpoints, and a column of
                    emphatic $0.00 would draw the eye away from the one that does. */}
                {agent.ledger.earned === "0" ? (
                  <span className="muted">$0</span>
                ) : (
                  `$${agent.ledger.earned}`
                )}
              </td>
              <td className="numeric">
                {agent.balance === null ? (
                  <span className="muted" title="Fuel could not read this balance just now">
                    unknown
                  </span>
                ) : (
                  `$${agent.balance}`
                )}
              </td>
              <td>
                <AgentStatus frozen={agent.frozen} />
              </td>
              <td className="numeric">
                <CapCell
                  agent={agent}
                  mode={modeFor(agent.id)}
                  onEdit={() => setMode(agent.id, { kind: "edit", draft: agent.spendCap })}
                  onDraftChange={(draft) => setMode(agent.id, { kind: "edit", draft })}
                  onRequestConfirm={(value) => setMode(agent.id, { kind: "confirm", value })}
                  onCancel={() => setMode(agent.id, { kind: "view" })}
                  onConfirm={(value) => commit(agent, value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The cap editor.
 *
 * The trigger used to be the bare word "edit" styled as a link. Two problems
 * with that, both accessibility ones: a screen reader moving between form
 * controls heard "edit" five times with nothing to tell the rows apart, and a
 * text-coloured word gives no indication that it does something. It is now a
 * real button that looks like one, and its accessible name carries the agent it
 * belongs to. The same applies to the input, which had no label at all.
 *
 * The behaviour underneath is untouched: edit, then confirm, then send.
 */
function CapCell({
  agent,
  mode,
  onEdit,
  onDraftChange,
  onRequestConfirm,
  onCancel,
  onConfirm,
}: {
  agent: FuelAgent;
  mode: RowMode;
  onEdit: () => void;
  onDraftChange: (draft: string) => void;
  onRequestConfirm: (value: string) => void;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  if (mode.kind === "view") {
    return (
      <span className="cap-cell">
        ${agent.spendCap}
        <button
          type="button"
          className="btn"
          onClick={onEdit}
          aria-label={`Change spend cap for ${agent.name}`}
        >
          Change
        </button>
      </span>
    );
  }

  if (mode.kind === "edit") {
    const valid = VALID_USD.test(mode.draft.trim());
    return (
      <span className="cap-cell cap-cell-stack">
        <span className="cap-cell">
          <input
            className="cap-input"
            autoFocus
            inputMode="decimal"
            aria-label={`New spend cap for ${agent.name}, in dollars`}
            aria-invalid={!valid}
            value={mode.draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid) onRequestConfirm(mode.draft.trim());
              if (e.key === "Escape") onCancel();
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={!valid}
            onClick={() => onRequestConfirm(mode.draft.trim())}
          >
            Review
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </span>
        {mode.error && <span className="error-text">{mode.error}</span>}
      </span>
    );
  }

  if (mode.kind === "confirm") {
    return (
      <span className="confirm-row">
        <span>
          Set {agent.name}&rsquo;s cap to ${mode.value}?
        </span>
        <button type="button" className="btn btn-primary" onClick={() => onConfirm(mode.value)}>
          Confirm
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="muted" role="status">
      Saving ${mode.value}…
    </span>
  );
}
