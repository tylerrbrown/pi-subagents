import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({ createWorktree: vi.fn(), cleanupWorktree: vi.fn(), pruneWorktrees: vi.fn(), isWorktreeIsolationEnabled: () => true }));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { SubagentScheduler } from "../src/schedule.js";
import { showSchedulesMenu } from "../src/ui/schedule-menu.js";
import { work, workAdapter, workContext } from "./helpers/work-adapter.js";

const managers: AgentManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.dispose(); vi.clearAllMocks(); });
describe("nonfatal Work check skips", () => {
  it.each([{ assignment_id: "forged" }, { run_started: true }, { execution_id: "foreign" },
    { launch_key: "foreign" }, { advisories: ["private prose"] }, { slice_ids: [] }])("refuses malformed skip without starting a child %j", async change => {
    const adapter = workAdapter(); adapter.held.add("reserve");
    adapter.events.on("subagents:work:reserve", request => {
      adapter.events.emit(`subagents:work:reserve:reply:${request.requestId}`, { success: true, data: {
        status: "skipped", reason: "review_budget_exhausted", action: "lead_continue", run_started: false,
        case_uid: "00000000-0000-4000-8000-000000000001", execution_id: work.execution,
        launch_key: request.payload.launchKey, slice_ids: ["S02"], advisories: [], ...change,
      } });
    });
    const manager = new AgentManager(undefined, 1); managers.push(manager);
    const id = manager.spawn(adapter.pi, workContext(), "reviewer", "unused", { description: "bounded", invocationId: "invalid-skip", work });
    await expect(manager.awaitStartup(id)).rejects.toThrow();
    expect(runAgent).not.toHaveBeenCalled();
    expect(adapter.requests.bind).toHaveLength(0);
  });
  it("shows a neutral explicit skip in the scheduled-jobs picker", async () => {
    const scheduler = new SubagentScheduler();
    const job = scheduler.buildJob({ name: "check", description: "check", prompt: "unused", subagent_type: "reviewer", schedule: "1h" });
    vi.spyOn(scheduler, "isActive").mockReturnValue(true);
    vi.spyOn(scheduler, "list").mockReturnValue([{ ...job, lastStatus: "skipped" }]);
    const ctx = workContext();
    ctx.ui.select = vi.fn(async () => undefined);
    await showSchedulesMenu(ctx, scheduler);
    const rows = vi.mocked(ctx.ui.select).mock.calls[0][1];
    expect(rows[0]).toContain("skipped (no child run)");
    expect(rows[0]).not.toContain("✓");
  });
  it("does not turn a known no-run skip into failure when local persistence is unavailable", async () => {
    const adapter = workAdapter(); adapter.held.add("reserve");
    adapter.events.on("subagents:work:reserve", request => {
      vi.mocked(adapter.pi.appendEntry).mockImplementation(() => { throw new Error("synthetic log unavailable"); });
      adapter.events.emit(`subagents:work:reserve:reply:${request.requestId}`, { success: true, data: {
        status: "skipped", reason: "verification_budget_exhausted", action: "lead_continue", run_started: false,
        case_uid: "00000000-0000-4000-8000-000000000001", execution_id: work.execution,
        launch_key: request.payload.launchKey, slice_ids: ["S02"], advisories: [],
      } });
    });
    const manager = new AgentManager(undefined, 1); managers.push(manager);
    const id = manager.spawn(adapter.pi, workContext(), "verifier", "unused", {
      description: "bounded verifier", invocationId: "skip-no-log", work,
    });
    await expect(manager.awaitStartup(id)).resolves.toBeUndefined();
    expect(manager.getRecord(id)!.status).toBe("skipped");
    expect(runAgent).not.toHaveBeenCalled();
    expect(adapter.requests.finalize).toHaveLength(0);
  });
  it.each([false, true])("creates no child or terminal proof and keeps queue usable (background=%s)", async isBackground => {
    const adapter = workAdapter();
    adapter.held.add("reserve");
    adapter.events.on("subagents:work:reserve", request => {
      adapter.events.emit(`subagents:work:reserve:reply:${request.requestId}`, { success: true, data: {
        status: "skipped", reason: "review_budget_exhausted", action: "lead_continue", run_started: false,
        case_uid: "00000000-0000-4000-8000-000000000001", execution_id: work.execution,
        launch_key: request.payload.launchKey, slice_ids: ["S02"], advisories: [],
      } });
    });
    const completed = vi.fn();
    const manager = new AgentManager(completed, 1); managers.push(manager);
    const id = manager.spawn(adapter.pi, workContext(), "reviewer", "unused prompt", {
      description: "bounded review", invocationId: "skip-first", work, isBackground,
    });
    await expect(manager.awaitStartup(id)).resolves.toBeUndefined();
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)).toMatchObject({ status: "skipped", toolUses: 0 });
    expect(manager.getRecord(id)!.error).toBeUndefined();
    expect(JSON.parse(manager.getRecord(id)!.result!)).toMatchObject({ status: "skipped", run_started: false });
    expect(runAgent).not.toHaveBeenCalled();
    expect(adapter.requests.bind).toHaveLength(0);
    expect(adapter.requests.finalize).toHaveLength(0);
    expect(completed).toHaveBeenCalledOnce();
    expect(manager.hasRunning()).toBe(false);
    expect((manager as unknown as { workRuns: Map<unknown, unknown> }).workRuns.size).toBe(0);
    await manager.reconcileWork(adapter.pi, adapter.entries);
    expect(adapter.requests.reconcile).toHaveLength(0);
    const next = manager.spawn(adapter.pi, workContext(), "reviewer", "unused prompt", {
      description: "another bounded review", invocationId: "skip-next", work, isBackground,
    });
    await manager.awaitStartup(next);
    expect(manager.getRecord(next)!.status).toBe("skipped");
    expect(runAgent).not.toHaveBeenCalled();
  });
});
