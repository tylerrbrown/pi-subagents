import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SPINNER } from "../src/ui/agent-widget.js";
import { styleWorkflowCardLines, type WorkflowCardTask } from "../src/ui/workflow-card.js";
import {
  ASCII_DIALOG_GLYPHS,
  dialogRowGlyph,
  handleWorkflowDialogKey,
  initialWorkflowDialogState,
  layoutWorkflowDialog,
  PROMPT_COLLAPSED_LINES,
  plainWorkflowDialogLines,
  resolveWorkflowDialog,
  subStatusAnnotations,
  UNICODE_DIALOG_GLYPHS,
  WORKFLOW_DIALOG_COPY,
  WorkflowDialog,
  type WorkflowDialogInput,
  type WorkflowDialogState,
  workflowDialogContentWidth,
} from "../src/ui/workflow-dialog.js";
import type { WorkflowMeta } from "../src/workflow/meta.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "../src/workflow/progress.js";

const START = 1_000_000;

/** A theme that makes every colour and bold span visible in the assertion. */
const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
};

function agentEntry(partial: Partial<WorkflowAgentEntry> & { index: number }): WorkflowAgentEntry {
  return {
    type: "workflow_agent",
    label: `agent-${partial.index}`,
    phaseIndex: 0,
    state: "start",
    ...partial,
  };
}

type DialogOverrides = Partial<Omit<WorkflowDialogInput, "state">> & {
  progress: readonly WorkflowEntry[];
  state?: Partial<WorkflowDialogState>;
};

function input(over: DialogOverrides): WorkflowDialogInput {
  const task: WorkflowCardTask = {
    status: "running",
    workflowName: "review-changes",
    startTime: START,
    ...over.task,
  };
  return {
    width: 86,
    now: START + 1000,
    ...over,
    task,
    state: { ...initialWorkflowDialogState(), ...over.state },
  };
}

const dialog = (over: DialogOverrides): string[] =>
  plainWorkflowDialogLines(layoutWorkflowDialog(input(over)));

const styled = (over: DialogOverrides): string[] =>
  styleWorkflowCardLines(layoutWorkflowDialog(input(over)), theme);

/** Strip the fake theme's markup and a heading's focus marker / padding. */
const bare = (line: string) => line.replace(/<\/?[a-zA-Z]+>|\*/g, "").replace(/^[\s▸>]+/, "");

/** Rows of a section, i.e. everything between its heading and the next blank. */
function section(lines: string[], heading: string): string[] {
  const start = lines.findIndex(l => bare(l).startsWith(heading));
  if (start < 0) throw new Error(`no ${heading} section in:\n${lines.join("\n")}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => l.trim() === "");
  return end < 0 ? rest : rest.slice(0, end);
}

/* ------------------------------------------------------------------------- *
 * Glyphs
 * ------------------------------------------------------------------------- */

describe("dialog glyph mapping", () => {
  const live: WorkflowEntry[] = [
    agentEntry({ index: 0, label: "done", state: "done" }),
    agentEntry({ index: 1, label: "failed", state: "error" }),
    agentEntry({ index: 2, label: "skipped", state: "error", skipped: true }),
    agentEntry({ index: 3, label: "blocked", state: "error", blocked: true }),
    agentEntry({ index: 4, label: "queued", state: "start", queuedAt: START }),
    agentEntry({ index: 5, label: "running", state: "progress", startedAt: START }),
  ];

  it("maps every one of the seven display states to its glyph and colour", () => {
    expect(dialogRowGlyph("done", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✔", color: "success" });
    expect(dialogRowGlyph("failed", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✘", color: "error" });
    expect(dialogRowGlyph("skipped", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✘", color: "dim" });
    expect(dialogRowGlyph("blocked", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✘", color: "warning" });
    expect(dialogRowGlyph("queued", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "◌", color: "dim" });
    expect(dialogRowGlyph("interrupted", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "◌", color: "dim" });
    expect(dialogRowGlyph("running", UNICODE_DIALOG_GLYPHS, 3)).toEqual({ text: SPINNER[3], color: "dim" });
  });

  it("keys off the derived display state, not the raw entry state", () => {
    const rows = section(dialog({ progress: live }), "Agents");
    expect(rows[0]).toContain("✔ done");
    expect(rows[1]).toContain("✘ failed");
    expect(rows[2]).toContain("✘ skipped");
    expect(rows[3]).toContain("✘ blocked");
    // All four above are `state: "done" | "error"` inline; only the dialog
    // splits the last three apart, and only it can draw ◌ for the queued row.
    expect(rows[4]).toContain("◌ queued");
    expect(rows[5]).toContain(`${SPINNER[0]} running`);
  });

  it("renders blocked distinctly from skipped despite sharing the cross", () => {
    const lines = styled({ progress: live });
    expect(lines.find(l => l.includes("skipped"))).toContain("<dim>✘</dim>");
    expect(lines.find(l => l.includes("blocked"))).toContain("<warning>✘</warning>");
    expect(lines.find(l => l.includes("failed"))).toContain("<error>✘</error>");
    expect(lines.find(l => l.includes(">done"))).toContain("<success>✔</success>");
  });

  it("does not use the card's ⟳ for a running row — it spins, and queues draw ◌", () => {
    const joined = dialog({ progress: live }).join("\n");
    expect(joined).not.toContain("⟳");
    expect(joined).toContain("◌");
    // And the spinner really advances, which a static glyph could not do.
    const later = dialog({ progress: live, spinnerFrame: 4 }).join("\n");
    expect(later).toContain(`${SPINNER[4]} running`);
    expect(later).not.toContain(`${SPINNER[0]} running`);
  });

  it("draws ◌ for an agent still live when the run stopped", () => {
    const rows = section(
      dialog({
        progress: [agentEntry({ index: 0, label: "cutoff", state: "progress", startedAt: START })],
        task: { status: "killed", startTime: START },
      }),
      "Agents",
    );
    expect(rows[0]).toContain("◌ cutoff");
  });

  it("keeps an ASCII tier one column wide for every glyph", () => {
    for (const key of ["tick", "cross", "queued", "pointer", "focus"] as const) {
      expect(visibleWidth(ASCII_DIALOG_GLYPHS[key]), key).toBe(1);
    }
    const joined = dialog({ progress: live, ascii: true }).join("\n");
    expect(joined).not.toMatch(/[✔✘◌❯▸]/);
    expect(joined).toContain("√ done");
    expect(joined).toContain("o queued");
  });
});

/* ------------------------------------------------------------------------- *
 * Phases pane
 * ------------------------------------------------------------------------- */

describe("phases pane", () => {
  const meta: WorkflowMeta = {
    name: "review-changes",
    description: "Review changed files",
    phases: [{ title: "Review" }, { title: "Verify" }, { title: "Report" }],
  };
  const progress: WorkflowEntry[] = [
    { type: "workflow_phase", index: 0, title: "Review" },
    { type: "workflow_phase", index: 1, title: "Verify" },
    agentEntry({ index: 0, label: "a", phaseIndex: 0, state: "done" }),
    agentEntry({ index: 1, label: "b", phaseIndex: 1, state: "start" }),
  ];

  it("shows a phase's number until it finishes, then its glyph", () => {
    const rows = section(dialog({ progress, meta }), "Phases");
    // Review is fully done → tick. Verify is still running → its NUMBER, not a
    // glyph. Report never started → its number too.
    expect(rows[0]).toContain("✔ Review");
    expect(rows[1]).toContain("2 Verify");
    expect(rows[2]).toContain("3 Report");
    expect(rows[1]).not.toContain("✔");
    expect(rows[1]).not.toContain("✘");
  });

  it("shows a cross once a phase has a failure", () => {
    const rows = section(
      dialog({
        progress: [
          { type: "workflow_phase", index: 0, title: "Review" },
          agentEntry({ index: 0, label: "a", phaseIndex: 0, state: "error" }),
        ],
      }),
      "Phases",
    );
    expect(rows[0]).toContain("✘ Review");
  });

  it("points at the selected phase and accents it, leaving the others alone", () => {
    const rows = section(styled({ progress, meta, state: { selectedPhase: 1 } }), "Phases");
    expect(rows[1]).toContain("<accent>  ❯ </accent>");
    expect(rows[1]).toContain("<accent>Verify</accent>");
    expect(rows[0]).not.toContain("❯");
    expect(rows[0]).toContain("<success>");
    expect(rows[2]).toContain("<dim>");
  });

  it("labels a declared-but-unseen phase Not started yet", () => {
    const rows = section(dialog({ progress, meta }), "Phases");
    expect(rows[2]).toContain(WORKFLOW_DIALOG_COPY.notStarted);
    expect(rows[2]).toContain("Not started yet");
    expect(rows[0]).toContain("1/1");
  });

  it("swaps the agent list when the phase selection moves", () => {
    expect(section(dialog({ progress, meta }), "Agents")[0]).toContain(" a");
    expect(section(dialog({ progress, meta, state: { selectedPhase: 1 } }), "Agents")[0]).toContain(" b");
  });
});

/* ------------------------------------------------------------------------- *
 * State filter
 * ------------------------------------------------------------------------- */

describe("state filter", () => {
  const progress: WorkflowEntry[] = [
    agentEntry({ index: 0, label: "one", state: "done" }),
    agentEntry({ index: 1, label: "two", state: "progress", startedAt: START }),
    agentEntry({ index: 2, label: "three", state: "progress", startedAt: START }),
  ];

  it("counts unfiltered agents with a plural that agrees", () => {
    // Exact, not `toContain`: "1 agent" is a substring of "1 agents".
    expect(dialog({ progress }).find(l => l.includes("Agents"))).toBe("  Agents  3 agents");
    const one = dialog({ progress: [agentEntry({ index: 0, state: "done" })] });
    expect(one.find(l => l.includes("Agents"))).toBe("  Agents  1 agent");
  });

  it("narrows the visible set and reports `showing N <filter>`", () => {
    const lines = dialog({ progress, state: { filter: "running" } });
    expect(lines.find(l => l.includes("Agents"))).toContain("showing 2 running");
    const rows = section(lines, "Agents");
    expect(rows).toHaveLength(2);
    expect(rows.join("\n")).not.toContain("one");
    expect(rows.join("\n")).toContain("two");
  });

  it("reports a filter that matches nothing, and says so in the list", () => {
    const lines = dialog({ progress, state: { filter: "blocked" } });
    expect(lines.find(l => l.includes("Agents"))).toContain("showing 0 blocked");
    expect(section(lines, "Agents")).toEqual(["  No agents"]);
    expect(WORKFLOW_DIALOG_COPY.noAgents).toBe("No agents");
  });

  it("filters on the derived state, so a stopped run's live agents match interrupted", () => {
    const view = resolveWorkflowDialog(
      input({ progress, task: { status: "killed", startTime: START }, state: { filter: "interrupted" } }),
    );
    expect(view.visibleAgents.map(a => a.label)).toEqual(["two", "three"]);
  });
});

/* ------------------------------------------------------------------------- *
 * Sub-status annotations
 * ------------------------------------------------------------------------- */

describe("sub-status annotations", () => {
  it("renders the retry reason and attempt number from the entry", () => {
    expect(
      subStatusAnnotations(
        agentEntry({ index: 0, attempt: 3, lastAttemptReason: "throttled" }),
        "running",
        START,
      ),
    ).toEqual(["throttled", "attempt 3"]);
    expect(
      subStatusAnnotations(agentEntry({ index: 0, lastAttemptReason: "user-retry" }), "running", START),
    ).toEqual(["user retry"]);
    expect(
      subStatusAnnotations(agentEntry({ index: 0, lastAttemptReason: "stalled" }), "running", START),
    ).toEqual(["stalled"]);
  });

  it("does not annotate a first attempt", () => {
    expect(subStatusAnnotations(agentEntry({ index: 0, attempt: 1 }), "running", START)).toEqual([]);
  });

  it("marks a journal replay and an isolated child", () => {
    expect(
      subStatusAnnotations(agentEntry({ index: 0, cached: true, isolation: "worktree" }), "done", START),
    ).toEqual(["worktree", "from resume journal"]);
  });

  it("shows how long a queued agent has waited, and only while it is queued", () => {
    const entry = agentEntry({ index: 0, queuedAt: START });
    expect(subStatusAnnotations(entry, "queued", START + 8000)).toEqual(["waiting 8s"]);
    expect(subStatusAnnotations(entry, "running", START + 8000)).toEqual([]);
  });

  it("puts the annotations on the row ahead of the card's stat tail", () => {
    const rows = section(
      dialog({
        progress: [
          agentEntry({
            index: 0,
            label: "retry-me",
            state: "start",
            queuedAt: START,
            attempt: 2,
            lastAttemptReason: "throttled",
            agentType: "Explore",
            toolCalls: 4,
          }),
        ],
        now: START + 8000,
      }),
      "Agents",
    );
    expect(rows[0].trimStart()).toBe(
      "❯ ◌ retry-me · throttled · attempt 2 · waiting 8s · Explore · 4 tool calls",
    );
  });
});

/* ------------------------------------------------------------------------- *
 * Detail sections
 * ------------------------------------------------------------------------- */

describe("per-agent detail", () => {
  const long = Array.from({ length: 9 }, (_, i) => `prompt line ${i}`).join("\n");

  it("collapses a long prompt behind an `expand` affordance and counts its lines", () => {
    const collapsed = dialog({
      progress: [agentEntry({ index: 0, state: "done", promptPreview: long })],
    });
    expect(collapsed.find(l => l.includes("Prompt"))).toContain("Prompt  9 lines · expand");
    expect(section(collapsed, "Prompt")).toHaveLength(PROMPT_COLLAPSED_LINES);

    const expanded = dialog({
      progress: [agentEntry({ index: 0, state: "done", promptPreview: long })],
      state: { promptExpanded: true },
    });
    expect(expanded.find(l => l.includes("Prompt"))).toContain("Prompt  9 lines");
    expect(expanded.find(l => l.includes("Prompt"))).not.toContain("expand");
    expect(section(expanded, "Prompt")).toHaveLength(9);
  });

  it("does not offer expand for a prompt that already fits, and counts one line as one", () => {
    const two = dialog({
      progress: [agentEntry({ index: 0, state: "done", promptPreview: "one\ntwo" })],
    });
    expect(two.find(l => l.includes("Prompt"))).toBe("  Prompt  2 lines");
    const one = dialog({ progress: [agentEntry({ index: 0, state: "done", promptPreview: "solo" })] });
    expect(one.find(l => l.includes("Prompt"))).toBe("  Prompt  1 line");
  });

  it("uses Claude Code's copy for a prompt and activity that do not exist yet", () => {
    const lines = dialog({ progress: [agentEntry({ index: 0, state: "start", queuedAt: START })] });
    expect(section(lines, "Prompt")).toEqual([`  ${WORKFLOW_DIALOG_COPY.availableOnceStarted}`]);
    expect(section(lines, "Activity")).toEqual(["  Available once the agent starts."]);
    expect(section(lines, "Outcome")).toEqual(["  Waiting for an agent slot."]);
  });

  it("distinguishes no-tool-calls-yet from no-tool-calls-ever", () => {
    const running = dialog({ progress: [agentEntry({ index: 0, state: "progress", startedAt: START })] });
    expect(section(running, "Activity")).toEqual(["  No tool calls yet."]);
    const finished = dialog({ progress: [agentEntry({ index: 0, state: "done" })] });
    expect(section(finished, "Activity")).toEqual(["  No tool calls."]);
  });

  it("heads Activity with the tool-call count and admits it has no transcript", () => {
    const lines = dialog({ progress: [agentEntry({ index: 0, state: "done", toolCalls: 3 })] });
    expect(lines.find(l => l.includes("Activity"))).toBe("  Activity  last 3 tool calls");
    expect(section(lines, "Activity")).toEqual(["  Transcript not available."]);
    const one = dialog({ progress: [agentEntry({ index: 0, state: "done", toolCalls: 1 })] });
    expect(one.find(l => l.includes("Activity"))).toBe("  Activity  last 1 tool call");
  });

  it("writes a different Outcome for every terminal state", () => {
    const outcome = (entry: Partial<WorkflowAgentEntry>, task?: WorkflowCardTask) =>
      section(dialog({ progress: [agentEntry({ index: 0, ...entry })], task }), "Outcome");

    expect(outcome({ state: "error", skipped: true })).toEqual(["  Skipped by user."]);
    expect(outcome({ state: "error", error: "boom" })).toEqual(["  boom"]);
    expect(outcome({ state: "error", blocked: true })).toEqual([`  ${WORKFLOW_DIALOG_COPY.noTranscript}`]);
    expect(outcome({ state: "done", resultPreview: "shipped" })).toEqual(["  shipped"]);
    expect(outcome({ state: "progress", startedAt: START })).toEqual([
      "  Not available yet (agent still running).",
    ]);
    expect(outcome({ state: "progress", startedAt: START }, { status: "killed", startTime: START })).toEqual([
      "  The workflow stopped before this agent finished.",
    ]);
  });

  it("omits the detail sections entirely when nothing is selected", () => {
    const lines = dialog({ progress: [] });
    expect(lines.join("\n")).not.toContain("Prompt");
    expect(lines.join("\n")).not.toContain("Outcome");
    expect(section(lines, "Agents")).toEqual([`  ${WORKFLOW_DIALOG_COPY.noAgents}`]);
  });
});

/* ------------------------------------------------------------------------- *
 * Keys
 * ------------------------------------------------------------------------- */

describe("keys", () => {
  const progress: WorkflowEntry[] = [
    { type: "workflow_phase", index: 0, title: "Review" },
    { type: "workflow_phase", index: 1, title: "Verify" },
    agentEntry({ index: 0, label: "a", phaseIndex: 0, state: "done" }),
    agentEntry({ index: 1, label: "b", phaseIndex: 0, state: "done" }),
    agentEntry({ index: 2, label: "c", phaseIndex: 1, state: "done" }),
  ];

  const press = (data: string, state?: Partial<WorkflowDialogState>) => {
    const full = input({ progress, state });
    return handleWorkflowDialogKey(data, full.state, resolveWorkflowDialog(full));
  };

  it("moves the phase selection with j/k and clamps at both ends", () => {
    expect(press("j")?.state.selectedPhase).toBe(1);
    expect(press("j", { selectedPhase: 1 })?.state.selectedPhase).toBe(1);
    expect(press("k", { selectedPhase: 1 })?.state.selectedPhase).toBe(0);
    expect(press("k", { selectedPhase: 0 })?.state.selectedPhase).toBe(0);
  });

  it("moves the agent selection with j/k and clamps at both ends", () => {
    const agents = { pane: "agents" as const };
    expect(press("j", agents)?.state.selectedAgent).toBe(1);
    expect(press("j", { ...agents, selectedAgent: 1 })?.state.selectedAgent).toBe(1);
    expect(press("k", { ...agents, selectedAgent: 1 })?.state.selectedAgent).toBe(0);
    expect(press("k", { ...agents, selectedAgent: 0 })?.state.selectedAgent).toBe(0);
  });

  it("re-points the agent cursor at the top when the phase changes", () => {
    const moved = press("j", { selectedAgent: 1 });
    expect(moved?.state.selectedPhase).toBe(1);
    expect(moved?.state.selectedAgent).toBe(0);
  });

  it("never runs the cursor off an empty list", () => {
    const empty = input({ progress: [], state: { pane: "agents" } });
    const view = resolveWorkflowDialog(empty);
    expect(handleWorkflowDialogKey("j", empty.state, view)?.state.selectedAgent).toBe(0);
    expect(view.selectedEntry).toBeUndefined();
  });

  it("toggles the pane focus, and the focused pane is the marked one", () => {
    expect(press("\t")?.state.pane).toBe("agents");
    expect(press("\t", { pane: "agents" })?.state.pane).toBe("phases");

    const phases = dialog({ progress });
    expect(phases.find(l => l.includes("Phases"))).toBe("▸ Phases");
    expect(phases.find(l => l.includes("Agents"))?.startsWith("  Agents")).toBe(true);

    const agents = dialog({ progress, state: { pane: "agents" } });
    expect(agents.find(l => l.includes("Phases"))).toBe("  Phases");
    expect(agents.find(l => l.includes("Agents"))?.startsWith("▸ Agents")).toBe(true);
  });

  it("cycles the filter and resets the agent cursor with it", () => {
    expect(press("f")?.state.filter).toBe("running");
    expect(press("f", { filter: "running" })?.state.filter).toBe("queued");
    expect(press("f", { filter: "interrupted" })?.state.filter).toBe("all");
    expect(press("f", { selectedAgent: 1 })?.state.selectedAgent).toBe(0);
  });

  it("toggles the prompt expansion", () => {
    expect(press("e")?.state.promptExpanded).toBe(true);
    expect(press("e", { promptExpanded: true })?.state.promptExpanded).toBe(false);
  });

  it("cancels on escape", () => {
    expect(press("\x1b")?.action).toEqual({ kind: "cancel" });
  });

  it("raises the run-level actions, and pause flips to resume once paused", () => {
    expect(press("x")?.action).toEqual({ kind: "kill" });
    expect(press("p")?.action).toEqual({ kind: "pause" });
    const paused = input({ progress, task: { status: "paused", startTime: START } });
    expect(handleWorkflowDialogKey("p", paused.state, resolveWorkflowDialog(paused))?.action).toEqual({
      kind: "resume",
    });
  });

  it("raises skip and retry against the selected agent's stable index", () => {
    const at = { pane: "agents" as const, selectedAgent: 1 };
    expect(press("s", at)?.action).toEqual({ kind: "skip", index: 1 });
    expect(press("r", at)?.action).toEqual({ kind: "retry", index: 1 });
    // Phase 1 holds the agent whose index is 2 — the row position is not it.
    expect(press("s", { selectedPhase: 1 })?.action).toEqual({ kind: "skip", index: 2 });
  });

  it("leaves an unbound key alone", () => {
    expect(press("z")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- *
 * Width
 * ------------------------------------------------------------------------- */

describe("width", () => {
  const wide: WorkflowEntry[] = [
    { type: "workflow_phase", index: 0, title: "A phase title that runs on well past any sane terminal width" },
    agentEntry({
      index: 0,
      label: "an-extremely-long-agent-label-that-would-otherwise-wrap-the-whole-dialog",
      state: "done",
      agentType: "general-purpose",
      model: "claude-opus-4-5-20260101",
      tokens: 1_240_000,
      toolCalls: 412,
      durationMs: 3_723_000,
      promptPreview: "a prompt line long enough to overflow a narrow terminal all by itself",
      resultPreview: "an outcome line long enough to overflow a narrow terminal all by itself",
    }),
  ];

  it("reserves six columns of chrome from the terminal width", () => {
    expect(workflowDialogContentWidth(86)).toBe(80);
    expect(Math.max(...dialog({ progress: wide, width: 86 }).map(visibleWidth))).toBe(80);
  });

  it("floors the content width at 12 rather than going negative", () => {
    expect(workflowDialogContentWidth(4)).toBe(12);
    // Without the floor the layout would clamp every line to nothing at all.
    const lines = dialog({ progress: wide, width: 4 });
    expect(Math.max(...lines.map(visibleWidth))).toBe(12);
  });

  it("never exceeds the content width", () => {
    for (const width of [4, 12, 20, 40, 80]) {
      const lines = dialog({ progress: wide, width });
      const content = workflowDialogContentWidth(width);
      expect(lines.length).toBeGreaterThan(5);
      for (const line of lines) expect(visibleWidth(line), `w=${width}`).toBeLessThanOrEqual(content);
    }
  });

  it("counts wide characters rather than code points", () => {
    const lines = dialog({
      progress: [agentEntry({ index: 0, label: "日本語のラベルがとても長い場合の折り返し確認", toolCalls: 3 })],
      width: 30,
    });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
  });
});

/* ------------------------------------------------------------------------- *
 * Header
 * ------------------------------------------------------------------------- */

describe("header", () => {
  it("carries the shared N/M agents · elapsed line and the run's subtext", () => {
    const lines = dialog({
      progress: [
        agentEntry({ index: 0, state: "done" }),
        agentEntry({ index: 1, state: "start", startedAt: START }),
      ],
      meta: { name: "review-changes", description: "Review changed files" },
      now: START + 72_000,
    });
    expect(lines[0]).toContain("Workflow  review-changes");
    expect(lines[0]).toContain("1/2 agents · 1m12s");
    expect(lines[1]).toBe("  Review changed files");
  });
});

/* ------------------------------------------------------------------------- *
 * Component
 * ------------------------------------------------------------------------- */

describe("WorkflowDialog component", () => {
  const source = () => ({
    progress: [agentEntry({ index: 7, label: "only", state: "done" })],
    task: { status: "running" as const, workflowName: "wf", startTime: START },
  });

  function harness(): { dialog: WorkflowDialog; calls: string[]; closed: boolean[] } {
    const calls: string[] = [];
    const closed: boolean[] = [];
    const tui = { requestRender: () => calls.push("render") } as unknown as never;
    const instance = new WorkflowDialog(
      tui,
      source,
      theme,
      () => closed.push(true),
      {
        onKill: () => calls.push("kill"),
        onPause: () => calls.push("pause"),
        onSkipAgent: (index: number) => calls.push(`skip:${index}`),
        onRetryAgent: (index: number) => calls.push(`retry:${index}`),
      },
    );
    return { dialog: instance, calls, closed };
  }

  it("themes the layout and keeps its line count", () => {
    const { dialog: instance } = harness();
    const rendered = instance.render(86);
    expect(rendered).toHaveLength(
      layoutWorkflowDialog({ ...source(), state: initialWorkflowDialogState(), width: 86 }).length,
    );
    expect(rendered[0]).toContain("<toolTitle>*Workflow*</toolTitle>");
    expect(rendered.join("\n")).toContain("<success>✔</success>");
    instance.dispose();
  });

  it("dispatches the injected actions and closes on escape", () => {
    const { dialog: instance, calls, closed } = harness();
    instance.handleInput("x");
    instance.handleInput("p");
    instance.handleInput("s");
    instance.handleInput("r");
    expect(calls.filter(c => c !== "render")).toEqual(["kill", "pause", "skip:7", "retry:7"]);
    expect(closed).toHaveLength(0);
    instance.handleInput("\x1b");
    expect(closed).toEqual([true]);
    instance.dispose();
  });

  it("keeps its state across keypresses", () => {
    const { dialog: instance } = harness();
    instance.handleInput("\t");
    expect(instance.render(86).find(l => l.includes("Agents"))).toContain("▸ ");
    instance.dispose();
  });
});

describe("key hints reflect the wired actions", () => {
  const live: WorkflowEntry[] = [
    { type: "workflow_agent", index: 0, label: "a", phaseIndex: 0, state: "progress", startedAt: START },
  ];
  // Wide enough that the footer is never clipped — these assert which hints are
  // present, not how they truncate (that is covered by the width tests).
  const hintLine = (over: DialogOverrides) =>
    dialog({ width: 200, ...over }).find(line => line.includes("j/k move")) ?? "";

  it("advertises every key when availability is not declared", () => {
    const hints = hintLine({ progress: live });
    for (const key of ["s skip", "r retry", "p pause", "x stop", "esc close"]) {
      expect(hints).toContain(key);
    }
  });

  it("hides the keys the caller did not wire", () => {
    // A caller that wires only onKill must not advertise skip/retry/pause —
    // a footer promising a key that silently does nothing is worse than no key.
    const hints = hintLine({
      progress: live,
      available: { onKill: true, onPause: false, onResume: false, onSkipAgent: false, onRetryAgent: false },
    });
    expect(hints).toContain("x stop");
    expect(hints).toContain("esc close");
    expect(hints).not.toContain("s skip");
    expect(hints).not.toContain("r retry");
    expect(hints).not.toContain("p pause");
  });

  it("hides stop when kill is not wired", () => {
    expect(hintLine({ progress: live, available: { onKill: false } })).not.toContain("x stop");
  });

  it("hides resume on a paused run when resume is not wired", () => {
    const hints = hintLine({
      progress: live,
      task: { status: "paused", startTime: START },
      available: { onResume: false },
    });
    expect(hints).not.toContain("p resume");
  });
});

describe("component availability", () => {
  const tui = { requestRender: () => {} } as unknown as never;
  const liveSource = () => ({
    progress: [
      { type: "workflow_agent", index: 0, label: "a", phaseIndex: 0, state: "progress", startedAt: START },
    ] as WorkflowEntry[],
    task: { status: "running", workflowName: "wf", startTime: START } as WorkflowCardTask,
  });
  const footer = (instance: WorkflowDialog) =>
    instance.render(200).find(line => line.includes("j/k move")) ?? "";

  it("advertises only the actions it was given", () => {
    // Wiring just onKill must not promise skip/retry/pause.
    const instance = new WorkflowDialog(tui, liveSource, theme, () => {}, { onKill: () => {} });
    const hints = footer(instance);
    expect(hints).toContain("x stop");
    expect(hints).not.toContain("s skip");
    expect(hints).not.toContain("r retry");
    expect(hints).not.toContain("p pause");
    instance.dispose();
  });

  it("advertises the full set when every action is wired", () => {
    const instance = new WorkflowDialog(tui, liveSource, theme, () => {}, {
      onKill: () => {}, onPause: () => {}, onResume: () => {},
      onSkipAgent: () => {}, onRetryAgent: () => {},
    });
    const hints = footer(instance);
    for (const key of ["s skip", "r retry", "p pause", "x stop"]) expect(hints).toContain(key);
    instance.dispose();
  });

  it("advertises nothing actionable when no actions are wired", () => {
    const instance = new WorkflowDialog(tui, liveSource, theme, () => {});
    const hints = footer(instance);
    for (const key of ["s skip", "r retry", "p pause", "x stop"]) expect(hints).not.toContain(key);
    expect(hints).toContain("esc close");
    instance.dispose();
  });
});
