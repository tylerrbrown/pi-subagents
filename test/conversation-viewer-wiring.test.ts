import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import type * as AgentRunner from "../src/agent-runner.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { loadSettings } from "../src/settings.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import type { FleetUICtx } from "../src/ui/fleet-list.js";
import { ctx, flush, hermeticDir, makePi } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async (original) => ({
  ...await original<typeof AgentRunner>(),
  runAgent: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it.each(["fleet", "menu"])("persists m through the real %s entry point and reopens with the same mode", async entry => {
  const sandbox = hermeticDir({ settings: { viewerMarkdown: "off", schedulingEnabled: false, outputTranscript: false } });
  const { pi, tools, lifecycle } = makePi();
  let input: ((data: string) => unknown) | undefined;
  const modes: string[] = [];
  const custom: FleetUICtx["custom"] = async factory => {
    const viewer = factory({ terminal: { rows: 30, columns: 100 }, requestRender: vi.fn() },
      { fg: (_color, text) => text, bold: text => text }, undefined, vi.fn());
    expect(viewer).toBeInstanceOf(ConversationViewer);
    const conversation = viewer as ConversationViewer;
    modes.push(conversation.render(100).join("\n"));
    conversation.handleInput("m");
    conversation.handleInput("q");
    conversation.dispose();
    return undefined as never;
  };
  const ui = {
    setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), custom,
    getEditorText: () => "",
    onTerminalInput: (handler: (data: string) => unknown) => { input = handler; return vi.fn(); },
    select: vi.fn(),
  };
  const context = ctx({ hasUI: true, ui });
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "# heading" }] }],
    subscribe: () => vi.fn(), dispose: vi.fn(),
  } as unknown as AgentSession;
  vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session, aborted: false, steered: false });
  try {
    subagentsExtension(pi);
    await lifecycle.get("tool_execution_start")({}, context);
    await tools.get("Agent").execute("t", { prompt: "test", description: "viewer", subagent_type: "general-purpose", run_in_background: true }, undefined, undefined, context);
    await flush();
    for (let opened = 0; opened < 2; opened++) {
      if (entry === "fleet") {
        if (opened === 0) { input?.("\x1b[B"); input?.("\x1b[B"); }
        input?.("\r");
        await flush();
      } else {
        ui.select.mockImplementationOnce((_title: string, choices: string[]) => choices[0])
          .mockImplementationOnce((_title: string, choices: string[]) => choices[0])
          .mockResolvedValue(undefined);
        const command = pi.registerCommand.mock.calls.find((call: unknown[]) => call[0] === "agents")[1];
        await command.handler("", context);
      }
      expect(loadSettings(sandbox.dir).viewerMarkdown).toBe(opened === 0 ? "assistant" : "all");
    }
    expect(modes[0]).toContain("m raw");
    expect(modes[0]).toContain("# heading");
    expect(modes[1]).toContain("m md");
    expect(modes[1]).not.toContain("# heading");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:settings_changed", expect.objectContaining({ persisted: true }));
  } finally {
    await lifecycle.get("session_shutdown")?.({}, context);
    sandbox.restore();
  }
});
