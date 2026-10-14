import { describe, expect, it } from "vitest";
import { ContextGuard, resolveContextThresholds } from "../src/context-guard.js";

describe("context guard", () => {
  it("uses per-dispatch values ahead of agent and project defaults", () => {
    expect(resolveContextThresholds(
      { warn: 35, stop: 65 },
      { warn: 40, stop: 70 },
      { warn: 30, stop: 50 },
    )).toEqual({ warn: 35, stop: 65 });
  });

  it("rejects invalid effective thresholds", () => {
    expect(() => resolveContextThresholds({ warn: 60 }, undefined, { warn: 30, stop: 50 })).toThrow("0 < warn < stop <= 100");
  });

  it("warns once and hard-stops first when a jump crosses both thresholds", () => {
    const guard = new ContextGuard({ warn: 30, stop: 50 });
    expect(guard.observe(30)).toEqual({ action: "warn", percent: 30 });
    expect(guard.observe(40)).toEqual({ action: "none", percent: 40 });
    expect(guard.observe(55)).toEqual({ action: "stop", percent: 55 });
    expect(guard.state).toEqual({ warnPercent: 30, stopPercent: 50, warned: true, peakPercent: 55, stopped: true });

    const jump = new ContextGuard({ warn: 30, stop: 50 });
    expect(jump.observe(55)).toEqual({ action: "stop", percent: 55 });
    expect(jump.state.warned).toBe(false);
    expect(jump.observe(56)).toEqual({ action: "stop", percent: 56 });
    expect(jump.state.warned).toBe(false);
  });

  it("refuses a resumed session that previously crossed the hard ceiling", () => {
    const guard = new ContextGuard({ warn: 30, stop: 50 }, { peakPercent: 55 });
    expect(guard.observe(null)).toEqual({ action: "stop", percent: 55 });
    expect(guard.state.stopped).toBe(true);
  });

  it("keeps the peak and warning state when context is unavailable or falls after compaction", () => {
    const guard = new ContextGuard({ warn: 30, stop: 50 }, { warned: true, peakPercent: 45 });
    expect(guard.observe(null)).toEqual({ action: "unavailable" });
    expect(guard.observe(10)).toEqual({ action: "none", percent: 10 });
    expect(guard.state.peakPercent).toBe(45);
    expect(guard.state.warned).toBe(true);
  });
});
