// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { NO_FALLBACK } from "./agent-types.js";
const VALID_JOIN_MODES = new Set(["async", "group", "smart"]);
const VALID_TOOL_DESCRIPTION_MODES = new Set(["full", "compact", "custom"]);
const VALID_WIDGET_MODES = new Set(["all", "background", "off"]);
const VALID_AGENT_MENTION_MODES = new Set(["model", "direct", "off"]);
// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;
const SUBAGENT_DEPTH_CEILING = 16;
/** 24h. Past this a "deadline" is indistinguishable from none, and reads as a typo. */
const DEADLINE_MS_CEILING = 24 * 60 * 60_000;
/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw) {
    if (!raw || typeof raw !== "object")
        return {};
    const r = raw;
    const out = {};
    if (Number.isInteger(r.maxConcurrent) &&
        r.maxConcurrent >= 1 &&
        r.maxConcurrent <= MAX_CONCURRENT_CEILING) {
        out.maxConcurrent = r.maxConcurrent;
    }
    if (Number.isInteger(r.defaultMaxTurns) &&
        r.defaultMaxTurns >= 0 &&
        r.defaultMaxTurns <= MAX_TURNS_CEILING) {
        out.defaultMaxTurns = r.defaultMaxTurns;
    }
    if (Number.isInteger(r.graceTurns) &&
        r.graceTurns >= 1 &&
        r.graceTurns <= GRACE_TURNS_CEILING) {
        out.graceTurns = r.graceTurns;
    }
    if (Number.isInteger(r.runDeadlineMs) &&
        r.runDeadlineMs >= 0 &&
        r.runDeadlineMs <= DEADLINE_MS_CEILING) {
        out.runDeadlineMs = r.runDeadlineMs;
    }
    if (Number.isInteger(r.waitCeilingMs) &&
        r.waitCeilingMs >= 0 &&
        r.waitCeilingMs <= DEADLINE_MS_CEILING) {
        out.waitCeilingMs = r.waitCeilingMs;
    }
    if (Number.isInteger(r.maxSubagentDepth) &&
        r.maxSubagentDepth >= 0 &&
        r.maxSubagentDepth <= SUBAGENT_DEPTH_CEILING) {
        out.maxSubagentDepth = r.maxSubagentDepth;
    }
    if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode)) {
        out.defaultJoinMode = r.defaultJoinMode;
    }
    if (typeof r.backgroundByDefault === "boolean") {
        out.backgroundByDefault = r.backgroundByDefault;
    }
    if (typeof r.schedulingEnabled === "boolean") {
        out.schedulingEnabled = r.schedulingEnabled;
    }
    if (typeof r.scopeModels === "boolean") {
        out.scopeModels = r.scopeModels;
    }
    if (typeof r.strictAgentFiles === "boolean") {
        out.strictAgentFiles = r.strictAgentFiles;
    }
    if (typeof r.disableDefaultAgents === "boolean") {
        out.disableDefaultAgents = r.disableDefaultAgents;
    }
    if (typeof r.toolDescriptionMode === "string" && VALID_TOOL_DESCRIPTION_MODES.has(r.toolDescriptionMode)) {
        out.toolDescriptionMode = r.toolDescriptionMode;
    }
    if (typeof r.fleetView === "boolean") {
        out.fleetView = r.fleetView;
    }
    // Was a boolean before the `model` mode existed. A hand-written or
    // previously-written `true` means "on", which is now the default `model`.
    if (typeof r.agentMentions === "boolean") {
        out.agentMentions = r.agentMentions ? "model" : "off";
    }
    else if (typeof r.agentMentions === "string" && VALID_AGENT_MENTION_MODES.has(r.agentMentions)) {
        out.agentMentions = r.agentMentions;
    }
    if (typeof r.rememberAgents === "boolean") {
        out.rememberAgents = r.rememberAgents;
    }
    if (typeof r.widgetMode === "string" && VALID_WIDGET_MODES.has(r.widgetMode)) {
        out.widgetMode = r.widgetMode;
    }
    if (typeof r.outputTranscript === "boolean") {
        out.outputTranscript = r.outputTranscript;
    }
    if (typeof r.worktreeIsolation === "boolean") {
        out.worktreeIsolation = r.worktreeIsolation;
    }
    if (typeof r.reportUsage === "boolean") {
        out.reportUsage = r.reportUsage;
    }
    if (typeof r.showCost === "boolean") {
        out.showCost = r.showCost;
    }
    if (r.fallbackSubagent === false) {
        // The only non-string spelling worth accepting: a boolean would otherwise be
        // dropped, silently leaving the PERMISSIVE default in place. Every string is
        // an agent name except the `none` sentinel, which the resolver recognizes —
        // so a mistaken "off" fails loudly at dispatch instead of meaning something
        // different here than it does there.
        out.fallbackSubagent = NO_FALLBACK;
    }
    else if (typeof r.fallbackSubagent === "string" && r.fallbackSubagent.trim()) {
        out.fallbackSubagent = r.fallbackSubagent.trim();
    }
    return out;
}
function globalPath() {
    return join(getAgentDir(), "subagents.json");
}
function projectPath(cwd) {
    return join(cwd, ".pi", "subagents.json");
}
/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path) {
    if (!existsSync(path))
        return {};
    try {
        return sanitize(JSON.parse(readFileSync(path, "utf-8")));
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
        return {};
    }
}
/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd = process.cwd()) {
    return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}
/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s, cwd = process.cwd()) {
    const path = projectPath(cwd);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
        return true;
    }
    catch {
        return false;
    }
}
/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s, appliers) {
    if (typeof s.maxConcurrent === "number")
        appliers.setMaxConcurrent(s.maxConcurrent);
    if (typeof s.defaultMaxTurns === "number")
        appliers.setDefaultMaxTurns(s.defaultMaxTurns);
    if (typeof s.graceTurns === "number")
        appliers.setGraceTurns(s.graceTurns);
    if (typeof s.runDeadlineMs === "number")
        appliers.setRunDeadlineMs(s.runDeadlineMs);
    if (typeof s.waitCeilingMs === "number")
        appliers.setWaitCeilingMs(s.waitCeilingMs);
    if (typeof s.maxSubagentDepth === "number")
        appliers.setMaxSubagentDepth(s.maxSubagentDepth);
    if (typeof s.fallbackSubagent === "string")
        appliers.setFallbackSubagent(s.fallbackSubagent);
    if (s.defaultJoinMode)
        appliers.setDefaultJoinMode(s.defaultJoinMode);
    if (typeof s.backgroundByDefault === "boolean")
        appliers.setBackgroundByDefault(s.backgroundByDefault);
    if (typeof s.schedulingEnabled === "boolean")
        appliers.setSchedulingEnabled(s.schedulingEnabled);
    if (typeof s.scopeModels === "boolean")
        appliers.setScopeModels(s.scopeModels);
    if (typeof s.strictAgentFiles === "boolean")
        appliers.setStrictAgentFiles(s.strictAgentFiles);
    if (typeof s.disableDefaultAgents === "boolean")
        appliers.setDisableDefaultAgents(s.disableDefaultAgents);
    if (s.toolDescriptionMode)
        appliers.setToolDescriptionMode(s.toolDescriptionMode);
    if (typeof s.fleetView === "boolean")
        appliers.setFleetView(s.fleetView);
    if (s.agentMentions)
        appliers.setAgentMentions(s.agentMentions);
    if (typeof s.rememberAgents === "boolean")
        appliers.setRememberAgents(s.rememberAgents);
    if (s.widgetMode)
        appliers.setWidgetMode(s.widgetMode);
    if (typeof s.outputTranscript === "boolean")
        appliers.setOutputTranscript(s.outputTranscript);
    if (typeof s.worktreeIsolation === "boolean")
        appliers.setWorktreeIsolation(s.worktreeIsolation);
    if (typeof s.reportUsage === "boolean")
        appliers.setReportUsage(s.reportUsage);
    if (typeof s.showCost === "boolean")
        appliers.setShowCost(s.showCost);
}
/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(successMsg, persisted) {
    return persisted
        ? { message: successMsg, level: "info" }
        : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}
/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(appliers, emit, cwd = process.cwd()) {
    const settings = loadSettings(cwd);
    applySettings(settings, appliers);
    emit("subagents:settings_loaded", { settings });
    return settings;
}
/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(snapshot, successMsg, emit, cwd = process.cwd()) {
    const persisted = saveSettings(snapshot, cwd);
    emit("subagents:settings_changed", { settings: snapshot, persisted });
    return persistToastFor(successMsg, persisted);
}
