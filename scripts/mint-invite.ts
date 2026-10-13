/**
 * Mints an invite, and prints its token once.
 *
 * WHY A SCRIPT AND NOT A ROUTE. A FOUNDING invite — one whose redemption
 * creates a company — is the single most consequential thing anyone can hand
 * out in this product: it makes a new tenant, with its own books and its own
 * spend authority. There is deliberately no HTTP route that can express it, so
 * "a second real company now exists" always costs somebody a shell.
 *
 * The in-product route (`POST /api/invites`) mints the other kind: it always
 * writes the owner's own company id, and has no way to say NULL.
 *
 * Run:
 *   npx tsx scripts/mint-invite.ts --email you@example.com --company <id> [--role operator]
 *   npx tsx scripts/mint-invite.ts --email you@example.com --new-company "Acme Inc"
 *
 * The token is printed ONCE. Only its hash is stored, so it cannot be read back
 * — losing it means minting another, which is the cost of a stolen database
 * being worth nothing.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { DB_PATH } from "../src/db/index.js";
import { createInvite, INVITE_TTL_MS } from "../src/db/invites.js";
import { getCompanyUnscoped } from "../src/db/companies.js";
import type { UserRole } from "../src/db/users.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  // A flag whose value is the next flag is a typo, not an empty string. Taking
  // it literally would mint an invite for an address like "--role".
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

function main(): void {
  const email = arg("email");
  const companyId = arg("company");
  const newCompany = process.argv.includes("--new-company");
  const newCompanyName = arg("new-company");
  const role = (arg("role") ?? (newCompany ? "owner" : "operator")) as UserRole;

  if (!email || !email.includes("@")) {
    throw new Error("--email <address> is required");
  }
  if (role !== "owner" && role !== "operator") {
    throw new Error("--role must be owner or operator");
  }
  if (newCompany && companyId) {
    throw new Error("--new-company and --company are mutually exclusive: pick one");
  }
  if (!newCompany && !companyId) {
    // NO DEFAULT, on purpose. Defaulting either way is wrong: silently joining
    // the bootstrap company hands someone the live books, and silently creating
    // a company makes a tenant nobody asked for.
    throw new Error(
      "say which: --company <id> to invite into an existing company, or --new-company \"Name\" to create one",
    );
  }
  if (newCompany && role !== "owner") {
    throw new Error("a new company's first member must be an owner");
  }

  if (companyId && !getCompanyUnscoped(companyId)) {
    throw new Error(`no company with id ${companyId}`);
  }

  // Named before the write, not after. This mints a live credential, and the
  // difference between the live database and a scratch copy is one env var.
  console.log(`\nDatabase: ${resolve(DB_PATH)}`);

  const { invite, token } = createInvite({
    companyId: newCompany ? null : companyId!,
    email,
    role,
  });

  const days = Math.round(INVITE_TTL_MS / 86_400_000);
  console.log(
    newCompany
      ? `\nFOUNDING invite — redeeming this CREATES A NEW COMPANY${newCompanyName ? ` named "${newCompanyName}"` : ""}.`
      : `\nInvite into company ${companyId}.`,
  );
  console.log(`  for:     ${invite.email}`);
  console.log(`  role:    ${invite.role}`);
  console.log(`  expires: ${invite.expiresAt} (${days} days)`);
  console.log(`\n  token:   ${token}`);
  console.log(
    "\nThis token is shown ONCE and is not recoverable — only its hash is stored.\n" +
      "It is a credential: whoever holds it can create the account above. Send it\n" +
      "the way you would send a password, and remember it is now in this terminal's\n" +
      "scrollback and possibly your shell history.\n",
  );
  if (newCompanyName) {
    console.log(`Redeem with companyName: ${JSON.stringify(newCompanyName)}\n`);
  }
}

try {
  main();
} catch (error) {
  // The message alone, not the stack. Every refusal here is a usage mistake
  // with a clear fix, and burying it under twenty lines of Node internals
  // makes it look like a crash.
  console.error(`\n${(error as Error).message}\n`);
  process.exit(1);
}
