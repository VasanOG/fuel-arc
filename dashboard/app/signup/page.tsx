import type { Metadata } from "next";
import styles from "../login/login.module.css";

export const metadata: Metadata = { title: "Redeem your invitation · Fuel" };

// Never cached: the notice below is decided per request.
export const dynamic = "force-dynamic";

/**
 * Redeeming an invitation.
 *
 * A form and nothing else — no client JavaScript, no state, no fetch, and the
 * same card as the sign-in page it sits beside. It posts to /api/signup, which
 * proxies the Fuel API and relays the session cookie.
 *
 * THE INVITATION CODE IS TYPED IN, NOT READ FROM THE LINK. There is no
 * /signup?t=… form of this page, deliberately. A token in a URL survives in
 * browser history, in the address bar over somebody's shoulder, and in every
 * access log the request passes through — three places that outlive the invite
 * itself, which is single-use and worth a real account. Fuel sends no email, so
 * there is no link being clicked anyway: the code arrives as text somebody
 * already has to copy, and a paste costs nothing over a click that does not
 * exist.
 *
 * THERE IS NO "REQUEST AN INVITATION". Accounts exist only because somebody
 * deliberately minted an invite, and a form promising to ask on your behalf
 * would advertise a door that is not there. The note at the bottom says so
 * plainly instead.
 */

/**
 * Every notice this page can show, keyed by a code.
 *
 * A CLOSED SET, LOOKED UP — never a message read out of the URL, and never the
 * API's own sentence. The query string is written by whoever sends the link, so
 * rendering text from it would let anyone put their own words on a real Fuel
 * page; "your invitation expired, confirm your card details to continue" on a
 * genuine Fuel URL is a phishing page we would have built ourselves. An unknown
 * code shows nothing.
 *
 * The keys are the SIGNUP_CODES vocabulary from src/auth/codes.ts, plus two
 * this page owns because Fuel never sees them: `mismatch` (the confirmation
 * field, checked before the call) and `unreachable` (Fuel did not answer).
 * verify-api asserts the two sets line up, so a code added on the server cannot
 * quietly become a blank notice here.
 *
 * `invite_unusable` repeats the API's deliberate vagueness. The server will not
 * say whether a code was forged, expired, withdrawn, or simply addressed to
 * somebody else — see InviteNotUsableError in src/db/invites.ts — and a more
 * helpful sentence here would undo exactly what that refusal is protecting.
 */
const NOTICES: Record<string, { text: string; tone: "bad" | "quiet" }> = {
  incomplete: { text: "Fill in every field to continue.", tone: "bad" },
  invite_unusable: {
    text: "That invitation is not valid, or has already been used.",
    tone: "bad",
  },
  password_weak: { text: "Choose a password of at least 12 characters.", tone: "bad" },
  email_taken: {
    text: "That email address already has a Fuel account. Sign in instead.",
    tone: "bad",
  },
  mismatch: { text: "Those two passwords do not match. Try typing them again.", tone: "bad" },
  throttled: {
    text: "Too many attempts from here. Wait a few minutes and try again.",
    tone: "bad",
  },
  busy: { text: "Fuel is handling too many requests at once. Try again in a moment.", tone: "bad" },
  unreachable: {
    text: "Fuel could not be reached, so no account was created. Your invitation is unused.",
    tone: "bad",
  },
};

export default async function SignupPage({
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
        <h1 className={styles.title}>Redeem your invitation</h1>
        <p className={styles.lead}>
          Somebody invited you to a company on Fuel. Setting a password here creates your account
          and signs you in. Decisions you make afterwards are recorded against your name.
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
        <form className={styles.form} method="post" action="/api/signup">
          <label className={styles.field}>
            <span className={styles.label}>Invitation code</span>
            <input
              className={styles.input}
              type="text"
              name="token"
              autoComplete="off"
              spellCheck={false}
              required
              autoFocus
            />
          </label>

          {/*
            The address is typed, not prefilled, because the invitation is bound
            to one and the server compares them. Getting it wrong is refused, so
            the field is asking the person to confirm who the invite was for.
          */}
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
              autoComplete="new-password"
              minLength={12}
              required
            />
          </label>

          {/*
            NOT A COURTESY. Fuel has no self-serve password reset, so a typo
            here produces an account nobody can open without shell access to the
            machine Fuel runs on. The route checks the two before calling Fuel.
          */}
          <label className={styles.field}>
            <span className={styles.label}>Confirm password</span>
            <input
              className={styles.input}
              type="password"
              name="confirm"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </label>

          <button type="submit" className={`btn btn-primary ${styles.submit}`}>
            Create account
          </button>
        </form>

        <p className={styles.foot}>
          Accounts are created by invitation only, and an invitation cannot be requested from this
          page. Already have an account? <a href="/login">Sign in</a>.
        </p>
      </main>
    </div>
  );
}
