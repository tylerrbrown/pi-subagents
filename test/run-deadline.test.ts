/**
 * run-deadline.test.ts — b1: a wall-clock ceiling on an agent RUN.
 *
 * The fork enforced `maxTurns`/`graceTurns` and nothing else, so a run stalled
 * on a provider (08/24: two Anthropic specialists in `overloaded_error`) had no
 * upper bound at all. The deadline is armed around `session.prompt()` and ends
 * the run in a `timeout` status that keeps the partial output inspectable —
 * the record must NOT look like a completion or a user stop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armRunDeadline, normalizeRunDeadlineMs } from "../src/agent-runner.js";

describe("normalizeRunDeadlineMs", () => {
  it("treats undefined and 0 as unlimited, mirroring maxTurns", () => {
    expect(normalizeRunDeadlineMs(undefined)).toBeUndefined();
    expect(normalizeRunDeadlineMs(0)).toBeUndefined();
  });

  it("floors a positive value at one second so a typo can't kill every run instantly", () => {
    expect(normalizeRunDeadlineMs(5)).toBe(1000);
    expect(normalizeRunDeadlineMs(90_000)).toBe(90_000);
  });
});

describe("armRunDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is inert when no deadline is configured", () => {
    const abort = vi.fn();
    const d = armRunDeadline(undefined, abort);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(abort).not.toHaveBeenCalled();
    expect(d.timedOut()).toBe(false);
    d.cancel();
  });

  it("aborts the run once and reports the timeout after the deadline", () => {
    const abort = vi.fn();
    const d = armRunDeadline(60_000, abort);
    vi.advanceTimersByTime(59_000);
    expect(d.timedOut()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(d.timedOut()).toBe(true);
    d.cancel();
  });

  it("stops firing once the run settles first", () => {
    const abort = vi.fn();
    const d = armRunDeadline(60_000, abort);
    d.cancel();
    vi.advanceTimersByTime(120_000);
    expect(abort).not.toHaveBeenCalled();
    expect(d.timedOut()).toBe(false);
  });

  it("swallows an abort that throws — the deadline must still be recorded", () => {
    // session.abort() on a half-torn-down session is exactly the case where a
    // throw here would leave the run looking like a clean completion.
    const d = armRunDeadline(1_000, () => { throw new Error("already disposed"); });
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
    expect(d.timedOut()).toBe(true);
  });
});

describe("runAgent wires the deadline (wire-up)", () => {
  it("arms armRunDeadline around the prompt", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/agent-runner.ts", import.meta.url), "utf-8");
    expect(src).toContain("armRunDeadline(");
    expect(src).toContain("resolveEffectiveRunDeadlineMs(");
    expect(src).toContain("timedOut: deadline.timedOut()");
  });
});
