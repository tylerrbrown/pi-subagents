/**
 * model-scope.ts — `scopeModels` policy, shared by the top-level Agent tool and
 * the nested delegation tools so a nested spawn can't escape the allowlist the
 * top-level path enforces.
 *
 * State lives here (rather than in an index.ts closure) for the same reason
 * `disableDefaults` lives in agent-types.ts: both entry points need it.
 */
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
/**
 * When enabled, subagent model choices are validated against `enabledModels`
 * from pi's settings — both global `<agentDir>/settings.json` and project-local
 * `<cwd>/.pi/settings.json` (project overrides global). Off by default; opt-in
 * via `/agents → Settings`. See the SubagentsSettings.scopeModels docstring for
 * the hard-error vs warn-and-proceed policy and its rationale.
 */
let scopeModelsEnabled = false;
export function isScopeModelsEnabled() { return scopeModelsEnabled; }
export function setScopeModelsEnabled(enabled) { scopeModelsEnabled = enabled; }
/**
 * Check the effective resolved model against the user's enabledModels list.
 *
 * scopeModels guards against *runtime* LLM choices, not user-level config:
 *   - Caller-supplied out-of-scope → hard error (the orchestrator made an explicit
 *     out-of-scope choice; surface it so it picks differently).
 *   - Frontmatter-pinned or parent-inherited out-of-scope → warn but proceed (the
 *     user authored/installed this agent or chose the parent's model; trust it).
 */
export function checkModelScope(args) {
    const { model, cwd, modelRegistry, callerSupplied, agentLabel, modelInput } = args;
    if (!scopeModelsEnabled || !model)
        return { kind: "ok" };
    const allowed = resolveEnabledModels(readEnabledModels(cwd), modelRegistry, cwd);
    if (!allowed || isModelInScope(model, allowed))
        return { kind: "ok" };
    if (callerSupplied) {
        const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
        return {
            kind: "error",
            message: `Model not in scope: "${modelInput}".\n\nAllowed models (from enabledModels):\n${list}`,
        };
    }
    const modelLabel = modelInput ?? `${model.provider}/${model.id}`;
    return {
        kind: "warn",
        message: `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
    };
}
