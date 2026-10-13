/**
 * Seeds a dedicated, idempotent test account for scripts/qa-dashboard.ts.
 *
 * WHY THIS EXISTS. qa-dashboard.ts drives a real browser against the running
 * dashboard, and since ADR 0018 every dashboard route requires a session
 * cookie — a signed-out visit is bounced to /login by middleware.ts. That
 * script had no sign-in step at all (predating ADR 0018), so every route it
 * "checked" was silently the login page. It needs an account to sign in
 * with, and it must not be a real person's — not the account this repo's
 * owner signs in with, and not one created ad hoc in a company that holds
 * real data.
 *
 * SO IT GETS ITS OWN COMPANY, entirely separate from anything real: a fixed
 * name, one team, one agent. The agent exists only so ADR 0019's funding
 * panel has something to reveal when qa-dashboard clicks it — its spend cap
 * is 0 and it is never used to pay for anything.
 *
 * IDEMPOTENT BY DESIGN, so running this before every qa-dashboard run costs
 * nothing once the fixtures exist:
 *   - the company is found by its fixed name, never recreated;
 *   - the user is found by (company, email); if found, its password is
 *     re-hashed from QA_DASHBOARD_PASSWORD only when it no longer matches —
 *     so the env var is always the one true source of this account's
 *     password, and nothing about it is ever printed;
 *   - the team is found by (company, name);
 *   - the agent is found by (team, name) via the same lookup
 *     createAgentWithCustody itself uses — provisioning a REAL Fireblocks
 *     sandbox vault happens at most once, on the very first run.
 *
 * WRITES TO WHATEVER fuel.db THIS PROCESS'S ENVIRONMENT POINTS AT — the real
 * one, same as the API server, unless FUEL_DB_PATH says otherwise. Back up
 * fuel.db before the first run, the same as any other change that adds a
 * row for good.
 *
 * Run:
 *   npx tsx scripts/seed-qa-dashboard.ts
 *
 * Requires QA_DASHBOARD_EMAIL and QA_DASHBOARD_PASSWORD in .env. No default
 * password — generating and printing one here would put a live credential in
 * terminal scrollback for an account this script itself can silently
 * re-arm; the operator chooses it once, the same way any other secret in
 * .env is chosen.
 */
import "dotenv/config";
import { requireEnv } from "../src/lib/env.js";
import { db, DB_PATH } from "../src/db/index.js";
import { createCompany } from "../src/db/companies.js";
import { createTeam } from "../src/db/teams.js";
import { createUser, findUserForLogin, normaliseEmail } from "../src/db/users.js";
import { getAgentInTeamByName } from "../src/db/agents.js";
import { createAgentWithCustody } from "../src/agents/create.js";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "../src/lib/passwords.js";

const COMPANY_NAME = "Fuel QA Dashboard";
const TEAM_NAME = "QA";
const AGENT_NAME = "qa-dashboard-agent";

async function main(): Promise<void> {
  // A cheap, explicit refusal rather than trusting every future invocation
  // to have read the header comment above (security review, this slice).
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed a QA test account with NODE_ENV=production set.");
  }

  const email = normaliseEmail(requireEnv("QA_DASHBOARD_EMAIL"));
  const password = requireEnv("QA_DASHBOARD_PASSWORD");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`QA_DASHBOARD_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  console.log(`\nDatabase: ${DB_PATH}`);

  // Company: found by name, never recreated. Company names are not unique
  // (ADR 0018), so the oldest match is treated as the one this script owns —
  // stable across runs, and a second "Fuel QA Dashboard" would mean someone
  // created one by hand, which this script leaves alone rather than guessing
  // about.
  // Only the two columns this script actually reads back — a raw row, not
  // the camelCase `Company` shape `createCompany` returns, so the type here
  // does not overclaim what a bare SELECT * actually has.
  const existingCompany = db
    .prepare("SELECT id, handle FROM companies WHERE name = ? ORDER BY created_at ASC LIMIT 1")
    .get(COMPANY_NAME) as { id: string; handle: string | null } | undefined;
  let company: { id: string; handle: string };
  if (!existingCompany) {
    const created = createCompany({ name: COMPANY_NAME, spendCapBaseUnits: 0n });
    console.log(`Created company "${COMPANY_NAME}" (handle ${created.handle}).`);
    // createCompany always assigns a handle before returning; only a row from
    // before ADR 0018 could ever have a null one, and this company is new.
    company = { id: created.id, handle: created.handle! };
  } else if (existingCompany.handle === null) {
    throw new Error(
      `Company "${COMPANY_NAME}" exists but has no handle yet — boot fills that in; start the API once first.`,
    );
  } else {
    company = { id: existingCompany.id, handle: existingCompany.handle };
    // THE COMMENT ABOVE PROMISES "left alone"; THIS IS WHAT ACTUALLY ENFORCES
    // IT. Matching by name alone (company names are not unique, ADR 0018)
    // took ownership of whichever row was oldest, without checking it was
    // ever this script's own — a second, unrelated "Fuel QA Dashboard" would
    // have silently had a team and agent seeded into it, and if its email
    // happened to collide with QA_DASHBOARD_EMAIL, its password reset
    // underneath it (security review, this slice). So: refuse outright
    // unless every user already in this company is the one this script
    // expects.
    const others = db
      .prepare("SELECT email FROM users WHERE company_id = ? AND email != ?")
      .all(company.id, email) as { email: string }[];
    if (others.length > 0) {
      throw new Error(
        `Company "${COMPANY_NAME}" (handle ${company.handle}) already has ${others.length} ` +
          `user(s) this script did not create. Refusing to touch it — a same-named company that ` +
          `is not this script's own is not safe to seed into. Rename or remove it, or change ` +
          `COMPANY_NAME in this script.`,
      );
    }
    console.log(`Reusing company "${COMPANY_NAME}" (handle ${company.handle}).`);
  }

  // User: found by (company, email). If it already exists, its password is
  // re-hashed only when QA_DASHBOARD_PASSWORD no longer verifies against the
  // stored hash — so this script is safe to run before every qa-dashboard
  // run, and the env var stays the single source of truth for this
  // account's password without ever printing it.
  const existingUser = findUserForLogin(company.handle, email);
  if (!existingUser) {
    createUser({ companyId: company.id, email, passwordHash: await hashPassword(password), role: "owner" });
    console.log(`Created user ${email} (owner).`);
  } else if (!(await verifyPassword(password, existingUser.passwordHash))) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
      await hashPassword(password),
      existingUser.id,
    );
    console.log(`Reset ${email}'s password to match QA_DASHBOARD_PASSWORD.`);
  } else {
    console.log(`Reusing user ${email} (owner) — password already matches.`);
  }

  // Team: found by (company, name).
  let team = db
    .prepare("SELECT * FROM teams WHERE company_id = ? AND name = ?")
    .get(company.id, TEAM_NAME) as { id: string } | undefined;
  if (!team) {
    team = createTeam({ companyId: company.id, name: TEAM_NAME, spendCapBaseUnits: 0n });
    console.log(`Created team "${TEAM_NAME}".`);
  } else {
    console.log(`Reusing team "${TEAM_NAME}".`);
  }

  // Agent: found by (team, name) — the same lookup createAgentWithCustody
  // itself does before provisioning, so this check and that function can
  // never disagree about whether the vault call is needed.
  const existingAgent = getAgentInTeamByName(team.id, AGENT_NAME);
  if (!existingAgent) {
    console.log(`Provisioning a real Fireblocks sandbox vault for "${AGENT_NAME}"…`);
    const agent = await createAgentWithCustody({ name: AGENT_NAME, teamId: team.id, spendCapBaseUnits: 0n });
    console.log(`Created agent "${AGENT_NAME}" (${agent.address}).`);
  } else {
    console.log(`Reusing agent "${AGENT_NAME}" (${existingAgent.address}).`);
  }

  console.log(`\nSet QA_DASHBOARD_COMPANY=${company.handle} in .env (if not already), then run:`);
  console.log(`  npm run qa-dashboard\n`);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
