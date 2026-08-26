/**
 * wait-ceiling.ts — bounding the blocking join.
 *
 * `get_subagent_result(wait: true)` used to await `record.promise` with the
 * tool-call abort signal as its only bound, and pi returns a turn's parallel
 * tool results only once every one of them resolves. One blocking join per
 * specialist therefore turns a background batch into a barrier on the slowest
 * agent — which is how a five-minute tester ended up invisible behind a
 * two-hour security run.
 *
 * Two guards live here because they fail at different edges:
 *   - a wall-clock ceiling, so a single wait ends in a typed "still running"
 *     rather than never;
 *   - a concurrency gate, so the SECOND simultaneous blocking wait is refused
 *     outright. The ceiling alone still lets N parallel joins hold the turn for
 *     the full ceiling; refusing the parallel shape is what makes the async
 *     collection doctrine mechanical instead of prose.
 *
 * Neither guard touches the agent. A bounded wait leaves the run going and its
 * result unconsumed, so the completion notification is still the way home.
 */

import { abortable } from "./abortable.js";

/** Default wall-clock ceiling on one blocking wait. */
export const DEFAULT_WAIT_CEILING_MS = 5 * 60_000;

/** Shortest ceiling worth honoring — below this, every wait is a no-op. */
const MIN_WAIT_CEILING_MS = 1_000;
const MAX_WAIT_CEILING_MS = 24 * 60 * 60_000;

/**
 * Normalize a configured ceiling. `0` is the opt-out spelling used throughout
 * this extension for "unlimited" (`defaultMaxTurns`, `runDeadlineMs`), so it
 * means the pre-fix behavior: wait as long as it takes.
 */
export function normalizeWaitCeilingMs(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.min(MAX_WAIT_CEILING_MS, Math.max(MIN_WAIT_CEILING_MS, n));
}

/**
 * Configured ceiling. Unlike `defaultMaxTurns`, an absent setting is NOT
 * unlimited: an unbounded blocking join is the defect this module exists for,
 * so the default has to be a real bound. `0` in `subagents.json` opts out.
 */
let waitCeilingMs: number | undefined = DEFAULT_WAIT_CEILING_MS;

/** The wall-clock ceiling one blocking wait will enforce. undefined = unlimited. */
export function getWaitCeilingMs(): number | undefined { return waitCeilingMs; }

/** Set the ceiling. `undefined` restores the default; `0` means unlimited. */
export function setWaitCeilingMs(n: number | undefined): void {
  waitCeilingMs = n === undefined ? DEFAULT_WAIT_CEILING_MS : normalizeWaitCeilingMs(n);
}

/** How a bounded wait ended. */
export type WaitOutcome = "settled" | "timeout";

/**
 * Await `promise` until it settles, the ceiling elapses, or the caller cancels.
 * A timeout resolves — it does not throw and does not abort anything; the
 * caller decides what to tell the model. Cancellation still rejects, because
 * that is the caller going away, not the agent being slow.
 */
export function waitWithCeiling<T>(
  promise: Promise<T>,
  ceilingMs: number | undefined,
  signal?: AbortSignal,
): Promise<WaitOutcome> {
  const settled = promise.then(() => "settled" as const, () => "settled" as const);
  if (ceilingMs == null) return abortable(settled, signal);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<WaitOutcome>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ceilingMs);
    timer.unref?.();
  });

  return abortable(Promise.race([settled, expired]), signal).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Blocking waits currently in flight in this session. A counter rather than a
 * boolean so a nested/queued caller can't leave the gate stuck closed.
 */
let inFlight = 0;

/** Whether a blocking wait is already holding the turn. */
export function hasBlockingWait(): boolean { return inFlight > 0; }

/** Claim the single blocking-wait slot. `false` means a join is already in flight. */
export function beginBlockingWait(): boolean {
  if (inFlight > 0) return false;
  inFlight++;
  return true;
}

/** Release the slot. Never goes negative — a refused wait may still call this. */
export function endBlockingWait(): void {
  if (inFlight > 0) inFlight--;
}

/**
 * Whether the previous blocking wait in this session ended at the ceiling.
 *
 * Measured against the real pi runtime rather than assumed: a turn's tool calls
 * are executed one after another, so the concurrency gate above never fires on
 * a batch the model issues in one message. What actually happens is N
 * SEQUENTIAL joins, and the barrier is N x the ceiling — 25 minutes at the
 * default for a five-specialist batch. Bounded, but still a barrier, and still
 * hiding every sibling that finished in the first minute.
 *
 * So one ceiling hit spends the session's patience: the next blocking join is
 * refused until something actually settles. The caller has already been told,
 * in the result it just read, that the agent is still running and that its
 * completion will reach it — a second wait adds nothing but delay.
 */
let lastWaitHitCeiling = false;

/** Record how a bounded wait ended. */
export function noteWaitOutcome(outcome: WaitOutcome): void {
  lastWaitHitCeiling = outcome === "timeout";
}

/** Whether a further blocking join should be refused rather than waited out. */
export function shouldRefuseRepeatJoin(): boolean { return lastWaitHitCeiling; }

/** Drop all in-flight state. Session boundaries and tests only. */
export function resetBlockingWaits(): void {
  inFlight = 0;
  lastWaitHitCeiling = false;
}

/**
 * What a refused parallel join tells the model. Names the failure mode rather
 * than the tool, and points at the collection path that already exists (the
 * consolidated group-join notification) instead of at a retry.
 */
export const PARALLEL_JOIN_REFUSAL =
  "Refused: a blocking get_subagent_result(wait: true) has already used this turn's wait " +
  "budget. Joining a batch one blocking wait at a time makes the turn return only when the " +
  "SLOWEST agent finishes, hiding every sibling that already completed. You are notified as " +
  "each agent completes — collect from those notifications and do other work meanwhile. " +
  "A non-blocking check (wait omitted) is always allowed, and blocking waits resume once an " +
  "agent actually settles.";
