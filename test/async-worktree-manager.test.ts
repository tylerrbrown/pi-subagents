import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { cleanupWorktree, createWorktree, type WorktreeInfo } from "../src/worktree.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), cleanupWorktree: vi.fn(), pruneWorktrees: vi.fn(async () => {}),
  isWorktreeIsolationEnabled: () => true,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const pi = {} as ExtensionAPI;
const ctx = { cwd: process.cwd() } as ExtensionContext;
const wt: WorktreeInfo = { path: "/copy", workPath: "/copy", branch: "pi-agent-test", baseSha: "abc" };
const flush = () => new Promise<void>(r => setImmediate(r));
let manager: AgentManager;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: false });
  vi.mocked(runAgent).mockResolvedValue({ responseText: "done", aborted: false, steered: false, session: { dispose: vi.fn() } as never });
  manager = new AgentManager(undefined, 1);
});
afterEach(async () => { await manager.dispose(); });

it("returns an ID immediately but reserves the slot and never runs before the copy completes", async () => {
  const copy = deferred<WorktreeInfo>();
  vi.mocked(createWorktree).mockReturnValue(copy.promise);
  const id = manager.spawn(pi, ctx, "X", "first", { description: "first", isolation: "worktree", isBackground: true });
  const second = manager.spawn(pi, ctx, "X", "second", { description: "second", isBackground: true });
  expect(typeof id).toBe("string");
  expect(manager.getRecord(id)?.status).toBe("running");
  expect(manager.getRecord(second)?.status).toBe("queued");
  expect(runAgent).not.toHaveBeenCalled();
  const waiting = manager.waitForAll();
  let settled = false;
  void waiting.then(() => { settled = true; });
  await flush();
  expect(settled).toBe(false);
  copy.resolve(wt);
  await waiting;
  expect(runAgent).toHaveBeenCalledTimes(2);
  expect(cleanupWorktree).toHaveBeenCalledWith(pi, ctx.cwd, wt, "first");
});

it.each(["manager", "parent", "shutdown"])("stops during creation via %s and awaits cleanup without running", async (source) => {
  const copy = deferred<WorktreeInfo>();
  const cleanup = deferred<{ hasChanges: boolean }>();
  vi.mocked(createWorktree).mockReturnValue(copy.promise);
  vi.mocked(cleanupWorktree).mockReturnValue(cleanup.promise);
  const parent = new AbortController();
  const id = manager.spawn(pi, ctx, "X", "first", { description: "first", isolation: "worktree", signal: parent.signal, isBackground: true });
  const startupResult = manager.awaitStartup(id).then(
    () => "resolved",
    error => error instanceof Error ? error.message : String(error),
  );
  if (source === "parent") parent.abort();
  else if (source === "shutdown") manager.abortAll();
  else manager.abort(id);
  copy.resolve(wt);
  await flush();
  expect(runAgent).not.toHaveBeenCalled();
  expect(cleanupWorktree).toHaveBeenCalledOnce();
  let settled = false;
  const waiting = manager.waitForAll().then(() => { settled = true; });
  await flush();
  expect(settled).toBe(false);
  cleanup.resolve({ hasChanges: false });
  await waiting;
  expect(await startupResult).toMatch(/cancelled|stopped/i);
  expect(manager.getRecord(id)?.status).toBe("stopped");
});

it("foreground waits for startup and cleanup; concurrent spawns keep their own onSpawned callback", async () => {
  const first = deferred<WorktreeInfo>();
  const second = deferred<WorktreeInfo>();
  const cleanup = deferred<{ hasChanges: boolean; branch: string }>();
  vi.mocked(createWorktree).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.mocked(cleanupWorktree).mockReturnValue(cleanup.promise);
  const a = vi.fn();
  const b = vi.fn();
  let settled = false;
  const pendingA = manager.spawnAndWait(pi, ctx, "X", "a", { description: "a", isolation: "worktree" }, a).then(result => { settled = true; return result; });
  const pendingB = manager.spawnAndWait(pi, ctx, "X", "b", { description: "b", isolation: "worktree" }, b);
  await flush();
  expect(settled).toBe(false);
  expect(a).not.toHaveBeenCalled();
  second.resolve(wt);
  await flush();
  expect(a).not.toHaveBeenCalled();
  expect(b).toHaveBeenCalledOnce();
  first.resolve(wt);
  await flush();
  expect(a).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  cleanup.resolve({ hasChanges: true, branch: "saved" });
  const [ra, rb] = await Promise.all([pendingA, pendingB]);
  expect(a).toHaveBeenCalledWith(ra.id);
  expect(b).toHaveBeenCalledWith(rb.id);
  expect(ra.record.result).toContain("Changes saved to branch `saved`");
});

it("startup failure rejects the await contract, drops the immediate record, and frees its slot", async () => {
  const copy = deferred<WorktreeInfo | undefined>();
  vi.mocked(createWorktree).mockReturnValue(copy.promise);
  const id = manager.spawn(pi, ctx, "X", "bad", { description: "bad", isolation: "worktree", isBackground: true });
  const waiting = expect(manager.awaitStartup(id)).rejects.toThrow('isolation: "worktree"');
  const next = manager.spawn(pi, ctx, "X", "next", { description: "next", isBackground: true });
  copy.resolve(undefined);
  await waiting;
  await manager.waitForAll();
  expect(manager.getRecord(id)).toBeUndefined();
  expect(manager.getRecord(next)?.status).toBe("completed");
});

it("surfaces a retained worktree path and preservation failure in the agent result", async () => {
  vi.mocked(createWorktree).mockResolvedValue(wt);
  vi.mocked(cleanupWorktree).mockResolvedValue({
    hasChanges: true,
    path: wt.path,
    error: "commit denied",
  });

  const { record } = await manager.spawnAndWait(pi, ctx, "X", "done", {
    description: "done",
    isolation: "worktree",
  });

  expect(record.worktreeResult).toEqual({ hasChanges: true, path: wt.path, error: "commit denied" });
  expect(record.status).toBe("error");
  expect(record.error).toContain("commit denied");
  expect(record.result).toContain("Worktree output was not preserved");
  expect(record.result).toContain(wt.path);
  expect(record.result).toContain("commit denied");
});

it("rejects an escaped workPath before launching the child", async () => {
  const copyRoot = join(process.cwd(), "copy-root");
  const escaped = join(process.cwd(), "escaped");
  vi.mocked(createWorktree).mockResolvedValue({ ...wt, path: copyRoot, workPath: escaped });

  const id = manager.spawn(pi, ctx, "X", "unsafe", {
    cwd: process.cwd(),
    description: "unsafe",
    isolation: "worktree",
    isBackground: true,
  });

  await expect(manager.awaitStartup(id)).rejects.toThrow(/outside|escape|contain/i);
  expect(runAgent).not.toHaveBeenCalled();
});

it("retains the slot and waits for async error cleanup before draining", async () => {
  vi.mocked(createWorktree).mockResolvedValue(wt);
  const cleanup = deferred<{ hasChanges: boolean }>();
  vi.mocked(cleanupWorktree).mockReturnValue(cleanup.promise);
  vi.mocked(runAgent).mockRejectedValueOnce(new Error("runner failed"));
  const id = manager.spawn(pi, ctx, "X", "bad", { description: "bad", isolation: "worktree", isBackground: true });
  const next = manager.spawn(pi, ctx, "X", "next", { description: "next", isBackground: true });
  await flush();
  expect(cleanupWorktree).toHaveBeenCalledOnce();
  expect(manager.getRecord(next)?.status).toBe("queued");
  cleanup.resolve({ hasChanges: false });
  await manager.waitForAll();
  expect(manager.getRecord(id)?.error).toBe("runner failed");
  expect(manager.getRecord(next)?.status).toBe("completed");
});

it("does not expose a completed result or allow eviction while preservation is pending", async () => {
  vi.mocked(createWorktree).mockResolvedValue(wt);
  const cleanup = deferred<{ hasChanges: boolean }>();
  vi.mocked(cleanupWorktree).mockReturnValue(cleanup.promise);
  const id = manager.spawn(pi, ctx, "X", "done", { description: "done", isolation: "worktree", isBackground: true });
  await flush();
  const status = manager.getRecord(id)?.status;
  manager.clearCompleted();
  const retained = manager.getRecord(id);
  cleanup.resolve({ hasChanges: false });
  await manager.waitForAll();
  expect(status).toBe("running");
  expect(retained).toBeDefined();
});

it("dispose waits for a running isolated agent's preservation before removing records", async () => {
  vi.mocked(createWorktree).mockResolvedValue(wt);
  const cleanup = deferred<{ hasChanges: boolean }>();
  vi.mocked(cleanupWorktree).mockReturnValue(cleanup.promise);
  manager.spawn(pi, ctx, "X", "done", { description: "done", isolation: "worktree", isBackground: true });
  await flush();
  let settled = false;
  const disposing = manager.dispose().then(() => { settled = true; });
  await flush();
  const early = settled;
  cleanup.resolve({ hasChanges: false });
  await disposing;
  expect(early).toBe(false);
});
