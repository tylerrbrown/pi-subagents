import { describe, expect, it, vi } from "vitest";
import { renderRunningAgentStatus } from "../src/index.js";
import type { WidgetMode } from "../src/types.js";
import { type AgentActivity, AgentWidget, agentRecordName, fgPreservingNestedStyles, formatCost, formatMs, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("formatMs", () => {
  it("uses seconds only below one minute", () => {
    expect(formatMs(1_800)).toBe("1.8s");
    expect(formatMs(59_950)).toBe("60.0s");
  });

  it("uses minutes and hours for longer durations", () => {
    expect(formatMs(110_500)).toBe("1.8m");
    expect(formatMs(4_320_000)).toBe("1.2h");
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    };
  }

  function makeRecord(id: string, opts: { isBackground?: boolean; parentAgentId?: string } = {}) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: opts.isBackground,
      parentAgentId: opts.parentAgentId,
    };
  }

  /** Render the widget for a manager and return the produced lines ("" if nothing rendered). */
  function renderLines(
    manager: unknown,
    activityId: string,
    mode?: () => WidgetMode,
    activity = new Map([[activityId, makeActivity()]]),
    columns = 120,
  ): string {
    const widget = new AgentWidget(manager as any, activity, mode);
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    if (!factory) return "";
    return factory({ terminal: { columns }, requestRender: () => {} }, theme)
      .render()
      .join("\n");
  }

  // "all" (and the no-policy constructor default) shows every agent.
  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("hides nested children in every coordinator widget mode", () => {
    const manager = {
      listAgents: () => [makeRecord("nested", { isBackground: true, parentAgentId: "parent" })],
    };
    expect(renderLines(manager, "nested", () => "all")).toBe("");
    expect(renderLines(manager, "nested", () => "background")).toBe("");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  // Also covers scheduler-spawned agents (isBackground=true, no `invocation`
  // snapshot): if the filter still keyed off `invocation.runInBackground` —
  // #118's original approach — this would wrongly vanish.
  it("renders background agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });

  it("shows elapsed and idle time for a running agent", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(20_000);
      const record = makeRecord("idle", { isBackground: true });
      record.startedAt = 10_000;
      record.lastProgressAt = 17_000;
      const widget = new AgentWidget(
        { listAgents: () => [record] } as any,
        new Map(),
        () => "background",
      );
      let factory: any;
      widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
      widget.update();
      const output = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

      expect(output).toContain("10.0s elapsed");
      expect(output).toContain("idle 3.0s");
    } finally {
      vi.useRealTimers();
    }
  });

  // 'background' excludes only agents *known* to be foreground; one with no
  // isBackground flag (e.g. a cross-extension RPC spawn) is kept, not hidden.
  it("aligns name, description, posture, and metrics columns", () => {
    const first = makeRecord("a1", { isBackground: true }) as any;
    Object.assign(first, {
      handle: "builder",
      description: "Build Pi Informer adapter",
      toolUses: 13,
      lifetimeUsage: { input: 20_800, output: 0, cacheWrite: 0 },
      lastProgressAt: Date.now() - 9_000,
      invocation: { thinking: "medium" },
      session: {
        model: { id: "gpt-5.6-sol" },
        thinkingLevel: "medium",
        getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 2 } }),
      },
    });
    const second = makeRecord("a2", { isBackground: true }) as any;
    Object.assign(second, {
      handle: "builder-2",
      description: "Build Work Informer enforcement",
      toolUses: 144,
      lifetimeUsage: { input: 9_600, output: 0, cacheWrite: 0 },
      lastProgressAt: Date.now() - 10_000,
      invocation: { thinking: "high" },
      session: {
        model: { id: "grok-4.6" },
        thinkingLevel: "high",
        getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 88 } }),
      },
    });
    const activity = new Map<string, AgentActivity>([
      ["a1", { activeTools: new Map(), toolUses: 13, responseText: "", turnCount: 9 }],
      ["a2", { activeTools: new Map(), toolUses: 144, responseText: "", turnCount: 66 }],
    ]);
    const output = renderLines({ listAgents: () => [first, second] }, "a1", () => "all", activity, 160).split("\n");
    const a = output.find(line => line.includes("Build Pi Informer"))!;
    const b = output.find(line => line.includes("Build Work Informer"))!;

    expect(a).toMatch(/builder\s+Build Pi Informer adapter\s+gpt-5\.6-sol\/med\/med\s+↻9/);
    expect(b).toMatch(/builder-2\s+Build Work Informer enforcement\s+grok-4\.6\/high\/high\s+↻66/);
    expect(a.indexOf("gpt-5.6-sol")).toBe(b.indexOf("grok-4.6"));
    expect(a.indexOf("↻9")).toBe(b.indexOf("↻66"));
    expect(a.indexOf("token")).toBe(b.indexOf("token"));
    expect(a.indexOf("elapsed")).toBe(b.indexOf("elapsed"));
    expect(a.indexOf("idle")).toBe(b.indexOf("idle"));
    expect(a.indexOf("↻9") - a.indexOf("gpt-5.6-sol")).toBeLessThan(30);
    expect(a).toContain("idle ");
    expect(b).toContain("idle ");
    const compact = renderLines({ listAgents: () => [first, second] }, "a1", () => "all", activity, 40);
    expect(compact).toContain("idle ");
  });

  it("hidden overflow rows do not widen visible columns", () => {
    const records = Array.from({ length: 6 }, (_, index) => {
      const record = makeRecord(`a${index}`, { isBackground: true }) as any;
      record.handle = index === 5 ? "hidden-agent-with-a-very-long-name" : `builder-${index}`;
      record.description = index === 5 ? "hidden description that should not affect visible rows" : `visible ${index}`;
      record.invocation = { thinking: "medium" };
      record.session = { model: { id: index === 5 ? "hidden-model-with-a-very-long-name" : "gpt-5.6-sol" }, thinkingLevel: "medium" };
      return record;
    });
    const activity = new Map(records.map(record => [record.id, makeActivity()]));
    const output = renderLines({ listAgents: () => records }, "a0", () => "all", activity);
    const visible = output.split("\n").find(line => line.includes("visible 0"))!;
    expect(visible).toContain("gpt-5.6-sol/med/med");
    expect(visible).toContain("idle ");
  });

  it("does not label a finished row idle beside a running row", () => {
    const running = makeRecord("running", { isBackground: true }) as any;
    const finished = makeRecord("finished", { isBackground: true }) as any;
    finished.status = "completed";
    finished.completedAt = Date.now();
    const output = renderLines(
      { listAgents: () => [running, finished] },
      "running",
      () => "all",
    ).split("\n");
    expect(output.find(line => line.includes("running description"))).toContain("idle ");
    expect(output.find(line => line.includes("finished description"))).not.toContain("idle");
  });

  it("renders a timed-out agent as an error, not a completion", () => {
    const record = makeRecord("timeout", { isBackground: true }) as any;
    record.status = "timeout";
    record.completedAt = Date.now();
    const manager = { listAgents: () => [record] };
    const output = renderLines(manager, "timeout", () => "background", undefined, 40);
    expect(output).toContain("✗");
    expect(output).toContain("timed out");
  });

  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  // "off" hides the widget entirely — even a background agent renders nothing.
  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });
});

// The widget caps itself at MAX_WIDGET_LINES (12) and, past that, hands out a
// line budget in priority order: running pairs, then the queued summary, then
// finished lines. Running and finished increment `hiddenRunning`/`hiddenFinished`
// when they don't fit; the queued line is dropped with NO counter at all, so the
// footer under-reports and — worse — the queue vanishes from the UI entirely.
// That happens exactly when the concurrency limit is saturated, i.e. when the
// queue is the thing the user most needs to see.
describe("agentRecordName", () => {
  it("shows the type-derived handle instead of a custom instance alias", () => {
    expect(agentRecordName({
      type: "security",
      handle: "security",
      alias: "octopus-protocol",
    } as any)).toBe("security");
  });
});

describe("formatCost", () => {
  it("keeps the precision that distinguishes one run from another", () => {
    // Rounding to cents would print the same figure for a run that cost four
    // times another — the band most single subagent runs fall in.
    expect(formatCost(0.0042)).toBe("~$0.0042");
    expect(formatCost(0.0123)).toBe("~$0.0123");
    expect(formatCost(1.239)).toBe("~$1.24");
  });

  it("never pads a round figure with noise, nor cuts it below cents", () => {
    expect(formatCost(0.05)).toBe("~$0.05");    // not ~$0.0500
    expect(formatCost(0.4)).toBe("~$0.40");     // not ~$0.4
    expect(formatCost(12)).toBe("~$12.00");
  });

  it("shows nothing when there is nothing to show", () => {
    // Zero is what a model with no pricing data reports, so `$0.00` would claim
    // a measurement that was never made.
    expect(formatCost(0)).toBe("");
    expect(formatCost(Number.NaN)).toBe("");
    expect(formatCost(-1)).toBe("");
  });

  it("says a real but tiny cost is tiny, not zero", () => {
    // The distinction the whole helper turns on: "measured, below what four
    // decimals can show" must not render the same as "never measured".
    expect(formatCost(0.00002)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("");
  });

  it("marks the figure as an estimate", () => {
    // The tilde is the whole disclaimer — it sits beside exact token counts.
    expect(formatCost(0.5).startsWith("~")).toBe(true);
  });
});

describe("AgentWidget cost display", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function render(showCost: boolean, cost: number): string {
    const agent = {
      id: "a1",
      type: "general-purpose",
      description: "spending agent",
      status: "running",
      toolUses: 1,
      startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
      compactionCount: 0,
    };
    // Carries figures of its own, in the shape the tracker used to have: spend
    // is read from the record now, so these must not reach the line. Only the
    // record accumulates a nested child's spend, and only it outlives the run.
    const activity = new Map([["a1", {
      activeTools: new Map(),
      toolUses: 1,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 9, output: 9, cacheWrite: 0, cost: 0.9 },
    } as unknown as AgentActivity]]);
    const widget = new AgentWidget(
      { listAgents: () => [agent] } as any,
      activity,
      () => "all",
      () => showCost,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    const line = render(true, 0.0042);
    expect(line).toContain("1.2k token");
    expect(line).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const line = render(false, 0.0042);
    expect(line).toContain("1.2k token");
    expect(line).not.toContain("$");
  });

  it("shows no cost for an unpriced model, even when enabled", () => {
    const line = render(true, 0);
    expect(line).toContain("1.2k token");
    expect(line).not.toContain("$");
  });

  it("keeps the cost visible after the agent finishes", () => {
    // The activity entry is deleted the moment an agent finishes, so a finished
    // line reading from it would drop the number precisely when the question
    // "what did that cost" gets asked.
    const finished = {
      id: "a1", type: "general-purpose", description: "done agent", status: "completed",
      toolUses: 2, startedAt: Date.now() - 1000, completedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      { listAgents: () => [finished] } as any, new Map(), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("done agent");
    expect(out).toContain("~$0.0042");
  });

  it("shows stats for an agent nobody is tracking live", () => {
    // A scheduled agent has no activity entry — it spawns through the manager
    // directly — and used to render with no tokens and no cost at all.
    const running = {
      id: "sched", type: "general-purpose", description: "scheduled agent", status: "running",
      toolUses: 1, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      { listAgents: () => [running] } as any, new Map(), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("defaults to hiding it", () => {
    const agent = {
      id: "a1", type: "general-purpose", description: "d", status: "running",
      toolUses: 0, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.5 }, compactionCount: 0,
    };
    const activity = new Map([["a1", {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget({ listAgents: () => [agent] } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    expect(factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n"))
      .not.toContain("$");
  });
});

describe("AgentWidget overflow accounting", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function record(id: string, status: string) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status,
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: status === "completed" ? Date.now() : undefined,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: true,
    };
  }

  /** Render a whole fleet (mixed statuses) and return the produced lines. */
  function renderFleet(counts: { running: number; queued: number; finished: number }): string[] {
    const agents = [
      ...Array.from({ length: counts.running }, (_, i) => record(`run${i}`, "running")),
      ...Array.from({ length: counts.queued }, (_, i) => record(`q${i}`, "queued")),
      ...Array.from({ length: counts.finished }, (_, i) => record(`fin${i}`, "completed")),
    ];
    const activity = new Map(agents.map(a => [a.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]));
    const widget = new AgentWidget({ listAgents: () => agents } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    if (!factory) return [];
    return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render();
  }

  /** The `+N more (…)` footer, if the widget overflowed. */
  const footer = (lines: string[]) => lines.find(l => l.includes("more ("));

  /** Every fleet shape worth rendering — swept, not sampled. */
  const SHAPES: { running: number; queued: number; finished: number }[] = [];
  for (let running = 0; running <= 8; running++)
    for (let queued = 0; queued <= 8; queued++)
      for (let finished = 0; finished <= 8; finished++) SHAPES.push({ running, queued, finished });

  // Swept rather than sampled: reserving the queued row moves `budget` around by
  // hand, and an off-by-one there overflows the cap only for specific shapes.
  it("never exceeds the line cap, for any fleet shape", () => {
    for (const counts of SHAPES) {
      expect(renderFleet(counts).length, JSON.stringify(counts)).toBeLessThanOrEqual(12);
    }
  });

  it("never prints a footer that miscounts what it hid, for any fleet shape", () => {
    for (const counts of SHAPES) {
      const f = footer(renderFleet(counts));
      if (!f) continue;
      const total = Number(/\+(\d+) more/.exec(f)?.[1]);
      const where = `${JSON.stringify(counts)} → ${f}`;
      // A visible footer means something was dropped, so "+0 more ()" is a lie...
      expect(total, where).toBeGreaterThan(0);
      // ...and it counts agents that have their own row, so it can never exceed
      // them — in particular the queued summary must not be counted as an agent.
      expect(total, where).toBeLessThanOrEqual(counts.running + counts.finished);
    }
  });

  it("keeps the queued summary visible when the running agents fill the widget", () => {
    // 5 running (10 lines) consume the entire budget, so the queued line is
    // dropped — and with it, any sign that 3 agents are waiting to start.
    const lines = renderFleet({ running: 5, queued: 3, finished: 1 });
    expect(lines.join("\n")).toContain("3 queued");
  });

  it("counts everything it hid — the footer total matches what is missing", () => {
    // Computed rather than hardcoded, so this survives a scenario change but not
    // a change to what the footer counts.
    const counts = { running: 5, queued: 3, finished: 1 };
    const lines = renderFleet(counts);
    const body = lines.join("\n");

    const shownRunning = counts.running - [...Array(counts.running).keys()]
      .filter(i => !body.includes(`run${i} description`)).length;
    const shownFinished = counts.finished - [...Array(counts.finished).keys()]
      .filter(i => !body.includes(`fin${i} description`)).length;
    const actuallyHidden = (counts.running - shownRunning) + (counts.finished - shownFinished);

    const reported = Number(/\+(\d+) more/.exec(footer(lines) ?? "")?.[1] ?? -1);
    expect(reported).toBe(actuallyHidden);
  });

  it("gives the queued summary priority over finished lines", () => {
    const lines = renderFleet({ running: 4, queued: 2, finished: 3 });
    expect(lines.join("\n")).toContain("2 queued");
  });

  it("renders everything with no footer when the fleet fits", () => {
    const lines = renderFleet({ running: 2, queued: 1, finished: 1 });
    expect(lines.join("\n")).toContain("1 queued");
    expect(footer(lines)).toBeUndefined();
  });

  // A background resume runs an agent that already finished once. markFinished
  // only seeds an age it has not seen before, so without markRunning the agent
  // carries its previous run's age — already past the linger limit — and the
  // resumed run's ✓ line never renders: the agent just disappears.
  it("shows the completion line again after a finished agent is resumed", () => {
    const agent = record("resumed", "completed");
    const activity = new Map([[agent.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget({ listAgents: () => [agent] } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: any, c: any) => { factory = c; } } as any);
    const render = () => {
      widget.update();
      return (factory?.({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render() ?? []).join("\n");
    };

    // First run finishes and ages out of the widget.
    widget.markFinished(agent.id);
    widget.onTurnStart();
    widget.onTurnStart();
    expect(render()).not.toContain("resumed description");

    // Background resume puts it back on the running list.
    agent.status = "running";
    widget.markRunning(agent.id);
    expect(render()).toContain("resumed description");

    // ...and its completion is visible when the resumed run settles.
    agent.status = "completed";
    widget.markFinished(agent.id);
    expect(render()).toContain("resumed description");
  });
});
