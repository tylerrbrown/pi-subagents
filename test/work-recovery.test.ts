import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent-runner.js")>(),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));
vi.mock("../src/custom-agents.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/custom-agents.js")>(),
  loadCustomAgents: () => [],
}));
vi.mock("../src/settings.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/settings.js")>(),
  loadSettings: () => ({ schedulingEnabled: false, outputTranscript: false }),
  applyAndEmitLoaded: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { retainedWorkSnapshots, workLaunchKey } from "../src/work-lifecycle.js";
import { makePi, textOf } from "./helpers/boot-extension.js";
import { deferred, work, workAdapter, workContext } from "./helpers/work-adapter.js";

const predecessorId = "01234567-89ab-cde";
const predecessorAssignmentId = "01234567-89ab-4cde-8123-0123456789ab";
const predecessorLaunch = (childSessionId?: string) => ({
  launchKey: workLaunchKey("parent-session", "original-call"),
  parentSessionId: "parent-session",
  invocationId: "original-call",
  agentId: predecessorId,
  agentType: "general-purpose",
  description: "original assignment",
  cwd: process.cwd(),
  work,
  reservation: { reservationId: predecessorAssignmentId },
  childSessionId,
  bound: false,
});

function persistedRecord(childSessionId?: string, overrides: Record<string, unknown> = {}) {
  const launch = predecessorLaunch(childSessionId);
  return {
    customType: "subagents:record",
    data: {
      version: 1,
      id: predecessorId,
      handles: { handle: "general-purpose", alias: "original-assignment" },
      type: "general-purpose",
      description: "original assignment",
      status: "error",
      error: "Work bind adapter refused the request.",
      toolUses: 0,
      startedAt: 100,
      completedAt: 200,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
      compactionCount: 0,
      contextPercent: null,
      toolCallId: "original-call",
      work,
      workLaunch: launch,
      invocation: { modelId: "pi-sub-anthropic/claude-haiku-4-5", thinking: "low", runInBackground: true },
      isBackground: true,
      // Agent may create the transcript path before reserve/bind; the path is
      // not evidence that the child produced substantive output.
      output: { file: "/bounded/new-agent.output" },
      notificationPending: false,
      ...overrides,
    },
  };
}

function branch(record: ReturnType<typeof persistedRecord>) {
  return [
    { customType: "subagents:work-record", data: { version: 1, launch: record.data.workLaunch, status: "error" } },
    record,
  ];
}

async function boot(record: ReturnType<typeof persistedRecord>, retained: unknown[] = []) {
  const adapter = workAdapter();
  const host = makePi();
  Object.assign(host.pi, adapter.pi);
  subagentsExtension(host.pi);
  const ctx = workContext();
  ctx.modelRegistry.find = vi.fn((provider: string, id: string) => ({ provider, id, name: id }));
  ctx.modelRegistry.getAvailable = vi.fn(() => [{ provider: "pi-sub-anthropic", id: "claude-haiku-4-5", name: "Haiku" }]);
  ctx.sessionManager.getBranch = () => [...branch(record), ...retained];
  await host.lifecycle.get("session_start")?.({}, ctx);
  return { ...host, adapter, ctx };
}

const resumeParams = {
  subagent_type: "general-purpose",
  description: "continue assignment",
  prompt: "retry the assignment",
  resume: predecessorId,
  run_in_background: true,
};

const harnesses: Array<Awaited<ReturnType<typeof boot>>> = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.lifecycle.get("session_shutdown")?.({}, harness.ctx);
  }
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")];
  vi.restoreAllMocks();
});

describe("Work assignment recovery through Agent resume", () => {
  it.each([
    [undefined, "prebind-recovery"],
    ["allocated-child", "bound-reactivation"],
  ] as const)("starts one fresh successor for %s mode", async (childSessionId, mode) => {
    const record = persistedRecord(childSessionId);
    const harness = await boot(record); harnesses.push(harness);
    const done = deferred<any>();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      expect(options?.resumeSessionFile).toBeUndefined();
      expect(options?.model).toMatchObject({ provider: "pi-sub-anthropic", id: "claude-haiku-4-5" });
      expect(options?.thinkingLevel).toBe("low");
      await options!.onSessionCreated?.({
        sessionManager: { getSessionId: () => "fresh-child-session" },
        dispose: vi.fn(), steer: vi.fn(async () => {}),
      } as any);
      return done.promise;
    });

    const first = await harness.tools.get("Agent").execute("recovery-call", resumeParams, undefined, undefined, harness.ctx);
    const successorId = /Agent ID: (\S+)/.exec(textOf(first))?.[1];
    expect(successorId).toBeTruthy();
    expect(successorId).not.toBe(predecessorId);
    expect(harness.adapter.requests.reserve).toHaveLength(1);
    expect(harness.adapter.requests.reserve[0]).toMatchObject({
      agentId: successorId,
      agentType: "general-purpose",
      description: "original assignment",
      cwd: process.cwd(),
      work,
      recovery: {
        mode,
        predecessorAssignmentId,
        predecessorLaunchKey: record.data.workLaunch.launchKey,
        proof: {
          status: "error",
          bound: false,
          reservationId: predecessorAssignmentId,
          toolUses: 0,
          usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
          resultPresent: false,
          substantiveOutputPresent: false,
          ...(childSessionId ? { childSessionId } : {}),
        },
      },
    });

    const repeated = await harness.tools.get("Agent").execute("recovery-call-2", resumeParams, undefined, undefined, harness.ctx);
    expect(textOf(repeated)).toContain(successorId!);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(harness.adapter.requests.reserve).toHaveLength(1);

    done.resolve({ session: { dispose: vi.fn() }, responseText: "recovered", aborted: false, steered: false });
  });

  it("fences parallel foreground recovery before asynchronous reserve", async () => {
    const record = persistedRecord();
    const harness = await boot(record); harnesses.push(harness);
    const done = deferred<any>();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options!.onSessionCreated?.({
        sessionManager: { getSessionId: () => "fresh-child-session" },
        dispose: vi.fn(), steer: vi.fn(async () => {}),
      } as any);
      return done.promise;
    });
    const foreground = { ...resumeParams, run_in_background: false };
    const first = harness.tools.get("Agent").execute("foreground-1", foreground, undefined, undefined, harness.ctx);
    await vi.waitFor(() => expect(harness.adapter.requests.reserve).toHaveLength(1));
    const second = await harness.tools.get("Agent").execute("foreground-2", foreground, undefined, undefined, harness.ctx);
    expect(textOf(second)).toContain("Work recovery already started");
    expect(runAgent).toHaveBeenCalledOnce();
    expect(harness.adapter.requests.reserve).toHaveLength(1);
    done.resolve({ session: { dispose: vi.fn() }, responseText: "recovered", aborted: false, steered: false });
    expect(textOf(await first)).toContain("recovered");
  });

  it("accepts an exact retained handle but not a partial handle", async () => {
    const record = persistedRecord();
    const harness = await boot(record); harnesses.push(harness);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options!.onSessionCreated?.({ sessionManager: { getSessionId: () => "fresh-child" }, dispose: vi.fn() } as any);
      return { session: { dispose: vi.fn() }, responseText: "done", aborted: false, steered: false } as any;
    });
    const partial = await harness.tools.get("Agent").execute("partial", { ...resumeParams, resume: "original" }, undefined, undefined, harness.ctx);
    expect(textOf(partial)).toContain("Agent not found");
    const exact = await harness.tools.get("Agent").execute("exact", { ...resumeParams, resume: "@original-assignment" }, undefined, undefined, harness.ctx);
    expect(textOf(exact)).toMatch(/Agent ID: (?!01234567-89ab-cde)/);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it.each([
    ["bound", { workLaunch: { ...predecessorLaunch(), bound: true } }],
    ["non-error", { status: "completed" }],
    ["tool use", { toolUses: 1 }],
    ["usage", { lifetimeUsage: { input: 1, output: 0, cacheWrite: 0 } }],
    ["result", { result: "partial" }],
    ["substantive output", { conversation: "a prior turn" }],
    ["old child session", { output: { sessionFile: "/sessions/old.jsonl" } }],
    ["missing reservation", { workLaunch: { ...predecessorLaunch(), reservation: undefined } }],
    ["malformed reservation identity", { workLaunch: {
      ...predecessorLaunch(), reservation: { reservationId: "reservation-04" },
    } }],
    ["indeterminate bound", { workLaunch: { ...predecessorLaunch(), bound: undefined } }],
    ["indeterminate version", { version: 0 }],
  ])("refuses %s persisted records without starting a child", async (_label, overrides) => {
    const record = persistedRecord(undefined, overrides);
    // Keep the work receipt consistent when this case changes the persisted launch.
    const harness = await boot(record); harnesses.push(harness);
    const result = await harness.tools.get("Agent").execute("recovery-call", resumeParams, undefined, undefined, harness.ctx);
    expect(textOf(result)).toContain("Agent not found");
    expect(runAgent).not.toHaveBeenCalled();
    expect(harness.adapter.requests.reserve).toHaveLength(0);
  });

  it("does not reclaim a predecessor handle already held by a live agent", async () => {
    const record = persistedRecord();
    const harness = await boot(record); harnesses.push(harness);
    let call = 0;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      call++;
      await options!.onSessionCreated?.({
        sessionManager: { getSessionId: () => `child-${call}` },
        dispose: vi.fn(), steer: vi.fn(async () => {}),
      } as any);
      if (call === 1) return new Promise(() => {});
      return { session: { dispose: vi.fn() }, responseText: "done", aborted: false, steered: false } as any;
    });
    const live = await harness.tools.get("Agent").execute("live", {
      prompt: "hold", description: "live holder", subagent_type: "general-purpose", run_in_background: true,
    }, undefined, undefined, harness.ctx);
    const liveId = /Agent ID: (\S+)/.exec(textOf(live))![1];
    const recovered = await harness.tools.get("Agent").execute("recover", resumeParams, undefined, undefined, harness.ctx);
    const successorId = /Agent ID: (\S+)/.exec(textOf(recovered))![1];
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(manager.getRecord(liveId).handle).toBe("general-purpose");
    expect(manager.getRecord(successorId).handle).not.toBe("general-purpose");
  });

  it("refuses an ambiguous persisted handle while exact Agent ID remains recoverable", async () => {
    const record = persistedRecord();
    const otherId = "abcdef01-2345-678";
    const otherAssignment = "fedcba98-7654-4321-8123-fedcba987654";
    const other = persistedRecord(undefined, {
      id: otherId,
      workLaunch: {
        ...predecessorLaunch(), agentId: otherId,
        reservation: { reservationId: otherAssignment },
      },
    });
    const harness = await boot(record, [other]); harnesses.push(harness);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options!.onSessionCreated?.({ sessionManager: { getSessionId: () => "fresh-child" }, dispose: vi.fn() } as any);
      return { session: { dispose: vi.fn() }, responseText: "done", aborted: false, steered: false } as any;
    });
    const ambiguous = await harness.tools.get("Agent").execute(
      "ambiguous", { ...resumeParams, resume: "@original-assignment" }, undefined, undefined, harness.ctx,
    );
    expect(textOf(ambiguous)).toContain("Agent not found");
    expect(runAgent).not.toHaveBeenCalled();
    const exact = await harness.tools.get("Agent").execute(
      "exact", { ...resumeParams, resume: predecessorId }, undefined, undefined, harness.ctx,
    );
    expect(textOf(exact)).toContain("Agent ID:");
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("keeps ordinary persisted no-session records on the Agent-not-found path", async () => {
    const record = persistedRecord(undefined, { work: undefined, workLaunch: undefined });
    const harness = await boot(record); harnesses.push(harness);
    const result = await harness.tools.get("Agent").execute("ordinary-resume", resumeParams, undefined, undefined, harness.ctx);
    expect(textOf(result)).toContain("Agent not found");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("does not allocate a second successor when retained Work replay already records one", async () => {
    const record = persistedRecord();
    const recovery = {
      mode: "prebind-recovery" as const,
      predecessorAssignmentId,
      predecessorLaunchKey: predecessorLaunch().launchKey,
      proof: {
        status: "error" as const, bound: false as const, reservationId: predecessorAssignmentId,
        toolUses: 0 as const,
        usage: { input: 0 as const, output: 0 as const, cacheWrite: 0 as const, cacheRead: 0 as const, cost: 0 as const },
        resultPresent: false as const, substantiveOutputPresent: false as const,
      },
    };
    const successorId = "fedcba98-7654-321";
    const successor = {
      ...predecessorLaunch(),
      launchKey: workLaunchKey("parent-session", "successor-call"),
      invocationId: "successor-call",
      agentId: successorId,
      recovery,
    };
    const harness = await boot(record, [{
      customType: "subagents:work-record",
      data: { version: 1, launch: successor, status: "running" },
    }]);
    harnesses.push(harness);

    const result = await harness.tools.get("Agent").execute("recovery-call", resumeParams, undefined, undefined, harness.ctx);
    expect(textOf(result)).toContain(successorId);
    expect(runAgent).not.toHaveBeenCalled();
    expect(harness.adapter.requests.reserve).toHaveLength(0);
  });

  it("retains the typed recovery descriptor through Work snapshot replay", () => {
    const recovery = {
      mode: "prebind-recovery" as const,
      predecessorAssignmentId,
      predecessorLaunchKey: predecessorLaunch().launchKey,
      proof: {
        status: "error" as const,
        bound: false as const,
        reservationId: predecessorAssignmentId,
        toolUses: 0 as const,
        usage: { input: 0 as const, output: 0 as const, cacheWrite: 0 as const, cacheRead: 0 as const, cost: 0 as const },
        resultPresent: false as const,
        substantiveOutputPresent: false as const,
      },
    };
    const launch = {
      ...predecessorLaunch(),
      launchKey: workLaunchKey("parent-session", "successor-call"),
      invocationId: "successor-call",
      agentId: "fedcba98-7654-321",
      recovery,
    };
    const [snapshot] = retainedWorkSnapshots([{ customType: "subagents:work-record", data: { version: 1, launch, status: "running" } }]);
    expect(snapshot.launch.recovery).toEqual(recovery);
  });
});
