import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    async reload() {}
    getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
  },
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  SessionManager: {
    inMemory: vi.fn(() => ({})),
    create: vi.fn(() => ({})),
    open: vi.fn(() => ({})),
  },
  SettingsManager: { create: vi.fn(() => ({ getSessionDir: () => undefined })) },
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read"],
  getConfig: vi.fn(() => ({ builtinToolNames: ["read"], extensions: false, skills: false })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore", description: "Explore", builtinToolNames: ["read"],
    extensions: false, skills: false, systemPrompt: "Explore", promptMode: "replace",
  })),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
  resolveSpawnType: vi.fn(),
}));
vi.mock("../src/env.js", () => ({ detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })) }));
vi.mock("../src/prompts.js", () => ({ buildAgentPrompt: vi.fn(() => "system") }));
vi.mock("../src/memory.js", () => ({ buildMemoryBlock: vi.fn(() => ""), buildReadOnlyMemoryBlock: vi.fn(() => "") }));
vi.mock("../src/skill-loader.js", () => ({ preloadSkills: vi.fn(() => []) }));
vi.mock("../src/nested-tools.js", () => ({ getMaxSubagentDepth: vi.fn(() => 2), createNestedSubagentTools: vi.fn(() => []) }));

import { resumeAgent, runAgent, setDefaultContextThresholds, setDefaultMaxTurns } from "../src/agent-runner.js";
import { SubagentScheduler } from "../src/schedule.js";

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent"),
  sessionManager: { getBranch: vi.fn(() => []), getSessionFile: vi.fn(() => "/sessions/parent.jsonl") },
} as any;

function createSession(percent: () => number | null, duringPrompt?: () => void) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); };
    }),
    prompt: vi.fn(async () => {
      duringPrompt?.();
      for (const listener of listeners) listener({ type: "turn_end" });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "partial answer" }] });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getSessionStats: vi.fn(() => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: percent() } })),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    getAllTools: vi.fn(() => [{ name: "read" }]),
    agent: {},
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return session;
}

beforeEach(() => {
  createAgentSession.mockReset();
  setDefaultContextThresholds(undefined, undefined);
  setDefaultMaxTurns(undefined);
});

describe("context guard runtime outcomes", () => {
  it("reports a fresh context warning as a successful steered run, not a completed run", async () => {
    const session = createSession(() => 30);
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi: {} as any });

    expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("Context utilization reached 30%"));
    expect(result.steered).toBe(true);
  });

  it("reports a resumed context warning as steered so its owner cannot mark it completed", async () => {
    const session = createSession(() => 30);

    const result = await resumeAgent(session as any, "continue");

    expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("Context utilization reached 30%"));
    expect((result as any).steered).toBe(true);
  });

  it("does not queue a turn-limit steer after a hard context stop on turn end", async () => {
    let currentPercent = 20;
    const session = createSession(() => currentPercent, () => { currentPercent = 55; });
    createAgentSession.mockResolvedValue({ session });
    setDefaultMaxTurns(1);

    const result = await runAgent(ctx, "Explore", "go", { pi: {} as any });

    expect(result.contextAborted).toBe(true);
    expect(session.abort).toHaveBeenCalled();
    expect(session.steer).not.toHaveBeenCalled();
  });

  it("refuses invalid scheduled thresholds before a job can be persisted or armed", () => {
    const scheduler = new SubagentScheduler();

    expect(() => scheduler.buildJob({
      name: "bad-context-thresholds",
      description: "must not schedule",
      schedule: "1h",
      subagent_type: "Explore",
      prompt: "go",
      context_warn_percent: 60,
      context_stop_percent: 50,
    })).toThrow("0 < warn < stop <= 100");
  });
});
