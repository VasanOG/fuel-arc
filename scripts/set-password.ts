/**
 * Sets a new password for an existing account. THE WAY BACK IN.
 *
 * WHY THIS EXISTS. Stage 3 gives Fuel real logins and no password reset — there
 * is no email provider, so there is no link to send. Without this script, a
 * forgotten password would mean no way to sign in as yourself at all, and the
 * only remedy would be writing a scrypt hash into the database by hand, which
 * you cannot compute at a shell prompt. That is a bad place to discover you are
 * locked out of your own product.
 *
 * WHY IT GRANTS NO NEW AUTHORITY, which is what makes it safe to leave here.
 * Running it requires local filesystem access to `fuel.db`. Anyone who has that
 * can already write any row they like with `sqlite3` — make themselves an
 * owner, disable anyone, change any cap. The only thing this adds is the
 * ability to compute a valid password hash, which is a convenience, not a
 * capability. It is the same argument `scripts/remediate-shared-vault.ts`
 * makes about operating directly on the database.
 *
 * WHY IT RESETS A PASSWORD RATHER THAN MINTING A SESSION. A minted session
 * token would be a live credential printed into terminal scrollback, usable
 * immediately by anyone who reads it over your shoulder or in your history —
 * and it would bypass the login path entirely, so the recovery route would
 * never exercise what production does. Setting a password makes you sign in
 * normally afterwards, through the same rate-limited, timing-equalised route
 * everyone else uses, which means this path gets tested every time it is used.
 *
 * Run:
 *   npx tsx scripts/set-password.ts --company <handle> --email you@example.com
 *   npx tsx scripts/set-password.ts --company <handle> --email you@example.com --password "..."
 *
 * With no --password, a strong one is generated and printed once.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { db, DB_PATH } from "../src/db/index.js";
import { findUserForLogin, normaliseEmail } from "../src/db/users.js";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../src/lib/passwords.js";
import { revokeSessionsForUser } from "../src/db/sessions.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

/** Five random words' worth of entropy, in a form that survives being retyped. */
function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

async function main(): Promise<void> {
  const email = arg("email");
  if (!email) throw new Error("--email <address> is required");
  // An address is unique within a company, not across the platform (ADR 0018),
  // so an account is named by both. No default: resetting the wrong person's
  // password is exactly the mistake a default would make easy.
  const company = arg("company");
  if (!company) throw new Error("--company <handle> is required: an address can have an account at more than one company");

  // MUST ALREADY EXIST. This script resets; it does not create. An account that
  // appeared out of a recovery tool would be an account nobody invited, which
  // is exactly the property invite-gated signup exists to have.
  const user = findUserForLogin(company, email);
  if (!user) {
    throw new Error(
      `No account for ${normaliseEmail(email)} at ${company}. This script resets an existing password; ` +
        "it cannot create an account. Use scripts/mint-invite.ts for that.",
    );
  }

  const supplied = arg("password");
  const password = supplied ?? generatePassword();
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`a password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  // The same function the signup route uses, so a password set here is
  // indistinguishable from one set normally — including its cost parameters.
  const passwordHash = await hashPassword(password);

  // Named before the write, for the same reason mint-invite does: this
  // rewrites a credential, and pointing it at the wrong database is one
  // environment variable away.
  console.log(`\nDatabase: ${resolve(DB_PATH)}`);

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);

  // A reset is also a "kick everything out": if the reason you are here is that
  // something got hold of your account, leaving its sessions alive would defeat
  // the point.
  const ended = revokeSessionsForUser(user.id);

  console.log(`\nPassword reset for ${user.email} (${user.role}).`);
  console.log(`Ended ${ended} live session${ended === 1 ? "" : "s"}.`);
  if (!supplied) {
    console.log(`\n  password: ${password}\n`);
    console.log(
      "Shown ONCE — only its hash is stored. It is now in this terminal's scrollback.\n" +
        "Sign in with it at /api/auth/login, then change it if you mean to keep using it.\n",
    );
  } else {
    console.log("\nUsing the password you supplied. Note it is in your shell history.\n");
  }

  if (user.disabledAt !== null) {
    // Said plainly rather than fixed: re-enabling somebody is a different
    // decision from resetting their password, and this script should not make
    // it quietly on the way past.
    console.log(
      "NOTE: this account is DISABLED, so the new password will not sign in until\n" +
        "somebody re-enables it. Nothing here changed that.\n",
    );
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
