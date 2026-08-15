/**
 * host.ts — binds a workflow run to the real `AgentManager`.
 *
 * `runtime.ts` deliberately knows nothing about this extension: its only seam is
 * the injected {@link WorkflowHost}, which is what keeps the runtime's tests
 * free of sessions, models and git. This file is the other half of that seam —
 * everything the script can reach through `agent()`, `resume` and `gate` ends up
 * here, and nowhere else.
 *
 * Four mappings carry most of the weight:
 *
 *   - **ids.** The runtime hands out its own `wf-agent-N` handles before
 *     anything spawns, because it needs a stable progress-entry identity. The
 *     manager issues a different id when the child actually starts. `records`
 *     is the translation, and it is kept for the whole run rather than cleared
 *     on completion: `resume` reaches back to a child that has already
 *     finished.
 *   - **agent type and model.** Resolved through `resolveSpawnType` and
 *     `getAgentConfig` — the same dispatch the `Agent` tool uses — so a
 *     workflow and a tool call disagree about nothing.
 *   - **failure.** A strict worktree-isolation failure throws out of
 *     `spawnAndWait`; the script must see that as an agent that failed
 *     (`{ok: false}` → `null`), not as an unhandled rejection that takes the
 *     run down.
 *   - **when a `gate` runs.** For an isolated child it cannot wait until the
 *     spawn resolves: the manager commits the worktree to a branch and deletes
 *     the copy inside the child's own settle, so by then the only tree left to
 *     run `npm test` in is the main one — which would report on code the child
 *     never wrote. So the gate runs from `onBeforeWorktreeCleanup`, inside that
 *     settle, and the verdict travels back on the spawn result. `runGate` still
 *     exists for a child that had no worktree; the runtime uses whichever of
 *     the two happened, never both.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { getAgentConfig, resolveSpawnType } from "../agent-types.js";
import { resolveModel } from "../model-resolver.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import type { WorkflowGateResult, WorkflowHost, WorkflowSpawnResult } from "./runtime.js";

/**
 * Wall-clock bound on a `gate` command. Generous — a gate is routinely a test
 * suite — but not unbounded: `pi.exec` reports a timeout as `killed`, and a
 * gate that hangs forever would wedge the agent slot it is holding.
 */
export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

export interface WorkflowHostOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  /** The run's abort signal, so killing the workflow kills its children. */
  signal?: AbortSignal;
  /** Groups child transcripts under the parent session. */
  rootSessionId?: string;
  gateTimeoutMs?: number;
}

/**
 * Where the child worked, when that directory still exists.
 *
 * The guard is not defensive padding. `cleanupWorktree` commits the child's
 * changes to a branch and *removes* the copy before `spawnAndWait` resolves, so
 * an isolated child's worktree is normally already gone by the time a result is
 * built. That is exactly why a gate cannot wait until here — it runs from
 * `onBeforeWorktreeCleanup` instead — and why this reports nothing rather than
 * a path that no longer exists: handing a stale path to a command would fail
 * every gated worktree agent with a spawn error instead of a test result.
 */
function childCwd(record: AgentRecord): string | undefined {
  // `path`, not `workPath`: a workflow spawn never passes a cwd, so the manager
  // runs the child at the copied repo's root.
  const path = record.worktree?.path;
  return path !== undefined && existsSync(path) ? path : undefined;
}

/**
 * Whether the child itself succeeded — the same condition {@link toSpawnResult}
 * turns into `ok`, read from the live record so the pre-cleanup hook can tell a
 * finished child from a failed one before the result exists.
 */
function succeeded(record: AgentRecord | undefined): boolean {
  return record?.status === "completed" || record?.status === "steered";
}

/** Translate a settled record into what the script sees. */
function toSpawnResult(record: AgentRecord): WorkflowSpawnResult {
  const tokens = getLifetimeTotal(record.lifetimeUsage);
  const cwd = childCwd(record);
  const common = {
    ...(tokens > 0 ? { tokens } : {}),
    ...(record.toolUses > 0 ? { toolCalls: record.toolUses } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };

  if (succeeded(record)) {
    return { ...common, ok: true, text: record.result ?? "" };
  }
  // "stopped" is someone reaching in and stopping this child — /agents, the
  // fleet list, a workflow abort. That is the same thing the /workflows dialog's
  // skip action means, so it renders as skipped rather than failed.
  if (record.status === "stopped") {
    return { ...common, ok: false, skipped: true, error: record.error ?? "Stopped." };
  }
  return { ...common, ok: false, error: record.error ?? `Agent ${record.status}.` };
}

/** Shell used to run a `gate` command, mirroring how a user would type it. */
const GATE_SHELL: readonly [string, string] =
  process.platform === "win32" ? ["cmd", "/c"] : ["sh", "-c"];

export function createWorkflowHost(deps: WorkflowHostOptions): WorkflowHost {
  const { pi, ctx, manager } = deps;
  /** Runtime agent id → the manager record it spawned. Never pruned mid-run. */
  const records = new Map<string, string>();

  /**
   * Run a gate command in `cwd`. The only place a gate is executed — `runGate`
   * and the pre-cleanup hook both come through here — so "gate passed" is
   * decided from one behaviour, whichever route the command took.
   */
  async function executeGate(command: string, cwd: string): Promise<WorkflowGateResult> {
    const result = await pi.exec(GATE_SHELL[0], [GATE_SHELL[1], command], {
      cwd,
      timeout: deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const output = [result.stdout, result.stderr]
      .map(stream => stream.trim())
      .filter(Boolean)
      .join("\n");
    // `pi.exec` reports a timeout as `killed` with exit code 0, so the code
    // alone would read a killed gate as a passing one.
    if (result.killed) {
      return { ok: false, output: output || `Gate command timed out: ${command}` };
    }
    return { ok: result.code === 0, output };
  }

  return {
    async spawnAgent(request) {
      const dispatch = resolveSpawnType(request.agentType);
      if (!dispatch.ok) return { ok: false, error: dispatch.message };

      // Same precedence as the Agent tool: the caller's model wins, the agent
      // definition's is next, and the parent's is the floor. A model the script
      // named and we cannot resolve is an error; one the definition named falls
      // back to the parent silently, because the script never asked for it.
      let model = ctx.model;
      const modelInput = request.model ?? getAgentConfig(dispatch.type)?.model;
      if (modelInput !== undefined) {
        const resolved = resolveModel(modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (request.model !== undefined) return { ok: false, error: resolved };
        } else {
          model = resolved;
        }
      }

      /**
       * The gate's verdict, set only if the hook below actually ran the command.
       * Its presence is what stops the runtime running the gate a second time,
       * so it is set on the failure route too — a gate we tried and could not
       * complete is a failed gate, never an un-run one that then re-runs
       * against the wrong tree.
       */
      let gate: WorkflowGateResult | undefined;
      let spawnedId: string | undefined;
      const command = request.gate;
      /**
       * Verify the child's work while its worktree still exists.
       *
       * The manager destroys that copy inside the child's own settle, so this
       * is the last (and only) moment at which `npm test` can mean "the code
       * this child just wrote" rather than "whatever is in the main tree".
       */
      const onBeforeWorktreeCleanup =
        command === undefined
          ? undefined
          : async (worktreePath: string): Promise<void> => {
              // A failed child's gate is never consulted — the runtime reports
              // the child's own failure — so running it would be pure cost.
              if (spawnedId === undefined || !succeeded(manager.getRecord(spawnedId))) return;
              try {
                gate = await executeGate(command, worktreePath);
              } catch (error) {
                gate = { ok: false, output: error instanceof Error ? error.message : String(error) };
              }
            };

      try {
        const { record } = await manager.spawnAndWait(
          pi,
          ctx,
          dispatch.type,
          request.prompt,
          {
            description: request.label,
            ...(model !== undefined ? { model } : {}),
            ...(request.isolation !== undefined ? { isolation: request.isolation } : {}),
            ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
            ...(deps.rootSessionId !== undefined ? { rootSessionId: deps.rootSessionId } : {}),
            ...(onBeforeWorktreeCleanup !== undefined ? { onBeforeWorktreeCleanup } : {}),
          },
          id => {
            spawnedId = id;
            records.set(request.agentId, id);
          },
        );
        return { ...toSpawnResult(record), ...(gate !== undefined ? { gate } : {}) };
      } catch (error) {
        // Strict worktree isolation rejects out of `awaitStartup` — the child
        // never ran. That is this agent's failure, not the run's: the script
        // sees `null` and its siblings carry on.
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    abortAgent(agentId) {
      const id = records.get(agentId);
      // Nothing to abort before the manager has issued an id — the child is
      // still in startup, and the run's own signal reaches it there.
      if (id !== undefined) manager.abort(id);
    },

    async resumeAgent(agentId, prompt) {
      const id = records.get(agentId);
      if (id === undefined) {
        return { ok: false, error: `Cannot resume "${agentId}" — it never started.` };
      }
      const record = await manager.resume(id, prompt, deps.signal);
      if (record === undefined) {
        return {
          ok: false,
          error: `Agent ${id} has no session left to resume — records are dropped ten minutes after they finish.`,
        };
      }
      return toSpawnResult(record);
    },

    // Reached only for a gate the spawn did not already run — a child with no
    // worktree of its own, or a host wired without the pre-cleanup hook.
    async runGate(command, gate) {
      // The child's worktree when it had one and it survived; otherwise the
      // session's own directory, which is where a non-isolated child worked.
      return await executeGate(command, gate.cwd ?? ctx.cwd);
    },
  };
}
