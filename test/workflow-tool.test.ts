/**
 * workflow-tool.test.ts — the seams that bind the workflow engine to the rest of
 * the extension.
 *
 * The engine itself is covered by workflow-runtime/-progress/-meta/-render; what
 * is untested until here is everything *around* it: the adapter that turns a
 * `WorkflowSpawnRequest` into a real `AgentManager` spawn, the `Workflow` tool's
 * input contract, and the CLI flag's ordering — read from `session_start`, never
 * at activation, because the host applies flag values only after every extension
 * has already loaded.
 *
 * The host tests drive a stub manager rather than the real one. That is not to
 * avoid work: `spawnAndWait` needs a model, a session and a repo, and none of
 * those are what these assertions are about — the mapping is.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentManager } from "../src/agent-manager.js";
import { SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import { NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import subagentsExtension, { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG } from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

/** A settled record, in the shape `toSpawnResult` reads. */
function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "general-purpose",
    description: "a child",
    status: "completed",
    result: "the answer",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  } as AgentRecord;
}

interface StubManager {
  manager: AgentManager;
  spawnAndWait: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

/** A manager that spawns nothing; `settle` decides what each spawn produces. */
function stubManager(
  settle: (type: string, prompt: string, options: any) => Promise<AgentRecord> | AgentRecord = () => record(),
): StubManager {
  const abort = vi.fn();
  const resume = vi.fn(async () => record({ id: "agent-1", result: "resumed" }));
  const spawnAndWait = vi.fn(
    async (_pi: any, _ctx: any, type: string, prompt: string, options: any, onSpawned?: (id: string) => void) => {
      const settled = await settle(type, prompt, options);
      onSpawned?.(settled.id);
      return { id: settled.id, record: settled };
    },
  );
  return { manager: { spawnAndWait, abort, resume } as unknown as AgentManager, spawnAndWait, abort, resume };
}

const request = (overrides: Partial<WorkflowSpawnRequest> = {}): WorkflowSpawnRequest => ({
  agentId: "wf-agent-0",
  index: 0,
  prompt: "do the thing",
  label: "step",
  agentType: "general-purpose",
  ...overrides,
});

const execResult = (overrides: Partial<{ stdout: string; stderr: string; code: number; killed: boolean }> = {}) => ({
  stdout: "",
  stderr: "",
  code: 0,
  killed: false,
  ...overrides,
});

/* ------------------------------------------------------------------------- *
 * The host adapter
 * ------------------------------------------------------------------------- */

describe("createWorkflowHost — spawn mapping", () => {
  beforeEach(() => {
    // The host resolves agent types through the process-wide registry, the same
    // one the Agent tool uses. Seed it with the shipped defaults.
    registerAgents(new Map());
  });

  it("spawns through the manager and maps a completed record onto the script's result", async () => {
    const stub = stubManager(() =>
      record({ result: "the answer", toolUses: 3, lifetimeUsage: { input: 100, output: 20, cacheWrite: 5 } }),
    );
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ label: "review:bugs" }));

    expect(result).toMatchObject({ ok: true, text: "the answer", tokens: 125, toolCalls: 3 });
    const [, , type, prompt, options] = stub.spawnAndWait.mock.calls[0];
    expect(type).toBe("general-purpose");
    expect(prompt).toBe("do the thing");
    // The label is the child's display description, so the fleet list and the
    // workflow tree name the same agent the same way.
    expect(options.description).toBe("review:bugs");
  });

  it("passes isolation and the run's abort signal down to the spawn", async () => {
    const stub = stubManager();
    const controller = new AbortController();
    const host = createWorkflowHost({
      pi: {} as any,
      ctx: ctx(),
      manager: stub.manager,
      signal: controller.signal,
      rootSessionId: "root-1",
    });

    await host.spawnAgent(request({ isolation: "worktree" }));

    const options = stub.spawnAndWait.mock.calls[0][4];
    expect(options.isolation).toBe("worktree");
    expect(options.signal).toBe(controller.signal);
    expect(options.rootSessionId).toBe("root-1");
  });

  it("routes an unknown agent type through the same dispatch the Agent tool uses", async () => {
    // Not a second resolution path: `resolveSpawnType` owns the fallback policy,
    // so an unknown type falls back here exactly as it does for a tool call…
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const fellBack = await host.spawnAgent(request({ agentType: "no-such-agent" }));
    expect(fellBack.ok).toBe(true);
    expect(stub.spawnAndWait.mock.calls[0][2]).toBe("general-purpose");

    // …and fails closed here too when the project configured strict dispatch.
    setFallbackSubagent(NO_FALLBACK);
    try {
      const strict = stubManager();
      const strictHost = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: strict.manager });
      const rejected = await strictHost.spawnAgent(request({ agentType: "no-such-agent" }));
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toMatch(/no-such-agent/);
      expect(strict.spawnAndWait).not.toHaveBeenCalled();
    } finally {
      setFallbackSubagent(undefined);
    }
  });

  it("rejects a model the script named and cannot be resolved", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ model: "not-a-model" }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Model not found/);
    expect(stub.spawnAndWait).not.toHaveBeenCalled();
  });

  it("resolves a model the script named through the session's registry", async () => {
    const stub = stubManager();
    const model = { id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic" };
    const host = createWorkflowHost({
      pi: {} as any,
      ctx: ctx({
        modelRegistry: {
          find: vi.fn(() => model),
          getAvailable: vi.fn(() => [model]),
        },
      }),
      manager: stub.manager,
    });

    await host.spawnAgent(request({ model: "haiku" }));

    expect(stub.spawnAndWait.mock.calls[0][4].model).toBe(model);
  });

  it("surfaces a strict worktree-isolation failure as a failed agent, not a rejection", async () => {
    const stub = stubManager(() => {
      throw new Error('Cannot run with isolation: "worktree" — not a git repo');
    });
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    // `await` rather than `rejects`: a startup failure must land in the script
    // as a null, so the rest of a fan-out keeps going.
    const result = await host.spawnAgent(request({ isolation: "worktree" }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/isolation: "worktree"/);
  });

  it("maps an errored record onto an error, and a stopped one onto skipped", async () => {
    const failing = stubManager(() => record({ status: "error", error: "boom" }));
    const stopped = stubManager(() => record({ status: "stopped" }));

    const failed = await createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: failing.manager })
      .spawnAgent(request());
    const skipped = await createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stopped.manager })
      .spawnAgent(request());

    expect(failed).toMatchObject({ ok: false, error: "boom" });
    expect(failed.skipped).toBeUndefined();
    expect(skipped).toMatchObject({ ok: false, skipped: true });
  });
});

describe("createWorkflowHost — worktree cwd propagation", () => {
  let worktree: string;

  beforeEach(() => {
    registerAgents(new Map());
    worktree = mkdtempSync(join(tmpdir(), "wf-worktree-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("reports the directory the child ran in, so a gate verifies that tree", async () => {
    const stub = stubManager(() =>
      record({ worktree: { path: worktree, branch: "b", baseSha: "sha", workPath: worktree } }),
    );
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ isolation: "worktree" }));

    expect(result.cwd).toBe(worktree);
  });

  it("reports no cwd once the worktree has been torn down", async () => {
    // The manager commits the child's changes to a branch and REMOVES the copy
    // before spawnAndWait resolves. Handing that path to a gate would fail every
    // gated worktree agent with a spawn error instead of a test result.
    const gone = join(worktree, "already-removed");
    expect(existsSync(gone)).toBe(false);
    const stub = stubManager(() =>
      record({ worktree: { path: gone, branch: "b", baseSha: "sha", workPath: gone } }),
    );
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ isolation: "worktree" }));

    expect(result.cwd).toBeUndefined();
  });

  it("reports no cwd for a child that never had a worktree", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    expect((await host.spawnAgent(request())).cwd).toBeUndefined();
  });
});

describe("createWorkflowHost — abort, resume and gate", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  it("aborts the manager record the runtime's agent id stands for", async () => {
    const stub = stubManager(() => record({ id: "manager-id-7" }));
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ agentId: "wf-agent-3" }));
    host.abortAgent("wf-agent-3");

    expect(stub.abort).toHaveBeenCalledWith("manager-id-7");
  });

  it("does not abort anything for an agent that never started", () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    host.abortAgent("wf-agent-0");

    expect(stub.abort).not.toHaveBeenCalled();
  });

  it("resumes the same manager record, long after that agent settled", async () => {
    const stub = stubManager(() => record({ id: "manager-id-7" }));
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ agentId: "wf-agent-0" }));
    const resumed = await host.resumeAgent?.("wf-agent-0", "and now this");

    expect(stub.resume).toHaveBeenCalledWith("manager-id-7", "and now this", undefined);
    expect(resumed).toMatchObject({ ok: true, text: "resumed" });
  });

  it("refuses to resume an agent the run never spawned", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const resumed = await host.resumeAgent?.("wf-agent-9", "continue");

    expect(resumed?.ok).toBe(false);
    expect(stub.resume).not.toHaveBeenCalled();
  });

  it("asks the manager for a pre-cleanup hook only when the agent is gated", async () => {
    // The hook is how a gate reaches the child's worktree before it is deleted
    // (see workflow-gate-worktree.test.ts). An ungated agent must not acquire
    // one: nothing would run in it, and the manager's settle path is shared
    // with every other spawn.
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ isolation: "worktree" }));
    expect(stub.spawnAndWait.mock.calls[0][4].onBeforeWorktreeCleanup).toBeUndefined();

    await host.spawnAgent(request({ isolation: "worktree", gate: "npm test" }));
    expect(stub.spawnAndWait.mock.calls[1][4].onBeforeWorktreeCleanup).toBeInstanceOf(Function);
  });

  it("runs a gate through pi.exec in the child's own tree", async () => {
    const exec = vi.fn(async () => execResult({ stdout: "3 passing" }));
    const host = createWorkflowHost({
      pi: { exec } as any,
      ctx: ctx({ cwd: "/session" }),
      manager: stubManager().manager,
    });

    const gate = await host.runGate?.("npm test", { agentId: "wf-agent-0", cwd: "/worktree" });

    expect(gate).toEqual({ ok: true, output: "3 passing" });
    expect(exec.mock.calls[0][2]).toMatchObject({ cwd: "/worktree" });
  });

  it("falls back to the session's cwd when the child had no tree of its own", async () => {
    const exec = vi.fn(async () => execResult());
    const host = createWorkflowHost({
      pi: { exec } as any,
      ctx: ctx({ cwd: "/session" }),
      manager: stubManager().manager,
    });

    await host.runGate?.("npm test", { agentId: "wf-agent-0" });

    expect(exec.mock.calls[0][2]).toMatchObject({ cwd: "/session" });
  });

  it("fails a gate on a non-zero exit and surfaces its output", async () => {
    const exec = vi.fn(async () => execResult({ code: 1, stderr: "1 failing" }));
    const host = createWorkflowHost({ pi: { exec } as any, ctx: ctx(), manager: stubManager().manager });

    expect(await host.runGate?.("npm test", { agentId: "wf-agent-0" })).toEqual({ ok: false, output: "1 failing" });
  });

  it("fails a gate that was killed, which pi.exec reports with exit code 0", async () => {
    const exec = vi.fn(async () => execResult({ killed: true, code: 0 }));
    const host = createWorkflowHost({ pi: { exec } as any, ctx: ctx(), manager: stubManager().manager });

    const gate = await host.runGate?.("sleep 999", { agentId: "wf-agent-0" });

    expect(gate?.ok).toBe(false);
    expect(gate?.output).toMatch(/timed out/);
  });
});

/* ------------------------------------------------------------------------- *
 * Tool registration
 * ------------------------------------------------------------------------- */

describe("Workflow tool registration", () => {
  it("excludes itself from subagents, so a workflow cannot recurse into itself", () => {
    // The exclusion list is derived from this object; a Workflow tool missing
    // here is a Workflow tool every spawned child inherits.
    expect(Object.values(SUBAGENT_TOOL_NAMES)).toContain("Workflow");
    expect(SUBAGENT_TOOL_NAMES.WORKFLOW).toBe("Workflow");
  });
});

/* ------------------------------------------------------------------------- *
 * The tool's input contract
 * ------------------------------------------------------------------------- */

const inlineScript = 'export const meta = { name: "from-inline", description: "inline source" };\n';
const fileScript = 'export const meta = { name: "from-file", description: "file source" };\n';

/** Plain theme, so a rendered component can be asserted as text. */
const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

describe("Workflow tool — script vs scriptPath", () => {
  let hermetic: Hermetic;
  let booted: ReturnType<typeof makePi>;
  let tools: Map<string, any>;

  beforeEach(() => {
    // Hermetic dir first — settings and agent files are read at boot.
    hermetic = hermeticDir({ settings: { schedulingEnabled: false } });
    booted = makePi();
    subagentsExtension(booted.pi);
    tools = booted.tools;
  });

  afterEach(async () => {
    // Let any detached run settle before the temp dir disappears under it.
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  const workflowCtx = () => ctx({ cwd: hermetic.dir });

  it("runs the inline script when only `script` is given, and persists it", async () => {
    const result = await tools.get("Workflow").execute("tc-1", { script: inlineScript }, undefined, undefined, workflowCtx());

    const text = textOf(result);
    expect(text).toMatch(/Workflow "from-inline" started/);
    const scriptLine = text.split("\n").find((line: string) => line.startsWith("Script: "));
    expect(scriptLine, "the persisted script path is what makes iteration edit-then-rerun").toBeTruthy();
    expect(existsSync(scriptLine!.slice("Script: ".length))).toBe(true);
  });

  it("prefers scriptPath over script when both are given", async () => {
    const path = join(hermetic.dir, "wf.js");
    writeFileSync(path, fileScript);

    const result = await tools.get("Workflow").execute(
      "tc-2",
      { script: inlineScript, scriptPath: path },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/Workflow "from-file" started/);
    expect(textOf(result)).not.toMatch(/from-inline/);
  });

  it("resolves a relative scriptPath against the project directory", async () => {
    mkdirSync(join(hermetic.dir, "flows"), { recursive: true });
    writeFileSync(join(hermetic.dir, "flows", "wf.js"), fileScript);

    const result = await tools.get("Workflow").execute(
      "tc-3",
      { scriptPath: join("flows", "wf.js") },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/Workflow "from-file" started/);
  });

  it("reports a missing scriptPath instead of silently falling back to `script`", async () => {
    const result = await tools.get("Workflow").execute(
      "tc-4",
      { script: inlineScript, scriptPath: join(hermetic.dir, "nope.js") },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/Could not read workflow script/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("asks for one of the two when neither is given", async () => {
    const result = await tools.get("Workflow").execute("tc-5", {}, undefined, undefined, workflowCtx());

    expect(textOf(result)).toMatch(/Provide either `script`.*or `scriptPath`/s);
  });

  it("reports a bad `meta` up front rather than as a background run that failed", async () => {
    const result = await tools.get("Workflow").execute(
      "tc-6",
      { script: "const x = 1;\n" },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/must begin with .export const meta/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("names the workflow on the call line", () => {
    const line = tools.get("Workflow").renderCall({ script: inlineScript }, plainTheme, { isPartial: false }).text ?? "";
    expect(String(line)).toContain("Workflow");
    expect(String(line)).toContain("from-inline");
  });

  it("actually runs the script in the background and notifies through the agent channel", async () => {
    const script = `${inlineScript}log("scanned 3 files");\nreturn "done here";\n`;
    const result = await tools.get("Workflow").execute("tc-run", { script }, undefined, undefined, workflowCtx());
    const taskId = /Task ID: (\S+)/.exec(textOf(result))?.[1];
    expect(taskId).toBeTruthy();

    // The tool returned before the run finished — the completion has to arrive
    // on its own, through the same channel a background agent uses.
    await vi.waitFor(
      () =>
        expect(
          booted.pi.sendMessage.mock.calls.some((c: any[]) => String(c[0]?.content).includes(taskId!)),
        ).toBe(true),
      { timeout: 10_000 },
    );

    const sent = booted.pi.sendMessage.mock.calls.find((c: any[]) => String(c[0]?.content).includes(taskId!))!;
    expect(sent[0].customType).toBe("subagent-notification");
    expect(sent[1]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    expect(String(sent[0].content)).toContain("<result>done here</result>");

    // …and the inline card follows the background run rather than freezing at
    // whatever `execute` returned.
    const card = String(
      tools.get("Workflow")
        .renderResult(result, { expanded: false, isPartial: false }, plainTheme, { isError: false })
        .text ?? "",
    );
    expect(card).toContain("from-inline");
    expect(card).toContain("scanned 3 files");
    expect(card).toContain("done");
  });

  /** Wait for the completion notification a background run sends for `taskId`. */
  async function awaitNotification(taskId: string) {
    await vi.waitFor(
      () =>
        expect(
          booted.pi.sendMessage.mock.calls.some((c: any[]) => String(c[0]?.content).includes(taskId)),
        ).toBe(true),
      { timeout: 10_000 },
    );
    return booted.pi.sendMessage.mock.calls.find((c: any[]) => String(c[0]?.content).includes(taskId))!;
  }

  const startedTaskId = (result: unknown) => /Task ID: (\S+)/.exec(textOf(result))![1];

  it("kills a still-running workflow (and its worker thread) on session shutdown", async () => {
    // A never-returning script: only the run's own abort signal can stop it, so
    // abortAll() over the agent records would leave the worker spinning.
    const result = await tools.get("Workflow").execute(
      "tc-shutdown",
      { script: `${inlineScript}await new Promise(() => {});\n` },
      undefined, undefined, workflowCtx(),
    );

    await booted.lifecycle.get("session_shutdown")?.({}, workflowCtx());

    const sent = await awaitNotification(startedTaskId(result));
    expect(String(sent[0].content)).toContain("<status>Stopped</status>");
  });

  it("reports a script that threw, rather than a run that quietly ended", async () => {
    const result = await tools.get("Workflow").execute(
      "tc-throw",
      { script: `${inlineScript}throw new Error("script blew up");\n` },
      undefined, undefined, workflowCtx(),
    );

    const sent = await awaitNotification(startedTaskId(result));
    expect(String(sent[0].content)).toContain("<status>Error:");
    expect(sent[0].details).toMatchObject({ status: "error" });
    // The reason has to be the *result* too, not only the status line — that is
    // what the collapsed notification row shows.
    expect(String(sent[0].details.resultPreview)).toContain("script blew up");
  });

  it("reports a run that could not start at all", async () => {
    // A control character is rejected before the worker is created, so this
    // never reaches the run's own error path.
    const result = await tools.get("Workflow").execute(
      "tc-bad",
      { script: `${inlineScript}const x = "\u0007";\n` },
      undefined, undefined, workflowCtx(),
    );

    const sent = await awaitNotification(startedTaskId(result));
    expect(String(sent[0].content)).toContain("control characters");
    expect(sent[0].details).toMatchObject({ status: "error" });
  });
});

/* ------------------------------------------------------------------------- *
 * The CLI flag
 * ------------------------------------------------------------------------- */

describe("--subagents-workflow-file", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false } });
  });

  afterEach(async () => {
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  const uiCtx = (overrides: Record<string, unknown> = {}) =>
    ctx({
      hasUI: true,
      cwd: hermetic.dir,
      ui: {
        setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(),
        addAutocompleteProvider: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()),
      },
      ...overrides,
    });

  it("captures the UI at session_start, before any tool has executed", () => {
    // A flag-launched workflow runs from session_start, so a UI captured only
    // from tool_execution_start would leave it with no widget and no fleet row.
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = uiCtx();

    booted.lifecycle.get("session_start")?.({}, context);

    expect(context.ui.onTerminalInput, "the fleet list only hooks input once it has a UI").toHaveBeenCalled();
  });

  it("registers the flag at activation but does not read it there", () => {
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: "ignored-at-activation.js" });
    subagentsExtension(booted.pi);

    expect(booted.registeredFlags.get(WORKFLOW_FILE_FLAG)).toMatchObject({ type: "string" });
    // The host applies CLI values only AFTER every extension factory has run, so
    // reading here would see the registered default and never the real value.
    expect(booted.pi.getFlag).not.toHaveBeenCalled();
  });

  it("reads the flag from session_start", async () => {
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, fileScript);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);

    await booted.lifecycle.get("session_start")?.({}, uiCtx());

    expect(booted.pi.getFlag).toHaveBeenCalledWith(WORKFLOW_FILE_FLAG);
  });

  it("explains the `=` form when the flag arrives bare as boolean true", async () => {
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: true });
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);

    const notices = context.ui.notify.mock.calls.map((c: any[]) => String(c[0]));
    expect(notices.some((m: string) => m.includes(`--${WORKFLOW_FILE_FLAG}=<path>`))).toBe(true);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("does nothing at all when the flag was not passed", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);
    await flush();

    expect(context.ui.notify).not.toHaveBeenCalled();
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("reports a script it cannot read without starting a run", async () => {
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: join(hermetic.dir, "absent.js") });
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);
    await flush();

    expect(context.ui.notify.mock.calls.some((c: any[]) => /Could not read/.test(String(c[0])))).toBe(true);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("renders the finished run as a session entry and hands it to the model as next-turn context", async () => {
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, `${fileScript}log("scanned");\nreturn "all clear";\n`);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);

    await booted.lifecycle.get("session_start")?.({}, uiCtx());
    await vi.waitFor(
      () => expect(booted.pi.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything()),
      { timeout: 10_000 },
    );

    const [, data] = booted.pi.appendEntry.mock.calls.find((c: any[]) => c[0] === WORKFLOW_ENTRY_TYPE)!;
    expect(data).toMatchObject({ name: "from-file", status: "completed" });
    // The card is rebuilt from this log, so the entry has to carry it.
    expect(data.progress).toContainEqual({ type: "workflow_log", message: "scanned" });

    // nextTurn, not followUp: a flag-launched run puts its result in context
    // without forcing a turn the user never asked for.
    const sent = booted.pi.sendMessage.mock.calls.find((c: any[]) => c[0]?.customType === "workflow-result");
    expect(sent, "the run's outcome must reach the model").toBeTruthy();
    expect(sent![1]).toMatchObject({ deliverAs: "nextTurn" });
    expect(String(sent![0].content)).toContain("<result>all clear</result>");
  });

  it("renders the persisted entry through the shared workflow card layout", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const renderer = booted.entryRenderers.get(WORKFLOW_ENTRY_TYPE);
    expect(renderer, "a custom entry with no renderer is silently dropped by the host").toBeTruthy();

    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const rendered = renderer(
      {
        data: {
          name: "from-file",
          status: "completed",
          startTime: 0,
          endTime: 1000,
          agentCount: 1,
          totalTokens: 0,
          progress: [
            { type: "workflow_agent", index: 0, label: "step", state: "done", agentType: "Explore" },
          ],
        },
      },
      { expanded: false },
      theme,
    );

    const text = String(rendered.text ?? "");
    expect(text).toContain("from-file");
    expect(text).toContain("step");
    expect(text).toContain("1/1 agent");
  });
});
