/**
 * wait-ceiling.test.ts — b2: bounding the blocking join.
 *
 * `get_subagent_result(wait: true)` awaited `record.promise` with no time bound
 * at all, and pi returns a turn's parallel tool results only when every one of
 * them resolves. Issuing one blocking join per specialist therefore converts a
 * background batch into a barrier on the slowest agent — the 08/24 incident's
 * 1h58m, 2h07m and 51m stalls. Two guards: a wall-clock ceiling on any single
 * wait, and refusal of a SECOND concurrent blocking wait.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginBlockingWait,
  endBlockingWait,
  getWaitCeilingMs,
  hasBlockingWait,
  normalizeWaitCeilingMs,
  resetBlockingWaits,
  setWaitCeilingMs,
  waitWithCeiling,
} from "../src/wait-ceiling.js";

describe("wait ceiling configuration", () => {
  afterEach(() => setWaitCeilingMs(undefined));

  it("defaults to five minutes — a bound short enough that a stall is a pause, not a night", () => {
    expect(getWaitCeilingMs()).toBe(5 * 60_000);
  });

  it("treats 0 as unlimited (opt out) and floors anything positive at a second", () => {
    expect(normalizeWaitCeilingMs(0)).toBeUndefined();
    expect(normalizeWaitCeilingMs(10)).toBe(1000);
    expect(normalizeWaitCeilingMs(120_000)).toBe(120_000);
    expect(normalizeWaitCeilingMs(Number.MAX_SAFE_INTEGER)).toBe(24 * 60 * 60_000);
  });

  it("undefined restores the default rather than meaning unlimited", () => {
    setWaitCeilingMs(120_000);
    expect(getWaitCeilingMs()).toBe(120_000);
    setWaitCeilingMs(undefined);
    expect(getWaitCeilingMs()).toBe(5 * 60_000);
  });
});

describe("waitWithCeiling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns settled when the agent finishes inside the ceiling", async () => {
    let done!: (v: string) => void;
    const p = new Promise<string>((r) => { done = r; });
    const outcome = waitWithCeiling(p, 60_000);
    done("finished");
    await expect(outcome).resolves.toBe("settled");
  });

  it("returns timeout without touching the underlying run", async () => {
    let settled = false;
    const p = new Promise<string>(() => {});
    void p.then(() => { settled = true; });
    const outcome = waitWithCeiling(p, 60_000);
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(outcome).resolves.toBe("timeout");
    expect(settled).toBe(false);
  });

  it("waits forever when the ceiling is unlimited", async () => {
    let outcome: string | undefined;
    void waitWithCeiling(new Promise<string>(() => {}), undefined).then((o) => { outcome = o; });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(outcome).toBeUndefined();
  });

  it("propagates the caller's cancellation without waiting out the ceiling", async () => {
    const controller = new AbortController();
    const outcome = waitWithCeiling(new Promise<string>(() => {}), 60_000, controller.signal);
    controller.abort(new Error("esc"));
    await expect(outcome).rejects.toThrow("esc");
  });
});

describe("concurrent blocking joins", () => {
  afterEach(() => resetBlockingWaits());

  it("admits the first wait and refuses the second while it is in flight", () => {
    expect(hasBlockingWait()).toBe(false);
    expect(beginBlockingWait()).toBe(true);
    expect(hasBlockingWait()).toBe(true);
    expect(beginBlockingWait()).toBe(false);
  });

  it("admits the next wait once the first returns — sequential joins are legal", () => {
    expect(beginBlockingWait()).toBe(true);
    endBlockingWait();
    expect(hasBlockingWait()).toBe(false);
    expect(beginBlockingWait()).toBe(true);
  });

  it("never goes negative when a refused wait ends anyway", () => {
    endBlockingWait();
    endBlockingWait();
    expect(hasBlockingWait()).toBe(false);
    expect(beginBlockingWait()).toBe(true);
  });
});
