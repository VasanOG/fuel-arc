/**
 * What `npm test` runs, in order. Read by scripts/test.ts.
 *
 * FASTEST FIRST. A typecheck error or a broken rollup should be reported in
 * seconds, not after verify-api's half-minute. The order is otherwise free:
 * every suite builds its own database, so none depends on another having run.
 *
 * WHAT IS NOT HERE, AND WHY. qa-dashboard's browser half needs a running
 * dashboard, the API, the QA account's password and a real database, so only
 * its source checks run here (`--source-only`). The live walkthroughs
 * (walk-accounting, walk-revenue) talk to real sandboxes and are run by hand.
 *
 * A step that counts checks must print `All N checks passed.` and N must not
 * fall below its floor in scripts/test-baseline.json. The floor is what stops a
 * suite quietly losing checks -- a skipped branch, a loop over data that is no
 * longer there -- while still exiting 0. Raise it when you add checks; lower it
 * only in the same commit that deliberately removes some, and say why.
 */

export interface TestStep {
  name: string;
  /** Run as given, from `cwd`. A path to a .ts file runs under tsx. */
  command: string[];
  cwd?: string;
  /** Prints `All N checks passed.`, and N is held to a floor. */
  countsChecks: boolean;
  /** Only in a custom step list: the floor, inline. The real list's floors live in test-baseline.json. */
  minChecks?: number;
  /**
   * Hosts this step reaches over the network. Checked first, so an outage reads
   * as one. No real step needs any today: npm test runs offline (TR-7).
   */
  needsHosts?: string[];
  timeoutMs?: number;
}

/**
 * The only environment variables a step inherits. Everything a suite needs
 * beyond these -- a database, keys, credentials -- it makes for itself.
 */
export const STEP_ENV_ALLOWED = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL"];

/**
 * Set on every step whatever the shell holds. Several scripts a suite runs as
 * a child (set-password, mint-invite) `import "dotenv/config"`, which reads
 * ./.env from the repository -- so the real .env would reach them however
 * clean the environment is. dotenv honours DOTENV_CONFIG_PATH, every child
 * inherits it, and so every one of those loads reads an empty file instead.
 */
export const STEP_ENV_FORCED: Record<string, string> = { DOTENV_CONFIG_PATH: "/dev/null" };

const tsx = (script: string): string[] => [process.execPath, "--import", "tsx", script];

export const STEPS: TestStep[] = [
  { name: "verify-runner", command: tsx("scripts/verify-runner.ts"), countsChecks: true },
  {
    name: "typecheck-api",
    command: [process.execPath, "node_modules/typescript/bin/tsc", "--noEmit", "-p", "."],
    countsChecks: false,
  },
  {
    name: "typecheck-dashboard",
    command: [process.execPath, "node_modules/typescript/bin/tsc", "--noEmit"],
    cwd: "dashboard",
    countsChecks: false,
  },
  {
    name: "qa-dashboard-source",
    command: [...tsx("scripts/qa-dashboard.ts"), "--source-only"],
    countsChecks: true,
  },
  // Seconds, and the one a guard edit should trip first: every testnet pin and the
  // signer's refusals. Early on purpose, by this file's own rule.
  { name: "verify-pins", command: tsx("scripts/verify-pins.ts"), countsChecks: true },
  // Seconds too: the Arc founder-demo lock, its signer's refusals and limits, offline.
  { name: "verify-arc-lock", command: tsx("scripts/verify-arc-lock.ts"), countsChecks: true },
  { name: "verify-earning", command: tsx("scripts/verify-earning.ts"), countsChecks: true },
  { name: "verify-rollup", command: tsx("scripts/verify-rollup.ts"), countsChecks: true },
  { name: "verify-quickbooks", command: tsx("scripts/verify-quickbooks.ts"), countsChecks: true },
  { name: "verify-migration", command: tsx("scripts/verify-migration.ts"), countsChecks: true },
  { name: "verify-api", command: tsx("scripts/verify-api.ts"), countsChecks: true },
  // Last: it runs the real API several times, offline, and waits out real retry delays.
  { name: "verify-startup", command: tsx("scripts/verify-startup.ts"), countsChecks: true },
];
