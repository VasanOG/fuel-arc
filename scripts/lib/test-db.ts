/**
 * A fresh test database for one suite run: `createTestDatabase("api")` returns
 * the path of a new file in the system temp directory, already built by
 * scripts/lib/seed-test-db.ts.
 *
 * The suites point FUEL_DB_PATH at it before importing anything that opens the
 * database, exactly as they did with the copy of `fuel.db` this replaces.
 *
 * BUILT IN A CHILD PROCESS, not by importing the seeder. src/db/index.ts opens
 * FUEL_DB_PATH once, at import, and every module after it shares that
 * connection and whatever state the seeder's imports set up. In a child, the
 * suite's own process opens the finished file fresh, as the API would.
 *
 * THE CHILD GETS ALMOST NO ENVIRONMENT. PATH, HOME and the temp directory, and
 * nothing else: no Fireblocks credentials, no relay key, no encryption key but
 * the throwaway one the seeder makes for itself. Whatever the parent process
 * happens to hold, the database is built the same way.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEEDER = join(ROOT, "scripts", "lib", "seed-test-db.ts");

/*
 * A FALLBACK THAT IS NEVER `fuel.db`, set the moment this module loads.
 *
 * src/db/index.ts opens `FUEL_DB_PATH ?? "fuel.db"` once, at its first import.
 * Each suite sets FUEL_DB_PATH before importing it -- but a static import of a
 * database module added to a suite later would be hoisted above that line and
 * open `fuel.db` first. This module is the first import in every suite, so from
 * here on the fallback can never be reached: an import that comes too early
 * opens an empty temp file instead, and TD-2 reports the mistake.
 */
process.env.FUEL_DB_PATH = join(mkdtempSync(join(tmpdir(), "fuel-unbuilt-")), "never-built.db");

export function createTestDatabase(label: string): string {
  const path = join(mkdtempSync(join(tmpdir(), `fuel-${label}-`)), "scratch.db");
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", SEEDER, path], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The seeder's one-line summary; boot's migration chatter is left out.
    const summary = out.split("\n").find((line) => line.startsWith("test database:"));
    if (summary) console.log(`${summary} (${path})`);
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `FAILED: could not build the test database\n${e.stderr || e.stdout || e.message}`,
    );
  }
  return path;
}
