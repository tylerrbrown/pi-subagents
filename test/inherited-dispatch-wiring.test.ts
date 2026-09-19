import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(() => { throw new Error("Unexpected spawn"); }) };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

let base: string;
let oldCwd: string;
let cwd: string;
beforeEach(() => {
  oldCwd = process.cwd();
  base = mkdtempSync(join(import.meta.dirname, "dispatch-fixture-"));
  cwd = join(base, "automations/AWS");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(base, ".git"));
  mkdirSync(join(base, ".pi"));
  mkdirSync(join(base, ".claude/agents"), { recursive: true });
  writeFileSync(join(base, ".pi/subagents.json"), JSON.stringify({ fallbackSubagent: "none" }));
  writeFileSync(join(base, ".claude/agents/cartographer.md"), "---\ntools: read, grep, bash\n---\nMap.\n");
  vi.stubEnv("PI_CODING_AGENT_DIR", join(base, "global"));
  vi.stubEnv("HOME", base);
  process.chdir(cwd);
  vi.mocked(runAgent).mockClear();
});
afterEach(() => {
  process.chdir(oldCwd);
  vi.unstubAllEnvs();
  setFallbackSubagent(undefined);
  registerAgents(new Map());
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  rmSync(base, { recursive: true, force: true });
});
for (const background of [false, true]) {
  it(`real nested-CWD Agent refuses unknown type before spawn (background=${background})`, async () => {
    const tools = new Map<string, any>();
    subagentsExtension({
      registerMessageRenderer: vi.fn(), registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: vi.fn(), on: vi.fn(), events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(), sendMessage: vi.fn(),
    } as any);
    const result = await tools.get("Agent").execute("test", {
      prompt: "do not run", description: "unknown", subagent_type: "missing", run_in_background: background,
    }, undefined, undefined, {
      hasUI: false, cwd, model: undefined,
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionId: () => "test", getBranch: () => [] },
      getSystemPrompt: () => "parent",
    });
    expect(result.content[0].text).toContain('Unknown or disabled agent type: "missing"');
    expect(result.content[0].text).toContain("cartographer");
    expect(runAgent).not.toHaveBeenCalled();
  });
}
