import { getEnvironment } from "@/lib/fuel";
import styles from "./shell.module.css";

/**
 * What Fuel is pointed at, stated by the server.
 *
 * Persistent, in the nav, on every page — because the question it answers
 * ("could this move real money?") does not stop mattering when you navigate.
 *
 * THREE STATES AND A SILENCE, and the silence is the important one:
 *
 *   Sandbox              quiet. The expected case; it should not shout.
 *   Production           loud, filled, red. The only state where a mistake on
 *                        this screen costs real money.
 *   Environment unknown  warning. The server reached an unrecognised constant,
 *                        which is a real configuration answer and not an error.
 *   (nothing)            Fuel could not be asked. NO CLAIM IS MADE.
 *
 * The last two are deliberately not merged. "Unknown" is a verdict Fuel
 * reached; silence means Fuel never got to look. Showing "unknown" when the API
 * is merely unreachable would make a network blip look like a misconfiguration,
 * and — worse in the other direction — any fallback that resolved to "Sandbox"
 * would tell someone their money was safe on exactly the evidence that Fuel
 * has none.
 */
export async function EnvironmentBadge() {
  const environment = await getEnvironment();

  // No claim. Not "unknown", not "sandbox", not a dash — nothing.
  if (!environment) return null;

  const tone = environment.isProduction
    ? styles.envProduction
    : environment.environment === "sandbox"
      ? styles.envSandbox
      : styles.envUnknown;

  return (
    <p className={`${styles.env} ${tone}`}>
      <span className={styles.envLabel}>Environment</span>
      {/*
        The server's own word, rendered as given — including "Unknown", which
        src/lib/environment.ts already labels. Never a lookup table here: a
        dashboard that mapped a verdict onto its own vocabulary could disagree
        with the thing it is reporting, which is the one failure this badge
        cannot have. The `environment` VALUE is read above to pick a colour;
        it is never turned into words.
      */}
      <span className={styles.envValue}>{environment.label}</span>
    </p>
  );
}

/**
 * Occupies exactly the badge's height while the verdict is being fetched.
 *
 * The nav is fixed furniture on every page. A badge that appeared late and
 * pushed the navigation down would move a link out from under a cursor already
 * travelling towards it, so the space is reserved rather than grown into.
 */
export function EnvironmentBadgeSkeleton() {
  return <p className={`${styles.env} ${styles.envPending}`} aria-hidden="true" />;
}
