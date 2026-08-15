/**
 * workflow-dialog.ts — the `/workflows` two-pane inspector.
 *
 * ```
 * Workflow  review-changes                            3/7 agents · 1m12s
 *   Review changed files across dimensions, verify each finding
 *
 * ▸ Phases
 *   ❯ ✔ Review                                                     3/3
 *     2 Verify                                                      1/2
 *     3 Report                                             Not started yet
 *
 *   Agents  showing 1 queued
 *   ❯ ◌ verify:auth.ts · attempt 2 · throttled · waiting 8s
 *
 *   Prompt  12 lines · expand
 *     Verify the auth findings against the actual middleware…
 *
 *   Activity  last 3 tool calls
 *     Transcript not available.
 *
 *   Outcome
 *       Waiting for an agent slot.
 * ```
 *
 * **The glyphs are not the card's glyphs.** `workflow-card.ts` keys off the raw
 * entry `state`; this file keys off the *derived* `displayState(entry, active)`
 * and splits cases the card cannot see — skipped, blocked, queued and
 * interrupted all render as a plain ✘ or ⟳ inline but are distinct here. `◌`
 * (U+25CC) appears only in this file, and a running row animates a spinner where
 * the card draws a static `⟳`.
 *
 * **The phases pane is stranger still**: a phase that has not finished shows
 * *its number*, not a glyph. That is deliberate, recovered behaviour.
 *
 * **The layout is pure.** `layoutWorkflowDialog` returns coloured segments and
 * `handleWorkflowDialogKey` maps a keypress to the next state plus an optional
 * action; neither touches a theme, a terminal, or the workflow runtime. The
 * `WorkflowDialog` component is the thin shell that wires those to `ctx.ui`, and
 * the runtime side arrives as an injected `WorkflowDialogActions`.
 *
 * All state derivation lives in `src/workflow/progress.ts`; this file only
 * arranges what that module returns.
 */

import { type Component, matchesKey, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowMeta } from "../workflow/meta.js";
import {
  buildPhaseGroups,
  displayState,
  formatDuration,
  header,
  isLive,
  type PhaseGroup,
  type WorkflowAgentEntry,
  type WorkflowDisplayState,
  type WorkflowEntry,
} from "../workflow/progress.js";
import { SPINNER, type Theme } from "./agent-widget.js";
import {
  ASCII_GLYPHS,
  agentStatSegments,
  clampLine,
  styleWorkflowCardLines,
  UNICODE_GLYPHS,
  type WorkflowCardColor,
  type WorkflowCardLine,
  type WorkflowCardSegment,
  type WorkflowCardTask,
} from "./workflow-card.js";

/** Fallback width when the caller does not know the terminal's. */
const DEFAULT_WIDTH = 80;

/** Phase rows shown at once before the list windows around the selection. */
const MAX_PHASE_ROWS = 8;
/** Agent rows shown at once before the list windows around the selection. */
const MAX_AGENT_ROWS = 10;
/** Prompt lines shown before `expand` is offered. */
export const PROMPT_COLLAPSED_LINES = 4;
/** Spinner cadence. Unlike the card's 1s header tick, this row really animates. */
export const WORKFLOW_DIALOG_SPINNER_MS = 80;

/* ------------------------------------------------------------------------- *
 * Glyphs
 * ------------------------------------------------------------------------- */

export interface WorkflowDialogGlyphs {
  tick: string;
  cross: string;
  /** `◌` — queued or interrupted. The card has no row that draws this. */
  queued: string;
  /** `figures.pointer` — the selected row in either pane. */
  pointer: string;
  /** Marks whichever pane currently owns j/k. */
  focus: string;
  /** Running rows cycle these. */
  spinner: readonly string[];
}

export const UNICODE_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
  tick: UNICODE_GLYPHS.tick,
  cross: UNICODE_GLYPHS.cross,
  queued: "◌",
  pointer: "❯",
  focus: UNICODE_GLYPHS.pointer,
  spinner: SPINNER,
};

/** The ASCII tier, one column per glyph so the panes stay aligned either way. */
export const ASCII_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
  tick: ASCII_GLYPHS.tick,
  cross: ASCII_GLYPHS.cross,
  queued: "o",
  pointer: ">",
  focus: ASCII_GLYPHS.pointer,
  spinner: ["-", "\\", "|", "/"],
};

/**
 * The recovered dialog mapping — keyed on the *display* state.
 *
 * Claude Code's `permission` colour has no pi equivalent; a blocked agent is
 * waiting on the user, so it maps to `warning` (selection maps to `accent`).
 */
export function dialogRowGlyph(
  state: WorkflowDisplayState,
  glyphs: WorkflowDialogGlyphs,
  spinnerFrame = 0,
): WorkflowCardSegment {
  switch (state) {
    case "done":
      return { text: glyphs.tick, color: "success" };
    case "failed":
      return { text: glyphs.cross, color: "error" };
    case "skipped":
      return { text: glyphs.cross, color: "dim" };
    case "blocked":
      return { text: glyphs.cross, color: "warning" };
    case "queued":
    case "interrupted":
      return { text: glyphs.queued, color: "dim" };
    case "running":
      return { text: glyphs.spinner[spinnerFrame % glyphs.spinner.length], color: "dim" };
  }
}

/* ------------------------------------------------------------------------- *
 * Verbatim copy
 * ------------------------------------------------------------------------- */

/**
 * Claude Code's own strings. Kept together and named so a reader can see at a
 * glance which surface each belongs to, and so none drifts under an edit.
 */
export const WORKFLOW_DIALOG_COPY = {
  waitingForSlot: "Waiting for an agent slot.",
  availableOnceStarted: "Available once the agent starts.",
  notAvailableYet: "Not available yet (agent still running).",
  noTranscript: "Transcript not available.",
  stoppedEarly: "The workflow stopped before this agent finished.",
  skippedByUser: "Skipped by user.",
  noToolCallsYet: "No tool calls yet.",
  noToolCalls: "No tool calls.",
  notStarted: "Not started yet",
  noAgents: "No agents",
} as const;

/* ------------------------------------------------------------------------- *
 * State
 * ------------------------------------------------------------------------- */

export type WorkflowDialogPane = "phases" | "agents";

/** `all`, or exactly one display state. */
export type WorkflowDialogFilter = "all" | WorkflowDisplayState;

/** The order `f` cycles through. */
export const WORKFLOW_DIALOG_FILTERS: readonly WorkflowDialogFilter[] = [
  "all",
  "running",
  "queued",
  "done",
  "failed",
  "blocked",
  "skipped",
  "interrupted",
];

export interface WorkflowDialogState {
  /** Raw selection; `clampedPhase` is what actually renders. */
  selectedPhase: number;
  selectedAgent: number;
  pane: WorkflowDialogPane;
  filter: WorkflowDialogFilter;
  promptExpanded: boolean;
}

export function initialWorkflowDialogState(initialPhaseIndex = 0): WorkflowDialogState {
  return {
    selectedPhase: initialPhaseIndex,
    selectedAgent: 0,
    pane: "phases",
    filter: "all",
    promptExpanded: false,
  };
}

/** Everything the dialog reads about a run, so it can be driven from a stub. */
export interface WorkflowDialogSource {
  progress: readonly WorkflowEntry[];
  task: WorkflowCardTask;
  meta?: WorkflowMeta;
  /** Agents the runtime has scheduled, which can exceed those that reported. */
  agentCount?: number;
}

export interface WorkflowDialogInput extends WorkflowDialogSource {
  state: WorkflowDialogState;
  /**
   * Which actions the caller actually wired. Absent keys default to available,
   * so layout tests and read-only callers keep the full footer; a caller that
   * wires only some actions passes the map so the hints stay truthful.
   */
  available?: Partial<Record<keyof WorkflowDialogActions, boolean>>;
  now?: number;
  /** The *terminal* width; the content width is derived from it. */
  width?: number;
  ascii?: boolean;
  spinnerFrame?: number;
}

/** The actions the dialog needs from the workflow runtime, injected. */
export interface WorkflowDialogActions {
  onKill?(): void;
  onPause?(): void;
  onResume?(): void;
  /** `index` is the entry's stable `index`, not its row position. */
  onSkipAgent?(index: number): void;
  onRetryAgent?(index: number): void;
}

export type WorkflowDialogAction =
  | { kind: "cancel" }
  | { kind: "kill" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "skip"; index: number }
  | { kind: "retry"; index: number };

export interface ResolvedWorkflowDialog {
  groups: PhaseGroup[];
  clampedPhase: number;
  clampedAgent: number;
  /** The selected phase's agents, after the state filter. */
  visibleAgents: WorkflowAgentEntry[];
  selectedEntry: WorkflowAgentEntry | undefined;
  /** False once the run stops — which is what turns live agents "interrupted". */
  workflowActive: boolean;
  paused: boolean;
}

/** Content width. The 6 columns are the dialog's border and padding. */
export function workflowDialogContentWidth(terminalWidth: number): number {
  return Math.max(12, terminalWidth - 6);
}

const clampIndex = (index: number, length: number) =>
  length === 0 ? 0 : Math.min(Math.max(0, Math.trunc(index)), length - 1);

/**
 * Settle the selection against the data actually present.
 *
 * Selection is stored raw and clamped on read, so a phase finishing (and its
 * agents dropping out of a filtered view) never leaves the cursor pointing past
 * the end — the same trick `fleet-list.ts` plays, minus the mutation.
 */
export function resolveWorkflowDialog(input: WorkflowDialogInput): ResolvedWorkflowDialog {
  const groups = buildPhaseGroups(input.progress, input.meta?.phases);
  const workflowActive = input.task.status === "running" || input.task.status === "paused";
  const clampedPhase = clampIndex(input.state.selectedPhase, groups.length);
  const all = groups[clampedPhase]?.agents ?? [];
  const visibleAgents =
    input.state.filter === "all"
      ? [...all]
      : all.filter(entry => displayState(entry, workflowActive) === input.state.filter);
  const clampedAgent = clampIndex(input.state.selectedAgent, visibleAgents.length);

  return {
    groups,
    clampedPhase,
    clampedAgent,
    visibleAgents,
    selectedEntry: visibleAgents[clampedAgent],
    workflowActive,
    paused: input.task.status === "paused",
  };
}

/* ------------------------------------------------------------------------- *
 * Row pieces
 * ------------------------------------------------------------------------- */

/**
 * The `·`-separated annotations between an agent's label and its stats.
 *
 * These say *why* a row looks the way it does — a retry and its cause, a cache
 * hit replayed from the resume journal, how long a queued agent has been
 * waiting. The stat tail (agentType, model, tokens, tool calls, duration) is the
 * card's and is appended after.
 */
export function subStatusAnnotations(
  entry: WorkflowAgentEntry,
  state: WorkflowDisplayState,
  now: number,
): string[] {
  const parts: string[] = [];
  if (entry.isolation) parts.push(entry.isolation);
  if (entry.cached) parts.push("from resume journal");
  if (entry.lastAttemptReason) {
    parts.push(entry.lastAttemptReason === "user-retry" ? "user retry" : entry.lastAttemptReason);
  }
  if (entry.attempt != null && entry.attempt > 1) parts.push(`attempt ${entry.attempt}`);
  if (state === "queued" && entry.queuedAt != null) {
    parts.push(`waiting ${formatDuration(Math.max(0, now - entry.queuedAt))}`);
  }
  return parts;
}

const lineWidth = (line: WorkflowCardLine) => line.reduce((sum, s) => sum + visibleWidth(s.text), 0);

/** Place `right` flush to `width`, cutting `left` first so the stats survive. */
function rightAlign(left: WorkflowCardLine, right: WorkflowCardLine, width: number): WorkflowCardLine {
  const rightWidth = lineWidth(right);
  const clampedLeft = clampLine(left, Math.max(0, width - rightWidth - 1));
  const gap = Math.max(1, width - lineWidth(clampedLeft) - rightWidth);
  return clampLine([...clampedLeft, { text: " ".repeat(gap) }, ...right], width);
}

/**
 * Window a list around its selection, so a 200-agent fan-out still shows the
 * row you are on. Mirrors `fleet-list.ts`'s arithmetic.
 */
function windowRange(selected: number, total: number, max: number): { start: number; end: number } {
  const visible = Math.min(max, total);
  const start = selected < visible ? 0 : selected - visible + 1;
  return { start, end: start + visible };
}

const overflowRow = (text: string, width: number): WorkflowCardLine =>
  rightAlign([], [{ text, color: "dim" }], width);

/** `▸ Phases` when focused, `  Phases` when not, with an optional dim suffix. */
function sectionHeading(
  title: string,
  suffix: string | undefined,
  focused: boolean,
  glyphs: WorkflowDialogGlyphs,
  width: number,
): WorkflowCardLine {
  const line: WorkflowCardLine = [
    focused ? { text: `${glyphs.focus} `, color: "accent" } : { text: "  " },
    { text: title, color: focused ? "accent" : "muted", bold: true },
  ];
  if (suffix) line.push({ text: "  " }, { text: suffix, color: "dim" });
  return clampLine(line, width);
}

/**
 * A detail-section body line. The two-space indent is part of Claude Code's own
 * copy — `"  Waiting for an agent slot."` ships with it baked in — so the body
 * column is fixed at 2 and the recovered strings render byte-identical.
 */
const bodyLine = (text: string, width: number): WorkflowCardLine =>
  clampLine([{ text: `  ${text}` }], width);

/* ------------------------------------------------------------------------- *
 * Detail sections
 * ------------------------------------------------------------------------- */

/** Split a preview into lines, treating an empty preview as absent. */
const previewLines = (preview: string | undefined) => (preview ? preview.split("\n") : []);

/** What the Activity body says. There is a count of tool calls, never a list. */
function activityBody(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  if (state === "queued") return WORKFLOW_DIALOG_COPY.availableOnceStarted;
  if ((entry.toolCalls ?? 0) > 0) return WORKFLOW_DIALOG_COPY.noTranscript;
  return isLive(entry) ? WORKFLOW_DIALOG_COPY.noToolCallsYet : WORKFLOW_DIALOG_COPY.noToolCalls;
}

/** What the Outcome body says, which is a different sentence for every state. */
function outcomeBody(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  switch (state) {
    case "skipped":
      return WORKFLOW_DIALOG_COPY.skippedByUser;
    case "interrupted":
      return WORKFLOW_DIALOG_COPY.stoppedEarly;
    case "queued":
      return WORKFLOW_DIALOG_COPY.waitingForSlot;
    case "running":
      return WORKFLOW_DIALOG_COPY.notAvailableYet;
    case "failed":
    case "blocked":
      return entry.error ?? WORKFLOW_DIALOG_COPY.noTranscript;
    case "done":
      return entry.resultPreview ?? WORKFLOW_DIALOG_COPY.noTranscript;
  }
}

/* ------------------------------------------------------------------------- *
 * Layout
 * ------------------------------------------------------------------------- */

/**
 * Build the dialog.
 *
 * The two panes stack rather than sitting side by side: at the recovered
 * `max(12, width - 6)` content width there is no room to split columns, and
 * stacking keeps the selected phase visible as context while the agent list has
 * focus. "Pane" therefore means "which list j/k moves", which is what the
 * recovered focus toggle actually controls.
 */
export function layoutWorkflowDialog(input: WorkflowDialogInput): WorkflowCardLine[] {
  const glyphs = input.ascii ? ASCII_DIALOG_GLYPHS : UNICODE_DIALOG_GLYPHS;
  const width = workflowDialogContentWidth(input.width ?? DEFAULT_WIDTH);
  const now = input.now ?? Date.now();
  const view = resolveWorkflowDialog(input);
  const { state } = input;

  const lines: WorkflowCardLine[] = [];

  // ---- Header ----
  const head = header(input.task, input.meta, view.groups, input.agentCount ?? 0, now);
  lines.push(
    rightAlign(
      [
        { text: "Workflow", color: "toolTitle", bold: true },
        { text: "  " },
        { text: head.name, color: "muted" },
      ],
      [{ text: head.stats, color: "dim" }],
      width,
    ),
  );
  if (head.subtext) lines.push(clampLine([{ text: `  ${head.subtext}`, color: "dim" }], width));

  // ---- Phases pane ----
  lines.push([]);
  lines.push(sectionHeading("Phases", undefined, state.pane === "phases", glyphs, width));

  const phases = windowRange(view.clampedPhase, view.groups.length, MAX_PHASE_ROWS);
  if (phases.start > 0) lines.push(overflowRow(`↑ ${phases.start} more`, width));
  // Wide enough for the largest phase number, so titles line up under each other.
  const digits = String(view.groups.length).length;
  for (let i = phases.start; i < phases.end; i++) {
    const group = view.groups[i];
    const selected = i === view.clampedPhase;
    // Recovered: colour and pointer both key off `selected`, and an unfinished
    // phase shows its number where a finished one shows a glyph.
    const color: WorkflowCardColor =
      selected ? "accent"
      : group.status === "done" ? "success"
      : group.status === "failed" ? "error"
      : "dim";
    const glyph =
      group.status === "done" ? glyphs.tick
      : group.status === "failed" ? glyphs.cross
      : String(i + 1);
    lines.push(
      rightAlign(
        [
          { text: `  ${selected ? glyphs.pointer : " "} `, color },
          { text: `${glyph.padStart(digits)} `, color },
          { text: group.title, color },
        ],
        [
          {
            text:
              group.totalCount === 0 ?
                WORKFLOW_DIALOG_COPY.notStarted
              : `${group.doneCount}/${group.totalCount}`,
            color,
          },
        ],
        width,
      ),
    );
  }
  const hiddenPhases = view.groups.length - phases.end;
  if (hiddenPhases > 0) lines.push(overflowRow(`↓ ${hiddenPhases} more`, width));

  // ---- Agents pane ----
  lines.push([]);
  const count = view.visibleAgents.length;
  lines.push(
    sectionHeading(
      "Agents",
      state.filter === "all" ?
        `${count} ${count === 1 ? "agent" : "agents"}`
      : `showing ${count} ${state.filter}`,
      state.pane === "agents",
      glyphs,
      width,
    ),
  );

  if (count === 0) {
    lines.push(bodyLine(WORKFLOW_DIALOG_COPY.noAgents, width));
  } else {
    const agents = windowRange(view.clampedAgent, count, MAX_AGENT_ROWS);
    if (agents.start > 0) lines.push(overflowRow(`↑ ${agents.start} more`, width));
    for (let i = agents.start; i < agents.end; i++) {
      const entry = view.visibleAgents[i];
      const selected = i === view.clampedAgent;
      const display = displayState(entry, view.workflowActive);
      const row: WorkflowCardLine = [
        selected ? { text: `  ${glyphs.pointer} `, color: "accent" } : { text: "    " },
        dialogRowGlyph(display, glyphs, input.spinnerFrame ?? 0),
        { text: " " },
        { text: entry.label, color: selected ? "accent" : undefined },
      ];
      for (const part of [...subStatusAnnotations(entry, display, now), ...agentStatSegments(entry)]) {
        row.push({ text: " · ", color: "dim" }, { text: part, color: "dim" });
      }
      lines.push(clampLine(row, width));
    }
    const hiddenAgents = count - agents.end;
    if (hiddenAgents > 0) lines.push(overflowRow(`↓ ${hiddenAgents} more`, width));
  }

  // ---- Per-agent detail ----
  const entry = view.selectedEntry;
  if (entry) {
    const display = displayState(entry, view.workflowActive);

    const prompt = previewLines(entry.promptPreview);
    const collapsed = !state.promptExpanded && prompt.length > PROMPT_COLLAPSED_LINES;
    const promptSuffix: string[] = [];
    if (prompt.length > 0) promptSuffix.push(`${prompt.length} ${prompt.length === 1 ? "line" : "lines"}`);
    if (collapsed) promptSuffix.push("expand");
    lines.push([]);
    lines.push(sectionHeading("Prompt", promptSuffix.join(" · ") || undefined, false, glyphs, width));
    if (prompt.length === 0) {
      lines.push(bodyLine(WORKFLOW_DIALOG_COPY.availableOnceStarted, width));
    } else {
      for (const text of collapsed ? prompt.slice(0, PROMPT_COLLAPSED_LINES) : prompt) {
        lines.push(bodyLine(text, width));
      }
    }

    const toolCalls = entry.toolCalls ?? 0;
    lines.push([]);
    lines.push(
      sectionHeading(
        "Activity",
        toolCalls > 0 ? `last ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}` : undefined,
        false,
        glyphs,
        width,
      ),
    );
    lines.push(bodyLine(activityBody(entry, display), width));

    lines.push([]);
    lines.push(sectionHeading("Outcome", undefined, false, glyphs, width));
    for (const text of outcomeBody(entry, display).split("\n")) lines.push(bodyLine(text, width));
  }

  // ---- Key hints ----
  // Only the actions the run can currently take, so the footer never advertises
  // a key that does nothing.
  // Gated on `available` as well as run state: a caller that wires only some of
  // the actions must not get a footer advertising keys that do nothing. Omitting
  // `available` entirely keeps every hint, which is what the layout tests want.
  const can = (action: keyof WorkflowDialogActions) => input.available?.[action] ?? true;
  const hints = ["j/k move", "tab pane", "f filter"];
  if (previewLines(entry?.promptPreview).length > PROMPT_COLLAPSED_LINES) {
    hints.push(state.promptExpanded ? "e collapse" : "e expand");
  }
  if (entry && can("onSkipAgent")) hints.push("s skip");
  if (entry && can("onRetryAgent")) hints.push("r retry");
  if (view.paused && can("onResume")) hints.push("p resume");
  else if (view.workflowActive && can("onPause")) hints.push("p pause");
  if (view.workflowActive && can("onKill")) hints.push("x stop");
  hints.push("esc close");
  lines.push([]);
  lines.push(clampLine([{ text: `  ${hints.join(" · ")}`, color: "dim" }], width));

  return lines;
}

/* ------------------------------------------------------------------------- *
 * Keys
 * ------------------------------------------------------------------------- */

const nextFilter = (filter: WorkflowDialogFilter): WorkflowDialogFilter =>
  WORKFLOW_DIALOG_FILTERS[(WORKFLOW_DIALOG_FILTERS.indexOf(filter) + 1) % WORKFLOW_DIALOG_FILTERS.length];

/**
 * Map a keypress to the next state and, where the key is an action, what the
 * caller should do about it. Pure: `undefined` means "not ours".
 *
 * Movement clamps at both ends rather than wrapping — a long agent list should
 * not jump back to the top under a held `j`.
 */
export function handleWorkflowDialogKey(
  data: string,
  state: WorkflowDialogState,
  view: ResolvedWorkflowDialog,
): { state: WorkflowDialogState; action?: WorkflowDialogAction } | undefined {
  if (matchesKey(data, "escape") || matchesKey(data, "q")) return { state, action: { kind: "cancel" } };

  if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
    return { state: { ...state, pane: state.pane === "phases" ? "agents" : "phases" } };
  }

  const down = matchesKey(data, "j") || matchesKey(data, "down");
  const up = matchesKey(data, "k") || matchesKey(data, "up");
  if (down || up) {
    const delta = down ? 1 : -1;
    if (state.pane === "phases") {
      const next = clampIndex(view.clampedPhase + delta, view.groups.length);
      // Changing phase re-points the agent list at a different set of rows, so
      // the old row index would be meaningless.
      return { state: next === view.clampedPhase ? state : { ...state, selectedPhase: next, selectedAgent: 0 } };
    }
    return { state: { ...state, selectedAgent: clampIndex(view.clampedAgent + delta, view.visibleAgents.length) } };
  }

  if (matchesKey(data, "f")) {
    return { state: { ...state, filter: nextFilter(state.filter), selectedAgent: 0 } };
  }
  if (matchesKey(data, "e") || matchesKey(data, "enter")) {
    return { state: { ...state, promptExpanded: !state.promptExpanded } };
  }

  if (matchesKey(data, "x")) return { state, action: { kind: "kill" } };
  if (matchesKey(data, "p")) return { state, action: { kind: view.paused ? "resume" : "pause" } };
  if (matchesKey(data, "s") && view.selectedEntry) {
    return { state, action: { kind: "skip", index: view.selectedEntry.index } };
  }
  if (matchesKey(data, "r") && view.selectedEntry) {
    return { state, action: { kind: "retry", index: view.selectedEntry.index } };
  }

  return undefined;
}

/* ------------------------------------------------------------------------- *
 * Rendering
 * ------------------------------------------------------------------------- */

/** The dialog as plain text — what the layout tests assert against. */
export function plainWorkflowDialogLines(lines: readonly WorkflowCardLine[]): string[] {
  return lines.map(line => line.map(segment => segment.text).join(""));
}

/**
 * The `/workflows` overlay.
 *
 * Deliberately thin: it owns the spinner timer and the theme, and delegates
 * everything else to the two pure functions above. `source` is re-read every
 * render so a live run updates in place without any subscription plumbing.
 */
export class WorkflowDialog implements Component {
  private state: WorkflowDialogState;
  private spinnerFrame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private tui: TUI,
    private source: () => WorkflowDialogSource,
    private theme: Theme,
    private done: (result: undefined) => void,
    private actions: WorkflowDialogActions = {},
    initialPhaseIndex = 0,
  ) {
    this.state = initialWorkflowDialogState(initialPhaseIndex);
    this.timer = setInterval(() => {
      this.spinnerFrame++;
      if (!this.closed) this.tui.requestRender();
    }, WORKFLOW_DIALOG_SPINNER_MS);
    this.timer.unref?.();
  }

  handleInput(data: string): void {
    const input: WorkflowDialogInput = { ...this.source(), state: this.state };
    const result = handleWorkflowDialogKey(data, this.state, resolveWorkflowDialog(input));
    if (!result) return;
    this.state = result.state;
    if (result.action) this.dispatch(result.action);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = layoutWorkflowDialog({
      ...this.source(),
      state: this.state,
      // Derived from what was actually injected, so the footer advertises only
      // the keys this dialog can service.
      available: {
        onKill: this.actions.onKill !== undefined,
        onPause: this.actions.onPause !== undefined,
        onResume: this.actions.onResume !== undefined,
        onSkipAgent: this.actions.onSkipAgent !== undefined,
        onRetryAgent: this.actions.onRetryAgent !== undefined,
      },
      width,
      spinnerFrame: this.spinnerFrame,
    });
    return styleWorkflowCardLines(lines, this.theme);
  }

  invalidate(): void {
    /* no cached state to clear */
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private dispatch(action: WorkflowDialogAction): void {
    switch (action.kind) {
      case "cancel":
        this.closed = true;
        this.done(undefined);
        return;
      case "kill":
        this.actions.onKill?.();
        return;
      case "pause":
        this.actions.onPause?.();
        return;
      case "resume":
        this.actions.onResume?.();
        return;
      case "skip":
        this.actions.onSkipAgent?.(action.index);
        return;
      case "retry":
        this.actions.onRetryAgent?.(action.index);
        return;
    }
  }
}
