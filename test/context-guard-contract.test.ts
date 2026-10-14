import { describe, expect, it } from "vitest";
import { ContextGuard, resolveContextThresholds } from "../src/context-guard.js";

const thresholdError = "0 < warn < stop <= 100";

describe("ContextGuard contract", () => {
  it("defaults to a 30% steer threshold and 50% hard-stop threshold", () => {
    expect(resolveContextThresholds(undefined, undefined, undefined)).toEqual({ warn: 30, stop: 50 });

    const guard = new ContextGuard(resolveContextThresholds(undefined, undefined, undefined));
    expect(guard.observe(29.999)).toEqual({ action: "none", percent: 29.999 });
    expect(guard.observe(30)).toEqual({ action: "warn", percent: 30 });
    expect(guard.observe(50)).toEqual({ action: "stop", percent: 50 });
  });

  it("resolves partial thresholds per field: dispatch, then agent, then project, then defaults", () => {
    expect(resolveContextThresholds(
      { warn: 35 },
      { warn: 40, stop: 70 },
      { warn: 25, stop: 60 },
    )).toEqual({ warn: 35, stop: 70 });
    expect(resolveContextThresholds(
      { stop: 65 },
      { warn: 40, stop: 70 },
      { warn: 25, stop: 60 },
    )).toEqual({ warn: 40, stop: 65 });
    expect(resolveContextThresholds(
      undefined,
      { warn: 35 },
      { stop: 60 },
    )).toEqual({ warn: 35, stop: 60 });
    expect(resolveContextThresholds(
      undefined,
      undefined,
      { warn: 31 },
    )).toEqual({ warn: 31, stop: 50 });
  });

  it("rejects invalid per-dispatch values and every invalid effective pair", () => {
    const invalidDispatches = [
      { warn: 0, stop: 50 },
      { warn: -0.01, stop: 50 },
      { warn: Number.NaN, stop: 50 },
      { warn: Number.POSITIVE_INFINITY, stop: 50 },
      { warn: 30, stop: 0 },
      { warn: 30, stop: Number.NaN },
      { warn: 30, stop: Number.NEGATIVE_INFINITY },
      { warn: 30, stop: Number.POSITIVE_INFINITY },
      { warn: 30, stop: 100.001 },
      { warn: 50, stop: 50 },
      { warn: 60, stop: 50 },
    ];

    for (const dispatch of invalidDispatches) {
      expect(() => resolveContextThresholds(dispatch, undefined, undefined)).toThrow(thresholdError);
    }
    expect(() => resolveContextThresholds({ warn: 70 }, { stop: 60 }, undefined)).toThrow(thresholdError);
  });

  it("honors exact floating-point thresholds", () => {
    const guard = new ContextGuard({ warn: 30.25, stop: 50.5 });
    expect(guard.observe(30.249999)).toEqual({ action: "none", percent: 30.249999 });
    expect(guard.observe(30.25)).toEqual({ action: "warn", percent: 30.25 });
    expect(guard.observe(50.499999)).toEqual({ action: "none", percent: 50.499999 });
    expect(guard.observe(50.5)).toEqual({ action: "stop", percent: 50.5 });
  });

  it("hard-stops instead of warning when one observation crosses both thresholds", () => {
    const guard = new ContextGuard({ warn: 30, stop: 50 });

    expect(guard.observe(55)).toEqual({ action: "stop", percent: 55 });
    expect(guard.state).toMatchObject({ warned: false, stopped: true, peakPercent: 55 });
    expect(guard.observe(56)).toEqual({ action: "stop", percent: 56 });
    expect(guard.state.warned).toBe(false);
  });

  it("emits at most one warning for a child session", () => {
    const guard = new ContextGuard({ warn: 30, stop: 50 });
    const actions = [29, 30, 31, 49].map(percent => guard.observe(percent).action);

    expect(actions).toEqual(["none", "warn", "none", "none"]);
    expect(guard.state.warned).toBe(true);
  });

  it("treats missing and non-finite context as unavailable rather than zero", () => {
    const guard = new ContextGuard({ warn: 30, stop: 50 });

    expect(guard.observe(null)).toEqual({ action: "unavailable" });
    expect(guard.observe(Number.NaN)).toEqual({ action: "unavailable" });
    expect(guard.observe(Number.POSITIVE_INFINITY)).toEqual({ action: "unavailable" });
    expect(guard.observe(Number.NEGATIVE_INFINITY)).toEqual({ action: "unavailable" });
    expect(guard.state).toMatchObject({ warned: false, stopped: false, peakPercent: null });
  });

  it("retains a warning and peak through compaction and resume", () => {
    const fresh = new ContextGuard({ warn: 30, stop: 50 });
    expect(fresh.observe(35)).toEqual({ action: "warn", percent: 35 });

    const resumed = new ContextGuard({ warn: 30, stop: 50 }, fresh.state);
    expect(resumed.observe(null)).toEqual({ action: "unavailable" });
    expect(resumed.observe(10)).toEqual({ action: "none", percent: 10 });
    expect(resumed.observe(40)).toEqual({ action: "none", percent: 40 });
    expect(resumed.state).toMatchObject({ warned: true, stopped: false, peakPercent: 40 });
  });

  it("never treats a prior hard stop or peak above stop as safe after resume", () => {
    const fresh = new ContextGuard({ warn: 30, stop: 50 });
    expect(fresh.observe(55)).toEqual({ action: "stop", percent: 55 });

    const stoppedResume = new ContextGuard({ warn: 30, stop: 50 }, fresh.state);
    expect(stoppedResume.observe(10)).toMatchObject({ action: "stop" });
    expect(stoppedResume.observe(null)).toMatchObject({ action: "stop" });
    expect(stoppedResume.state).toMatchObject({ warned: false, stopped: true, peakPercent: 55 });

    const peakOnlyResume = new ContextGuard({ warn: 30, stop: 50 }, { peakPercent: 55 });
    expect(peakOnlyResume.observe(10)).toMatchObject({ action: "stop" });
    expect(peakOnlyResume.observe(null)).toMatchObject({ action: "stop" });
  });
});
