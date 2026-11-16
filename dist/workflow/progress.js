/**
 * progress.ts — the workflow progress model, ported from Claude Code.
 *
 * Progress is an **append-only event log**, not a tree. Agent entries are keyed
 * by `index` and last-write-wins, so a running agent is updated by appending a
 * fresh entry with the same index rather than mutating anything. Every view —
 * the inline card, the workflows dialog, the fleet widget — derives its shape
 * by collapsing that log. Keeping the log authoritative is what lets a batched
 * update carry several agents' changes in one message from the worker.
 *
 * Two vocabularies, deliberately distinct:
 *   - entry `state` is only start | progress | done | error, with `skipped`,
 *     `blocked` and `cached` as separate booleans;
 *   - the display state adds queued, running, interrupted, skipped, blocked and
 *     failed, and is *derived* (see `displayState`).
 * Mixing them up is the easiest way to get the rendering wrong, which is why
 * the derivation lives here as one function rather than inline in each renderer.
 *
 * Everything in this file is pure and framework-free so the whole model is
 * unit-testable without a terminal.
 */
/**
 * Fold the event log into its latest state.
 *
 * Agent entries collapse by index (last write wins); logs accumulate in order;
 * phase titles are a lookup for grouping.
 */
export function collapse(progress) {
    const agents = new Map();
    const logs = [];
    const phaseTitles = new Map();
    for (const entry of progress) {
        if (entry.type === "workflow_agent")
            agents.set(entry.index, entry);
        else if (entry.type === "workflow_log")
            logs.push(entry.message);
        else
            phaseTitles.set(entry.index, entry.title);
    }
    return {
        agents: [...agents.values()].sort((a, b) => a.index - b.index),
        logs,
        phaseTitles,
    };
}
/**
 * Derive what to render for one agent.
 *
 * `workflowActive` is false once the run has stopped: anything still mid-flight
 * at that point was cut off rather than finished, hence "interrupted".
 */
export function displayState(entry, workflowActive) {
    if (entry.state === "done")
        return "done";
    if (entry.state === "error") {
        if (entry.skipped)
            return "skipped";
        if (entry.blocked)
            return "blocked";
        return "failed";
    }
    if (!workflowActive)
        return "interrupted";
    // Queued means accepted but never given a slot. An entry with no queuedAt at
    // all predates the semaphore and is treated as running.
    return entry.queuedAt != null && entry.startedAt == null ? "queued" : "running";
}
/** True while an entry is still expected to change. */
export function isLive(entry) {
    return entry.state === "start" || entry.state === "progress";
}
/** Bucket agents by phase. Returns null when no agent declared a phase. */
function groupByPhase(agents, phaseTitles) {
    if (!agents.some(a => a.phaseIndex != null))
        return null;
    const byPhase = new Map();
    for (const agent of agents) {
        const phaseIndex = agent.phaseIndex ?? 0;
        let group = byPhase.get(phaseIndex);
        if (!group) {
            group = { phaseIndex, title: phaseTitles.get(phaseIndex) ?? `Phase ${phaseIndex}`, agents: [] };
            byPhase.set(phaseIndex, group);
        }
        group.agents.push(agent);
    }
    return [...byPhase.values()].sort((a, b) => a.phaseIndex - b.phaseIndex);
}
/** Roll a phase's agents up into the counts and totals its header shows. */
function summarize(group) {
    let done = 0;
    let failed = 0;
    let tokens = 0;
    let minStart = Number.POSITIVE_INFINITY;
    let maxProgress = 0;
    for (const agent of group.agents) {
        if (agent.state === "done")
            done++;
        else if (agent.state === "error")
            failed++;
        if (agent.tokens)
            tokens += agent.tokens;
        if (agent.startedAt != null) {
            if (agent.startedAt < minStart)
                minStart = agent.startedAt;
            const last = agent.lastProgressAt ?? agent.startedAt;
            if (last > maxProgress)
                maxProgress = last;
        }
    }
    const total = group.agents.length;
    const finished = done + failed === total && total > 0;
    return {
        title: group.title,
        status: finished ? (failed > 0 ? "failed" : "done") : "running",
        agents: group.agents,
        doneCount: done,
        totalCount: total,
        tokens,
        // Wall-clock across the phase, not the sum of its agents: they overlap.
        durationMs: minStart < Number.POSITIVE_INFINITY ? maxProgress - minStart : 0,
    };
}
/** A phase declared in `meta` that has not produced any agent yet. */
function placeholder(title) {
    return { title, status: "not-started", agents: [], doneCount: 0, totalCount: 0, tokens: 0, durationMs: 0 };
}
const normalizeTitle = (title) => title.toLowerCase().trim();
/**
 * Reconcile the phases declared in `meta` with the phases actually observed.
 *
 * Matching is fuzzy on purpose: a script may call `phase("Review")` against a
 * declared `{ title: "Review changed files" }`, and Claude Code treats those as
 * the same phase when either title is a prefix of the other. Each observed
 * group is consumed at most once, declared-but-unseen phases render as
 * not-started placeholders, and observed groups with no declaration are
 * appended after — that is how an undeclared `phase()` "gets its own group".
 */
function mergePhases(declared, observed) {
    const consumed = new Set();
    const merged = [];
    for (const phase of declared ?? []) {
        const wanted = normalizeTitle(phase.title);
        const match = observed.find(group => {
            if (consumed.has(group))
                return false;
            const actual = normalizeTitle(group.title);
            return actual === wanted || actual.startsWith(wanted) || wanted.startsWith(actual);
        });
        if (match) {
            consumed.add(match);
            merged.push(summarize(match));
        }
        else {
            merged.push(placeholder(phase.title));
        }
    }
    for (const group of observed) {
        if (!consumed.has(group))
            merged.push(summarize(group));
    }
    return merged;
}
/**
 * Build the phase groups a renderer walks.
 *
 * When nothing declared or emitted a phase, every agent collapses into a single
 * group titled "Agents" so the tree still has one level of structure.
 */
export function buildPhaseGroups(progress, declared) {
    const { agents, phaseTitles } = collapse(progress);
    const observed = groupByPhase(agents, phaseTitles) ?? [];
    const merged = mergePhases(declared, observed);
    if (merged.length === 0 && agents.length > 0) {
        return [summarize({ title: "Agents", agents })];
    }
    // A run that declared phases but produced un-phased agents would otherwise
    // render placeholders and drop those agents from the tree entirely. Claude
    // Code has the same hole; showing the work is worth the small divergence.
    if (agents.length > 0 && !merged.some(group => group.totalCount > 0)) {
        return [...merged, summarize({ title: "Agents", agents })];
    }
    return merged;
}
/**
 * Aggregate counts for the header line.
 *
 * `agentCount` is the number the runtime has *scheduled*, which can exceed the
 * number that has emitted an entry — a fan-out reports its size before its
 * agents start, so the total does not visibly climb as they trickle in.
 */
export function stats(progress, agentCount = 0) {
    let seen = 0;
    let done = 0;
    let failed = 0;
    let started = 0;
    let anyLive = false;
    for (const entry of progress) {
        if (entry.type !== "workflow_agent")
            continue;
        seen++;
        if (entry.state === "done") {
            done++;
            started++;
        }
        else if (entry.state === "error") {
            failed++;
            started++;
        }
        else {
            anyLive = true;
            // Counted as started unless it is provably still waiting for a slot.
            if (entry.startedAt !== undefined || entry.queuedAt === undefined)
                started++;
        }
    }
    const total = Math.max(agentCount, seen);
    return {
        done,
        failedCount: failed,
        running: anyLive,
        total,
        started,
        // `!anyLive` is implied by the count test — `total >= seen`, and `seen` also
        // counts live entries, so `done + failed >= total` can only hold when none
        // are live. Kept for parity with Claude Code and as a guard should `total`
        // ever stop deriving from `seen`; no test can reach it as written.
        complete: !anyLive && seen > 0 && done + failed >= total,
    };
}
/** Elapsed run time, excluding any time spent paused. */
export function elapsedMs(task, now) {
    return Math.max(0, (task.endTime ?? now) - task.startTime - (task.totalPausedMs ?? 0));
}
const plural = (n, word) => (n === 1 ? word : `${word}s`);
/** `1m12s` / `9s` / `340ms`, matching how the rest of the extension reads. */
export function formatDuration(ms) {
    if (ms < 1000)
        return `${Math.max(0, Math.round(ms))}ms`;
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0)
        return `${seconds}s`;
    return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}
/**
 * The one-line summary above the tree: `3/7 agents · 1m12s`, plus a terminal
 * suffix once the run stops. Deliberately carries no phase count.
 */
export function header(task, meta, groups, agentCount, now) {
    const suffix = task.status === "completed" ? " · done"
        : task.status === "killed" ? " · stopped"
            : task.status === "paused" ? " · paused"
                : task.status === "failed" ? " · failed"
                    : "";
    let doneAgents = 0;
    let totalAgents = 0;
    for (const group of groups) {
        doneAgents += group.doneCount;
        totalAgents += group.totalCount;
    }
    totalAgents = Math.max(agentCount, totalAgents, doneAgents);
    return {
        name: task.workflowName ?? meta?.name ?? task.summary ?? task.description ?? "workflow",
        subtext: meta?.description ?? task.description ?? task.summary ?? "",
        stats: `${doneAgents}/${totalAgents} ${plural(totalAgents, "agent")} · ${formatDuration(elapsedMs(task, now))}${suffix}`,
    };
}
/* ------------------------------------------------------------------------- *
 * Size warning
 * ------------------------------------------------------------------------- */
export const DEFAULT_AGENT_CAP = 25;
export const DEFAULT_TOKEN_CAP = 1_500_000;
/** Assumed spend per agent before any has reported, for the projection. */
export const ASSUMED_TOKENS_PER_AGENT = 70_000;
/**
 * Warn when a run is about to get expensive.
 *
 * The projection matters more than the current total: a 200-agent fan-out is
 * worth flagging at agent 3, not after it has already spent the budget.
 */
export function sizeWarning(input) {
    const agentCap = input.agentCap ?? DEFAULT_AGENT_CAP;
    const tokenCap = input.tokenCap ?? DEFAULT_TOKEN_CAP;
    const perAgent = input.startedAgents > 0 ? input.totalTokens / input.startedAgents : ASSUMED_TOKENS_PER_AGENT;
    const projectedTokens = Math.max(input.totalTokens, Math.round(perAgent * input.scheduledAgents));
    const overAgents = input.scheduledAgents > agentCap;
    const overTokens = input.totalTokens > tokenCap || projectedTokens > tokenCap;
    if (!overAgents && !overTokens)
        return undefined;
    return {
        axis: overAgents && overTokens ? "both" : overAgents ? "agents" : "tokens",
        scheduledAgents: input.scheduledAgents,
        totalTokens: input.totalTokens,
        projectedTokens,
        agentCap,
        tokenCap,
    };
}
/* ------------------------------------------------------------------------- *
 * Footer phase label
 * ------------------------------------------------------------------------- */
/** Words whose gerund is irregular, or which read better left alone. */
const GERUND_OVERRIDES = new Map([
    ["commit", "committing"],
    ["submit", "submitting"],
    ["format", "formatting"],
    ["setup", null],
    ["cleanup", null],
]);
const VOWELS = "aeiou";
const GERUND_CANDIDATE = /^[A-Za-z]{3,12}$/;
/**
 * Render a phase title as an activity: `Scan` → `Scanning`.
 *
 * Only applied in the footer, where the line reads as "what is happening now".
 * Anything that is not a plain short word is left untouched.
 */
export function gerund(word) {
    if (!GERUND_CANDIDATE.test(word))
        return word;
    const lower = word.toLowerCase();
    const override = GERUND_OVERRIDES.get(lower);
    if (override !== undefined)
        return override === null ? word : word[0] + override.slice(1);
    if (lower.endsWith("ing"))
        return word;
    if (lower.endsWith("ie"))
        return `${word.slice(0, -2)}ying`;
    if (lower.endsWith("e") && !lower.endsWith("ee") && !lower.endsWith("ye"))
        return `${word.slice(0, -1)}ing`;
    // Short consonant-vowel-consonant words double the final consonant: run →
    // running. `w`, `x` and `y` never double.
    const last = lower.at(-1) ?? "";
    if (lower.length <= 4 &&
        !VOWELS.includes(lower.at(-3) ?? "") &&
        VOWELS.includes(lower.at(-2) ?? "") &&
        !VOWELS.includes(last) &&
        !"wxy".includes(last)) {
        return `${word}${last}ing`;
    }
    return `${word}ing`;
}
/** Truncation width for a footer phase title. */
const FOOTER_TITLE_WIDTH = 16;
const truncate = (text, width) => text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
/**
 * The footer's "what is this run doing" label.
 *
 * One active phase shows its position; two concurrent phases are joined, since
 * a barrier-free pipeline routinely has work in more than one at a time.
 */
export function footerPhaseLabel(input) {
    const titles = input.titles.map(gerund);
    if (titles.length === 0)
        return "";
    if (titles.length === 1) {
        return `${truncate(titles[0], FOOTER_TITLE_WIDTH)} (${input.positionStart}/${input.totalPhases})`;
    }
    return titles.map(t => truncate(t, FOOTER_TITLE_WIDTH)).join(" & ");
}
