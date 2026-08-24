/**
 * timeout-status.test.ts — b1/b4: what the manager records when a run hits its
 * wall-clock deadline. `timeout` is its own terminal status: not `completed`
 * (the task is unfinished), not `stopped` (nobody intervened), not `aborted`
 * (the turn budget was never spent). Partial output stays on the record.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

describe("AgentManager — timed-out run", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  async function settleWith(result: Record<string, unknown>) {
    vi.mocked(runAgent).mockResolvedValue({
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
      timedOut: false,
      ...result,
    } as any);
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "go", { description: "go", isBackground: true });
    await manager.getRecord(id)!.promise;
    return manager.getRecord(id)!;
  }

  it("records status timeout with stopReason timeout and keeps partial output", async () => {
    const record = await settleWith({ responseText: "half an answer", timedOut: true });
    expect(record.status).toBe("timeout");
    expect(record.stopReason).toBe("timeout");
    expect(record.result).toBe("half an answer");
    expect(record.completedAt).toBeGreaterThan(0);
  });

  it("prefers timeout over the turn-limit abort when both fired", async () => {
    // graceTurns can elapse while the deadline abort is already in flight; the
    // wall clock is the honest cause, and the one the operator can act on.
    const record = await settleWith({ responseText: "", timedOut: true, aborted: true });
    expect(record.status).toBe("timeout");
  });

  it("leaves a genuine user stop alone", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "go", { description: "go", isBackground: true });
    manager.abort(id, "user");
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("stopped");
    expect(record.stopReason).toBe("user");
  });

  it("still completes normally when no deadline fired", async () => {
    const record = await settleWith({ responseText: "done" });
    expect(record.status).toBe("completed");
    expect(record.stopReason).toBeUndefined();
  });
});
