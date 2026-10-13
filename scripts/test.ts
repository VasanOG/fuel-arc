/**
 * `npm test`: every verify suite and both typechecks, in one command.
 *
 *   npm test                         the real list (scripts/test-steps.ts)
 *   npm test -- --steps <file.json>  a stand-in list; scripts/verify-runner.ts uses this
 *
 * WHAT DECIDES PASS. A step passes when its process exits 0, and -- for a
 * suite that counts checks -- when it printed `All N checks passed.` with N at
 * or above its floor in scripts/test-baseline.json. The exit code always wins
 * over the text: a suite that prints a success line and then exits 1 has
 * failed. The floor is what catches the opposite: a suite that exits 0 having
 * quietly run fewer checks.
 *
 * IT STOPS AT THE FIRST FAILURE. The steps after it are reported as not run,
 * never as passed.
 *
 * EVERY STEP GETS A BARE ENVIRONMENT: PATH, HOME, the temp directory, the
 * user and locale -- and nothing else. No relay key, encryption key,
 * Fireblocks credential or proxy setting reaches a suite, whatever the shell
 * running `npm test` happens to hold, and `.env` is not read by anything a
 * suite runs (see stepEnv). No suite needs any of it: each builds its own
 * database and makes its own throwaway keys.
 *
 * EACH STEP IS ITS OWN PROCESS GROUP, so a step that hangs is killed at its
 * timeout together with anything it started -- a server, a child script --
 * rather than leaving it running after the summary says TIMEOUT.
 *
 * A NETWORK OUTAGE IS REPORTED AS ONE. verify-api needs x402.org (see
 * test-steps.ts). If that host cannot be reached the run stops before
 * verify-api with NETWORK, exit code 2, and says it is not a code failure --
 * rather than letting the suite die two seconds in and look like a bug.
 *
 * ON macOS IT KEEPS THE MAC FROM IDLE-SLEEPING for exactly as long as it runs
 * (`caffeinate -w` on this process). A Mac that sleeps mid-run fails the
 * suites' time-window checks for reasons that have nothing to do with the code.
 * Closing the lid on battery still sleeps it; nothing here can prevent that.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STEP_ENV_ALLOWED, STEP_ENV_FORCED, STEPS, type TestStep } from "./test-steps.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 5_000;
/** After a timeout kill, how long to wait for the step's output pipes to close before giving up on them. */
const KILL_GRACE_MS = 5_000;

/** The process group of the step running now, so an interrupted run can take it down too. */
let activeGroup: number | undefined;

type Outcome = "PASS" | "FAIL" | "TIMEOUT" | "NETWORK" | "NOT RUN";

interface Result {
  step: TestStep;
  outcome: Outcome;
  checks: number | null;
  ms: number;
  /** Why it did not pass, in one line. */
  reason: string | null;
}

function parseArgs(argv: string[]): { stepsFile: string | null } {
  const i = argv.indexOf("--steps");
  if (i === -1) return { stepsFile: null };
  const file = argv[i + 1];
  if (!file) throw new Error("--steps needs a file");
  return { stepsFile: file };
}

function loadFloors(): Record<string, number> {
  return JSON.parse(readFileSync(join(ROOT, "scripts", "test-baseline.json"), "utf8")) as Record<string, number>;
}

function stepEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of STEP_ENV_ALLOWED) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // And .env neutralised as a FILE, not only kept out of the environment: see
  // STEP_ENV_FORCED.
  return { ...env, ...STEP_ENV_FORCED };
}

/** Can a TCP connection to host:443 be opened? DNS failure and refusal both count as no. */
function reachable(host: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port: 443, timeout: NETWORK_TIMEOUT_MS });
    const finish = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Kills a step's whole process group. Quiet if it is already gone. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: nothing left to kill.
  }
}

/** The first line that says what failed, as the suites write it; otherwise the last line of output. */
function failureLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^FAILED:|^FAIL\s/.test(l)) ?? lines.at(-1) ?? "(no output)";
}

function runStep(step: TestStep, floor: number | undefined, logDir: string): Promise<Result> {
  const started = Date.now();
  const logPath = join(logDir, `${step.name}.log`);
  const log = createWriteStream(logPath);
  const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((done) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (outcome: Outcome, checks: number | null, reason: string | null) => {
      if (settled) return;
      settled = true;
      log.end();
      done({ step, outcome, checks, ms: Date.now() - started, reason });
    };

    const [command, ...args] = step.command;
    const child = spawn(command!, args, {
      cwd: resolve(ROOT, step.cwd ?? "."),
      env: stepEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout can take everything it started.
      detached: true,
    });
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      log.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    activeGroup = child.pid;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      // Normally the kill closes the step's pipes and "close" follows at once.
      // A descendant that left the group (its own session) can still be
      // holding them, and then "close" never comes. Give it a moment, then
      // stop waiting: the step has timed out either way, and the run must end.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish("TIMEOUT", null, `still running after ${Math.round(timeoutMs / 1000)}s; killed, but something it started kept its output open`);
      }, KILL_GRACE_MS).unref();
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      finish("FAIL", null, `could not start: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      // Whatever the step left behind goes with it, passed or not.
      killGroup(child.pid);
      activeGroup = undefined;
      if (timedOut) return finish("TIMEOUT", null, `still running after ${Math.round(timeoutMs / 1000)}s; killed with everything it started`);
      if (signal) return finish("FAIL", null, `killed by ${signal}`);
      if (code !== 0) return finish("FAIL", null, failureLine(output));
      if (!step.countsChecks) return finish("PASS", null, null);

      // The LAST such line: a suite's own verdict is the final thing it prints,
      // and an earlier one could only be something it ran repeating its own.
      const counted = [...output.matchAll(/^All (\d+) checks passed\./gm)].at(-1);
      if (!counted) return finish("FAIL", null, "exited 0 but reported no check count");
      const checks = Number(counted[1]);
      if (floor === undefined) return finish("FAIL", checks, "has no check-count floor in scripts/test-baseline.json");
      if (checks < floor) {
        return finish("FAIL", checks, `ran ${checks} checks, below its floor of ${floor}: a check was lost or skipped`);
      }
      finish("PASS", checks, null);
    });
  });
}

const seconds = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

async function main(): Promise<number> {
  const { stepsFile } = parseArgs(process.argv.slice(2));
  const custom = stepsFile !== null;
  const steps: TestStep[] = custom ? (JSON.parse(readFileSync(stepsFile, "utf8")) as TestStep[]) : STEPS;
  const floors = custom ? null : loadFloors();
  // A stand-in list can never print the real run's verdict, so a run with
  // --steps cannot be mistaken for `npm test` passing.
  const label = custom ? `test runner (custom steps from ${stepsFile})` : "npm test";

  // Held for as long as this process lives, and no longer.
  if (process.platform === "darwin" && !custom) {
    spawn("caffeinate", ["-is", "-w", String(process.pid)], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  }

  // Interrupted (Ctrl-C, a closed terminal, a kill): the step running now is
  // in its own process group, so it would not hear the signal. Take it down
  // too rather than leave a suite and its server running with nobody watching.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      killGroup(activeGroup);
      console.log(`\n${label}: INTERRUPTED by ${signal}; the step that was running was stopped.`);
      process.exit(130);
    });
  }

  const logDir = mkdtempSync(join(tmpdir(), "fuel-test-"));
  console.log(`${label}: ${steps.length} steps, stopping at the first failure. Logs are kept if anything fails.\n`);
  const live = process.stdout.isTTY === true;

  const results: Result[] = [];
  const startedAll = Date.now();
  let stopped: Result | null = null;

  for (const step of steps) {
    if (stopped) {
      results.push({ step, outcome: "NOT RUN", checks: null, ms: 0, reason: null });
      continue;
    }

    // Its own variable, not `stopped`: this block decides one thing, whether
    // the network is there, and must not also be what stops the run after an
    // earlier failure (that is the block above).
    let unreachable: string | null = null;
    for (const host of step.needsHosts ?? []) {
      if (!(await reachable(host))) {
        unreachable = host;
        break;
      }
    }
    if (unreachable !== null) {
      stopped = {
        step,
        outcome: "NETWORK",
        checks: null,
        ms: 0,
        reason: `${unreachable} is unreachable from this machine. This is a network problem, not a code failure`,
      };
      results.push(stopped);
      console.log(`  NETWORK  ${step.name}  ${stopped.reason}`);
      continue;
    }

    // The "running" line is overwritten in place, which only works on a terminal.
    if (live) process.stdout.write(`  ....     ${step.name}`);
    const floor = custom ? step.minChecks : floors![step.name];
    const result = await runStep(step, floor, logDir);
    results.push(result);
    const counted = result.checks === null ? "" : `  ${result.checks} checks`;
    process.stdout.write(`${live ? "\r\x1b[2K" : ""}  ${result.outcome.padEnd(8)} ${step.name}${counted}  ${seconds(result.ms)}\n`);
    if (result.outcome !== "PASS") {
      console.log(`           ${result.reason}`);
      console.log(`           log: ${join(logDir, `${step.name}.log`)}`);
      stopped = result;
    }
  }

  const passed = results.filter((r) => r.outcome === "PASS").length;
  const total = seconds(Date.now() - startedAll);
  console.log("");
  for (const r of results) {
    const checks = r.checks === null ? "" : `${r.checks} checks`;
    console.log(`  ${r.step.name.padEnd(22)} ${r.outcome.padEnd(8)} ${checks.padEnd(14)} ${r.outcome === "NOT RUN" ? "" : seconds(r.ms)}`);
  }
  console.log("");

  if (!stopped) {
    // Nothing to look into, so nothing kept.
    rmSync(logDir, { recursive: true, force: true });
    console.log(`${label}: PASS (${passed}/${results.length}) in ${total}`);
    return 0;
  }
  if (stopped.outcome === "NETWORK") {
    console.log(`${label}: NETWORK at ${stopped.step.name} (${passed}/${results.length} passed before it) in ${total} -- ${stopped.reason}`);
    return 2;
  }
  console.log(`${label}: ${stopped.outcome} at ${stopped.step.name} (${passed}/${results.length} passed) in ${total} -- ${stopped.reason}`);
  return 1;
}

// exitCode rather than exit(): exit() can cut off the last lines of output
// when it is going to a pipe, and the last line is the verdict.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`npm test could not run: ${(error as Error).message}`);
    process.exitCode = 1;
  },
);
