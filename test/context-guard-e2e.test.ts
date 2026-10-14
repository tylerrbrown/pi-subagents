import { fileURLToPath } from "node:url";
import { type Context, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { agentCall, agentToolResults, type PrintModeRun, routeBySession, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 45_000 });
let run: PrintModeRun | undefined;
afterEach(async () => { await run?.dispose(); run = undefined; });

it("real Pi child warns and exposes the context reason to its real parent", async () => {
  run = await runPrintMode({
    live: false,
    prompt: "Delegate bounded work.",
    respond: routeBySession({
      parentInitial: agentCall({ description: "context warning proof", prompt: "Return a short finding.", run_in_background: false, context_warn_percent: 0.0001, context_stop_percent: 99 }),
      subagent: "CHILD_FINDING",
      parentFinal: "parent finished",
    }),
  });
  expect(agentToolResults(run.parentSession).join("\n")).toContain("context warning");
  expect(agentToolResults(run.parentSession).join("\n")).toContain("CHILD_FINDING");
});

it("packaged real Pi child ceiling returns an unfinished outcome rather than completion", async () => {
  run = await runPrintMode({
    extensionPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
    live: false,
    prompt: "Delegate bounded work.",
    respond: routeBySession({
      parentInitial: agentCall({ description: "context ceiling proof", prompt: "Return a short finding.", run_in_background: false, context_warn_percent: 0.0001, context_stop_percent: 0.001 }),
      subagent: "CHILD_FINDING",
      parentFinal: "parent finished",
    }),
  });
  const output = agentToolResults(run.parentSession).join("\n");
  expect(output).toContain("context ceiling");
  expect(output).toContain("unfinished");
  expect(output).not.toContain("Agent completed");
});

it("real resumed child applies a lowered ceiling and reports its hard stop", async () => {
  let resumeSent = false;
  let resultRequested = false;
  run = await runPrintMode({
    live: false,
    prompt: "Delegate then resume bounded work.",
    respond: routeBySession({
      parentInitial: agentCall({ description: "resume context proof", prompt: "Return a short finding.", run_in_background: true }),
      subagent: "CHILD_FINDING",
      parentFinal: (context: Context) => {
        if (resumeSent) return "parent finished";
        const initial = context.messages.find(message => message.role === "toolResult" && message.toolName === "Agent");
        const text = initial?.content.map(block => block.type === "text" ? block.text : "").join("") ?? "";
        const id = /Agent ID: ([a-z0-9-]+)/i.exec(text)?.[1];
        if (!id) return "missing child identity";
        if (!resultRequested) {
          resultRequested = true;
          return fauxToolCall("get_subagent_result", { agent_id: id, wait: true });
        }
        resumeSent = true;
        return agentCall({ description: "resume ceiling proof", prompt: "Continue.", resume: id, run_in_background: false, context_warn_percent: 0.0001, context_stop_percent: 0.001 });
      },
    }),
  });
  expect(resumeSent).toBe(true);
  const output = agentToolResults(run.parentSession).join("\n");
  expect(output).toContain("context ceiling");
  expect(output).toContain("unfinished");
});
