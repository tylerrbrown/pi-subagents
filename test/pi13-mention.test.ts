import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  create: vi.fn(),
  memory: vi.fn(() => ({})),
  loaders: [] as Array<{ systemPromptOverride: (base?: string) => string | undefined; noExtensions: boolean }>,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  buildSessionContext: () => ({ messages: [{ role: "user", content: "prior turn" }] }),
  createAgentSession: harness.create,
  SessionManager: { inMemory: harness.memory },
  getAgentDir: () => "/isolated",
  DefaultResourceLoader: class {
    constructor(options: typeof harness.loaders[number]) { harness.loaders.push(options); }
    async reload() {}
  },
}));

import { runMentionClone } from "../src/mention-clone.js";

it("seeds the selected branch and live prompt without assigning read-only agent state", async () => {
  const branch = [{ type: "message", id: "selected", message: { role: "user", content: "prior turn" } }];
  const context = {
    cwd: "/isolated",
    modelRegistry: {},
    getSystemPrompt: () => "live prompt",
    sessionManager: { getEntries: () => branch, getBranch: () => branch, getLeafId: () => "selected" },
  } as unknown as ExtensionContext;
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const dispose = vi.fn();
  harness.create.mockImplementation(async (options: { customTools: ToolDefinition[] }) => ({
    session: {
      agent: { state: Object.freeze({ systemPrompt: "read-only", messages: Object.freeze([]) }) },
      prompt: async () => options.customTools[0].execute("clone", {}, undefined, undefined, context as never),
      dispose,
    },
  }));
  const result = await runMentionClone({ ctx: context, type: "Explore", message: "continue", agentTool: { name: "Agent", execute } as unknown as ToolDefinition });
  expect(result).toEqual({ spawned: true });
  expect(harness.memory).toHaveBeenCalledWith("/isolated", undefined, branch);
  expect(harness.loaders[0].systemPromptOverride()).toBe("live prompt");
  expect(harness.loaders[0].noExtensions).toBe(true);
  expect(execute).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
});
