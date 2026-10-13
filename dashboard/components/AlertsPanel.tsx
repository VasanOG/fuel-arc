"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { sendToSignIn } from "@/lib/signed-out";
import {
  deliveryWords,
  isHttpsAddress,
  moment,
  outcomeShort,
  testSentence,
  type FuelAlertRecord,
  type FuelAlertWebhook,
} from "@/lib/alerts";
import { StatusPill } from "@/components/ui";
import styles from "@/app/integrations/integrations.module.css";

/**
 * Where this company's alerts go, for its owner (ADR 0021).
 *
 * THE FIELD IS WRITE-ONLY. The page never has the webhook URL to show: Fuel
 * returns its host and nothing more. So the input starts empty every time,
 * is cleared after a save, and is a password field so the URL is not on
 * screen while it is typed or pasted, since its path is the secret.
 *
 * A PASSWORD FIELD CAN BE AUTOFILLED WITH A PASSWORD. A browser that has saved
 * this person's Fuel sign-in may offer it here. So nothing that does not start
 * with https:// leaves the browser: the check below runs before any request,
 * and an autofilled sign-in password is refused on this page, not sent to Fuel
 * to be refused there.
 *
 * Replacing and removing each restate what will happen before doing it,
 * because both send one notice to the CURRENT destination: a person reading
 * that channel learns alerts were moved, which is the point (review F10).
 */

type Mode =
  | { kind: "idle" }
  | { kind: "confirm-replace" }
  | { kind: "confirm-remove" }
  | { kind: "sending" };

type Message = { tone: "ok" | "bad"; text: string } | null;

export function AlertsPanel({
  webhook,
  alerts,
}: {
  webhook: FuelAlertWebhook;
  alerts: FuelAlertRecord[];
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [message, setMessage] = useState<Message>(null);

  async function call(method: "PUT" | "DELETE" | "POST", body?: { url: string }) {
    setMode({ kind: "sending" });
    setMessage(null);
    try {
      const res = await fetch("/api/alerts", {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        // See lib/signed-out.ts: a sign-in redirect is not JSON.
        redirect: "manual",
      });
      if (sendToSignIn(res)) return null;
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ tone: "bad", text: typeof json.error === "string" ? json.error : "Fuel could not make that change." });
        return null;
      }
      return json as Record<string, unknown>;
    } catch {
      setMessage({ tone: "bad", text: "Fuel could not be reached. Try again." });
      return null;
    } finally {
      setMode({ kind: "idle" });
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!isHttpsAddress(url)) {
      // Checked here, before any request: see the note above about autofill.
      setMessage({ tone: "bad", text: "The webhook must be an https:// address." });
      return;
    }
    if (webhook.configured) setMode({ kind: "confirm-replace" });
    else void commitSave();
  }

  async function commitSave() {
    // Again here, not only in save(): the Replace button calls this directly.
    if (!isHttpsAddress(url)) {
      setMessage({ tone: "bad", text: "The webhook must be an https:// address." });
      setMode({ kind: "idle" });
      return;
    }
    const result = await call("PUT", { url: url.trim() });
    if (result === null) return;
    setUrl("");
    setMessage({ tone: "ok", text: "Saved. Fuel will send new alerts there. Send a test to check it works." });
    router.refresh();
  }

  async function remove() {
    const result = await call("DELETE");
    if (result === null) return;
    setMessage({ tone: "ok", text: "Alerts are off. Nothing will be sent until a webhook is set again." });
    router.refresh();
  }

  async function test() {
    const result = await call("POST");
    if (result === null) return;
    const outcome = typeof result.outcome === "string" ? result.outcome : "";
    setMessage({ tone: result.delivered === true ? "ok" : "bad", text: testSentence(outcome) });
    router.refresh();
  }

  const sending = mode.kind === "sending";
  const host = webhook.host ?? "the current webhook";

  return (
    <div className="panel-pad">
      {webhook.sweeperStale && (
        <p className="notice notice-bad" role="alert">
          Fuel has not checked for new alerts since {moment(webhook.sweeperLastRunAt)}. Until it does,
          nothing new will be sent. Whoever runs Fuel should check that its API is running.
        </p>
      )}
      {webhook.state === "degraded" && (
        <p className="notice notice-bad" role="alert">
          Alerts to {host} are failing
          {webhook.lastOutcome ? `: ${outcomeShort(webhook.lastOutcome)}` : ""}. Fuel now tries at
          most once every 15 minutes. Send a test, or replace the webhook.
        </p>
      )}
      {webhook.state === "unreadable" && (
        <p className="notice notice-bad" role="alert">
          Fuel cannot read the stored webhook, so no alerts are being sent. Replace it below.
        </p>
      )}

      <dl className="record">
        <div>
          <dt>Alerts go to</dt>
          <dd>
            {webhook.configured ? (
              <span className={styles.ok}>{webhook.host ?? "A webhook Fuel cannot read"}</span>
            ) : (
              <span className={styles.pending}>Nowhere yet</span>
            )}
            {webhook.setAt && <span className={styles.since}>set {moment(webhook.setAt)}</span>}
          </dd>
        </div>
        <div>
          <dt>Last delivery</dt>
          <dd>
            {webhook.lastOutcome === null ? (
              <span className={styles.pending}>Nothing sent yet</span>
            ) : webhook.lastOutcome === "delivered" ? (
              <span className={styles.ok}>Delivered</span>
            ) : (
              <span className={styles.pending}>Failed: {outcomeShort(webhook.lastOutcome)}</span>
            )}
            {webhook.lastAttemptAt && <span className={styles.since}>{moment(webhook.lastAttemptAt)}</span>}
          </dd>
        </div>
        <div>
          <dt>Checked for alerts</dt>
          <dd>
            {webhook.sweeperLastRunAt === null ? (
              <span className={styles.pending}>Not yet</span>
            ) : (
              <span className={webhook.sweeperStale ? styles.pending : styles.ok}>
                {moment(webhook.sweeperLastRunAt)}
              </span>
            )}
          </dd>
        </div>
      </dl>

      {/*
        method="post" and no `name` on the field: if this handler ever failed to
        attach, a native submit would otherwise be a GET with the URL in the
        address bar, the history and any proxy log (review of commit 2).
      */}
      <form className={styles.alertForm} onSubmit={save} method="post" autoComplete="off">
        <label htmlFor="alert-webhook" className={styles.fieldLabel}>
          {webhook.configured ? "Replace the webhook URL" : "Webhook URL"}
        </label>
        <div className={styles.fieldRow}>
          <input
            id="alert-webhook"
            type="password"
            className={styles.field}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (mode.kind === "confirm-replace") setMode({ kind: "idle" });
            }}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            maxLength={2048}
            placeholder="https://hooks.slack.com/services/…"
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            aria-describedby="alert-webhook-hint"
            disabled={sending}
          />
          <button type="submit" className="btn btn-primary" disabled={sending || url.trim() === ""}>
            Save webhook
          </button>
        </div>
        <p id="alert-webhook-hint" className={styles.hint}>
          A Slack incoming webhook, or any service that accepts Slack&apos;s message format. Fuel
          stores it encrypted and never shows it again, only its host.
        </p>
      </form>

      {mode.kind === "confirm-replace" && (
        <div className={styles.confirm} role="group" aria-label="Confirm replacing the webhook">
          <p className={styles.confirmAsk}>
            Send alerts to the new webhook instead of {host}? {host} gets one message saying the
            destination changed.
          </p>
          <div className={styles.actions}>
            <button type="button" className="btn btn-primary" onClick={() => void commitSave()}>
              Replace
            </button>
            <button type="button" className="btn" onClick={() => setMode({ kind: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode.kind === "confirm-remove" && (
        <div className={styles.confirm} role="group" aria-label="Confirm turning alerts off">
          <p className={styles.confirmAsk}>
            Stop sending alerts to {host}? It gets one message saying alerts were turned off.
            Everything that needs a person stays on the Overview.
          </p>
          <div className={styles.actions}>
            <button type="button" className="btn btn-primary" onClick={() => void remove()}>
              Turn alerts off
            </button>
            <button type="button" className="btn" onClick={() => setMode({ kind: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {webhook.configured && mode.kind !== "confirm-remove" && mode.kind !== "confirm-replace" && (
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={() => void test()} disabled={sending}>
            Send a test alert
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setMode({ kind: "confirm-remove" })}
            disabled={sending}
          >
            Turn alerts off
          </button>
        </div>
      )}

      {sending && (
        <p className="muted" role="status">
          Working…
        </p>
      )}
      {message && (
        <p className={message.tone === "ok" ? styles.resultOk : "error-text"} role={message.tone === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}

      <h3 className={styles.subhead}>Recent alerts</h3>
      {alerts.length === 0 ? (
        <p className={styles.pending}>
          None yet. An alert is recorded here when something starts needing a person.
        </p>
      ) : (
        <ul className={styles.history}>
          {alerts.map((a, i) => (
            <li key={`${a.openedAt}-${i}`} className={styles.historyItem}>
              <StatusPill label={a.label} tone={a.resolvedAt === null ? "watch" : "quiet"} />
              <span className={styles.historyWhat}>
                {a.unreadable ? "Details unavailable" : (a.agentName ?? a.teamName ?? "This company")}
                {a.amount !== null && ` · $${a.amount}`}
              </span>
              <span className={styles.historyMeta}>
                {moment(a.openedAt)}
                {a.resolvedAt !== null && " · resolved"} · {deliveryWords(a, webhook.configured)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
