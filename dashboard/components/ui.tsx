import { isExhausted, isOverAuthority, percentUsed } from "@/lib/money";
import type { Tone } from "@/lib/presentation";

/**
 * Small presentational pieces shared by the operator pages.
 *
 * No "use client" and no server-only imports, so these work on both sides of
 * the boundary — a Server Component can render them, and so can the roster,
 * which needs to be a Client Component for the cap editor.
 */

export function StatusPill({ label, tone = "quiet" }: { label: string; tone?: Tone }) {
  return <span className={tone === "quiet" ? "pill" : `pill pill-${tone}`}>{label}</span>;
}

/**
 * An agent's stored state — nothing derived.
 *
 * Frozen and "no authority left" are deliberately NOT merged into one status.
 * Freezing is a decision someone made and `frozen_at` records it; running out
 * of authority is arithmetic on two other numbers. Showing them as alternatives
 * in one pill would suggest a frozen agent has budget left, or that an
 * exhausted one has been acted on. They are separate facts, shown separately —
 * this column, and the authority column beside it.
 */
export function AgentStatus({ frozen }: { frozen: boolean }) {
  return frozen ? (
    <StatusPill label="Frozen" tone="bad" />
  ) : (
    <StatusPill label="Active" tone="good" />
  );
}

/**
 * Marks one record as seeded demonstration data.
 *
 * Rendered ONLY from `isDemo`, which is `payments.is_demo` /
 * `approval_requests.is_demo` — a column no production write path can set.
 * Never from a name, a date, an amount, a vendor, a test-looking string, or
 * `detail`. The dashboard used to infer it from `detail === "demo-seed"`, and
 * that was wrong twice over: a third-party merchant can put any string in a
 * payment's detail, so the inference was both unreliable and attacker-
 * influenced.
 *
 * A record without the marker gets NO LABEL — not "real", not "unverified".
 * Fuel says a thing is demonstration data when the database says so, and is
 * silent otherwise.
 *
 * Defined here rather than inline so the ledger, the agent record and the
 * approvals queue cannot end up calling the same fact three different things.
 */
export function DemoTag() {
  return <span className="pill pill-demo">Demo data</span>;
}

function formatPct(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/**
 * Spend against the ceiling that governs it.
 *
 * Spend can legitimately exceed a cap: an approved payment is allowed through,
 * and `src/db/approvals.ts` states plainly that "spent <= cap is not an
 * invariant". So the bar clamps its width at full but the words do not clamp —
 * an agent at 800% says 800%, because the overage is the interesting part and
 * every one of them traces back to a named approval.
 */
export function Authority({
  spent,
  cap,
  remaining,
}: {
  spent: string;
  cap: string;
  remaining: string;
}) {
  const pct = percentUsed(spent, cap);
  const over = isOverAuthority(spent, cap);
  const spentUp = isExhausted(remaining);

  let state = "";
  if (over) state = " is-over";
  else if (spentUp) state = " is-spent";

  return (
    <div className="authority">
      <span className="authority-figures">
        ${spent} <span className="muted">of ${cap}</span>
      </span>
      <span className="authority-track" aria-hidden="true">
        <span className={`authority-fill${state}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </span>
      <span className={`authority-note${state}`}>
        {pct === null
          ? "No authority granted"
          : over
            ? `${formatPct(pct)} used — over authority`
            : spentUp
              ? "No authority left"
              : `${formatPct(pct)} used`}
      </span>
    </div>
  );
}
