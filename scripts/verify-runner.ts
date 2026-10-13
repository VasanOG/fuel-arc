/**
 * Verifies `npm test` itself: that it fails when a suite fails, stops when it
 * should, and cannot be talked into a pass.
 *
 * A test runner that passes everything is worse than none -- it turns "the
 * suites are green" into a statement nobody checked. So this drives the REAL
 * runner (scripts/test.ts), as a child process, with stand-in steps written to
 * a temp directory: tiny scripts that pass, fail, lie about passing, hang, or
 * die. Each check names the behaviour it proves. Nothing here runs a real
 * suite; one section only reads the real step list.
 *
 * The pre-push hook (.githooks/pre-push) is checked the same way: the real
 * hook file, installed in a throwaway repository whose `npm test` is a stand-in,
 * pushing to a local bare repository. Nothing here reaches GitHub.
 *
 * Run:  npm run verify-runner     (and as the first step of npm test)
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { STEP_ENV_ALLOWED, STEP_ENV_FORCED, STEPS, type TestStep } from "./test-steps.js";

let checks = 0;

function assert(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
}

function assertEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) {
    throw new Error(`FAILED: ${description}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

const work = mkdtempSync(join(tmpdir(), "fuel-runner-"));
let listSeq = 0;

/** A stand-in step: plain JavaScript run by this Node, so it needs nothing installed. */
const js = (name: string, code: string, extra: Partial<TestStep> = {}): TestStep => ({
  name,
  command: [process.execPath, "-e", code],
  countsChecks: false,
  ...extra,
});

/** Writes a marker file when it runs, so a check can tell which steps ran. */
const marker = (name: string) => join(work, `${name}.ran`);
const touch = (name: string) => `require("fs").writeFileSync(${JSON.stringify(marker(name))}, "")`;

const writeSteps = (steps: TestStep[]): string => {
  const file = join(work, `steps-${(listSeq += 1)}.json`);
  writeFileSync(file, JSON.stringify(steps));
  return file;
};

/** Runs the real runner over a stand-in list. Never throws: the exit code is the result. */
function run(steps: TestStep[], env: NodeJS.ProcessEnv = {}): { code: number; out: string; ms: number } {
  const file = writeSteps(steps);
  const started = Date.now();
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", "scripts/test.ts", "--steps", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // A runner that hangs fails the check that was waiting on it, rather
      // than hanging this whole self-test.
      timeout: 60_000,
      // TMPDIR is this check's own folder, so the logs the runner keeps for each
      // deliberately failed stand-in run are removed with it at the end.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: work, ...env },
    });
    return { code: 0, out, ms: Date.now() - started };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}`, ms: Date.now() - started };
  }
}

const verdict = (out: string): string => out.trim().split("\n").at(-1) ?? "";

/** Polls until `ready` holds or the time runs out; returns whether it held. */
async function waitFor(ready: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return ready();
}

/** Resolves with a child's exit code (a signal death reads as null), or "hung" if it has not exited in time. */
const exited = (child: ChildProcess, ms = 30_000): Promise<number | null | "hung"> =>
  new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done("hung");
    }, ms);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });

/** A grandchild that writes its pid to `pidFile` and never ends. `detach` puts it in its own session. */
const hangingGrandchild = (pidFile: string, detach = false): string => `
  const { spawn } = require("child_process");
  const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], ${detach ? '{ stdio: "inherit", detached: true }' : '{ stdio: "ignore" }'});
  require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
  setInterval(() => {}, 1000);`;

/** Strips comments, as the suites do, so a check reads code rather than its explanation. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Is a process still alive? Signal 0 checks without touching it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log("\n== the runner, against stand-in steps");

  // TR-1. Everything passes, so the run passes.
  {
    const r = run([
      js("one", touch("tr1-one")),
      js("two", `${touch("tr1-two")}; console.log("All 5 checks passed.")`, { countsChecks: true, minChecks: 5 }),
      js("three", touch("tr1-three")),
    ]);
    assertEqual(r.code, 0, "TR-1: when every step passes, the runner exits 0");
    assert(/: PASS \(3\/3\)/.test(verdict(r.out)), "TR-1: and its last line says PASS (3/3)");
    assert(["tr1-one", "tr1-two", "tr1-three"].every((n) => existsSync(marker(n))), "TR-1: and every step ran");
  }

  // TR-2. A failure stops the run where it happened, and says what failed.
  {
    const r = run([
      js("first", touch("tr2-first")),
      js("second", `console.log("FAILED: the second step broke"); process.exit(1)`),
      js("third", touch("tr2-third")),
    ]);
    assertEqual(r.code, 1, "TR-2: a failing step makes the runner exit 1");
    assert(/FAIL at second/.test(verdict(r.out)), "TR-2: the last line names the step that failed");
    assert(verdict(r.out).includes("FAILED: the second step broke"), "TR-2: and that step's own first FAILED line");
    assert(existsSync(marker("tr2-first")), "TR-2: the step before it ran");
    assert(!existsSync(marker("tr2-third")), "TR-2: the step after it never ran");
    assert(/third\s+NOT RUN/.test(r.out), "TR-2: and is reported as not run, never as passed");
  }

  // TR-3. The exit code wins over the text.
  {
    const r = run([js("liar", `console.log("All 10 checks passed."); process.exit(1)`, { countsChecks: true, minChecks: 1 })]);
    assertEqual(r.code, 1, "TR-3: a step that prints success but exits 1 fails the run");
  }

  // TR-4. A suite that quietly runs fewer checks than its floor fails, exit 0 or not.
  {
    const r = run([js("thin", `console.log("All 4 checks passed.")`, { countsChecks: true, minChecks: 5 })]);
    assertEqual(r.code, 1, "TR-4: fewer checks than the floor fails the run");
    assert(/below its floor of 5/.test(verdict(r.out)), "TR-4: and says the count fell below its floor");
    // A suite's verdict is the last count it prints; an earlier, bigger one
    // (something it ran, echoing its own) must not stand in for it.
    const echoed = run([js("echo", `console.log("All 999 checks passed."); console.log("All 3 checks passed.")`, { countsChecks: true, minChecks: 5 })]);
    assertEqual(echoed.code, 1, "TR-4: the count is read from the last such line, not an earlier one");
  }

  // TR-5. A hung step is killed at its timeout, with everything it started.
  {
    const pidFile = join(work, "tr5-grandchild.pid");
    const hang = `
      const { spawn } = require("child_process");
      const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      setInterval(() => {}, 1000);`;
    const r = run([js("hangs", hang, { timeoutMs: 1500 }), js("after", touch("tr5-after"))]);
    assertEqual(r.code, 1, "TR-5: a step that never finishes fails the run");
    assert(/TIMEOUT at hangs/.test(verdict(r.out)), "TR-5: and is reported as TIMEOUT");
    assert(r.ms < 15_000, `TR-5: at its timeout, not long after (took ${r.ms}ms)`);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    assert(grandchild > 0 && !alive(grandchild), "TR-5: and the process it started is gone too");
    assert(!existsSync(marker("tr5-after")), "TR-5: and nothing after it ran");
  }

  // TR-6. Dying any other way is a failure, never a pass.
  {
    const killed = run([js("killed", `process.kill(process.pid, "SIGKILL")`)]);
    assertEqual(killed.code, 1, "TR-6: a step killed by a signal fails the run");
    assert(/killed by SIGKILL/.test(verdict(killed.out)), "TR-6: and says what killed it");
    const missing = run([{ name: "missing", command: [process.execPath, join(work, "no-such-script.js")], countsChecks: false }]);
    assertEqual(missing.code, 1, "TR-6: a step whose script does not exist fails the run");
    const noBinary = run([{ name: "no-binary", command: [join(work, "no-such-program")], countsChecks: false }]);
    assertEqual(noBinary.code, 1, "TR-6: a step whose program does not exist fails the run");
    assert(/could not start/.test(verdict(noBinary.out)), "TR-6: and says it could not start");
  }

  // TR-8. A step sees none of the runner's secrets.
  {
    const SENTINEL = `sentinel-${Date.now()}`;
    const envFile = join(work, "tr8-env.json");
    const r = run([js("env", `require("fs").writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env))`)], {
      FUEL_RELAY_KEY: SENTINEL,
      FUEL_TOKEN_ENCRYPTION_KEY: SENTINEL,
      FIREBLOCKS_API_KEY: SENTINEL,
      FUEL_API_KEY: SENTINEL,
      HTTPS_PROXY: `http://${SENTINEL}.invalid:1`,
      // Harmless to the runner itself (which is a Node process too), and must
      // still not reach the step: the names check below catches it if it does.
      NODE_OPTIONS: "--no-deprecation",
    });
    assertEqual(r.code, 0, "TR-8: (control) the step ran");
    const seen = readFileSync(envFile, "utf8");
    assert(!seen.includes(SENTINEL), "TR-8: no secret from the runner's environment reaches a step");
    const stepEnv = JSON.parse(seen) as Record<string, string>;
    // Node and macOS may add a few of their own at process start; none is a secret.
    const unexpected = Object.keys(stepEnv).filter(
      (n) => !STEP_ENV_ALLOWED.includes(n) && !(n in STEP_ENV_FORCED) && !/^(__CF_|__CFBundle|COMMAND_MODE|XPC_)/.test(n),
    );
    assertEqual(unexpected.join(","), "", "TR-8: and a step's environment holds only the allowed names");
    assertEqual(stepEnv.DOTENV_CONFIG_PATH, "/dev/null", "TR-8: and every dotenv load in it is pointed at an empty file");

    // Nor from a FILE. Scripts a suite spawns import dotenv/config, which reads
    // ./.env from wherever they run; the runner makes every such load empty.
    const envDir = mkdtempSync(join(tmpdir(), "fuel-runner-env-"));
    writeFileSync(join(envDir, ".env"), `FUEL_RELAY_KEY=${SENTINEL}\n`);
    const loadsDotenv = (out: string) =>
      `require(${JSON.stringify(resolve("node_modules", "dotenv", "config.js"))}); require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`;
    const direct = join(work, "tr8-direct.json");
    execFileSync(process.execPath, ["-e", loadsDotenv(direct)], { cwd: envDir, env: { PATH: process.env.PATH } });
    assert(readFileSync(direct, "utf8").includes(SENTINEL), "TR-8: (control) outside the runner, dotenv/config does load that .env");
    const viaRunner = join(work, "tr8-runner.json");
    const dotenvRun = run([js("dotenv", loadsDotenv(viaRunner), { cwd: envDir })]);
    assertEqual(dotenvRun.code, 0, "TR-8: (control) the dotenv step ran");
    assert(!readFileSync(viaRunner, "utf8").includes(SENTINEL), "TR-8: under the runner, a .env file is not loaded either");
  }

  // TR-9. A counting suite that reports no count has not passed.
  {
    const r = run([js("silent", `console.log("done")`, { countsChecks: true, minChecks: 1 })]);
    assertEqual(r.code, 1, "TR-9: a counting step that prints no check count fails the run");
    assert(/reported no check count/.test(verdict(r.out)), "TR-9: and says so");
  }

  // TR-10. An unreachable host is a network problem, named as one.
  {
    const r = run([js("before", touch("tr10-before")), js("needs-net", touch("tr10-needs"), { needsHosts: ["fuel-test.invalid"] })]);
    assertEqual(r.code, 2, "TR-10: an unreachable host stops the run with exit code 2, not 1");
    assert(/NETWORK at needs-net/.test(verdict(r.out)), "TR-10: names the step as NETWORK");
    assert(/not a code failure/.test(verdict(r.out)), "TR-10: and says it is not a code failure");
    assert(existsSync(marker("tr10-before")) && !existsSync(marker("tr10-needs")), "TR-10: the step that needed it never ran");
  }

  // TR-11. A stand-in list can never claim to be `npm test`.
  {
    const r = run([js("ok", "")]);
    assert(!/^npm test:/m.test(r.out), "TR-11: a run with --steps never prints the real run's verdict");
  }

  // TR-12. Interrupting the runner stops the step it is running, and what that started.
  {
    const pidFile = join(work, "tr12-grandchild.pid");
    const file = writeSteps([js("long", hangingGrandchild(pidFile), { timeoutMs: 120_000 })]);
    const runner = spawn(process.execPath, ["--import", "tsx", "scripts/test.ts", "--steps", file], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: work },
    });
    let out = "";
    runner.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    const running = await waitFor(() => existsSync(pidFile), 20_000);
    assert(running, "TR-12: (control) the step started its own process");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    const code = exited(runner);
    runner.kill("SIGTERM");
    assertEqual(await code, 130, "TR-12: an interrupted run exits 130");
    assert(/INTERRUPTED by SIGTERM/.test(out), "TR-12: and says it was interrupted");
    assert(await waitFor(() => !alive(grandchild), 5_000), "TR-12: and the step's processes are stopped, not left running");
  }

  // TR-13. A timeout ends the run even when something the step started has
  // left its process group and still holds its output open.
  {
    const pidFile = join(work, "tr13-escaped.pid");
    const r = run([js("escapes", hangingGrandchild(pidFile, true), { timeoutMs: 1500 })]);
    const escaped = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    if (escaped > 0 && alive(escaped)) process.kill(escaped, "SIGKILL");
    assert(escaped > 0, "TR-13: (control) the step started a process in its own session");
    assert(/TIMEOUT at escapes/.test(verdict(r.out)), "TR-13: the step is reported as TIMEOUT");
    assert(r.ms < 20_000, `TR-13: and the run still ends promptly (took ${r.ms}ms)`);
  }

  console.log(`   ${checks} checks so far`);

  // TR-7. The real list: every suite and both typechecks, in order, each held to a floor.
  console.log("\n== the real step list");
  {
    const names = STEPS.map((s) => s.name);
    assertEqual(
      names.join(","),
      "verify-runner,typecheck-api,typecheck-dashboard,qa-dashboard-source,verify-pins,verify-arc-lock,verify-earning,verify-rollup,verify-quickbooks,verify-migration,verify-api,verify-startup",
      "TR-7: npm test runs the runner check, both typechecks, the dashboard source checks and all eight suites, in that order",
    );
    const floors = JSON.parse(readFileSync(join("scripts", "test-baseline.json"), "utf8")) as Record<string, number>;
    for (const step of STEPS.filter((s) => s.countsChecks)) {
      assert(Number.isInteger(floors[step.name]) && floors[step.name]! > 0, `TR-7: ${step.name} has a check-count floor`);
    }
    assertEqual(
      Object.keys(floors).sort().join(","),
      STEPS.filter((s) => s.countsChecks).map((s) => s.name).sort().join(","),
      "TR-7: and no floor is left over for a step that no longer runs",
    );
    // Offline by design since the gateway startup fix: verify-api no longer
    // imports the gateway, and verify-startup plays the facilitator itself.
    // A step that starts needing a host must say so here, deliberately.
    assertEqual(
      STEPS.filter((s) => (s.needsHosts ?? []).length > 0).map((s) => s.name).join(","),
      "",
      "TR-7: no step needs the network, so npm test runs offline",
    );

    // TR-14. The dashboard step loads no secrets and reaches nothing: both .env
    // loads sit inside the gate, and the source-only run returns before main
    // probes the server or starts a browser.
    const qa = withoutComments(readFileSync(join("scripts", "qa-dashboard.ts"), "utf8"));
    const gate = qa.indexOf("if (!SOURCE_ONLY) {");
    // Its own closing brace, at the start of a line: the loads inside hold braces of their own.
    const gateEnd = qa.indexOf("\n}", gate);
    const loads = [...qa.matchAll(/\bloadEnv\(/g)].map((m) => m.index!);
    assert(loads.length === 2 && gate > 0 && loads.every((i) => i > gate && i < gateEnd), "TR-14: qa-dashboard --source-only loads neither .env file");
    const mainAt = qa.indexOf("async function main()");
    const returnsAt = qa.indexOf("if (SOURCE_ONLY) {", mainAt);
    const firstReach = Math.min(...["fetch(", "chromium.launch", "liveProviderSecrets("].map((t) => qa.indexOf(t, mainAt)).filter((i) => i > 0));
    assert(mainAt > 0 && returnsAt > mainAt && returnsAt < firstReach, "TR-14: and returns before any server, browser or database is reached");
  }

  console.log(`   ${checks} checks so far`);

  // TH. The pre-push hook, in a throwaway repository pushing to a local bare one.
  console.log("\n== the pre-push hook");
  {
    const repo = join(work, "hook-repo");
    const remote = join(work, "hook-remote.git");
    const ranLog = join(work, "hook-ran.log");
    const hangPid = join(work, "hook-hang.pid");
    // The hook's own temp directory, so "nothing left behind" can be checked.
    const hookTmp = join(work, "hook-tmp");
    mkdirSync(hookTmp);
    const leftovers = (): string[] => readdirSync(hookTmp).filter((n) => n.startsWith("fuel-prepush-"));
    // The user's own git configuration is left out entirely, so a global hook,
    // signing rule or template cannot change what is being tested.
    const gitEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: hookTmp,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "verify-runner",
      GIT_AUTHOR_EMAIL: "verify-runner@fuel-test.example",
      GIT_COMMITTER_NAME: "verify-runner",
      GIT_COMMITTER_EMAIL: "verify-runner@fuel-test.example",
    };
    const git = (args: string[], cwd = repo): string =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv }).trim();
    const push = (args: string[]): { ok: boolean; out: string } => {
      try {
        const out = execFileSync("git", ["push", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv });
        return { ok: true, out };
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string };
        return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    };
    const remoteHead = (branch: string): string | null => {
      try {
        return git(["rev-parse", `refs/heads/${branch}`], remote);
      } catch {
        return null;
      }
    };
    const runs = (): string[] => (existsSync(ranLog) ? readFileSync(ranLog, "utf8").trim().split("\n").filter(Boolean) : []);
    const worktrees = (): number => git(["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length;

    mkdirSync(repo);
    git(["init", "--quiet", "--bare", remote], work);
    git(["init", "--quiet", "-b", "main"]);
    git(["remote", "add", "origin", remote]);
    mkdirSync(join(repo, ".githooks"));
    // TH-9. The real file, with its real mode: a hook that is not executable is
    // skipped by git with no more than a hint, and every check below would
    // pass against a copy someone had made executable.
    const realHook = join(".githooks", "pre-push");
    const realMode = statSync(realHook).mode & 0o777;
    assert((realMode & 0o111) !== 0, "TH-9: the hook file is executable, so git will run it");
    const recorded = execFileSync("git", ["ls-files", "-s", realHook], { encoding: "utf8" }).trim();
    assert(recorded === "" || recorded.startsWith("100755 "), "TH-9: and git records it as executable, so a fresh clone gets it that way");
    writeFileSync(join(repo, ".githooks", "pre-push"), readFileSync(realHook));
    chmodSync(join(repo, ".githooks", "pre-push"), realMode);
    git(["config", "core.hooksPath", ".githooks"]);
    // The stand-in `npm test`: records where it ran, then passes, fails or
    // hangs on what the COMMITTED result.txt says.
    const standIn = join(work, "stand-in-test.cjs");
    writeFileSync(
      standIn,
      `const fs = require("fs");
fs.appendFileSync(${JSON.stringify(ranLog)}, process.cwd() + "\\n");
const result = fs.readFileSync("result.txt", "utf8").trim();
if (result === "hang") {
  fs.writeFileSync(${JSON.stringify(hangPid)}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  process.exit(result === "pass" ? 0 : 1);
}
`,
    );
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "hook-check", private: true, scripts: { test: `node "${standIn}"` } }, null, 2));
    const commit = (result: "pass" | "fail" | "hang", message: string): string => {
      writeFileSync(join(repo, "result.txt"), `${result}\n`);
      git(["add", "-A"]);
      git(["commit", "--quiet", "-m", message]);
      return git(["rev-parse", "HEAD"]);
    };

    const good = commit("pass", "a commit whose tests pass");
    const first = push(["origin", "main"]);
    assert(first.ok, "TH-3: a commit whose tests pass is pushed");
    assertEqual(remoteHead("main"), good, "TH-3: and arrives on the remote");
    assert(runs().length === 1 && /fuel-prepush-/.test(runs()[0]!), "TH-3: its tests ran once, in a temporary worktree, not in this checkout");

    const bad = commit("fail", "a commit whose tests fail");
    const blocked = push(["origin", "main"]);
    assert(!blocked.ok, "TH-1: a commit whose tests fail is not pushed");
    assertEqual(remoteHead("main"), good, "TH-1: and the remote is unchanged");
    assert(blocked.out.includes("git push --no-verify"), "TH-1: and the refusal says how to skip it in an emergency");
    assertEqual(worktrees(), 1, "TH-7: the temporary worktree is removed after a failure");

    // An uncommitted fix does not count: what is tested is what is pushed.
    writeFileSync(join(repo, "result.txt"), "pass\n");
    const dirtyFix = push(["origin", "main"]);
    assert(!dirtyFix.ok, "TH-4: fixing the failure without committing it does not get the commit pushed");
    git(["checkout", "--", "result.txt"]);

    // A commit other than the one checked out is tested as itself, both ways.
    const otherGood = push(["origin", `${good}:refs/heads/older`]);
    assert(otherGood.ok && remoteHead("older") === good, "TH-5: pushing an older passing commit tests that commit, not the failing one checked out");
    commit("pass", "a later commit whose tests pass");
    const otherBad = push(["origin", `${bad}:refs/heads/broken`]);
    assert(!otherBad.ok && remoteHead("broken") === null, "TH-5: and pushing an older failing commit is refused even though the checked-out one passes");

    const skipped = push(["--no-verify", "origin", `${bad}:refs/heads/emergency`]);
    assert(skipped.ok && remoteHead("emergency") === bad, "TH-2: git push --no-verify pushes a failing commit anyway");

    const before = runs().length;
    const deleted = push(["origin", ":refs/heads/older"]);
    assert(deleted.ok && remoteHead("older") === null, "TH-6: deleting a remote branch goes through");
    assertEqual(runs().length, before, "TH-6: without running any tests, since nothing is being sent");

    assertEqual(worktrees(), 1, "TH-7: and no temporary worktree is left behind after any push");
    assertEqual(leftovers().join(","), "", "TH-7: nor any temporary directory");
    assertEqual(git(["config", "--get", "core.hooksPath"]), ".githooks", "TH-8: (control) the hook really was the installed one");

    // TH-10. Interrupted mid-test, the hook stops the test and cleans up. Run
    // directly, as git would, with git's ref line on stdin.
    const hung = commit("hang", "a commit whose tests never finish");
    const hook = spawn("sh", [join(repo, ".githooks", "pre-push"), "origin", remote], {
      cwd: repo,
      env: gitEnv,
      stdio: ["pipe", "ignore", "ignore"],
    });
    hook.stdin!.end(`refs/heads/main ${hung} refs/heads/main ${"0".repeat(hung.length)}\n`);
    const started = await waitFor(() => existsSync(hangPid), 30_000);
    assert(started, "TH-10: (control) the hook's test started and is still running");
    const testPid = Number(readFileSync(hangPid, "utf8"));
    const hookExit = exited(hook);
    hook.kill("SIGTERM");
    assertEqual(await hookExit, 130, "TH-10: an interrupted hook exits 130, so nothing is pushed");
    assert(await waitFor(() => !alive(testPid), 10_000), "TH-10: and stops the test it was running");
    assertEqual(worktrees(), 1, "TH-10: and removes its worktree");
    assertEqual(leftovers().join(","), "", "TH-10: and its temporary directory");
  }

  rmSync(work, { recursive: true, force: true });
  console.log(`\nAll ${checks} checks passed.`);
}

main().catch((error) => {
  console.error(`\n${(error as Error).message}`);
  process.exit(1);
});
