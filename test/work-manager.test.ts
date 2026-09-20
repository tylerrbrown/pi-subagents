import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({ createWorktree: vi.fn(), cleanupWorktree: vi.fn(), pruneWorktrees: vi.fn(), isWorktreeIsolationEnabled: () => true }));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { childSession, deferred, withSyntheticEnvironment, work, workAdapter, workContext } from "./helpers/work-adapter.js";

let manager: AgentManager;
let adapter: ReturnType<typeof workAdapter>;
let session: any;
let prompt: ReturnType<typeof vi.fn>;
const options = (extra = {}) => ({ description: "test", invocationId: "call-04", work, ...extra });
function spawn(extra = {}) { return manager.spawn(adapter.pi, workContext(), "general-purpose", "SYNTHETIC_PRIVATE_PROMPT", options(extra)); }
async function settle(id: string) { await manager.awaitStartup(id); await manager.getRecord(id)!.promise; }
beforeEach(() => {
  vi.clearAllMocks();
  manager = new AgentManager(undefined, 1);
  adapter = workAdapter();
  session = childSession();
  prompt = vi.fn();
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _input, opts) => {
    await opts!.onSessionCreated?.(session);
    prompt();
    return { session, responseText: "SYNTHETIC_PRIVATE_RESULT", aborted: false, steered: false };
  });
});
afterEach(async () => { await manager.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("Work manager launch boundary", () => {
  it("awaits reserve before child creation and bind before prompt with actual child identity", async () => {
    adapter.held.add("reserve"); adapter.held.add("bind");
    const id = spawn();
    const startup = manager.awaitStartup(id);
    expect(adapter.requests.reserve).toHaveLength(1);
    expect(runAgent).not.toHaveBeenCalled();
    adapter.reply("reserve", adapter.requests.reserve[0]);
    await vi.waitFor(() => expect(adapter.requests.bind).toHaveLength(1));
    expect(adapter.requests.bind[0]).toMatchObject({ childSessionId: "actual-child-session", reservation: { reservationId: "reservation-04" } });
    expect(prompt).not.toHaveBeenCalled();
    adapter.reply("bind", adapter.requests.bind[0]);
    await startup; await manager.getRecord(id)!.promise;
    expect(prompt).toHaveBeenCalledOnce();
    expect(adapter.requests.finalize).toHaveLength(1);
  });
  it.each(["reserve", "bind"])("refused %s prevents prompt and finalizes once", async action => {
    adapter.refused.add(action);
    const id = spawn();
    await expect(manager.awaitStartup(id)).rejects.toThrow("refused");
    expect(prompt).not.toHaveBeenCalled();
    if (action === "reserve") expect(runAgent).not.toHaveBeenCalled();
    expect(adapter.requests.finalize).toHaveLength(1);
    expect(JSON.stringify(adapter.requests.finalize)).not.toContain("SYNTHETIC_PRIVATE_ADAPTER_ERROR");
  });
  it("missing reserve adapter prevents child creation", async () => {
    vi.useFakeTimers(); adapter.held.add("reserve");
    const id = spawn();
    const failure = expect(manager.awaitStartup(id)).rejects.toThrow("did not reply");
    await vi.advanceTimersByTimeAsync(5000); await failure;
    expect(runAgent).not.toHaveBeenCalled();
    expect(adapter.requests.finalize).toHaveLength(1);
  });
  it.each([
    ["completed", {}], ["error", { failure: "synthetic failure" }],
    ["timeout", { timedOut: true }], ["aborted", { aborted: true }],
  ])("finalizes %s exactly once", async (status, result) => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _input, opts) => {
      await opts!.onSessionCreated?.(session);
      return { session, responseText: "done", aborted: false, steered: false, ...result };
    });
    const id = spawn(); await settle(id);
    manager.abort(id); await manager.dispose();
    expect(adapter.requests.finalize).toHaveLength(1);
    expect(adapter.requests.finalize[0].status).toBe(status);
  });
  it("abort while reserve is pending never starts a child or duplicates finalize", async () => {
    adapter.held.add("reserve");
    const id = spawn();
    const failure = expect(manager.awaitStartup(id)).rejects.toThrow(/cancelled/);
    manager.abort(id); manager.abort(id);
    adapter.reply("reserve", adapter.requests.reserve[0]);
    await failure;
    expect(runAgent).not.toHaveBeenCalled();
    expect(adapter.requests.finalize).toHaveLength(1);
  });
  it("abort while bind is pending prevents prompt and finalizes exactly once", async () => {
    adapter.held.add("bind");
    const id = spawn();
    const failure = expect(manager.awaitStartup(id)).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(adapter.requests.bind).toHaveLength(1));
    manager.abort(id);
    adapter.reply("bind", adapter.requests.bind[0]);
    await failure;
    expect(prompt).not.toHaveBeenCalled();
    expect(adapter.requests.finalize).toHaveLength(1);
  });
  it("active abort and a late rejected child still finalize only once", async () => {
    const done = deferred<any>();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _input, opts) => {
      await opts!.onSessionCreated?.(session);
      return done.promise;
    });
    const id = spawn(); await manager.awaitStartup(id);
    manager.abort(id); manager.abort(id);
    done.reject(new Error("late child failure"));
    await manager.getRecord(id)!.promise;
    expect(adapter.requests.finalize).toHaveLength(1);
    expect(adapter.requests.finalize[0].status).toBe("stopped");
  });
  it("queued cancellation never reserves or creates the cancelled child", async () => {
    const done = deferred<any>();
    vi.mocked(runAgent).mockImplementation(() => done.promise);
    const first = manager.spawn(adapter.pi, workContext(), "general-purpose", "blocker", { description: "blocker", isBackground: true });
    const controller = new AbortController();
    const id = spawn({ isBackground: true, signal: controller.signal });
    expect(manager.getRecord(id)!.status).toBe("queued");
    controller.abort(); manager.abort(id);
    done.resolve({ session, responseText: "done", aborted: false, steered: false });
    await manager.getRecord(first)!.promise;
    expect(runAgent).toHaveBeenCalledOnce();
    expect(adapter.requests.reserve).toHaveLength(0);
    expect(adapter.requests.finalize).toHaveLength(1);
    expect(adapter.requests.finalize[0].launch.agentId).toBe(id);
  });
  it("restart reconcile deduplicates retained receipts without spawning or finalizing again", async () => {
    const id = spawn(); await settle(id); await manager.dispose();
    manager = new AgentManager();
    const before = adapter.requests.finalize.length;
    await manager.reconcileWork(adapter.pi, adapter.entries);
    await manager.reconcileWork(adapter.pi, adapter.entries);
    expect(adapter.requests.reconcile).toHaveLength(2);
    expect(adapter.requests.reconcile[0].launch.launchKey).toBe(adapter.requests.reconcile[1].launch.launchKey);
    expect(() => spawn()).toThrow(/already launched/);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(adapter.requests.finalize).toHaveLength(before);
  });
  it("persists binding identities without prompt or private result", async () => {
    const id = spawn(); await settle(id);
    expect(adapter.entries.at(-1).data.launch).toMatchObject({ work, childSessionId: "actual-child-session" });
    expect(JSON.stringify(adapter.entries)).not.toContain("SYNTHETIC_PRIVATE");
  });
  it("forwards exact cwd without changing process cwd or environment", async () => {
    const original = process.cwd();
    const chdir = vi.spyOn(process, "chdir");
    await withSyntheticEnvironment(async writes => {
      const cwd = `${original}/.`;
      const id = spawn({ cwd }); await settle(id);
      expect(vi.mocked(runAgent).mock.calls[0][3]!.cwd).toBe(cwd);
      expect(adapter.requests.reserve[0].cwd).toBe(cwd);
      expect(adapter.requests.bind[0].cwd).toBe(cwd);
      expect(process.cwd()).toBe(original);
      expect(chdir).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    });
  });
  it("unbound calls do not require any Work adapter", async () => {
    const id = manager.spawn({} as any, workContext(), "general-purpose", "normal", { description: "normal" });
    await settle(id);
    expect(prompt).toHaveBeenCalledOnce();
    expect(Object.values(adapter.requests).flat()).toEqual([]);
  });
  it("rejects worktree isolation before spawning", () => {
    expect(() => spawn({ isolation: "worktree" })).toThrow(/cannot be combined/);
    expect(runAgent).not.toHaveBeenCalled();
    expect(adapter.requests.reserve).toHaveLength(0);
  });
  it.each([false, true])("aborted pending resume background=%s refuses overlap until settlement and ignores stale replies", async isBackground => {
    const id = spawn(); await settle(id);
    adapter.held.add("reserve");
    adapter.held.add("finalize");
    vi.mocked(resumeAgent).mockResolvedValue({ text: "new answer" } as any);
    const first = manager.resume(id, "cancelled prompt", undefined, { toolCallId: "cancelled-resume", isBackground });
    await vi.waitFor(() => expect(adapter.requests.reserve).toHaveLength(2));
    const stale = adapter.requests.reserve[1];
    manager.abort(id);
    expect(await manager.resume(id, "overlap", undefined, { toolCallId: "new-resume", isBackground })).toBeUndefined();
    expect(adapter.requests.reserve).toHaveLength(2);
    adapter.reply("reserve", stale);
    await vi.waitFor(() => expect(adapter.requests.finalize).toHaveLength(2));
    // Finalization is also part of settlement, not permission to reuse the record.
    expect(await manager.resume(id, "overlap", undefined, { toolCallId: "new-resume", isBackground })).toBeUndefined();
    expect(adapter.requests.bind).toHaveLength(1);
    expect(resumeAgent).not.toHaveBeenCalled();
    adapter.reply("finalize", adapter.requests.finalize[1]);
    await first;
    if (isBackground) await manager.getRecord(id)!.promise;
    adapter.held.delete("finalize");

    const second = manager.resume(id, "new prompt", undefined, { toolCallId: "new-resume", isBackground });
    await vi.waitFor(() => expect(adapter.requests.reserve).toHaveLength(3));
    const newer = adapter.requests.reserve[2];
    adapter.reply("reserve", stale);
    await Promise.resolve(); await Promise.resolve();
    expect(adapter.requests.bind).toHaveLength(1);
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(adapter.requests.finalize).toHaveLength(2);
    expect(manager.getRecord(id)!.workLaunch!.launchKey).toBe(newer.launchKey);
    adapter.reply("reserve", newer);
    await second;
    if (isBackground) await manager.getRecord(id)!.promise;
    expect(resumeAgent).toHaveBeenCalledOnce();
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("new prompt");
    expect(adapter.requests.bind).toHaveLength(2);
    expect(adapter.requests.bind[1].launchKey).toBe(newer.launchKey);
    expect(adapter.requests.finalize.map(r => r.launch.launchKey)).toEqual([
      adapter.requests.reserve[0].launchKey, stale.launchKey, newer.launchKey,
    ]);
  });
  it.each([false, true])("rolls back background resume persistence failure before registration at concurrency limit=%s", async atLimit => {
    const id = spawn(); await settle(id);
    const record = manager.getRecord(id)!;
    // Retrieval state is part of the settled result, not the rejected attempt.
    record.resultConsumed = true;
    const previous = { ...record };
    const entries = structuredClone(adapter.entries);
    const blockerDone = deferred<Awaited<ReturnType<typeof runAgent>>>();
    let blocker: string | undefined;
    if (atLimit) {
      vi.mocked(runAgent).mockImplementationOnce(() => blockerDone.promise);
      blocker = manager.spawn(adapter.pi, workContext(), "general-purpose", "blocker", {
        description: "blocker", isBackground: true,
      });
      await manager.awaitStartup(blocker);
      expect(manager.getRecord(blocker)!.status).toBe("running");
    }
    const onStarted = vi.fn();
    const persistenceError = new Error("synthetic resume persistence failure");
    vi.mocked(adapter.pi.appendEntry).mockImplementationOnce(() => { throw persistenceError; });
    const resumeOptions = { toolCallId: "retry-persist-resume", isBackground: true, onStarted };
    try {
      await expect(manager.resume(id, "rejected prompt", undefined, resumeOptions)).rejects.toBe(persistenceError);
      expect(manager.getRecord(id)).toBe(record);
      expect(record).toEqual(previous);
      expect(record.session).toBe(previous.session);
      expect(record.workLaunch).toBe(previous.workLaunch);
      expect(record.abortController).toBe(previous.abortController);
      expect(record.promise).toBe(previous.promise);
      expect(adapter.entries).toEqual(entries);
      expect(adapter.requests.reserve).toHaveLength(1);
      expect(adapter.requests.bind).toHaveLength(1);
      expect(adapter.requests.finalize).toHaveLength(1);
      expect(onStarted).not.toHaveBeenCalled();
      expect(resumeAgent).not.toHaveBeenCalled();
      expect(Reflect.get(manager, "queue")).toEqual([]);
      expect((Reflect.get(manager, "workRuns") as Map<object, unknown>).has(record)).toBe(false);
      expect((Reflect.get(manager, "workLaunches") as Set<string>)).toEqual(new Set([previous.workLaunch!.launchKey]));

      if (blocker) {
        blockerDone.resolve({ session: childSession(), responseText: "blocker done", aborted: false, steered: false });
        await manager.getRecord(blocker)!.promise;
      }
      // A microtask budget also catches a spin over the old settled promise;
      // a timer alone cannot interrupt that failure mode.
      const waited = manager.waitForAll().then(() => "settled");
      const budget = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); return "hung"; };
      expect(await Promise.race([waited, budget()])).toBe("settled");
      expect(resumeAgent).not.toHaveBeenCalled();
      expect(adapter.requests.finalize).toHaveLength(1);

      vi.mocked(resumeAgent).mockResolvedValue({ text: "retry answer" } as Awaited<ReturnType<typeof resumeAgent>>);
      // The identical invocation must be reusable, not only a fresh key.
      expect(await manager.resume(id, "retry prompt", undefined, resumeOptions)).toBe(record);
      await record.promise;
      expect(record.status).toBe("completed");
      expect(record.result).toBe("retry answer");
      expect(record.session).toBe(previous.session);
      expect(onStarted).toHaveBeenCalledOnce();
      expect(resumeAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(resumeAgent).mock.calls[0].slice(0, 2)).toEqual([previous.session, "retry prompt"]);
      expect(adapter.requests.reserve).toHaveLength(2);
      expect(adapter.requests.bind).toHaveLength(2);
      expect(adapter.requests.finalize).toHaveLength(2);
      expect(adapter.requests.reserve[1].invocationId).toBe(resumeOptions.toolCallId);
    } finally {
      // Keep a failed regression from leaving a real pending child in teardown.
      blockerDone.resolve({ session: childSession(), responseText: "blocker done", aborted: false, steered: false });
      if (blocker) await manager.getRecord(blocker)!.promise;
      manager.abortAll();
    }
  });
  it("rejects changed work/cwd on bound resume before reserving", async () => {
    const id = spawn(); await settle(id);
    await expect(manager.resume(id, "next", undefined, { work: { ...work, actor: "other" }, toolCallId: "next" })).rejects.toThrow(/Cannot change/);
    await expect(manager.resume(id, "next", undefined, { cwd: `${process.cwd()}/.`, toolCallId: "next" })).rejects.toThrow(/Cannot change/);
    expect(adapter.requests.reserve).toHaveLength(1);
    expect(resumeAgent).not.toHaveBeenCalled();
  });
  it.each([false, true])("resume background=%s reserves and binds anew before executing on the existing child", async isBackground => {
    const id = spawn(); await settle(id);
    adapter.held.add("reserve"); adapter.held.add("bind");
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" } as any);
    const resumed = manager.resume(id, "next", undefined, { work, toolCallId: "resume-04", isBackground });
    expect(resumeAgent).not.toHaveBeenCalled();
    adapter.reply("reserve", adapter.requests.reserve[1]);
    await vi.waitFor(() => expect(adapter.requests.bind).toHaveLength(2));
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(adapter.requests.bind[1].childSessionId).toBe("actual-child-session");
    adapter.reply("bind", adapter.requests.bind[1]);
    await resumed;
    if (isBackground) await manager.getRecord(id)!.promise;
    expect(runAgent).toHaveBeenCalledOnce();
    expect(resumeAgent).toHaveBeenCalledOnce();
    expect(adapter.requests.finalize).toHaveLength(2);
    expect(new Set(adapter.requests.finalize.map(r => r.launch.launchKey)).size).toBe(2);
  });
});
