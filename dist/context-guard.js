import { getSessionContextPercent } from "./usage.js";
export const DEFAULT_CONTEXT_WARN_PERCENT = 30;
export const DEFAULT_CONTEXT_STOP_PERCENT = 50;
let configuredDefaults = { warn: DEFAULT_CONTEXT_WARN_PERCENT, stop: DEFAULT_CONTEXT_STOP_PERCENT };
function validPercent(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}
/** Validate the final effective pair; callers may layer partial sources first. */
export function validateContextThresholds(value) {
    if (!validPercent(value.warn) || !validPercent(value.stop) || value.warn >= value.stop) {
        throw new Error("Context thresholds must satisfy 0 < warn < stop <= 100.");
    }
    return value;
}
/** Per-dispatch values win over agent values, then project defaults, then built-ins. */
export function setContextGuardDefaults(warn, stop) {
    const next = validateContextThresholds({
        warn: warn ?? DEFAULT_CONTEXT_WARN_PERCENT,
        stop: stop ?? DEFAULT_CONTEXT_STOP_PERCENT,
    });
    configuredDefaults = next;
}
export function getContextGuardDefaults() {
    return { ...configuredDefaults };
}
export function resolveContextThresholds(dispatch, agent, project) {
    return validateContextThresholds({
        warn: dispatch?.warn ?? agent?.warn ?? project?.warn ?? configuredDefaults.warn,
        stop: dispatch?.stop ?? agent?.stop ?? project?.stop ?? configuredDefaults.stop,
    });
}
/**
 * Session-owned context guard state. It deliberately records a peak rather than
 * trusting current stats: Pi reports context as unknown immediately after
 * compaction, and a compacted session's smaller context must not reset a warning
 * or make a resumed child look safe again.
 */
export class ContextGuard {
    state;
    constructor(thresholds, prior) {
        const validated = validateContextThresholds(thresholds);
        const peakPercent = prior?.peakPercent ?? null;
        this.state = {
            warnPercent: validated.warn,
            stopPercent: validated.stop,
            warned: prior?.warned === true,
            peakPercent,
            // A persisted peak at the ceiling means a prior run already observed the
            // terminal condition. Compaction can lower current usage, but it cannot
            // make that child eligible to continue on resume.
            stopped: prior?.stopped === true || (peakPercent !== null && peakPercent >= validated.stop),
        };
    }
    observe(percent) {
        // Terminal is sticky across compaction and resumes. Never replace a hard
        // stop with a later warning when a caller happens to observe another event.
        if (this.state.stopped) {
            if (percent !== null && Number.isFinite(percent)) {
                const bounded = Math.max(0, Math.min(100, percent));
                this.state.peakPercent = Math.max(this.state.peakPercent ?? 0, bounded);
                return { action: "stop", percent: bounded };
            }
            return { action: "stop", percent: this.state.peakPercent ?? this.state.stopPercent };
        }
        if (percent === null || !Number.isFinite(percent))
            return { action: "unavailable" };
        const bounded = Math.max(0, Math.min(100, percent));
        this.state.peakPercent = Math.max(this.state.peakPercent ?? 0, bounded);
        // A single observation can cross both limits. Stop wins and must not emit a
        // warning/steer that would race the abort.
        if (bounded >= this.state.stopPercent) {
            this.state.stopped = true;
            return { action: "stop", percent: bounded };
        }
        if (!this.state.warned && bounded >= this.state.warnPercent) {
            this.state.warned = true;
            return { action: "warn", percent: bounded };
        }
        return { action: "none", percent: bounded };
    }
    observeSession(session) {
        return this.observe(getSessionContextPercent(session));
    }
}
