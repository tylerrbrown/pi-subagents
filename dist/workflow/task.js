/**
 * task.ts — the background record one workflow run lives in.
 *
 * A `SubagentWorkflow` tool call returns a task id immediately and the run continues
 * without it, so the run's state cannot live in the tool call's closure: the
 * inline card, the completion notification and (later) the `/agents → Workflows` dialog
 * all read it after `execute` has returned. This is that record, shaped after
 * Claude Code's `local_workflow` task so the fields line up with what the
 * renderers already expect.
 *
 * The progress log is append-only and collapses by index (see `progress.ts`),
 * so every derived counter here is recomputed from the log rather than
 * incremented as entries arrive — a re-emitted agent entry replaces its
 * predecessor, and adding its tokens on top would double-count them.
 */
import { randomUUID } from "node:crypto";
import { escapeXml } from "../xml.js";
import { collapse, elapsedMs, stats } from "./progress.js";
/** `wf_` + hex, matching Claude Code's `^wf_[a-z0-9-]{6,}$` run ids. */
export function workflowRunId() {
    return `wf_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
export function createWorkflowTask(init) {
    return {
        type: "local_workflow",
        id: init.id,
        status: "running",
        script: init.script,
        scriptPath: init.scriptPath,
        args: init.args,
        meta: init.meta,
        workflowName: init.meta?.name,
        toolCallId: init.toolCallId,
        journalPath: init.journalPath,
        replay: init.replay,
        resumedFrom: init.resumedFrom,
        replayedCount: 0,
        workflowProgress: [],
        progressVersion: 0,
        agentCount: 0,
        doneCount: 0,
        totalTokens: 0,
        totalToolCalls: 0,
        logs: [],
        abortController: new AbortController(),
        startTime: init.startTime ?? Date.now(),
        totalPausedMs: 0,
    };
}
/**
 * Apply one batch of progress entries.
 *
 * Batched rather than per-entry because that is how the worker emits them, and
 * because every counter below is an O(log) recompute — doing it once per fan-out
 * frame instead of once per agent is the difference that keeps a 200-agent run
 * cheap to render.
 */
export function updateWorkflowProgressBatch(task, entries) {
    if (entries.length === 0)
        return;
    task.workflowProgress.push(...entries);
    task.progressVersion++;
    const { agents, logs } = collapse(task.workflowProgress);
    task.logs = logs;
    // `agentCount` is what the runtime has scheduled, which can lead what the log
    // has seen — never let a recompute walk it backwards.
    task.agentCount = Math.max(task.agentCount, agents.length);
    let totalTokens = 0;
    let totalToolCalls = 0;
    let done = 0;
    for (const agent of agents) {
        totalTokens += agent.tokens ?? 0;
        totalToolCalls += agent.toolCalls ?? 0;
        // Counted off the collapsed agents, so a re-emitted row counts once.
        if (agent.state === "done")
            done++;
    }
    task.totalTokens = totalTokens;
    task.totalToolCalls = totalToolCalls;
    task.doneCount = done;
}
/**
 * Hold the run, and stop its clock.
 *
 * The elapsed figure every surface shows subtracts `totalPausedMs`, so a run
 * left paused overnight does not come back reading as a twelve-hour run.
 */
export function pauseWorkflowTask(task, now = Date.now()) {
    if (task.status !== "running" || task.control === undefined)
        return false;
    task.control.pause();
    task.status = "paused";
    task.pausedAt = now;
    return true;
}
/** Let it go again, banking however long it was held. */
export function resumeWorkflowTask(task, now = Date.now()) {
    if (task.status !== "paused" || task.control === undefined)
        return false;
    task.control.resume();
    task.status = "running";
    task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, now - (task.pausedAt ?? now));
    task.pausedAt = undefined;
    return true;
}
/** Settle a task from the run's own result. */
export function completeWorkflowTask(task, result) {
    // Banked before the status moves off "paused": a run that finished while held
    // still spent that time held, and the elapsed figure has to say so.
    if (task.pausedAt !== undefined) {
        task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, Date.now() - task.pausedAt);
        task.pausedAt = undefined;
    }
    // Nothing left to control, and holding the handle would let the dialog offer
    // pause on a run that has already stopped.
    task.control = undefined;
    task.status = result.status;
    task.meta ??= result.meta;
    task.workflowName ??= result.meta.name;
    task.agentCount = Math.max(task.agentCount, result.agentCount);
    task.replayedCount = result.replayedCount;
    task.value = result.value;
    task.error = result.error;
    task.endTime = Date.now();
}
/**
 * Settle a task that never produced a result — a script rejected before the
 * worker started (bad `meta`, oversized source, non-JSON `args`).
 */
export function failWorkflowTask(task, error) {
    task.control = undefined;
    task.pausedAt = undefined;
    task.status = "failed";
    task.error = error;
    task.endTime = Date.now();
}
/** The run's outcome as text, for the notification and the LLM-facing result. */
export function workflowResultText(task) {
    if (task.error !== undefined)
        return task.error;
    if (task.value === undefined)
        return "No output.";
    if (typeof task.value === "string")
        return task.value;
    return JSON.stringify(task.value, null, 2);
}
/**
 * Resolve a `resumeFromRunId` against the runs this session has seen.
 *
 * Same-session only, and deliberately so: the journal lives beside the
 * session's task files, and a run id from another session would silently find
 * nothing to replay — reporting that as "resumed" would be a lie the caller
 * could not see through. An unknown id is an error rather than a cold start,
 * because a caller that asked to resume is expecting not to pay.
 */
export function resolveResumeTarget(runId, tasks) {
    const id = runId?.trim();
    if (id === undefined || id === "")
        return undefined;
    const prior = tasks.get(id);
    if (prior === undefined) {
        const known = [...tasks.keys()];
        return {
            ok: false,
            message: `No workflow run "${id}" in this session. ` +
                (known.length > 0
                    ? `Runs this session: ${known.join(", ")}.`
                    : "Nothing has run yet — call this without `resumeFromRunId`."),
        };
    }
    if (prior.status === "running") {
        return {
            ok: false,
            message: `Workflow "${id}" is still running. Stop it from /agents → Workflows before resuming it.`,
        };
    }
    if (prior.journalPath === undefined) {
        return { ok: false, message: `Workflow "${id}" has no journal to resume from.` };
    }
    return {
        ok: true,
        runId: id,
        journalPath: prior.journalPath,
        // The persisted copy, which is what `scriptPath` holds when the call had
        // no file of its own.
        scriptPath: prior.scriptPath ?? "",
    };
}
/** `<task-notification>`, in the same shape a finished background agent sends. */
export function formatWorkflowNotification(task, now = Date.now()) {
    const totals = stats(task.workflowProgress, task.agentCount);
    const status = task.status === "completed" ? "Done"
        : task.status === "killed" ? "Stopped"
            : `Error: ${task.error ?? "unknown"}`;
    const result = workflowResultText(task);
    return [
        `<task-notification>`,
        `<task-id>${task.id}</task-id>`,
        task.toolCallId ? `<tool-use-id>${escapeXml(task.toolCallId)}</tool-use-id>` : null,
        task.scriptPath ? `<script>${escapeXml(task.scriptPath)}</script>` : null,
        `<status>${escapeXml(status)}</status>`,
        `<summary>Workflow "${escapeXml(task.workflowName ?? task.id)}" ${task.status} — ${totals.done}/${totals.total} agents${task.replayedCount > 0 ? `, ${task.replayedCount} replayed from ${escapeXml(task.resumedFrom ?? "an earlier run")}` : ""}</summary>`,
        `<result>${escapeXml(result.length > 4000 ? `${result.slice(0, 4000)}\n...(truncated)` : result)}</result>`,
        `<usage><total_tokens>${task.totalTokens}</total_tokens><tool_uses>${task.totalToolCalls}</tool_uses><duration_ms>${elapsedMs(task, now)}</duration_ms></usage>`,
        `</task-notification>`,
    ].filter(Boolean).join("\n");
}
