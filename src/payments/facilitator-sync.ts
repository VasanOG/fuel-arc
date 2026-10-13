/**
 * One x402 resource server's handshake with the facilitator, made safe to
 * start while the payment network is down.
 *
 * WHAT WENT WRONG WITHOUT IT. A resource server cannot quote a price until it
 * has fetched the facilitator's supported payment kinds (`initialize()`). Both
 * of Fuel's resource servers -- the gateway's, and the one behind /paid-hello --
 * used to start that fetch the moment they were created, and nothing listened
 * for it failing. With the facilitator unreachable the promise rejected with no
 * handler, and Node ends the process on an unhandled rejection: the whole API,
 * caps and approvals included, went down because one testnet host did not
 * answer within a second of boot.
 *
 * WHAT THIS DOES INSTEAD:
 *
 *   - Every attempt has its handlers attached the moment it is created, so a
 *     failure is a logged state, never a crash.
 *   - A failed attempt is retried in the background on a growing delay. The
 *     timer is unreferenced: a pending retry never keeps a process alive.
 *   - Until an attempt has succeeded, `ready()` answers false and the caller
 *     refuses the request. Nothing is quoted, verified, claimed or settled
 *     without the facilitator, so a refusal here is the closed answer.
 *
 * TWO RULES THE LIBRARY FORCES, and the reason this is a state machine rather
 * than a retrying promise:
 *
 *   ONE ATTEMPT AT A TIME. `x402ResourceServer.initialize()` CLEARS its map of
 *   supported kinds before refetching it (@x402/core server/index.mjs:459). Two
 *   attempts in flight can interleave their clears and fills, and an attempt
 *   still open is never abandoned for a new one, for the same reason.
 *
 *   NEVER AGAIN AFTER SUCCESS. Re-initializing a server that works opens a
 *   window in which concurrent requests find the map empty and fail. Once ready,
 *   ready it stays for the life of the process.
 *
 * A REQUEST NEVER STARTS AN ATTEMPT. During an outage every paid request would
 * otherwise become a handshake, and a flood of them a flood of requests to the
 * facilitator. Retries belong to the timer alone; a request only waits for an
 * attempt already under way, and only for a bounded time.
 *
 * Imports nothing and reads no environment, so the rail it talks to is fixed
 * by the caller's resource server, which is built from the hardcoded constants
 * in ./pay.ts. There is no setting here that could point Fuel elsewhere.
 */

/** Before each retry, in order; the last one repeats for as long as the outage lasts. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

/**
 * How long a request waits for an attempt already in flight.
 *
 * Today's boot behaviour, kept: the first request after a start waits for the
 * handshake under way rather than being refused. Bounded, because a facilitator
 * that accepts the connection and never answers would otherwise hold every
 * paid request open with it.
 */
export const READY_WAIT_MS = 5_000;

/** A continuing outage is logged again this often, not on every retry. */
export const REMINDER_EVERY_MS = 10 * 60_000;

/** What a refusal tells the payer: try again in this many seconds. */
export const RETRY_AFTER_SECONDS = 30;

export interface FacilitatorSyncOptions {
  /** Names this sync in its log lines ("gateway", "paid-hello"). */
  name: string;
  /** Tests shrink these. Production uses the defaults above. */
  retryDelaysMs?: readonly number[];
  readyWaitMs?: number;
  reminderEveryMs?: number;
  log?: (line: string) => void;
}

export interface FacilitatorSync {
  /** First attempt now. Idempotent, and a no-op after stop(). */
  start(): void;
  /** True once an attempt has succeeded. NEVER rejects, and never starts an attempt. */
  ready(): Promise<boolean>;
  isReady(): boolean;
  /** Final: clears any pending retry, and nothing runs after it. */
  stop(): void;
}

type State = "idle" | "attempting" | "waiting" | "ready" | "stopped";

export function createFacilitatorSync(
  init: () => Promise<unknown>,
  options: FacilitatorSyncOptions,
): FacilitatorSync {
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  if (delays.length === 0 || delays.some((d) => !(d > 0))) {
    throw new Error("retryDelaysMs needs at least one delay, each above zero");
  }
  const readyWaitMs = options.readyWaitMs ?? READY_WAIT_MS;
  const reminderEveryMs = options.reminderEveryMs ?? REMINDER_EVERY_MS;
  const sink = options.log ?? ((line: string) => console.error(line));
  // A log line is never worth a crash: a sink that throws is ignored here, so
  // nothing below can turn a failed handshake back into an unhandled rejection.
  const log = (line: string): void => {
    try {
      sink(line);
    } catch {
      // nothing: the state change it described has already happened
    }
  };
  const prefix = `[payments] ${options.name}:`;

  let state: State = "idle";
  let inFlight: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let lastLoggedAt = 0;
  let warnedNotStarted = false;
  // Read through a function so the compiler does not carry a narrowing across an await.
  const isReadyNow = (): boolean => state === "ready";

  function attempt(): void {
    if (state === "stopped" || state === "ready" || inFlight) return;
    state = "attempting";
    // `Promise.resolve().then(...)` so even an init that throws synchronously
    // becomes a rejection of THIS promise, which has its handlers attached on
    // the same line. Both handlers return a boolean and cannot themselves
    // reject, so `inFlight` never rejects either.
    inFlight = Promise.resolve()
      .then(() => init())
      .then(
        () => {
          inFlight = null;
          if (state === "stopped") return false;
          state = "ready";
          if (failures > 0) {
            log(`${prefix} the payment network is reachable again after ${failures} failed attempt(s).`);
          }
          return true;
        },
        (error: unknown) => {
          inFlight = null;
          if (state === "stopped") return false;
          failures += 1;
          const delay = delays[Math.min(failures - 1, delays.length - 1)]!;
          state = "waiting";
          timer = setTimeout(() => {
            timer = null;
            attempt();
          }, delay);
          // A pending retry must never be what keeps a process alive.
          timer.unref();

          // Logged on the first failure and then at most every
          // reminderEveryMs, computed here rather than on a timer of its own.
          const now = Date.now();
          if (failures === 1 || now - lastLoggedAt >= reminderEveryMs) {
            lastLoggedAt = now;
            let why = "unknown error";
            try {
              why = (error instanceof Error ? error.message : String(error)).slice(0, 200);
            } catch {
              // an error that cannot even be described still counts as a failure
            }
            log(
              failures === 1
                ? `${prefix} the payment network is unreachable (${why}). Paid requests are refused until it is back; retrying in the background.`
                : `${prefix} the payment network is still unreachable after ${failures} attempts (${why}).`,
            );
          }
          return false;
        },
      )
      // Belt and braces: `inFlight` must never reject, because nothing may be
      // awaiting it. The handlers above are written not to throw; this makes
      // that a property of the chain rather than of their bodies.
      .catch(() => false);
  }

  return {
    start(): void {
      if (state !== "idle") return;
      attempt();
    },

    async ready(): Promise<boolean> {
      if (state === "ready") return true;
      if (state === "idle" && !warnedNotStarted) {
        // A sync nobody started refuses every request. Said once, loudly,
        // because it is a wiring mistake, not an outage.
        warnedNotStarted = true;
        log(`${prefix} a paid request arrived before this sync was started; refusing it.`);
      }
      const pending = inFlight;
      if (!pending) return false;
      let bound: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        bound = setTimeout(() => resolve(false), readyWaitMs);
        bound.unref();
      });
      const outcome = await Promise.race([pending, timedOut]);
      clearTimeout(bound);
      return outcome && isReadyNow();
    },

    isReady: isReadyNow,

    stop(): void {
      state = "stopped";
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
