/**
 * status-note.ts — Honest framing for an agent result: the parenthetical status
 * note for a non-normal outcome, and the salvaged partial output of a failure.
 *
 * Lives here rather than in an index.ts closure because both entry points need
 * it — the top-level tools and the nested delegation tools, which can't import
 * from index.ts (that is the extension entry, and it already reaches these tools
 * through agent-runner).
 */

import type { AgentRecord, RunFailureKind, StopReason } from "./types.js";

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` (a human aborted it) is deliberately distinct from `aborted` (the
 * turn limit was hit) — the parent should treat human intervention differently
 * from a budget cutoff.
 */
export function getStatusNote(status: string, stopReason?: StopReason): string {
  switch (status) {
    case "stopped":
      return ` (${stoppedBy(stopReason)} before completion — output is partial; the task was NOT finished)`;
    case "timeout":
      return " (TIMED OUT at its wall-clock deadline — output is partial; the task was NOT finished)";
    case "aborted":
      return " (aborted — hit the turn limit before completion; output may be incomplete)";
    case "steered":
      return " (wrapped up at the turn limit — output may be partial)";
    default:
      return "";
  }
}

/**
 * Foreground variant of `getStatusNote`. A foreground caller is in a different
 * position from a background one, so it needs different text:
 *
 *   - It already holds the agent's ENTIRE output inline, whereas the background
 *     notification carries a 500-char preview. So only here can we truthfully
 *     say there is nothing more to fetch — which is the whole point, because
 *   - it has no agent id. The id travels in the tool result's renderer
 *     `details`, which is never serialized to the model. A parent that reads
 *     "output may be partial" as "truncated, go retrieve the rest" therefore
 *     has nothing valid to call `get_subagent_result` with, and will invent an
 *     id (#174).
 *
 * Only the lead clause varies between the three, and each variation carries
 * information: `wrapped up` vs `aborted` tells the parent whether the output is
 * a considered final answer or a fragment, and `stopped` shouts because a human
 * intervening outranks everything else in the string. Only `steered` hedges on
 * completion — it was told to wrap up and did, so it may well have finished at
 * the limit; an aborted run blew through its grace turns while still working,
 * and `stopped` can only fire on a running agent, so neither ever delivered a
 * final answer. Identical confidence gets identical wording: phrasing one fact
 * two ways invites a hunt for a distinction that isn't there.
 *
 * Every clause is a statement about state, never an instruction to act, and
 * `get_subagent_result` is never named — naming the tool we steer away from only
 * raises its salience. Two instructions were tried here and cut: "re-spawn with
 * a higher max_turns" (pushes a fresh multi-minute run to save one wasted tool
 * call) and, on `stopped`, "ask before restarting it" (restates the lead, and
 * presumes someone is present to ask — false under `pi -p`, in scheduled jobs,
 * and in any background-driven run). Nothing here can measure whether wording
 * improves parent behavior, so removing a false cue (which cannot induce new
 * behavior) and adding an instruction (which can) are not equally safe bets.
 * Don't add either back without a way to measure it.
 */
export function getForegroundOutcomeNote(status: string, stopReason?: StopReason): string {
  switch (status) {
    case "stopped":
      return ` (${stoppedBy(stopReason)} — everything the agent produced is above; the task is unfinished)`;
    case "timeout":
      return " (TIMED OUT at its wall-clock deadline — everything the agent produced is above; the task is unfinished)";
    case "aborted":
      return " (aborted at the turn limit — everything the agent produced is above; the task is unfinished)";
    case "steered":
      return " (wrapped up at the turn limit — everything the agent produced is above; the task may be unfinished)";
    default:
      return "";
  }
}

/**
 * Provider back-pressure, as distinct from a broken run. Substring/status
 * shapes rather than a provider-specific error type, because the text reaches
 * us through pi's resolved `errorMessage` and every provider spells it its own
 * way (`overloaded_error`, `429`, `503`, "rate limit").
 */
const OVERLOAD_PATTERN =
  /\boverload(ed|ing)?|\brate[ _-]?limit|\b429\b|\b503\b|too many requests|service unavailable/i;

/**
 * Classify a run failure. Overload is called out because the parent's correct
 * response differs: retry later, rather than fix the agent. Deliberately does
 * NOT trigger a provider fallback — per `user-preferences.md` (MIN AI provider
 * default), rerouting onto another provider is Tyler's explicit choice, not
 * something the fork does behind him.
 */
export function classifyRunFailure(message: string | undefined): RunFailureKind {
  return message && OVERLOAD_PATTERN.test(message) ? "overload" : "other";
}

/**
 * Lead clause naming who stopped a run.
 *
 * Only a genuine user stop shouts. Three different paths used to set `stopped`
 * — the conversation viewer, a cross-extension RPC abort, and
 * `session_shutdown → abortAll()` — and all three claimed a human had
 * intervened, so a session going down looked like Tyler pressing stop. An
 * unattributed stop says only that it stopped: inventing a cause is the bug.
 */
function stoppedBy(stopReason?: StopReason): string {
  switch (stopReason) {
    case "user":
      return "STOPPED BY THE USER";
    case "rpc":
      return "stopped by another extension";
    case "shutdown":
      return "stopped because the session shut down";
    case "parent":
      return "stopped because its parent agent finished";
    default:
      return "stopped";
  }
}

/**
 * Why a failed run failed, when that changes what the parent should do next.
 * An overloaded provider is transient and is deliberately NOT rerouted — see
 * `classifyRunFailure` — so the parent is told to retry rather than to fix
 * something. Everything else already carries its own error text.
 */
export function getFailureNote(kind: RunFailureKind | undefined): string {
  return kind === "overload"
    ? " (the provider was overloaded — transient, and not rerouted to another provider; retry later)"
    : "";
}

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}
