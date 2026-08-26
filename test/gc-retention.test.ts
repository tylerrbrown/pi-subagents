/**
 * gc-retention.test.ts — b3: a finished agent's result has to outlive the barrier.
 *
 * `cleanup()` evicted any completed record 10 minutes after `completedAt`, and
 * tombstones carried only handle + sessionFile, so `get_subagent_result`
 * answered `Agent not found`. In a 2-hour batch every sibling that finished
 * early was unretrievable by the time the Lead's turn came back — which is what
 * drove the rerun/resume churn on 08/24.
 *
 * Two independent guards, because they fail at different edges: unconsumed
 * records get a much longer retention window, and an evicted record's tombstone
 * still carries the result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const MINUTE = 60_000;
const TICK = 60_000;

describe("AgentManager — unconsumed results survive the old 10-minute GC", () => {
  let manager: AgentManager;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  async function settled(prompt: string, sessionFile?: string) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: `RESULT-${prompt}`,
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
      timedOut: false,
    } as any);
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "Explore", prompt, { description: prompt, isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.sessionFile = sessionFile;
    return { id, record };
  }

  it("keeps an unread result 15 minutes after completion", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("early-finisher");
    expect(record.resultConsumed).toBeFalsy();
    record.completedAt = Date.now() - 15 * MINUTE;

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)?.result).toBe("RESULT-early-finisher");
  });

  it("keeps an unread result across a two-hour barrier's worth of sweeps", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("held-through-the-barrier");
    record.completedAt = Date.now() - 45 * MINUTE;

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(manager.getRecord(id)).toBeDefined();
  });

  it("still evicts a read result on the old ten-minute schedule", async () => {
    // Retention is for results nobody has collected. Once read, the record is
    // just memory, and the 10-minute bound is what keeps a long session bounded.
    manager = new AgentManager();
    const { id, record } = await settled("already-read");
    record.resultConsumed = true;
    record.completedAt = Date.now() - 11 * MINUTE;

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("eventually evicts an unread result too — retention is a window, not a leak", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("abandoned");
    record.completedAt = Date.now() - 90 * MINUTE;

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("never evicts a running agent, whatever its timestamp claims", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "live", { description: "live", isBackground: true });
    manager.getRecord(id)!.completedAt = Date.now() - 10 * 60 * MINUTE;

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(manager.getRecord(id)).toBeDefined();
  });
});

describe("AgentManager — tombstones carry the terminal result", () => {
  let manager: AgentManager;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  async function evicted(prompt: string) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: `RESULT-${prompt}`,
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
      timedOut: false,
    } as any);
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "Explore", prompt, { description: prompt, isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.sessionFile = `/sessions/${prompt}.jsonl`;
    record.resultConsumed = true;
    record.completedAt = Date.now() - 11 * MINUTE;
    await vi.advanceTimersByTimeAsync(TICK);
    return { id, handle: record.handle! };
  }

  it("serves the result by id after eviction instead of Agent-not-found", async () => {
    manager = new AgentManager();
    const { id } = await evicted("collected-late");
    expect(manager.getRecord(id)).toBeUndefined();

    const stone = manager.getTombstone(id);
    expect(stone).toBeDefined();
    expect(stone!.result).toBe("RESULT-collected-late");
    expect(stone!.status).toBe("completed");
  });

  it("serves it by handle too", async () => {
    manager = new AgentManager();
    const { handle } = await evicted("by-handle");
    expect(manager.getTombstone(handle)?.result).toBe("RESULT-by-handle");
  });

  it("returns nothing for an id that never existed", async () => {
    manager = new AgentManager();
    expect(manager.getTombstone("nope")).toBeUndefined();
  });
});
