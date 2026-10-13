import type { Metadata } from "next";
import styles from "./login.module.css";

export const metadata: Metadata = { title: "Sign in · Fuel" };

// Never cached: the notice below is decided per request.
export const dynamic = "force-dynamic";

/**
 * The sign-in page.
 *
 * A form and nothing else — no client JavaScript, no state, no fetch. It posts
 * to /api/session, which proxies the Fuel API and relays the session cookie.
 * The page is deliberately the least clever thing in the product, because it
 * is the page an operator reaches when the rest of it has stopped working.
 *
 * THERE IS NO "CREATE AN ACCOUNT" LINK, and its absence is the design. Accounts
 * exist only by redeeming an invite somebody deliberately minted, and the
 * invite carries its own link. A sign-up affordance here would advertise a door
 * that is not there.
 *
 * NOR IS THERE A "FORGOT YOUR PASSWORD" LINK. Fuel sends no email, so there is
 * no self-serve reset to offer, and a link that opened a form which could never
 * deliver anything would be worse than saying nothing. The recovery path today
 * is `scripts/set-password.ts`, run by someone with access to the machine; the
 * note at the bottom says so rather than leaving a person guessing.
 */

/**
 * Every notice this page can show, keyed by a code the sign-in route chooses.
 *
 * A CLOSED SET, LOOKED UP — never a message read out of the URL. The query
 * string is written by whoever sends the link, so rendering text from it would
 * let anyone put their own sentence on Fuel's sign-in page: "your session
 * expired, confirm your card details to continue" on a real Fuel URL is a
 * phishing page we would have built ourselves. An unknown code shows nothing.
 *
 * The wording for a refusal repeats the API's deliberate vagueness. The server
 * will not say whether the company or the address exists — see the REFUSAL
 * comment in src/auth/routes.ts — and a friendlier sentence here ("no company
 * with that handle") would undo that.
 */
const NOTICES: Record<string, { text: string; tone: "bad" | "quiet" }> = {
  refused: { text: "That company, email and password do not match an account.", tone: "bad" },
  throttled: {
    text: "Too many sign-in attempts from here. Wait a few minutes and try again.",
    tone: "bad",
  },
  busy: { text: "Fuel is checking too many sign-ins at once. Try again in a moment.", tone: "bad" },
  unreachable: {
    text: "Fuel could not be reached, so you were not signed in. Nothing has changed.",
    tone: "bad",
  },
  expired: { text: "Your session has ended. Sign in again to carry on.", tone: "quiet" },
  out: { text: "You are signed out.", tone: "quiet" },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.e) ? params.e[0] : params.e;
  const notice = raw ? NOTICES[raw] : undefined;

  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <p className={styles.brand}>Fuel</p>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.lead}>
          Fuel needs to know who you are before it will show you a company&rsquo;s money. A decision
          you make here is recorded against your name, not against a shared key.
        </p>

        {notice && (
          <p
            className={notice.tone === "bad" ? styles.noticeBad : styles.noticeQuiet}
            role={notice.tone === "bad" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        )}

        {/*
          `method="post"` and a real action. No onSubmit, no preventDefault:
          if this page's JavaScript never arrives, the form still works.
        */}
        <form className={styles.form} method="post" action="/api/session">
          {/*
            THE COMPANY COMES FIRST, because an account belongs to one company
            and the same address can have an account at another (ADR 0018).
            It is TYPED, never chosen from a list: a list of the companies an
            address belongs to is exactly what this design keeps anyone from
            learning. Not remembered for now, and never guessed from the email.
            autoComplete is OFF, not "organization": that token fills in a
            company's NAME from a saved address, which is never the handle and
            would only produce a refusal nobody could explain.
          */}
          <label className={styles.field}>
            <span className={styles.label}>Company</span>
            <input
              className={`${styles.input} ${styles.handle}`}
              type="text"
              name="company"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="acme-7k2q"
              aria-describedby="company-hint"
              required
              autoFocus
            />
            <span id="company-hint" className={styles.hint}>
              Your company&rsquo;s handle. Whoever invited you has it, and anyone signed in to
              the company sees it under their name.
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Email</span>
            <input
              className={styles.input}
              type="email"
              name="email"
              autoComplete="username"
              required
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Password</span>
            <input
              className={styles.input}
              type="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </label>

          <button type="submit" className={`btn btn-primary ${styles.submit}`}>
            Sign in
          </button>
        </form>

        <p className={styles.foot}>
          Accounts are created by invitation only. If you are locked out of one you own, its
          password can be reset from the machine Fuel runs on.
        </p>
      </main>
    </div>
  );
}
