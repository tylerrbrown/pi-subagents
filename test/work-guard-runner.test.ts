import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ agentDir: "", session: undefined as any, runner: undefined as any, loaded: [] as string[] }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const sdk = await importOriginal<any>();
  return { ...sdk, getAgentDir: () => state.agentDir,
    createAgentSession: vi.fn(async options => {
      const session = {
        sessionManager: options.sessionManager, messages: [], agent: {},
        setSessionName: vi.fn(), subscribe: vi.fn(() => vi.fn()), dispose: vi.fn(), abort: vi.fn(),
        getAllTools: () => [{ name: "write" }], getActiveToolNames: () => ["write"], setActiveToolsByName: vi.fn(),
        async bindExtensions() {
          const loaded = options.resourceLoader.getExtensions();
          state.loaded = loaded.extensions.map((entry: any) => entry.path);
          state.runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, options.cwd,
            options.sessionManager, options.modelRegistry);
          await state.runner.emit({ type: "session_start" });
        },
        prompt: vi.fn(async () => {}),
      };
      state.session = session; return { session };
    }),
  };
});

import { runAgent, workBoundAgentConfig } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { type Hermetic, hermeticDir } from "./helpers/boot-extension.js";
import { workContext } from "./helpers/work-adapter.js";

let fixture: Hermetic | undefined;
afterEach(() => { state.session?.dispose(); fixture?.restore(); fixture = undefined; registerAgents([]); vi.clearAllMocks(); });

describe("bound Work guard through the actual resource loader", () => {
  it("refreshes only root shared definitions for a positive Work dispatch at actual Naming cwd", () => {
    const cwd = "C:/Worktrees/tylerrbrown/Claude/hyynh8qv-session-naming-targeted-model-comparison";
    const original = loadCustomAgents(cwd).get("builder")!;
    const refreshed = workBoundAgentConfig(cwd, original, true)!;
    expect(refreshed.sourcePath).toBe(resolve(homedir(), "SynologyDrive/Claude/.claude/agents/builder.md"));
    expect(refreshed.systemPrompt).toContain("file list is a prediction, not an edit lock");
    expect(workBoundAgentConfig(cwd, original, false)).toBe(original);
    const local = { ...original, sourcePath: join(cwd, "apps/helm/.claude/agents/builder.md"), systemPrompt: "local authority" };
    expect(workBoundAgentConfig(cwd, local, true)).toBe(local);
    const custom = { ...original, name: "only-local", sourcePath: join(cwd, ".claude/agents/only-local.md") };
    expect(workBoundAgentConfig(cwd, custom, true)).toBe(custom);
  });
  it.each([[false, true, true], [true, true, true], [false, false, false], [true, false, false], [true, true, false]])("loads the canonical floor only for bound children isolation=%s bound=%s marker=%s", async (isolated, bound, marker) => {
    fixture = hermeticDir(); state.agentDir = join(fixture.dir, "agent-dir");
    mkdirSync(state.agentDir); mkdirSync(join(fixture.dir, ".git"));
    const extensions = join(fixture.dir, ".pi/extensions");
    const compiled = join(fixture.dir, ".pi/extensions-dist");
    mkdirSync(extensions, { recursive: true }); mkdirSync(compiled);
    writeFileSync(join(extensions, "recall-inject.js"), "export default function(pi) {}\n");
    const guard = join(compiled, "work-agent-binding.js");
    const actualSource = resolve(homedir(), "SynologyDrive/Claude/.pi/extensions-dist/work-agent-binding.js");
    // Load the real adapter; only its external Work process is replaced.
    writeFileSync(guard, `import guard from ${JSON.stringify(pathToFileURL(actualSource).href)};
      export default function(pi) { guard({...pi, exec: async (_command,args) => ({code:0,stdout:JSON.stringify({
        case_uid:'00000000-0000-4000-8000-000000000001',assignment_id:'assignment-1',execution_id:'exec-1',
        launch_key:'launch-1',session:args[args.indexOf('--session')+1],cwd:${JSON.stringify(fixture.dir)},
        scopes:['predicted.ts'],run:null,review_budget:{schema_version:3,policy:'lead-managed-v1',boundary:'case-worktree'}
      })})}); }`);
    registerAgents(new Map([["guard-builder", { name: "guard-builder", description: "builder", systemPrompt: "synthetic",
      tools: ["write"], builtinToolNames: ["write"], extensions: ["recall-inject"], excludeExtensions: ["work-agent-binding"], skills: false,
    } as any]]));
    const ctx = workContext(); ctx.cwd = fixture.dir;
    const running = runAgent(ctx, "guard-builder", "Never call a real model", {
      pi: { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as any,
      isolated, bindBeforeExtensions: bound,
      onSessionCreated(session) {
        if (!marker) return;
        session.sessionManager.appendCustomEntry("work-bound-session", { schemaVersion: 1,
          childSessionId: session.sessionManager.getSessionId(), caseHandle: "e74a3rjt", executionId: "exec-1",
          assignmentId: "assignment-1", launchKey: "launch-1" });
      },
    });
    if (bound && !marker) {
      await expect(running).rejects.toThrow("identity marker is missing");
      expect(state.session.prompt).not.toHaveBeenCalled();
      return;
    }
    await running;
    if (bound) expect(state.loaded).toContain(guard);
    else expect(state.loaded).not.toContain(guard);
    if (isolated) expect(state.loaded).toEqual(bound ? [guard] : []);
    const tool = (path: string) => state.runner.emitToolCall({ type: "tool_call", toolCallId: "synthetic",
      toolName: "write", input: { path, content: "unused" } });
    expect(await tool("new-unpredicted.ts")).toBeUndefined();
    if (bound) {
      expect(await tool("../outside.ts")).toMatchObject({ block: true });
      expect(await tool("work/items/case/00-item.md")).toMatchObject({ block: true });
    } else {
      expect(await tool("../outside.ts")).toBeUndefined();
      expect(await tool("work/items/case/00-item.md")).toBeUndefined();
    }
  });
});
