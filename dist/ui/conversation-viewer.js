/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, ScrollView, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
const SCROLLBAR_WIDTH = 1;
/** Follow the active renderer, not a setting that may require a restart. */
export function getConversationOverlayOptions(tui) {
    return tui.mode === "fullscreen"
        ? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }
        : { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` };
}
/**
 * Cap on a single tool result or bash output before the viewer elides the rest.
 *
 * Bounds wrapping and Markdown parsing on every render and scroll key, while
 * exposing substantially more context than the previous 500-character preview.
 */
export const RESULT_MAX_CHARS = 16_000;
/** Hard ceiling on inspected content blocks, including non-text blocks. */
export const RESULT_MAX_BLOCKS_INSPECTED = 20_000;
/** Cycle order for the viewer's `m` key. */
const MARKDOWN_MODES = ["off", "assistant", "all"];
/** Footer labels — short, because the idle footer is already full at 80 columns. */
const MARKDOWN_MODE_LABELS = {
    off: "raw",
    assistant: "md",
    all: "md+",
};
/**
 * Both options keep the renderer from *rewriting* source that only looks like
 * Markdown: without them `3) a / 7) b / 9) c` comes back renumbered `3. 4. 5.`
 * and backslash escapes are normalized away. Neither is a safe edit to make to
 * a tool's output, and both are cheap to switch off.
 */
const MARKDOWN_OPTIONS = {
    preserveOrderedListMarkers: true,
    preserveBackslashEscapes: true,
};
/**
 * Pi's own Markdown theme when this process has one, else a theme built from the
 * viewer's `Theme`.
 *
 * Preferring pi's is what buys syntax-highlighted code fences (it carries a
 * `highlightCode`), and it keeps this surface consistent with the notification
 * renderer, which uses the same source. It has to be *probed* rather than
 * try/caught around the call: `getMarkdownTheme()` returns arrow functions that
 * read pi's global theme lazily, so an uninitialized theme throws inside
 * `render()` — long after this returns — and takes the overlay with it. That is
 * the case in tests and any embedded session that never called `initTheme()`.
 */
function resolveMarkdownTheme(th) {
    try {
        const piTheme = getMarkdownTheme();
        piTheme.heading("probe");
        return piTheme;
    }
    catch {
        return fallbackMarkdownTheme(th);
    }
}
/**
 * `Theme` carries only `fg` and `bold`, so the three remaining styles are
 * written as raw SGR. Rendering them as plain text instead would silently drop
 * `*emphasis*`'s markers with nothing in their place, turning a formatting
 * change into a content change.
 */
function fallbackMarkdownTheme(th) {
    const sgr = (on, off) => (text) => `\x1b[${on}m${text}\x1b[${off}m`;
    return {
        heading: text => th.bold(th.fg("accent", text)),
        link: text => th.fg("accent", text),
        linkUrl: text => th.fg("muted", text),
        code: text => th.fg("muted", text),
        codeBlock: text => th.fg("muted", text),
        codeBlockBorder: text => th.fg("dim", text),
        quote: text => th.fg("muted", text),
        quoteBorder: text => th.fg("dim", text),
        hr: text => th.fg("dim", text),
        listBullet: text => th.fg("accent", text),
        bold: text => th.bold(text),
        italic: sgr(3, 23),
        underline: sgr(4, 24),
        strikethrough: sgr(9, 29),
    };
}
/**
 * Cap `text` at `RESULT_MAX_CHARS`, reporting the elision separately rather than
 * appending it.
 *
 * Separately because the notice is the viewer's chrome, not the tool's output.
 * Appended into the string it becomes content: a cut landing inside a fenced
 * code block — likely, on exactly the large `ctx_execute` results this is for —
 * renders the notice as a line of source inside the fence.
 */
function capResult(text) {
    if (text.length <= RESULT_MAX_CHARS)
        return { text, elided: 0 };
    return {
        text: text.slice(0, RESULT_MAX_CHARS),
        elided: text.length - RESULT_MAX_CHARS,
    };
}
/**
 * The bounded equivalent of `extractText(content)`, including its newlines.
 * It reads only through the visible prefix plus one boundary block. When later
 * blocks remain, the notice reports a truthful lower bound rather than scanning
 * text that cannot reach the renderer.
 */
function capToolResult(content) {
    let remaining = RESULT_MAX_CHARS;
    let sawText = false;
    const visible = [];
    for (let index = 0; index < content.length; index++) {
        if (index >= RESULT_MAX_BLOCKS_INSPECTED) {
            // Non-text blocks still cost a property read. Stop independently of the
            // character cap and disclose that the remainder was not inspected.
            return { text: visible.join(""), elided: 1, uninspected: true };
        }
        const block = content[index];
        if (block?.type !== "text")
            continue;
        const part = String(block.text ?? "");
        const separator = sawText ? 1 : 0;
        sawText = true;
        if (remaining < separator) {
            // We only read one block beyond the cap. Its separator alone proves at
            // least one omitted character, without traversing an unbounded tail.
            return { text: visible.join(""), elided: 1, lowerBound: true };
        }
        if (separator) {
            visible.push("\n");
            remaining--;
        }
        if (part.length > remaining) {
            visible.push(part.slice(0, remaining));
            const elided = part.length - remaining;
            return {
                text: visible.join(""),
                elided,
                ...(index + 1 < content.length ? { lowerBound: true } : {}),
            };
        }
        visible.push(part);
        remaining -= part.length;
        if (remaining === 0 && index + 1 < content.length) {
            // Do not filter/map/reduce hidden blocks. The next block establishes a
            // lower bound when text; otherwise disclose that later blocks were not
            // inspected rather than pretending their character count is exact.
            const next = content[index + 1];
            if (next?.type === "text")
                return { text: visible.join(""), elided: 1, lowerBound: true };
            return { text: visible.join(""), elided: 1, uninspected: true };
        }
    }
    return { text: visible.join(""), elided: 0 };
}
/**
 * `999` · `1.5k` · `8.4M` — a magnitude cue, not an exact count, past 1000.
 *
 * The bracket is chosen against the *rounded* value, so 999,999 reads `1M`
 * rather than the `1000.0k` a naive `< 1e6` test produces.
 */
function humanCount(n) {
    if (n < 1_000)
        return `${n}`;
    const thousands = n < 999_950;
    const value = thousands ? n / 1_000 : n / 1_000_000;
    return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}
function lowerBoundHumanCount(n) {
    if (n < 1_000)
        return `${n}`;
    const thousands = n < 1_000_000;
    const divisor = thousands ? 1_000 : 1_000_000;
    const value = Math.floor((n / divisor) * 10) / 10;
    return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}
function truncationNote(elided, lowerBound = false, uninspected = false) {
    if (uninspected)
        return "... (truncated, additional result blocks not inspected)";
    const count = lowerBound ? lowerBoundHumanCount(elided) : humanCount(elided);
    return `... (truncated, ${lowerBound ? "at least " : ""}${count} more character${elided === 1 ? "" : "s"})`;
}
/** Avoid Markdown's recursive blockquote parser for known stack-exhausting input. */
function hasUnsafeMarkdownNesting(text) {
    for (let start = 0; start < text.length;) {
        let cursor = start;
        let depth = 0;
        while (cursor - start < 3 && text[cursor] === " ")
            cursor++;
        while (text[cursor] === ">") {
            depth++;
            cursor++;
            if (text[cursor] === " " || text[cursor] === "\t")
                cursor++;
            if (depth >= 48)
                return true;
        }
        const newline = text.indexOf("\n", cursor);
        start = newline === -1 ? text.length : newline + 1;
    }
    return false;
}
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
    viewerMarkdown;
    onMarkdownMode;
    onBackground;
    scrollOffset = 0;
    autoScroll = true;
    focused = false;
    fullscreen;
    viewport;
    scrollbarGrabOffset;
    footerTargets = [];
    latestTarget;
    newMessages = 0;
    scrollView;
    unsubscribe;
    lastInnerW = 0;
    closed = false;
    /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
    stopArmed = false;
    keys;
    /** Whether the raw `m` Markdown-cycle key is unclaimed by configured viewer bindings. */
    markdownCycleKeyAvailable;
    /** Steering composer — present while the user is typing a message to the agent. */
    composer;
    /** Resolved once: pi's Markdown theme is fixed for the life of the process. */
    markdownTheme;
    /** Set by the `m` key. Wins over the setting so `m` works without a persist hook. */
    markdownModeOverride;
    /**
     * One `Markdown` per message, so its own text/width cache does the work. A
     * fresh instance per render would re-parse the whole transcript on every
     * keystroke — the component caches, but only across calls to the same object.
     * Weak so a compacted-away message doesn't pin its render.
     */
    markdownCache = new WeakMap();
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
    showCost = false, 
    /**
     * The current `viewerMarkdown` setting. Read live rather than captured,
     * unlike `showCost`: `m` changes it while the overlay is on screen.
     * Omitted → `assistant`.
     */
    viewerMarkdown, 
    /**
     * Persist a mode chosen with `m`, so the key and `/agents → Settings` mean
     * the same thing. Omitted → `m` still cycles, viewer-locally.
     */
    onMarkdownMode, 
    /** Pi's fullscreen scrollbar preference, captured when the observer opens. */
    scrollbarMode = "auto", 
    /**
     * Hand this run to the background. `available` is read live — it turns
     * false the instant the handoff lands or the run ends. Omitted → no `b`
     * affordance (history views).
     */
    onBackground) {
        this.tui = tui;
        this.session = session;
        this.record = record;
        this.activity = activity;
        this.theme = theme;
        this.done = done;
        this.onStop = onStop;
        this.onSteer = onSteer;
        this.showCost = showCost;
        this.viewerMarkdown = viewerMarkdown;
        this.onMarkdownMode = onMarkdownMode;
        this.onBackground = onBackground;
        this.fullscreen = tui.mode === "fullscreen";
        this.markdownTheme = resolveMarkdownTheme(theme);
        this.keys = createViewerKeys(keybindings);
        this.markdownCycleKeyAvailable = !keybindings || !(keybindings.matches("m", "tui.select.up")
            || keybindings.matches("m", "tui.select.down")
            || keybindings.matches("m", "tui.select.pageUp")
            || keybindings.matches("m", "tui.select.pageDown"));
        this.scrollView = new ScrollView({
            render: width => this.buildContentLines(width),
            invalidate: () => { },
        }, { follow: "end", scrollbar: this.fullscreen ? scrollbarMode : "hidden" });
        this.unsubscribe = session.subscribe(event => {
            if (this.closed)
                return;
            if (this.fullscreen && !this.scrollView.isFollowingEnd && event.type === "message_start" && ["user", "assistant", "toolResult", "bashExecution"].includes(event.message.role)) {
                this.newMessages++;
            }
            this.tui.requestRender();
        });
    }
    handleInput(data) {
        if (this.closed)
            return;
        if (this.fullscreen && (this.keys.bottom(data) || (!this.composer && matchesKey(data, "end")))) {
            this.jumpToLatest();
            return;
        }
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
        // Hand a live foreground run to the background. Single press, unlike stop:
        // the transition is one-way but keeps the agent working, so a stray key
        // costs a notification rather than the run.
        if (matchesKey(data, "b") && this.canSendToBackground()) {
            this.stopArmed = false;
            this.onBackground?.send();
            this.tui.requestRender();
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
        if (this.markdownCycleKeyAvailable && matchesKey(data, "m")) {
            // Cycle raw → assistant-only → everything. Disabled when configured
            // ViewerKeys claim `m`, so bindings like `tui.select.down=m` win.
            this.stopArmed = false;
            const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
            this.markdownModeOverride = next;
            this.onMarkdownMode?.(next);
            this.tui.requestRender();
            return;
        }
        const totalLines = this.buildContentLines(this.lastInnerW).length;
        const viewportHeight = this.viewportHeight();
        if (this.fullscreen) {
            this.scrollView.updateLayout(totalLines, viewportHeight, () => {
                if (!this.closed)
                    this.tui.requestRender();
            });
            if (this.keys.scrollUp(data))
                this.scrollView.scrollBy(-1);
            else if (this.keys.scrollDown(data))
                this.scrollView.scrollBy(1);
            else if (this.keys.pageUp(data))
                this.scrollView.scrollBy(-viewportHeight);
            else if (this.keys.pageDown(data))
                this.scrollView.scrollBy(viewportHeight);
            else if (this.keys.top(data) || matchesKey(data, "home"))
                this.scrollView.scrollToStart();
            return;
        }
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
        else if (this.keys.top(data) || matchesKey(data, "home")) {
            this.scrollOffset = 0;
            this.autoScroll = false;
        }
        else if (this.keys.bottom(data) || matchesKey(data, "end")) {
            this.scrollOffset = maxScroll;
            this.autoScroll = true;
        }
    }
    jumpToLatest() {
        this.scrollView.scrollToEnd();
        this.newMessages = 0;
        this.stopArmed = false;
        this.tui.requestRender();
    }
    handleMouse(event) {
        if (!this.fullscreen)
            return { handled: false };
        // Every cell belongs to this observer. Even unused clicks/drags must not
        // fall through to Pi's transcript selection, scrolling, or editor.
        if (this.closed || !this.viewport)
            return { handled: true, render: false };
        const view = this.viewport;
        const onScrollbar = this.scrollView.scrollbar !== "hidden" && event.x >= view.width - SCROLLBAR_WIDTH && event.x < view.width && event.y >= view.top && event.y < view.top + view.height;
        if (event.type === "move") {
            this.scrollView.setScrollbarActive(onScrollbar);
            return { handled: true, render: false };
        }
        if (event.type === "wheel") {
            this.stopArmed = false;
            this.scrollView.scrollBy(event.wheelDelta ?? 0);
            return { handled: true, render: true };
        }
        if (event.type === "release") {
            const wasDragging = this.scrollbarGrabOffset !== undefined;
            this.scrollbarGrabOffset = undefined;
            this.scrollView.setScrollbarActive(onScrollbar);
            return { handled: true, render: wasDragging };
        }
        if (event.type === "drag" && this.scrollbarGrabOffset !== undefined) {
            const travel = view.height - view.thumbHeight;
            const position = Math.max(0, Math.min(travel, event.y - view.top - this.scrollbarGrabOffset));
            this.scrollView.scrollTo(travel > 0 ? Math.round(position / travel * view.maxScroll) : 0);
            return { handled: true, render: true };
        }
        if (event.type === "press" && event.button === "left") {
            this.scrollbarGrabOffset = undefined;
            this.scrollView.setScrollbarActive(onScrollbar);
            if (this.latestTarget && event.y === this.latestTarget.row && event.x >= this.latestTarget.start && event.x < this.latestTarget.end) {
                this.jumpToLatest();
                return { handled: true, render: true };
            }
            if (event.y === this.tui.terminal.rows - 1) {
                const target = this.footerTargets.find(t => event.x >= t.start && event.x < t.end);
                if (target) {
                    this.handleInput(target.key);
                    return { handled: true, render: true };
                }
            }
            this.stopArmed = false;
            if (this.composer && event.y === this.tui.terminal.rows - 2) {
                this.composer.handleMouse({ ...event, x: event.x - 1, y: 0, width: this.lastInnerW, height: 1 });
                return { handled: true, render: true };
            }
            if (onScrollbar && view.maxScroll > 0) {
                const y = event.y - view.top;
                if (y >= view.thumbTop && y < view.thumbTop + view.thumbHeight) {
                    this.scrollbarGrabOffset = y - view.thumbTop;
                    return { handled: true, capture: true, render: true };
                }
                this.scrollView.scrollBy(y < view.thumbTop ? -view.height : view.height);
                // A track click still pages, but holding it can grab the thumb too.
                this.scrollbarGrabOffset = Math.floor(view.thumbHeight / 2);
                return { handled: true, capture: true, render: true };
            }
            return { handled: true, render: true };
        }
        return { handled: true, render: false };
    }
    render(width) {
        this.footerTargets = [];
        this.latestTarget = undefined;
        this.viewport = undefined;
        const rows = Math.max(0, this.tui.terminal.rows);
        if (!this.fullscreen && width < 6)
            return []; // too narrow for any meaningful rendering
        if (width <= SCROLLBAR_WIDTH + 1)
            return Array.from({ length: rows }, () => " ".repeat(Math.max(0, width)));
        const th = this.theme;
        const innerW = this.fullscreen ? this.scrollView.getContentWidth(width - 1) : width - 4;
        this.lastInnerW = innerW;
        const lines = [];
        const footerActions = [];
        const pad = (s, len) => {
            const vis = visibleWidth(s);
            return s + " ".repeat(Math.max(0, len - vis));
        };
        const row = (content, scrollbar) => {
            if (this.fullscreen) {
                const contentWidth = width - 1 - (scrollbar ? SCROLLBAR_WIDTH : 0);
                return " " + truncateToWidth(content, contentWidth, scrollbar ? "" : "...", true) + (scrollbar ?? "");
            }
            return th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
        };
        const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
        const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
        const hrMid = row(th.fg("dim", "─".repeat(innerW)));
        // Header
        if (!this.fullscreen)
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
        const contentLines = this.fullscreen ? this.scrollView.render(width - 1) : this.buildContentLines(innerW);
        const viewportHeight = this.viewportHeight();
        const maxScroll = Math.max(0, contentLines.length - viewportHeight);
        if (this.fullscreen) {
            this.scrollView.updateLayout(contentLines.length, viewportHeight, () => {
                if (!this.closed)
                    this.tui.requestRender();
            });
            if (this.scrollView.isFollowingEnd)
                this.newMessages = 0;
        }
        else if (this.autoScroll) {
            this.scrollOffset = maxScroll;
        }
        const visibleStart = this.fullscreen ? this.scrollView.scrollTop : Math.min(this.scrollOffset, maxScroll);
        const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
        // Match Pi's scrollbar geometry: rounded size, at least two rows when available.
        const thumbHeight = Math.min(viewportHeight, Math.max(2, Math.round(viewportHeight * viewportHeight / Math.max(1, contentLines.length))));
        const thumbTop = maxScroll > 0 ? Math.round(visibleStart / maxScroll * (viewportHeight - thumbHeight)) : 0;
        this.viewport = { width, top: lines.length, height: viewportHeight, maxScroll, thumbTop, thumbHeight };
        for (let i = 0; i < viewportHeight; i++) {
            let scrollbar;
            if (this.scrollView.isScrollbarVisible) {
                const onThumb = i >= thumbTop && i < thumbTop + thumbHeight;
                if (onThumb) {
                    scrollbar = th.fg("scrollbarThumb", this.scrollView.isScrollbarActive ? "█" : "┃");
                }
                else {
                    scrollbar = th.fg("scrollbarTrack", "│");
                }
            }
            lines.push(row(visible[i] ?? "", scrollbar));
        }
        // Keep the divider pinned above the footer, with the jump control centered
        // inside it. Neither scrolling nor new messages change its position.
        if (this.fullscreen && !this.scrollView.isFollowingEnd && maxScroll > 0 && rows >= this.chromeLines()) {
            const text = this.newMessages > 0
                ? `${this.newMessages} new message${this.newMessages === 1 ? "" : "s"}`
                : "Jump to latest message";
            const label = truncateToWidth(`[ ↓ ${text} · ${this.keys.jumpToLatestLabel()} ]`, innerW, "…");
            const labelWidth = visibleWidth(label);
            const padding = Math.floor((innerW - labelWidth) / 2);
            this.latestTarget = { row: lines.length, start: padding + 1, end: padding + 1 + labelWidth };
            lines.push(row(th.fg("dim", "─".repeat(padding)) + th.fg("accent", label) + th.fg("dim", "─".repeat(innerW - padding - labelWidth))));
        }
        else {
            lines.push(hrMid);
        }
        if (this.composer) {
            // Composer row: the Input renders its own `> ` prompt and cursor.
            this.composer.focused = this.focused;
            lines.push(row(this.composer.render(innerW)[0] ?? ""));
            footerActions.push({ label: "Enter send", key: "\r" }, { label: "Esc cancel", key: "\x1b" });
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
            if (this.canSteer())
                footerActions.push({ label: "Enter steer", key: "\r" });
            // Abbreviated for the same reason as the Markdown group below.
            if (this.canSendToBackground())
                footerActions.push({ label: "b bg", key: "b" });
            if (this.isStoppable()) {
                footerActions.push({ label: this.stopArmed ? "x again to STOP" : "x stop", key: "x" });
            }
            // Abbreviated (`raw`/`md`/`md+`) because the idle footer is already full
            // at 80 columns with steer + stop present, and this group has no
            // degradation step below "drop the line-count readout".
            if (this.markdownCycleKeyAvailable)
                footerActions.push({ label: `m ${MARKDOWN_MODE_LABELS[this.markdownMode()]}`, key: "m" });
            const actions = footerActions.map(a => th.fg(a.key === "x" && this.stopArmed ? "error" : "dim", a.label));
            footerActions.push({ label: "Esc close", key: "\x1b" });
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
        if (!this.fullscreen) {
            lines.push(hrBot);
            return lines;
        }
        // Keep the footer on screen even in a terminal shorter than the chrome.
        const footer = lines.pop() ?? row("");
        const output = rows > 0 ? [...lines.slice(0, rows - 1), footer] : [];
        const footerText = stripTerminalSequences(footer);
        for (const action of footerActions) {
            const index = footerText.indexOf(action.label);
            if (index < 0)
                continue; // a clipped label is not a clickable control
            const start = visibleWidth(footerText.slice(0, index));
            this.footerTargets.push({ start, end: start + visibleWidth(action.label), key: action.key });
        }
        return output;
    }
    /** Stoppable only when a stop handler exists and the agent is still active. */
    isStoppable() {
        return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
    }
    /** The mode in force: an `m` press, else the setting, else the default. */
    markdownMode() {
        return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
    }
    /** Wrap `text` literally — the pre-Markdown path, and the fallback from it. */
    rawLines(text, width, dim) {
        const lines = wrapTextWithAnsi(text, width);
        return dim ? lines.map(l => this.theme.fg("dim", l)) : lines;
    }
    /** Render `text` as Markdown, reusing this message's component instance. */
    markdownLines(msg, text, width, dim) {
        if (hasUnsafeMarkdownNesting(text))
            return this.rawLines(text, width, dim);
        let entry = this.markdownCache.get(msg);
        if (!entry) {
            entry = {
                md: new Markdown(text, 0, 0, this.markdownTheme, 
                // Keeps result prose visually receded, the way the raw path's
                // per-line `fg("dim", …)` did. Fenced code is the exception and is
                // left alone deliberately: pi's theme highlights it with its own
                // colors, which this would otherwise flatten.
                dim ? { color: (t) => this.theme.fg("dim", t) } : undefined, MARKDOWN_OPTIONS),
                text,
            };
            this.markdownCache.set(msg, entry);
        }
        else if (entry.text !== text) {
            // Streaming: the message object is stable, its text grows. A failed
            // prefix remains unsafe after append-only deltas, so retry only when the
            // content was replaced or truncated.
            const shouldRetry = !text.startsWith(entry.text);
            entry.md.setText(text);
            entry.text = text;
            if (shouldRetry)
                entry.failed = false;
        }
        if (entry.failed)
            return this.rawLines(text, width, dim);
        try {
            return entry.md.render(width);
        }
        catch {
            // The parser is recursive and this is arbitrary tool output: ~54 nested
            // blockquotes overflow the stack, and no amount of fuzzing proves that is
            // the only such input. `render()` is on the TUI's critical path, so a
            // throw here takes the overlay down for content the literal path shows
            // fine — degrade to that instead, and remember, since the throw would
            // otherwise repeat on every render and every scroll key.
            entry.failed = true;
            return this.rawLines(text, width, dim);
        }
    }
    /** Steerable only when a steer handler exists and the agent is still active. */
    canSteer() {
        return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
    }
    /**
     * Asked of the owner rather than derived from the record: only the caller
     * blocked on this run knows it can let go of it, and `blocking` alone also
     * matches spawns nobody can hand off (the agent generator).
     */
    canSendToBackground() {
        return this.onBackground?.available() === true;
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
        this.scrollView.setScrollbar("hidden"); // clears Pi's auto-hide timer
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = undefined;
        }
    }
    // ---- Private ----
    viewportHeight() {
        if (this.fullscreen)
            return Math.max(0, this.tui.terminal.rows - this.chromeLines());
        // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
        // more lines than the overlay shows and clip the footer.
        const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
        return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
    }
    chromeLines() {
        // The composer adds one row above the footer hint while it's open.
        return CHROME_LINES_BASE - (this.fullscreen ? 2 : 0) + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
    }
    invocationLine() {
        // Canonical id here, short label everywhere else: this overlay is opened to
        // inspect one agent and has the width for it, and two providers can serve
        // models whose short names read alike.
        const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
        const model = modelId ?? modelName;
        const parts = model ? [model, ...tags] : tags;
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
        const mode = this.markdownMode();
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
                    const text = textParts.join("\n").trim();
                    lines.push(...(mode === "off"
                        ? this.rawLines(text, width, false)
                        : this.markdownLines(msg, text, width, false)));
                }
                for (const name of toolCalls) {
                    lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
                }
            }
            else if (msg.role === "toolResult") {
                const capped = capToolResult(msg.content);
                const text = capped.text.trim();
                if (!text && !capped.elided && !capped.uninspected)
                    continue;
                if (needsSeparator)
                    lines.push(th.fg("dim", "───"));
                lines.push(th.fg("dim", "[Result]"));
                if (text)
                    lines.push(...(mode === "all"
                        ? this.markdownLines(msg, text, width, true)
                        : this.rawLines(text, width, true)));
                if (capped.elided)
                    lines.push(truncateToWidth(th.fg("dim", truncationNote(capped.elided, capped.lowerBound, capped.uninspected)), width));
            }
            else if (msg.role === "bashExecution") {
                const bash = msg;
                if (needsSeparator)
                    lines.push(th.fg("dim", "───"));
                lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
                if (bash.output) {
                    // Cap before trimming: a multi-megabyte whitespace tail must never be
                    // scanned just to prepare the 16K prefix the renderer can consume.
                    const capped = capResult(bash.output);
                    const text = capped.text.trim();
                    if (text)
                        lines.push(...this.rawLines(text, width, true));
                    if (capped.elided)
                        lines.push(truncateToWidth(th.fg("dim", truncationNote(capped.elided)), width));
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
