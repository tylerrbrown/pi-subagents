/**
 * stop-provenance.test.ts — b4: `stopped` was set by three unrelated paths and
 * all three rendered "STOPPED BY THE USER". The 08/24 incident transcript has
 * no user stop turn in it; the status lied about what happened.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { getForegroundOutcomeNote, getStatusNote } from "../src/status-note.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(() => new Promise(() => {})), resumeAgent: vi.fn() };
});
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

describe("getStatusNote — provenance", () => {
  it("shouts about a human only for a genuine user stop", () => {
    expect(getStatusNote("stopped", "user")).toContain("STOPPED BY THE USER");
    for (const reason of ["rpc", "shutdown", "parent", undefined] as const) {
      expect(getStatusNote("stopped", reason)).not.toContain("STOPPED BY THE USER");
      expect(getStatusNote("stopped", reason)).toContain("stopped");
    }
  });

  it("names each non-user source distinctly", () => {
    expect(getStatusNote("stopped", "rpc")).toContain("another extension");
    expect(getStatusNote("stopped", "shutdown")).toContain("session shut down");
    expect(getStatusNote("stopped", "parent")).toContain("parent agent");
  });

  it("has a note for the timeout status", () => {
    expect(getStatusNote("timeout")).toContain("deadline");
    expect(getStatusNote("timeout")).not.toContain("STOPPED BY THE USER");
    expect(getForegroundOutcomeNote("timeout")).toContain("deadline");
  });

  it("says nothing for a clean completion", () => {
    expect(getStatusNote("completed")).toBe("");
    expect(getForegroundOutcomeNote("completed")).toBe("");
  });
});

describe("AgentManager — who stopped it", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  function running(description = "live") {
    manager ??= new AgentManager();
    return manager.spawn(mockPi, mockCtx, "X", description, { description, isBackground: true });
  }

  it("defaults an unattributed abort to the user (the /agents and Fleet stop path)", () => {
    manager = new AgentManager();
    const id = running();
    manager.abort(id);
    expect(manager.getRecord(id)!.stopReason).toBe("user");
  });

  it("records the caller's reason", () => {
    manager = new AgentManager();
    const id = running();
    manager.abort(id, "rpc");
    expect(manager.getRecord(id)!.stopReason).toBe("rpc");
  });

  it("attributes session shutdown to shutdown, not to a human", () => {
    manager = new AgentManager();
    const id = running();
    manager.abortAll("shutdown");
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("stopped");
    expect(record.stopReason).toBe("shutdown");
    expect(getStatusNote(record.status, record.stopReason)).not.toContain("STOPPED BY THE USER");
  });

  it("attributes a queued agent's shutdown the same way", () => {
    manager = new AgentManager(undefined, 1);
    running("holder");
    const queuedId = running("waiter");
    expect(manager.getRecord(queuedId)!.status).toBe("queued");
    manager.abortAll("shutdown");
    expect(manager.getRecord(queuedId)!.stopReason).toBe("shutdown");
  });

  it("wires the real stop sites to their own reasons (wire-up)", async () => {
    const { readFileSync } = await import("node:fs");
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    expect(index).toContain('manager.abortAll("shutdown")');
    // The RPC adapter object index.ts hands to registerRpcHandlers is the one
    // place the cross-extension stop path can be attributed.
    expect(index).toContain('manager.abort(id, "rpc")');
  });
});
