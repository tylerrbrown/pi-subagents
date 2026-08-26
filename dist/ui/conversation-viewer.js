/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import { buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { createViewerKeys } from "./viewer-keys.js";
/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;
export class ConversationViewer {
    tui;
    session;
    record;
    activity;
    theme;
    done;
    onStop;
    onSteer;
    showCost;
    scrollOffset = 0;
    autoScroll = true;
    unsubscribe;
    lastInnerW = 0;
    closed = false;
    /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
    stopArmed = false;
    keys;
    /** Steering composer — present while the user is typing a message to the agent. */
    composer;
    constructor(tui, session, record, activity, theme, done, 
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    onStop, 
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings, 
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    onSteer, 
    /**
     * Whether the header shows an estimated cost after the token count. Read
     * once, at construction: the overlay is opened from a menu, so the setting
     * cannot change while it is on screen.
     */
    showCost = false) {
        this.tui = tui;
        this.session = session;
        this.record = record;
        this.activity = activity;
        this.theme = theme;
        this.done = done;
        this.onStop = onStop;
        this.onSteer = onSteer;
        this.showCost = showCost;
        this.keys = createViewerKeys(keybindings);
        this.unsubscribe = session.subscribe(() => {
            if (this.closed)
                return;
            this.tui.requestRender();
        });
    }
    handleInput(data) {
        // While composing a steer message, the input owns all keys (Enter sends,
        // Esc cancels — both wired in openComposer()). Editing keys flow through.
        if (this.composer) {
            this.composer.handleInput(data);
            this.tui.requestRender();
            return;
        }
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
            this.closed = true;
            this.done(undefined);
            return;
        }
        // Enter opens the steering composer (only while the agent can still be
        // steered) — then type + Enter sends, Esc or an empty submit returns. When
        // not steerable, fall through so the key still disarms a pending stop.
        if (matchesKey(data, "enter") && this.canSteer()) {
            this.stopArmed = false;
            this.openComposer();
            return;
        }
        // Stop/abort the agent (only while it can still be stopped). Two-press:
        // first "x" arms, second confirms — any other key disarms.
        if (matchesKey(data, "x")) {
            if (this.isStoppable()) {
                if (this.stopArmed) {
                    this.stopArmed = false;
                    this.onStop?.();
                }
                else {
                    this.stopArmed = true;
                }
                this.tui.requestRender();
            }
            return;
        }
        if (this.stopArmed)
            this.stopArmed = false;
        const totalLines = this.buildContentLines(this.lastInnerW).length;
        const viewportHeight = this.viewportHeight();
        const maxScroll = Math.max(0, totalLines - viewportHeight);
        if (this.keys.scrollUp(data)) {
            this.scrollOffset = Math.max(0, this.scrollOffset - 1);
            this.autoScroll = this.scrollOffset >= maxScroll;
        }
        else if (this.keys.scrollDown(data)) {
            this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
            this.autoScroll = this.scrollOffset >= maxScroll;
        }
        else if (this.keys.pageUp(data)) {
            this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
            this.autoScroll = false;
        }
        else if (this.keys.pageDown(data)) {
            this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
            this.autoScroll = this.scrollOffset >= maxScroll;
        }
        else if (matchesKey(data, "home")) {
            this.scrollOffset = 0;
            this.autoScroll = false;
        }
        else if (matchesKey(data, "end")) {
            this.scrollOffset = maxScroll;
            this.autoScroll = true;
        }
    }
    render(width) {
        if (width < 6)
            return []; // too narrow for any meaningful rendering
        const th = this.theme;
        const innerW = width - 4; // border + padding
        this.lastInnerW = innerW;
        const lines = [];
        const pad = (s, len) => {
            const vis = visibleWidth(s);
            return s + " ".repeat(Math.max(0, len - vis));
        };
        const row = (content) => th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
        const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
        const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
        const hrMid = row(th.fg("dim", "─".repeat(innerW)));
        // Header
        lines.push(hrTop);
        const modeLabel = getPromptModeLabel(this.record.type);
        const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
        const statusIcon = this.record.status === "running"
            ? th.fg("accent", "●")
            : this.record.status === "completed"
                ? th.fg("success", "✓")
                : this.record.status === "error"
                    ? th.fg("error", "✗")
                    : th.fg("dim", "○");
        const duration = formatDuration(this.record.startedAt, this.record.completedAt);
        const headerParts = [duration];
        const toolUses = this.activity?.toolUses ?? this.record.toolUses;
        if (toolUses > 0)
            headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
        // Spend from the record, context from the live session: the record is the
        // only total that survives the agent finishing and the only one carrying a
        // nested child's spend.
        const tokens = getLifetimeTotal(this.record.lifetimeUsage);
        if (tokens > 0) {
            const percent = getSessionContextPercent(this.activity?.session);
            headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
        }
        const cost = this.showCost ? formatCost(getLifetimeCost(this.record.lifetimeUsage)) : "";
        if (cost)
            headerParts.push(cost);
        lines.push(row(`${statusIcon} ${renderAgentName(this.record.type, th, { bold: true })}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`));
        const invocationLine = this.invocationLine();
        if (invocationLine)
            lines.push(row(invocationLine));
        lines.push(hrMid);
        // Content area — rebuild every render (live data, no cache needed)
        const contentLines = this.buildContentLines(innerW);
        const viewportHeight = this.viewportHeight();
        const maxScroll = Math.max(0, contentLines.length - viewportHeight);
        if (this.autoScroll) {
            this.scrollOffset = maxScroll;
        }
        const visibleStart = Math.min(this.scrollOffset, maxScroll);
        const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
        for (let i = 0; i < viewportHeight; i++) {
            lines.push(row(visible[i] ?? ""));
        }
        // Footer
        lines.push(hrMid);
        if (this.composer) {
            // Composer row: the Input renders its own `> ` prompt and cursor.
            lines.push(row(this.composer.render(innerW)[0] ?? ""));
            const composeHint = th.fg("dim", "Enter send · Esc cancel");
            const composeLeft = th.fg("accent", "✎ steer");
            const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
            lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
        }
        else {
            // Actions on the left, navigation on the right. The scroll hint keeps its
            // full key list so the less-obvious bindings stay discoverable; it leads
            // the right group so "Esc close" is the only part that truncates first.
            const sep = th.fg("dim", " · ");
            const actions = [];
            if (this.canSteer())
                actions.push(th.fg("dim", "Enter steer"));
            if (this.isStoppable()) {
                actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
            }
            const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");
            // Prepend the line-count/scroll-% readout only when there's spare width —
            // it's the first thing dropped so it never crowds out the hints.
            const scrollPct = contentLines.length <= viewportHeight
                ? "100%"
                : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
            const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
            const withCount = [count, ...actions].join(sep);
            const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
                ? withCount
                : actions.join(sep);
            const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
            lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
        }
        lines.push(hrBot);
        return lines;
    }
    /** Stoppable only when a stop handler exists and the agent is still active. */
    isStoppable() {
        return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
    }
    /** Steerable only when a steer handler exists and the agent is still active. */
    canSteer() {
        return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
    }
    /** Open the inline steering composer and route subsequent input to it. */
    openComposer() {
        const input = new Input();
        input.focused = true;
        input.onSubmit = (value) => {
            const message = value.trim();
            this.composer = undefined;
            if (message)
                this.onSteer?.(message);
            this.tui.requestRender();
        };
        input.onEscape = () => {
            this.composer = undefined;
            this.tui.requestRender();
        };
        this.composer = input;
        this.tui.requestRender();
    }
    invalidate() { }
    dispose() {
        this.closed = true;
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = undefined;
        }
    }
    // ---- Private ----
    viewportHeight() {
        // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
        // more lines than the overlay shows and clip the footer.
        const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
        return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
    }
    chromeLines() {
        // The composer adds one row above the footer hint while it's open.
        return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
    }
    invocationLine() {
        const { modelName, tags } = buildInvocationTags(this.record.invocation);
        const parts = modelName ? [modelName, ...tags] : tags;
        if (parts.length === 0)
            return undefined;
        return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
    }
    buildContentLines(width) {
        if (width <= 0)
            return [];
        const th = this.theme;
        const messages = this.session.messages;
        const lines = [];
        if (messages.length === 0) {
            lines.push(th.fg("dim", "(waiting for first message...)"));
            return lines;
        }
        let needsSeparator = false;
        for (const msg of messages) {
            if (msg.role === "user") {
                const text = typeof msg.content === "string"
                    ? msg.content
                    : extractText(msg.content);
                if (!text.trim())
                    continue;
                if (needsSeparator)
                    lines.push(th.fg("dim", "───"));
                lines.push(th.fg("accent", "[User]"));
                for (const line of wrapTextWithAnsi(text.trim(), width)) {
                    lines.push(line);
                }
            }
            else if (msg.role === "assistant") {
                const textParts = [];
                const toolCalls = [];
                for (const c of msg.content) {
                    if (c.type === "text" && c.text)
                        textParts.push(c.text);
                    else if (c.type === "toolCall") {
                        toolCalls.push(c.name ?? c.toolName ?? "unknown");
                    }
                }
                if (needsSeparator)
                    lines.push(th.fg("dim", "───"));
                lines.push(th.bold("[Assistant]"));
                if (textParts.length > 0) {
                    for (const line of wrapTextWithAnsi(textParts.join("\n").trim(), width)) {
                        lines.push(line);
                    }
                }
                for (const name of toolCalls) {
                    lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
                }
            }
            else if (msg.role === "toolResult") {
                const text = extractText(msg.content);
                const truncated = text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
                if (!truncated.trim())
                    continue;
                if (needsSeparator)
                    lines.push(th.fg("dim", "───"));
                lines.push(th.fg("dim", "[Result]"));
                for (const line of wrapTextWithAnsi(truncated.trim(), width)) {
                    lines.push(th.fg("dim", line));
                }
            }
            else if (msg.role === "bashExecution") {
                const bash = msg;
                if (needsSeparator)
                    lines.push(th.fg("dim", "───"));
                lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
                if (bash.output?.trim()) {
                    const out = bash.output.length > 500
                        ? bash.output.slice(0, 500) + "... (truncated)"
                        : bash.output;
                    for (const line of wrapTextWithAnsi(out.trim(), width)) {
                        lines.push(th.fg("dim", line));
                    }
                }
            }
            else {
                continue;
            }
            needsSeparator = true;
        }
        // Streaming indicator for running agents
        if (this.record.status === "running" && this.activity) {
            const act = describeActivity(this.activity.activeTools, this.activity.responseText);
            lines.push("");
            lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
        }
        return lines.map(l => truncateToWidth(l, width));
    }
}
