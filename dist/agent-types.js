/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded defaults with shared definitions from .claude/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */
import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENTS } from "./default-agents.js";
/**
 * All known built-in tool names, derived from pi's own tool factories rather
 * than hardcoded so the set tracks pi-mono if it adds/renames a built-in.
 * `createCodingTools` → read/bash/edit/write; `createReadOnlyTools` →
 * read/grep/find/ls; their de-duplicated union is the 7 built-ins
 * (read, bash, edit, write, grep, find, ls). The `cwd` only binds tool
 * operations we never invoke here — we read each tool's `.name` and discard it.
 */
export const BUILTIN_TOOL_NAMES = [
    ...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map((t) => t.name)),
];
/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map();
/** When true, DEFAULT_AGENTS are skipped during registration. */
let disableDefaults = false;
/** Check whether default agents are disabled. */
export function isDefaultsDisabled() { return disableDefaults; }
/** Set whether default agents are disabled. */
export function setDefaultsDisabled(b) { disableDefaults = b; }
/** `fallbackSubagent` value that disables the fallback entirely (strict dispatch). */
export const NO_FALLBACK = "none";
/**
 * Agent type substituted when a caller-supplied `subagent_type` doesn't resolve
 * to exactly one enabled agent. `undefined` keeps the historical behavior
 * (general-purpose); `NO_FALLBACK` makes dispatch fail closed. Set from
 * `subagents.json` (`fallbackSubagent`).
 *
 * Module state rather than an index.ts closure because every caller-supplied
 * spawn path needs it — the Agent tool, the scheduler, and cross-extension RPC.
 */
let fallbackSubagent;
/** Get the configured fallback agent type. undefined = general-purpose. */
export function getFallbackSubagent() { return fallbackSubagent; }
/** Set the configured fallback agent type. undefined = general-purpose. */
export function setFallbackSubagent(v) { fallbackSubagent = v; }
/**
 * Build a registry map: DEFAULT_AGENTS first (unless disabled via settings),
 * then user agents overlaid on top (same name overrides the default).
 * Pure — callers that must not disturb the process-wide registry (nested
 * delegation resolving agents from its own config root) build their own map.
 */
export function buildAgentRegistry(userAgents) {
    const registry = new Map();
    if (!disableDefaults) {
        for (const [name, config] of DEFAULT_AGENTS)
            registry.set(name, config);
    }
    for (const [name, config] of userAgents)
        registry.set(name, config);
    return registry;
}
/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents) {
    agents.clear();
    for (const [name, config] of buildAgentRegistry(userAgents)) {
        agents.set(name, config);
    }
}
/** Case-insensitive key resolution within a registry. */
function resolveKeyIn(registry, name) {
    if (registry.has(name))
        return name;
    const lower = name.toLowerCase();
    for (const key of registry.keys()) {
        if (key.toLowerCase() === lower)
            return key;
    }
    return undefined;
}
/** Case-insensitive key resolution. */
function resolveKey(name) {
    return resolveKeyIn(agents, name);
}
/** Resolve a type name case-insensitively in a registry. Returns the canonical key or undefined. */
export function resolveTypeIn(registry, name) {
    return resolveKeyIn(registry, name);
}
/** Get the agent config for a type (case-insensitive) from a registry. */
export function getAgentConfigIn(registry, name) {
    const key = resolveKeyIn(registry, name);
    return key ? registry.get(key) : undefined;
}
/** Check if a type is valid and enabled (case-insensitive) in a registry. */
export function isValidTypeIn(registry, type) {
    const key = resolveKeyIn(registry, type);
    if (!key)
        return false;
    return registry.get(key)?.enabled !== false;
}
/** Get all enabled type names in a registry (for spawning and tool descriptions). */
export function getAvailableTypesIn(registry) {
    return [...registry.entries()]
        .filter(([_, config]) => config.enabled !== false)
        .map(([name]) => name);
}
/**
 * Case-insensitive resolution that refuses to guess. An exact match always wins;
 * otherwise the name must match exactly one key. Two agents differing only in
 * case are reachable (`loadCustomAgents` keys by filename across three
 * directories), and picking whichever came first would silently dispatch a
 * different agent, model and tool policy than the caller meant.
 */
function resolveUnambiguousKeyIn(registry, name) {
    if (registry.has(name))
        return name;
    const lower = name.toLowerCase();
    const matches = [...registry.keys()].filter(key => key.toLowerCase() === lower);
    return matches.length === 1 ? matches[0] : undefined;
}
/**
 * The canonical key for a caller-supplied name that identifies exactly one
 * ENABLED agent, or undefined. Strict by construction: no fallback, no guessing
 * between case-variants. Nested delegation resolves with this directly, since
 * "unknown types are rejected rather than falling back" is its own contract.
 */
export function resolveEnabledTypeIn(registry, requested) {
    const raw = typeof requested === "string" ? requested.trim() : "";
    if (!raw)
        return undefined;
    const key = resolveUnambiguousKeyIn(registry, raw);
    return key !== undefined && registry.get(key)?.enabled !== false ? key : undefined;
}
/**
 * Resolve a caller-supplied agent type against a registry, applying the
 * `fallbackSubagent` policy. The single decision point for every caller-supplied
 * spawn — the Agent tool, the scheduler, cross-extension RPC, and the nested
 * tools — so a type that fails here never reaches `runAgent`, where `getConfig`
 * would silently substitute general-purpose.
 *
 * Unknown, disabled, and case-ambiguous names are all treated the same way:
 * the caller named something that doesn't identify exactly one enabled agent.
 *
 * Pure over `registry` — callers that need fresh agent files reload before
 * calling (the Agent tool already does, per spawn). Reloading here would mean
 * importing custom-agents.ts, which imports this module.
 */
export function resolveSpawnTypeIn(registry, requested) {
    const raw = typeof requested === "string" ? requested.trim() : "";
    const available = () => getAvailableTypesIn(registry).join(", ") || "(none)";
    const key = resolveEnabledTypeIn(registry, raw);
    if (key !== undefined)
        return { ok: true, type: key };
    // A missing type follows the same policy as a wrong one rather than always
    // erroring: before this setting existed an empty type fell back like any
    // other unresolvable name, and only opting in should change that.
    const reason = raw ? `Unknown or disabled agent type: "${raw}".` : "No agent type given.";
    // Trimmed like `requested`: a padded value set programmatically would
    // otherwise be reported as a missing agent.
    const configured = typeof fallbackSubagent === "string" ? fallbackSubagent.trim() : undefined;
    if (configured !== undefined && configured.toLowerCase() === NO_FALLBACK) {
        return { ok: false, message: `${reason} Available: ${available()}.` };
    }
    if (configured !== undefined) {
        // An explicitly configured fallback that is itself unusable is a
        // misconfiguration, not a second chance to guess — say so rather than
        // quietly dropping to general-purpose.
        const fallbackKey = resolveUnambiguousKeyIn(registry, configured);
        if (fallbackKey === undefined || registry.get(fallbackKey)?.enabled === false) {
            return {
                ok: false,
                message: `${reason} The configured fallbackSubagent "${configured}" is itself ` +
                    `unknown or disabled. Available: ${available()}.`,
            };
        }
        return { ok: true, type: fallbackKey, fellBackFrom: raw };
    }
    // Unset: historical behavior, deliberately unchanged. #183 asks for the
    // fallback to remain the default, so the pre-existing hole it leaves — an
    // unregistered general-purpose resolving to `getConfig`'s all-tools hardcoded
    // tier — is what `fallbackSubagent: none` is for, not something to close
    // under everyone silently.
    return { ok: true, type: "general-purpose", fellBackFrom: raw };
}
/** Resolve a caller-supplied agent type against the process-wide registry. */
export function resolveSpawnType(requested) {
    return resolveSpawnTypeIn(agents, requested);
}
/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name) {
    return resolveKey(name);
}
/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name) {
    return getAgentConfigIn(agents, name);
}
/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes() {
    return getAvailableTypesIn(agents);
}
/** Get all type names including disabled (for UI listing). */
export function getAllTypes() {
    return [...agents.keys()];
}
/** Get names of default agents currently in the registry. */
export function getDefaultAgentNames() {
    return [...agents.entries()]
        .filter(([_, config]) => config.isDefault === true)
        .map(([name]) => name);
}
/** Get names of user-defined agents (non-defaults) currently in the registry. */
export function getUserAgentNames() {
    return [...agents.entries()]
        .filter(([_, config]) => config.isDefault !== true)
        .map(([name]) => name);
}
/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type) {
    return isValidTypeIn(agents, type);
}
/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"];
/**
 * Get memory tool names (read/write/edit) not already in the provided set.
 */
export function getMemoryToolNames(existingToolNames) {
    return MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}
/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES = ["read"];
/**
 * Get read-only memory tool names not already in the provided set.
 */
export function getReadOnlyMemoryToolNames(existingToolNames) {
    return READONLY_MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}
/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type) {
    const key = resolveKey(type);
    const raw = key ? agents.get(key) : undefined;
    const config = raw?.enabled !== false ? raw : undefined;
    // `undefined` (definition omitted the field) → all built-ins; an explicit `[]`
    // (`tools: none` or a `tools:` with only `ext:` entries) → zero built-ins.
    return config?.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
}
/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). Falls back to general-purpose. */
export function getConfig(type) {
    const key = resolveKey(type);
    const config = key ? agents.get(key) : undefined;
    if (config && config.enabled !== false) {
        return {
            displayName: config.displayName ?? config.name,
            color: config.color,
            description: config.description,
            builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
            extensions: config.extensions,
            excludeExtensions: config.excludeExtensions,
            skills: config.skills,
            promptMode: config.promptMode,
        };
    }
    // Fallback for unknown/disabled types — general-purpose config
    const gp = agents.get("general-purpose");
    if (gp && gp.enabled !== false) {
        return {
            displayName: gp.displayName ?? gp.name,
            color: gp.color,
            description: gp.description,
            builtinToolNames: gp.builtinToolNames ?? BUILTIN_TOOL_NAMES,
            extensions: gp.extensions,
            excludeExtensions: gp.excludeExtensions,
            skills: gp.skills,
            promptMode: gp.promptMode,
        };
    }
    // Absolute fallback (should never happen)
    return {
        displayName: "Agent",
        description: "General-purpose agent for complex, multi-step tasks",
        builtinToolNames: BUILTIN_TOOL_NAMES,
        extensions: true,
        skills: true,
        promptMode: "append",
    };
}
