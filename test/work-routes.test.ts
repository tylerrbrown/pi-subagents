import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScheduleStore } from "../src/schedule-store.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
vi.mock("../src/agent-runner.js", async importOriginal => ({ ...await importOriginal<any>(), runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", async importOriginal => ({ ...await importOriginal<any>(), createWorktree: vi.fn(), cleanupWorktree: vi.fn(), pruneWorktrees: vi.fn() }));
vi.mock("../src/custom-agents.js", async importOriginal => ({ ...await importOriginal<any>(), loadCustomAgents: () => [] }));
vi.mock("../src/settings.js", async importOriginal => ({ ...await importOriginal<any>(), loadSettings: () => ({}), applyAndEmitLoaded: vi.fn() }));
vi.mock("../src/output-file.js", async importOriginal => ({ ...await importOriginal<any>(), getOutputTranscriptDefault: () => false, createOutputFilePath: vi.fn(() => "mock.output"), writeInitialEntry: vi.fn(), ensureOutputFile: vi.fn(), streamToOutputFile: vi.fn(() => vi.fn()) }));
import { runAgent, resumeAgent } from "../src/agent-runner.js";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { registerRpcHandlers } from "../src/cross-extension-rpc.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { SubagentScheduler } from "../src/schedule.js";
import { makePi } from "./helpers/boot-extension.js";
import { childSession, work, workAdapter, workContext } from "./helpers/work-adapter.js";

let adapter: ReturnType<typeof workAdapter>;
let manager: AgentManager;
let scheduler: SubagentScheduler;
let shutdown: (() => Promise<void>) | undefined;
const params = { subagent_type: "general-purpose", description: "test", prompt: "private prompt", work };
beforeEach(() => {
  vi.clearAllMocks(); registerAgents([]);
  adapter = workAdapter(); manager = new AgentManager(); scheduler = new SubagentScheduler();
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    const session = childSession();
    await options!.onSessionCreated?.(session);
    return { session, responseText: "done", aborted: false, steered: false };
  });
});
afterEach(async () => { scheduler.stop(); await shutdown?.(); shutdown = undefined; await manager.dispose(); vi.useRealTimers(); });
function boot() {
  const { pi, tools, lifecycle } = makePi();
  Object.assign(pi, adapter.pi);
  subagentsExtension(pi);
  shutdown = async () => { await lifecycle.get("session_shutdown")?.({}, workContext()); };
  return tools.get("Agent");
}
async function assertBoundary(start: () => Promise<any>) {
  adapter.held.add("reserve"); adapter.held.add("bind");
  const pending = start();
  await vi.waitFor(() => expect(adapter.requests.reserve).toHaveLength(1));
  expect(runAgent).not.toHaveBeenCalled();
  adapter.reply("reserve", adapter.requests.reserve[0]);
  await vi.waitFor(() => expect(adapter.requests.bind).toHaveLength(1));
  expect(adapter.requests.bind[0]).toMatchObject({ work, childSessionId: "actual-child-session" });
  let returned = false;
  void pending.then(() => { returned = true; });
  await Promise.resolve();
  expect(returned).toBe(false);
  adapter.reply("bind", adapter.requests.bind[0]);
  const result = await pending;
  await vi.waitFor(() => expect(adapter.requests.finalize).toHaveLength(1));
  expect(runAgent).toHaveBeenCalledOnce();
  return result;
}
describe("Work binding through consumer routes", () => {
  it.each([false, true])("Agent run_in_background=%s shares reserve/bind boundary and exact cwd", async background => {
    const agent = boot();
    const cwd = `${process.cwd()}/.`;
    await assertBoundary(() => agent.execute("tool-call", { ...params, cwd, run_in_background: background }, undefined, undefined, workContext()));
    expect(adapter.requests.reserve[0]).toMatchObject({ invocationId: "tool-call", cwd, work });
    expect(vi.mocked(runAgent).mock.calls[0][3]!.cwd).toBe(cwd);
  });
  it.each([false, true])("bound terminal event failure=%s excludes private result and error prose", async failed => {
    const agent = boot();
    const events: any[] = [];
    adapter.events.on(failed ? "subagents:failed" : "subagents:completed", event => events.push(event));
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      const session = childSession();
      await options!.onSessionCreated?.(session);
      return { session, responseText: "SYNTHETIC_PRIVATE_RESULT", aborted: false, steered: false,
        ...(failed ? { failure: "SYNTHETIC_PRIVATE_ERROR" } : {}) };
    });
    await agent.execute("private-event", { ...params, run_in_background: true }, undefined, undefined, workContext());
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ id: adapter.requests.reserve[0].agentId, status: failed ? "error" : "completed" });
    expect(JSON.stringify(events[0])).not.toContain("SYNTHETIC_PRIVATE");
    expect(events[0].result).toBeUndefined();
    expect(events[0].error).toBeUndefined();
  });
  it("unbound completion keeps its result event and foreground result unchanged", async () => {
    const agent = boot();
    const events: any[] = [];
    adapter.events.on("subagents:completed", event => events.push(event));
    const unbound = { ...params, work: undefined };
    await agent.execute("normal-event", { ...unbound, run_in_background: true }, undefined, undefined, workContext());
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ result: "done", status: "completed" });
    const result = await agent.execute("normal-result", { ...unbound, run_in_background: false }, undefined, undefined, workContext());
    expect(result.content.some((part: any) => part.text?.includes("done"))).toBe(true);
    expect(adapter.requests.reserve).toHaveLength(0);
  });
  it("Agent work schema is strict and rejects isolation conflict before launch", async () => {
    const agent = boot();
    const schema = agent.parameters.properties.work;
    expect(Value.Check(schema, work)).toBe(true);
    for (const malformed of [{ ...work, extra: true }, { ...work, scopes: [] }, { ...work, scopes: ["x", "x"] }, { ...work, actor: "" }]) {
      expect(Value.Check(schema, malformed)).toBe(false);
      await expect(agent.execute("invalid", { ...params, work: malformed }, undefined, undefined, workContext())).rejects.toThrow();
    }
    await expect(agent.execute("conflict", { ...params, isolation: "worktree" }, undefined, undefined, workContext())).rejects.toThrow(/cannot be combined/);
    expect(runAgent).not.toHaveBeenCalled();
  });
  it("RPC waits for authorization and uses request identity", async () => {
    registerRpcHandlers({ events: adapter.events, pi: adapter.pi, getCtx: workContext, manager });
    const result = await assertBoundary(() => new Promise(resolve => {
      adapter.events.on("subagents:rpc:spawn:reply:rpc-call", resolve);
      adapter.events.emit("subagents:rpc:spawn", { requestId: "rpc-call", type: "general-purpose", prompt: "private", options: { description: "test", work, cwd: process.cwd() } });
    }));
    expect(result.success).toBe(true);
    expect(adapter.requests.reserve[0].invocationId).toBe("rpc-call");
  });
  it.each([
    { work: { ...work, extra: true } }, { work: { ...work, scopes: [] } },
    { work: { ...work, actor: "\n" } }, { work, isolation: "worktree" },
  ])("RPC rejects invalid binding/conflict %# without a child", async options => {
    registerRpcHandlers({ events: adapter.events, pi: adapter.pi, getCtx: workContext, manager });
    const reply = new Promise<any>(resolve => adapter.events.on("subagents:rpc:spawn:reply:invalid", resolve));
    adapter.events.emit("subagents:rpc:spawn", { requestId: "invalid", type: "general-purpose", prompt: "private", options: { description: "test", ...options } });
    expect((await reply).success).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
    expect(adapter.requests.reserve).toHaveLength(0);
  });
  it.each([false, true])("nested background=%s shares the boundary", async background => {
    const [agent] = createNestedSubagentTools({ manager, pi: adapter.pi, parentAgentId: "owner", depth: 1, maxSubagentDepth: 3, allowedSubagents: "all", configCwd: process.cwd() });
    await assertBoundary(() => agent.execute("nested-call", { ...params, run_in_background: background, cwd: process.cwd() }, undefined, undefined, workContext()));
    expect(adapter.requests.reserve[0].invocationId).toBe("nested-call");
  });
  it("Agent resume carries binding through reserve/bind on the original child", async () => {
    const agent = boot();
    await agent.execute("first-call", { ...params, run_in_background: false }, undefined, undefined, workContext());
    const id = adapter.requests.reserve[0].agentId;
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" } as any);
    adapter.held.add("reserve"); adapter.held.add("bind");
    const pending = agent.execute("resume-call", { ...params, resume: id, run_in_background: false }, undefined, undefined, workContext());
    await vi.waitFor(() => expect(adapter.requests.reserve).toHaveLength(2));
    expect(resumeAgent).not.toHaveBeenCalled();
    adapter.reply("reserve", adapter.requests.reserve[1]);
    await vi.waitFor(() => expect(adapter.requests.bind).toHaveLength(2));
    expect(resumeAgent).not.toHaveBeenCalled();
    adapter.reply("bind", adapter.requests.bind[1]); await pending;
    expect(runAgent).toHaveBeenCalledOnce(); expect(resumeAgent).toHaveBeenCalledOnce();
    expect(adapter.requests.finalize).toHaveLength(2);
  });
  it("recurring occurrence is durable before dispatch and restart reconciles without replay or rejection", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(process.cwd(), "test", ".schedule-restart-"));
    const path = join(directory, "schedule.json");
    try {
      const store = new ScheduleStore(path);
      scheduler.start(adapter.pi, workContext(), manager, store);
      adapter.held.add("reserve");
      const job = scheduler.addJob({ ...params, name: "restart", schedule: "1s" });
      const durableAtDispatch: any[] = [];
      adapter.events.on("subagents:work:reserve", () => {
        durableAtDispatch.push(new ScheduleStore(path).get(job.id));
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(adapter.requests.reserve).toHaveLength(1);
      expect(durableAtDispatch[0]).toMatchObject({ occurrenceCount: 1, lastStatus: "running", runCount: 0 });
      const first = adapter.requests.reserve[0];
      const retained = structuredClone(adapter.entries);
      const crashTimeStore = readFileSync(path);
      expect(retained.at(-1).data).toMatchObject({ status: "running", launch: { launchKey: first.launchKey } });
      scheduler.stop();
      // Settle the old test process after capturing its crash-time journal.
      manager.abort(first.agentId);
      adapter.reply("reserve", first);
      await vi.advanceTimersByTimeAsync(0);
      await manager.dispose();
      // Restore the crash-time disk image: orderly test cleanup is not part of
      // the simulated process crash and must not finalize its schedule state.
      writeFileSync(path, crashTimeStore);
      expect(new ScheduleStore(path).get(job.id)).toMatchObject({ lastStatus: "running", runCount: 0, occurrenceCount: 1 });
      manager = new AgentManager();
      await manager.reconcileWork(adapter.pi, retained);
      expect(adapter.requests.reconcile).toHaveLength(1);
      expect(adapter.requests.reconcile[0]).toMatchObject({ status: "running", launch: { launchKey: first.launchKey } });
      expect(runAgent).not.toHaveBeenCalled();

      scheduler = new SubagentScheduler();
      scheduler.start(adapter.pi, workContext(), manager, new ScheduleStore(path));
      adapter.held.delete("reserve");
      await vi.advanceTimersByTimeAsync(2000);
      expect(adapter.requests.reserve).toHaveLength(3);
      expect(adapter.requests.reserve.map(request => request.invocationId)).toEqual([
        `schedule:${job.id}:1`, `schedule:${job.id}:2`, `schedule:${job.id}:3`,
      ]);
      expect(new Set(adapter.requests.reserve.map(request => request.launchKey)).size).toBe(3);
      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(new ScheduleStore(path).get(job.id)).toMatchObject({ occurrenceCount: 3, lastStatus: "success" });
    } finally {
      scheduler.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("synchronous scheduled dispatch failure consumes its identity without wedging later ticks", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(process.cwd(), "test", ".schedule-failure-"));
    const path = join(directory, "schedule.json");
    const dispatch = vi.spyOn(manager, "spawn");
    try {
      scheduler.start(adapter.pi, workContext(), manager, new ScheduleStore(path));
      const job = scheduler.addJob({ ...params, name: "retry", schedule: "1s" });
      let durable: any;
      dispatch.mockImplementationOnce(() => {
        durable = new ScheduleStore(path).get(job.id);
        throw new Error("synthetic dispatch failure");
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(durable).toMatchObject({ occurrenceCount: 1, lastStatus: "running" });
      expect(new ScheduleStore(path).get(job.id)?.lastStatus).toBe("error");
      await vi.advanceTimersByTimeAsync(2000);
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(dispatch.mock.calls.map(call => call[4]!.invocationId)).toEqual([
        `schedule:${job.id}:1`, `schedule:${job.id}:2`, `schedule:${job.id}:3`,
      ]);
      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(new ScheduleStore(path).get(job.id)).toMatchObject({ occurrenceCount: 3, lastStatus: "success" });
    } finally {
      dispatch.mockRestore();
      scheduler.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("scheduled fire shares reserve/bind and forwards cwd/work without duplicate children", async () => {
    vi.useFakeTimers();
    const jobs = new Map<string, any>();
    const store = { list: () => [...jobs.values()], hasName: () => false,
      add: (job: any) => jobs.set(job.id, job), get: (id: string) => jobs.get(id),
      update: (id: string, patch: any) => { const job = { ...jobs.get(id), ...patch }; jobs.set(id, job); return job; },
    } as any;
    scheduler.start(adapter.pi, workContext(), manager, store);
    adapter.held.add("reserve"); adapter.held.add("bind");
    const cwd = `${process.cwd()}/.`;
    const job = scheduler.addJob({ ...params, name: "scheduled", schedule: "+1s", cwd });
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.requests.reserve).toHaveLength(1); expect(runAgent).not.toHaveBeenCalled();
    expect(adapter.requests.reserve[0]).toMatchObject({ work, cwd, invocationId: `schedule:${job.id}:1` });
    adapter.reply("reserve", adapter.requests.reserve[0]); await vi.advanceTimersByTimeAsync(0);
    expect(adapter.requests.bind).toHaveLength(1);
    expect(adapter.requests.finalize).toHaveLength(0);
    adapter.reply("bind", adapter.requests.bind[0]); await vi.advanceTimersByTimeAsync(0);
    expect(adapter.requests.finalize).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(runAgent).toHaveBeenCalledOnce();
  });
});
