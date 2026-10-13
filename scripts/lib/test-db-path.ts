/**
 * The one decision standing between the test-database seeder and any file that
 * matters: is this path a NEW file in the temp directory?
 *
 * Its own module, importing nothing that can open a database, so the guard can
 * be tested directly -- with `fuel.db` itself as the input -- without anything
 * in reach that could open it if the guard were wrong. verify-api's TD-3 does
 * exactly that.
 *
 * FOUR REFUSALS, each for a different way a path can go somewhere it should not:
 *
 *   1. Outside the temp directory -- `fuel.db`, a path in the repo, anywhere.
 *   2. Inside the repository, even when the temp directory itself has been
 *      pointed there (TMPDIR=. would otherwise make check 1 meaningless).
 *   3. An existing file, so a test database is never built over anything.
 *   4. Anything already at the name, created atomically: `wx` fails if a file
 *      OR A LINK is there, dangling or not, so nothing can be swapped in
 *      between the checks above and the open, and a link cannot redirect the
 *      seeder to a file somewhere else.
 *
 * It returns the physical path it created, which is the one the seeder opens:
 * the path that was checked is the path that is used.
 */
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const within = (dir: string, root: string): boolean => dir === root || dir.startsWith(root + sep);

export function claimNewTempFile(target: string): string {
  // Read on every call rather than once, so the TMPDIR a run actually has is
  // the one judged.
  const tempRoot = realpathSync(tmpdir());
  const dir = realpathSync(dirname(resolve(target)));
  if (!within(dir, tempRoot)) {
    throw new Error(`refusing to build a test database outside ${tempRoot}: ${target}`);
  }
  if (within(dir, REPO)) {
    throw new Error(`refusing to build a test database inside the repository: ${target}`);
  }
  if (existsSync(target)) {
    throw new Error(`refusing to build over an existing file: ${target}`);
  }
  const path = join(dir, basename(target));
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`refusing to build over an existing file or link: ${target}`);
    }
    throw error;
  }
  return path;
}
