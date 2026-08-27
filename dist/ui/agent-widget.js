/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentNameLabel } from "../agent-color.js";
import { getConfig } from "../agent-types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
// ---- Constants ----
/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;
/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped", "timeout"]);
/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY = {
    read: "reading",
    bash: "running command",
    edit: "editing",
    write: "writing",
    grep: "searching",
    find: "finding files",
    ls: "listing",
};
// ---- Formatting helpers ----
/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme, color, text) {
    const styledEmpty = theme.fg(color, "");
    const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
    return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}
/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count) {
    if (count >= 1_000_000)
        return `${(count / 1_000_000).toFixed(1)}M token`;
    if (count >= 1_000)
        return `${(count / 1_000).toFixed(1)}k token`;
    return `${count} token`;
}
/**
 * Format a cost as `~$0.0042`, or "" when there is nothing to show.
 *
 * The tilde is load-bearing: this is pi's own estimate from the model's listed
 * rates, not a billed figure, and the surfaces that print it sit next to token
 * counts that ARE exact.
 *
 * Nothing is printed for zero, which is also what a model with no pricing data
 * reports: `$0.00` beside a local model's tokens would claim its cost was
 * measured and found to be nothing, rather than never measured at all. For the
 * same reason a real cost too small for four decimals reads `<$0.0001` — it was
 * measured, and rounding it to `~$0.0000` would say the opposite.
 */
export function agentRecordName(record) {
    return record.alias ?? record.handle ?? getDisplayName(record.type);
}
export function agentRecordNameWidth(record) {
    return visibleWidth(agentRecordName(record)) + (hasAgentBadge(record.type) ? 2 : 0);
}
export function renderAgentRecordName(record, theme, style = {}, width) {
    const badgePadding = hasAgentBadge(record.type) ? 2 : 0;
    const name = width === undefined
        ? agentRecordName(record)
        : padColumn(agentRecordName(record), Math.max(0, width - badgePadding));
    return renderAgentNameLabel(name, getConfig(record.type).color, theme, style);
}
function compactLevel(level) {
    return level === "medium" ? "med" : level ?? "-";
}
/** `gpt-5.6-sol/med/med` — model/requested effort/effective thinking. */
export function formatAgentPosture(record) {
    const session = record.session;
    const thinking = session?.thinkingLevel ?? record.invocation?.thinking;
    const effort = record.invocation?.thinking ?? thinking;
    const model = session?.model?.id ?? record.invocation?.modelName;
    return model ? `${model}/${compactLevel(effort)}/${compactLevel(thinking)}` : "";
}
export function padColumn(text, width) {
    const clipped = truncateToWidth(text, width);
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
function rightAlign(left, right, width) {
    const rightWidth = visibleWidth(right);
    if (rightWidth >= width)
        return sliceByColumn(right, rightWidth - width, width, true);
    const leftWidth = Math.max(0, width - rightWidth - 1);
    const clippedLeft = truncateToWidth(left, leftWidth);
    const gap = Math.max(1, width - visibleWidth(clippedLeft) - rightWidth);
    return truncateToWidth(clippedLeft + " ".repeat(gap) + right, width);
}
export function formatCost(cost) {
    if (!(cost > 0))
        return ""; // also catches NaN
    if (cost < 0.0001)
        return "<$0.0001";
    if (cost >= 1)
        return `~$${cost.toFixed(2)}`;
    // Under a dollar: cents at minimum, four decimals at most, nothing trailing.
    // Most single runs land between a tenth of a cent and a dime, where rounding
    // to cents would collapse a 4x difference in spend into the same figure.
    const rounded = Number(cost.toFixed(4));
    const decimals = (String(rounded).split(".")[1] ?? "").length;
    return `~$${rounded.toFixed(Math.max(2, decimals))}`;
}
/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `⇊N` in dim.
 *
 *   "12.3k token"               — no annotations
 *   "12.3k token (45%)"         — percent only
 *   "12.3k token (⇊2)"          — compactions only (e.g. right after compact)
 *   "12.3k token (45% · ⇊2)"    — both
 */
export function formatSessionTokens(tokens, percent, theme, compactions = 0) {
    const tokenStr = formatTokens(tokens);
    const annot = [];
    if (percent !== null) {
        const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
        annot.push(theme.fg(color, `${Math.round(percent)}%`));
    }
    if (compactions > 0) {
        annot.push(theme.fg("dim", `⇊${compactions}`));
    }
    if (annot.length === 0)
        return tokenStr;
    return `${tokenStr} (${annot.join(" · ")})`;
}
/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount, maxTurns) {
    return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}
/** Format milliseconds as human-readable duration. */
export function formatMs(ms) {
    if (ms >= 3_600_000)
        return `${(ms / 3_600_000).toFixed(1)}h`;
    if (ms >= 60_000)
        return `${(ms / 60_000).toFixed(1)}m`;
    return `${(ms / 1000).toFixed(1)}s`;
}
export function formatAgentMetrics(record, activity, theme, showCost, now = Date.now()) {
    const parts = [];
    const toolUses = activity?.toolUses ?? record.toolUses;
    if (activity)
        parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    if (toolUses > 0)
        parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    if (tokens > 0) {
        parts.push(formatSessionTokens(tokens, getSessionContextPercent(activity?.session ?? record.session), theme, record.compactionCount));
    }
    if (showCost) {
        const cost = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (cost)
            parts.push(cost);
    }
    parts.push(`${formatMs((record.completedAt ?? now) - record.startedAt)} elapsed`);
    if (record.status === "running") {
        parts.push(`idle ${formatMs(now - (record.lastProgressAt ?? record.startedAt))}`);
    }
    return parts.join(" · ");
}
/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt, completedAt) {
    if (completedAt)
        return formatMs(completedAt - startedAt);
    return `${formatMs(Date.now() - startedAt)} (running)`;
}
/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type) {
    return getConfig(type).displayName;
}
/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type) {
    const config = getConfig(type);
    return config.promptMode === "append" ? "twin" : undefined;
}
/** Mode label is not included — callers add it where they want it. */
export function buildInvocationTags(invocation) {
    const tags = [];
    if (!invocation)
        return { tags };
    if (invocation.thinking)
        tags.push(`thinking: ${invocation.thinking}`);
    if (invocation.isolated)
        tags.push("isolated");
    if (invocation.isolation === "worktree")
        tags.push("worktree");
    if (invocation.inheritContext)
        tags.push("inherit context");
    if (invocation.runInBackground)
        tags.push("background");
    if (invocation.maxTurns != null)
        tags.push(`max turns: ${invocation.maxTurns}`);
    return { modelName: invocation.modelName, tags };
}
/** Truncate text to a single line, max `len` chars. */
function truncateLine(text, len = 60) {
    const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
    if (line.length <= len)
        return line;
    return line.slice(0, len) + "…";
}
/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools, responseText) {
    if (activeTools.size > 0) {
        const groups = new Map();
        for (const toolName of activeTools.values()) {
            const action = TOOL_DISPLAY[toolName] ?? toolName;
            groups.set(action, (groups.get(action) ?? 0) + 1);
        }
        const parts = [];
        for (const [action, count] of groups) {
            if (count > 1) {
                parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
            }
            else {
                parts.push(action);
            }
        }
        return parts.join(", ") + "…";
    }
    // No tools active — show truncated response text if available
    if (responseText && responseText.trim().length > 0) {
        return truncateLine(responseText);
    }
    return "thinking…";
}
// ---- Widget manager ----
export class AgentWidget {
    manager;
    agentActivity;
    mode;
    showCost;
    uiCtx;
    widgetFrame = 0;
    widgetInterval;
    /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
    finishedTurnAge = new Map();
    /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
    static ERROR_LINGER_TURNS = 2;
    /** Whether the widget callback is currently registered with the TUI. */
    widgetRegistered = false;
    /** Cached TUI reference from widget factory callback, used for requestRender(). */
    tui;
    /** Last status bar text, used to avoid redundant setStatus calls. */
    lastStatusText;
    constructor(manager, agentActivity,
    /**
     * Read live at render time. Selects which agents the widget shows — see
     * `WidgetMode`. Defaults to `"all"` when a caller supplies no policy; the
     * extension supplies one defaulting to `"background"`.
     */
    mode = () => "all",
    /**
     * Read live at render time, like `mode`. Whether running agents show an
     * estimated cost beside their token count. Defaults to off — the extension
     * supplies the user's `showCost` setting.
     */
    showCost = () => false) {
        this.manager = manager;
        this.agentActivity = agentActivity;
        this.mode = mode;
        this.showCost = showCost;
    }
    /**
     * Agents eligible for the widget, per the current `WidgetMode`:
     *   - `off`: none (the widget's existing empty-state path hides it entirely).
     *   - `background`: drop only agents *known* to be foreground
     *     (`isBackground === false`); keep everything else — background, queued,
     *     scheduled, or RPC-spawned (`undefined`). Keying off the `isBackground`
     *     record flag rather than the UI-only `invocation` snapshot (which only the
     *     Agent-tool path sets), and excluding rather than allow-listing, means
     *     only proven-foreground runs drop out — nothing else silently vanishes.
     *   - `all`: every agent.
     */
    widgetAgents() {
        const all = this.manager.listAgents().filter(a => !a.parentAgentId);
        switch (this.mode()) {
            case "off": return [];
            case "background": return all.filter(a => a.isBackground !== false);
            default: return all;
        }
    }
    /** Set the UI context (grabbed from first tool execution). */
    setUICtx(ctx) {
        if (ctx !== this.uiCtx) {
            // UICtx changed — the widget registered on the old context is gone.
            // Force re-registration on next update().
            this.uiCtx = ctx;
            this.widgetRegistered = false;
            this.tui = undefined;
            this.lastStatusText = undefined;
        }
    }
    /**
     * Called on each new turn (tool_execution_start).
     * Ages finished agents and clears those that have lingered long enough.
     */
    onTurnStart() {
        // Age all finished agents
        for (const [id, age] of this.finishedTurnAge) {
            this.finishedTurnAge.set(id, age + 1);
        }
        // Trigger a widget refresh (will filter out expired agents)
        this.update();
    }
    /** Ensure the widget update timer is running. */
    ensureTimer() {
        if (!this.widgetInterval) {
            this.widgetInterval = setInterval(() => this.update(), 80);
        }
    }
    /** Check if a finished agent should still be shown in the widget. */
    shouldShowFinished(agentId, status) {
        const age = this.finishedTurnAge.get(agentId) ?? 0;
        const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
        return age < maxAge;
    }
    /** Record an agent as finished (call when agent completes). */
    markFinished(agentId) {
        if (!this.finishedTurnAge.has(agentId)) {
            this.finishedTurnAge.set(agentId, 0);
        }
    }
    /**
     * Drop an agent's finished-age (call when a settled agent starts running
     * again, i.e. a background resume). markFinished only seeds an age it has not
     * seen before, so a resumed agent would otherwise keep the age from its
     * previous run — already past the linger limit, hiding the new run's
     * completion line entirely.
     */
    markRunning(agentId) {
        this.finishedTurnAge.delete(agentId);
    }
    /** Render a finished agent line. */
    renderFinishedLine(a, theme, widths, width) {
        let icon;
        let statusText;
        if (a.status === "completed") {
            icon = theme.fg("success", "✓");
            statusText = "";
        }
        else if (a.status === "steered") {
            icon = theme.fg("warning", "✓");
            statusText = theme.fg("warning", " (turn limit)");
        }
        else if (a.status === "stopped") {
            icon = theme.fg("dim", "■");
            statusText = theme.fg("dim", " stopped");
        }
        else if (a.status === "error") {
            icon = theme.fg("error", "✗");
            const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
            statusText = theme.fg("error", ` error${errMsg}`);
        }
        else if (a.status === "timeout") {
            icon = theme.fg("error", "✗");
            statusText = theme.fg("error", " timed out");
        }
        else {
            // aborted
            icon = theme.fg("error", "✗");
            statusText = theme.fg("warning", " aborted");
        }
        const metrics = formatAgentMetrics(a, this.agentActivity.get(a.id), theme, this.showCost());
        const name = renderAgentRecordName(a, theme, { fallbackColor: "dim" }, widths.name);
        const description = theme.fg("dim", padColumn(a.description, widths.description));
        const posture = theme.fg("dim", padColumn(formatAgentPosture(a), widths.posture));
        const left = `${theme.fg("dim", "├─")} ${icon} ${name}  ${description}  ${posture}`;
        const metricWidth = Math.max(0, widths.metrics - visibleWidth(statusText));
        const right = fgPreservingNestedStyles(theme, "dim", padColumn(metrics, metricWidth)) + statusText;
        return rightAlign(left, right, width);
    }
    /**
     * Render the widget content. Called from the registered widget's render() callback,
     * reading live state each time instead of capturing it in a closure.
     */
    renderWidget(tui, theme) {
        const allAgents = this.widgetAgents();
        const running = allAgents.filter(a => a.status === "running");
        const queued = allAgents.filter(a => a.status === "queued");
        const finished = allAgents.filter(a => a.status !== "running" && a.status !== "queued" && a.completedAt
            && this.shouldShowFinished(a.id, a.status));
        const hasActive = running.length > 0 || queued.length > 0;
        const hasFinished = finished.length > 0;
        // Nothing to show — return empty (widget will be unregistered by update())
        if (!hasActive && !hasFinished)
            return [];
        const w = tui.terminal.columns;
        const truncate = (line) => truncateToWidth(line, w);
        const headingColor = hasActive ? "accent" : "dim";
        const headingIcon = hasActive ? "●" : "○";
        const frame = SPINNER[this.widgetFrame % SPINNER.length];
        // Build sections separately for overflow-aware assembly.
        // Each running agent = 2 lines (header + activity), finished = 1 line, queued = 1 line.
        const maxBody = MAX_WIDGET_LINES - 1; // heading takes 1 line
        const totalBody = finished.length + running.length * 2 + (queued.length > 0 ? 1 : 0);
        let columnRecords = [...running, ...finished];
        if (totalBody > maxBody) {
            let budget = maxBody - 1 - (queued.length > 0 ? 1 : 0); // overflow + queue rows
            const visibleRunning = running.slice(0, Math.max(0, Math.floor(budget / 2)));
            budget -= visibleRunning.length * 2;
            const visibleFinished = finished.slice(0, Math.max(0, budget));
            columnRecords = [...visibleRunning, ...visibleFinished];
        }
        const renderedAt = Date.now();
        const metrics = new Map(columnRecords.map(record => [
            record.id,
            formatAgentMetrics(record, this.agentActivity.get(record.id), theme, this.showCost(), renderedAt),
        ]));
        const nameWidth = Math.max(0, ...columnRecords.map(agentRecordNameWidth));
        const postureWidth = Math.max(0, ...columnRecords.map(a => visibleWidth(formatAgentPosture(a))));
        const finishedStatusWidth = (record) => {
            let status = "";
            if (record.status === "steered")
                status = " (turn limit)";
            else if (record.status === "stopped")
                status = " stopped";
            else if (record.status === "timeout")
                status = " timed out";
            else if (record.status === "error")
                status = ` error${record.error ? `: ${record.error.slice(0, 60)}` : ""}`;
            else if (record.status === "aborted")
                status = " aborted";
            return visibleWidth(status);
        };
        const metricWidth = Math.max(0, ...columnRecords.map(record => visibleWidth(metrics.get(record.id) ?? "") + finishedStatusWidth(record)));
        const renderedNameWidth = Math.min(18, nameWidth);
        const renderedPostureWidth = Math.min(32, postureWidth);
        const widths = {
            name: renderedNameWidth,
            description: Math.max(0, Math.min(40, Math.max(0, ...columnRecords.map(a => visibleWidth(a.description))), w - 11 - renderedNameWidth - renderedPostureWidth - metricWidth)),
            posture: renderedPostureWidth,
            metrics: metricWidth,
        };
        const finishedLines = [];
        for (const a of finished) {
            finishedLines.push(this.renderFinishedLine(a, theme, widths, w));
        }
        const runningLines = []; // each entry is [header, activity]
        for (const a of running) {
            const bg = this.agentActivity.get(a.id);
            const statsText = metrics.get(a.id) ?? "";
            const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";
            const name = renderAgentRecordName(a, theme, { bold: true }, widths.name);
            const description = theme.fg("muted", padColumn(a.description, widths.description));
            const posture = theme.fg("dim", padColumn(formatAgentPosture(a), widths.posture));
            const left = theme.fg("dim", "├─") + ` ${theme.fg("accent", frame)} ${name}  ${description}  ${posture}`;
            const right = fgPreservingNestedStyles(theme, "dim", padColumn(statsText, widths.metrics));
            runningLines.push([
                rightAlign(left, right, w),
                truncate(theme.fg("dim", "│  ") + theme.fg("dim", `  ⎿  ${activity}`)),
            ]);
        }
        const queuedLine = queued.length > 0
            ? truncate(theme.fg("dim", "├─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`)
            : undefined;
        // Assemble with overflow cap (heading + overflow indicator = 2 reserved lines).
        const lines = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"))];
        if (totalBody <= maxBody) {
            // Everything fits — add all lines and fix up connectors for the last item.
            lines.push(...finishedLines);
            for (const pair of runningLines)
                lines.push(...pair);
            if (queuedLine)
                lines.push(queuedLine);
            // Fix last connector: swap ├─ → └─ and │ → space for activity lines.
            if (lines.length > 1) {
                const last = lines.length - 1;
                lines[last] = lines[last].replace("├─", "└─");
                // If last item is a running agent activity line, fix indent of that line
                // and fix the header line above it.
                if (runningLines.length > 0 && !queuedLine) {
                    // The last two lines are the last running agent's header + activity.
                    if (last >= 2) {
                        lines[last - 1] = lines[last - 1].replace("├─", "└─");
                        lines[last] = lines[last].replace("│  ", "   ");
                    }
                }
            }
        }
        else {
            // Overflow — prioritize: running > queued > finished.
            // Reserve 1 line for overflow indicator.
            let budget = maxBody - 1;
            let hiddenRunning = 0;
            let hiddenFinished = 0;
            // Reserve the queued line's row up front. It is a single summary of N
            // waiting agents, so it cannot be folded into the "+N more" count (which
            // is denominated in agents) without either under-reporting it as 1 or
            // inflating the total with agents that were never getting their own rows.
            // Reserving costs at most one running agent — which IS counted below —
            // and makes the drop unreachable. It matters most exactly when it used to
            // vanish: the pool is saturated and the queue is what the user needs to see.
            const queuedReserve = queuedLine ? 1 : 0;
            budget -= queuedReserve;
            // 1. Running agents (2 lines each)
            for (const pair of runningLines) {
                if (budget >= 2) {
                    lines.push(...pair);
                    budget -= 2;
                }
                else {
                    hiddenRunning++;
                }
            }
            // 2. Queued line (always fits — its row was reserved above)
            if (queuedLine) {
                budget += queuedReserve;
                lines.push(queuedLine);
                budget--;
            }
            // 3. Finished agents
            for (const fl of finishedLines) {
                if (budget >= 1) {
                    lines.push(fl);
                    budget--;
                }
                else {
                    hiddenFinished++;
                }
            }
            // Overflow summary
            const overflowParts = [];
            if (hiddenRunning > 0)
                overflowParts.push(`${hiddenRunning} running`);
            if (hiddenFinished > 0)
                overflowParts.push(`${hiddenFinished} finished`);
            const overflowText = overflowParts.join(", ");
            lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`));
        }
        return lines;
    }
    /** Force an immediate widget update. */
    update() {
        if (!this.uiCtx)
            return;
        const allAgents = this.widgetAgents();
        // Lightweight existence checks — full categorization happens in renderWidget()
        let runningCount = 0;
        let queuedCount = 0;
        let hasFinished = false;
        for (const a of allAgents) {
            if (a.status === "running") {
                runningCount++;
            }
            else if (a.status === "queued") {
                queuedCount++;
            }
            else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) {
                hasFinished = true;
            }
        }
        const hasActive = runningCount > 0 || queuedCount > 0;
        // Nothing to show — clear widget
        if (!hasActive && !hasFinished) {
            if (this.widgetRegistered) {
                this.uiCtx.setWidget("agents", undefined);
                this.widgetRegistered = false;
                this.tui = undefined;
            }
            if (this.lastStatusText !== undefined) {
                this.uiCtx.setStatus("subagents", undefined);
                this.lastStatusText = undefined;
            }
            if (this.widgetInterval) {
                clearInterval(this.widgetInterval);
                this.widgetInterval = undefined;
            }
            // Clean up stale entries
            for (const [id] of this.finishedTurnAge) {
                if (!allAgents.some(a => a.id === id))
                    this.finishedTurnAge.delete(id);
            }
            return;
        }
        // Status bar — only call setStatus when the text actually changes
        let newStatusText;
        if (hasActive) {
            const statusParts = [];
            if (runningCount > 0)
                statusParts.push(`${runningCount} running`);
            if (queuedCount > 0)
                statusParts.push(`${queuedCount} queued`);
            const total = runningCount + queuedCount;
            newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
        }
        if (newStatusText !== this.lastStatusText) {
            this.uiCtx.setStatus("subagents", newStatusText);
            this.lastStatusText = newStatusText;
        }
        this.widgetFrame++;
        // Register widget callback once; subsequent updates use requestRender()
        // which re-invokes render() without replacing the component (avoids layout thrashing).
        if (!this.widgetRegistered) {
            this.uiCtx.setWidget("agents", (tui, theme) => {
                this.tui = tui;
                return {
                    render: () => this.renderWidget(tui, theme),
                    invalidate: () => {
                        // Theme changed — force re-registration so factory captures fresh theme.
                        this.widgetRegistered = false;
                        this.tui = undefined;
                    },
                };
            }, { placement: "aboveEditor" });
            this.widgetRegistered = true;
        }
        else {
            // Widget already registered — just request a re-render of existing components.
            this.tui?.requestRender();
        }
    }
    dispose() {
        if (this.widgetInterval) {
            clearInterval(this.widgetInterval);
            this.widgetInterval = undefined;
        }
        if (this.uiCtx) {
            this.uiCtx.setWidget("agents", undefined);
            this.uiCtx.setStatus("subagents", undefined);
        }
        this.widgetRegistered = false;
        this.tui = undefined;
        this.lastStatusText = undefined;
    }
}
