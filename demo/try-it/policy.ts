/**
 * The Try-it door's policy: what a visitor may ask for, and when the door is
 * closed. Pure functions and one small stateful gate, so the lock suite can
 * drive every refusal offline (scripts/verify-arc-lock.ts, AL-8).
 *
 * WHAT THE DOOR IS. The one thing on the internet that can make the Arc demo
 * agent pay. A judge presses Buy; the door asks Fuel's API to pay for one of
 * three FIXED shop items; Fuel's controls decide. The door never takes a URL,
 * an amount, an agent id or a payee from the visitor: the only input is the
 * name of an item, looked up in the table below.
 *
 * WHY STOPS OF ITS OWN, ON TOP OF FUEL'S. Fuel's limits are per agent and
 * lifetime ($5, arc-chain.ts) or per minute ($0.02, velocity.ts). A public
 * button could spend the whole lifetime budget in a few hours of clicking,
 * and then only a code change brings the demo back. So the door adds:
 *
 *   - a DAILY cap on what it will forward, counted conservatively: every
 *     request that reaches Fuel counts at full price, paid or refused;
 *   - a PER-VISITOR limit, so one person cannot take the day;
 *   - a PAUSE file, the kill switch: touch it and the door answers "closed"
 *     before anything reaches Fuel (demo/try-it/control.ts);
 *   - a LOW-BALANCE stop: the shop wallet pays gas for every settlement, so
 *     below a floor the door closes rather than let settlements start failing
 *     mid-demo, and likewise if the agent wallet is nearly empty.
 *
 * Every refusal here is decided BEFORE a request leaves for Fuel, so a closed
 * door costs nothing and reserves nothing.
 */
import { existsSync } from "node:fs";

/** The three items, by the only name a visitor may use. Paths are the shop's. */
export const TRY_ITEMS = {
  basic: { path: "/item/basic", amountBaseUnits: 1_000n, label: "an ordinary $0.001 payment" },
  unusual: { path: "/item/unusual", amountBaseUnits: 5_000n, label: "a $0.005 payment, unusual for this agent" },
  ceiling: { path: "/item/ceiling", amountBaseUnits: 10_000n, label: "a $0.01 payment, Fuel's per-payment ceiling" },
} as const;
export type TryItem = keyof typeof TRY_ITEMS;

/** The item named, or null. Own keys only: "constructor" is not an item. */
export function itemNamed(input: unknown): TryItem | null {
  if (typeof input !== "string") return null;
  return Object.prototype.hasOwnProperty.call(TRY_ITEMS, input) ? (input as TryItem) : null;
}

/** The most the door forwards in one UTC day: $0.20, every attempt at full price. */
export const TRY_DAILY_CAP_BASE_UNITS = 200_000n;
/** Attempts one visitor may make in the window. */
export const TRY_VISITOR_LIMIT = 6;
export const TRY_VISITOR_WINDOW_MS = 10 * 60 * 1000;
/** The shop wallet pays gas (~$0.0017 a settlement): close below $0.50. */
export const TRY_MIN_SHOP_BALANCE_BASE_UNITS = 500_000n;
/** The agent wallet: close below $0.05, before the chain starts refusing. */
export const TRY_MIN_AGENT_BALANCE_BASE_UNITS = 50_000n;
/** A balance read older than this is no longer trusted: closed until a fresh one. */
export const TRY_BALANCE_MAX_AGE_MS = 10 * 60 * 1000;

export interface Balances {
  agentBaseUnits: bigint;
  shopBaseUnits: bigint;
  readAt: number;
}

export type Closed =
  | { open: false; reason: "paused"; detail: string }
  | { open: false; reason: "daily-cap"; detail: string }
  | { open: false; reason: "low-balance"; detail: string }
  | { open: false; reason: "balance-unknown"; detail: string };
export type Verdict = { open: true } | Closed;

export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/**
 * Whether the door is open at all, for anyone. Checked in this order so the
 * cheapest, most deliberate stop (the pause file) wins, and so a closed door
 * says which stop closed it.
 */
export function doorVerdict(state: {
  pauseFile: string;
  forwardedTodayBaseUnits: bigint;
  nextAmountBaseUnits: bigint;
  balances: Balances | null;
  now: number;
}): Verdict {
  if (existsSync(state.pauseFile)) return { open: false, reason: "paused", detail: "The live demo is paused by its operator." };
  if (state.forwardedTodayBaseUnits + state.nextAmountBaseUnits > TRY_DAILY_CAP_BASE_UNITS) {
    return { open: false, reason: "daily-cap", detail: "Today's demo budget is used up. It resets at midnight UTC." };
  }
  const b = state.balances;
  if (!b || state.now - b.readAt > TRY_BALANCE_MAX_AGE_MS) {
    return { open: false, reason: "balance-unknown", detail: "The demo cannot see the wallets' balances right now; try again shortly." };
  }
  if (b.shopBaseUnits < TRY_MIN_SHOP_BALANCE_BASE_UNITS || b.agentBaseUnits < TRY_MIN_AGENT_BALANCE_BASE_UNITS) {
    return { open: false, reason: "low-balance", detail: "A demo wallet is nearly empty; the demo is closed until it is topped up." };
  }
  return { open: true };
}

/**
 * The daily counter. Append-only in memory; the door persists each line to
 * its log and replays today's at boot, so a restart cannot reset the cap.
 */
export class DailyMeter {
  private day: string;
  private total = 0n;
  constructor(now: number) {
    this.day = utcDay(now);
  }
  forwardedToday(now: number): bigint {
    this.roll(now);
    return this.total;
  }
  /** Counts an attempt about to be forwarded. Call BEFORE the request leaves. */
  count(amountBaseUnits: bigint, now: number): void {
    this.roll(now);
    this.total += amountBaseUnits;
  }
  private roll(now: number): void {
    const day = utcDay(now);
    if (day !== this.day) {
      this.day = day;
      this.total = 0n;
    }
  }
}
