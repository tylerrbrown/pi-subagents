/**
 * workflow.e2e.test.ts — the Workflow tool driven end to end, for real.
 *
 * Every other workflow suite stubs something. The runtime tests inject a fake
 * `WorkflowHost`; the tool tests drive a stub `AgentManager`. Both are the right
 * call for what they assert, but neither proves the parts fit together: a script
 * has to be parsed, compiled in a vm inside a worker thread, call back over the
 * RPC bridge, reach the real `AgentManager`, spawn real agent sessions against a
 * faux model, and carry results back across the JSON boundary.
 *
 * The evidence used here is what the *child* model calls actually saw. If a
 * subagent's context contains the prompt the script wrote, then every link in
 * that chain ran — nothing else could have put it there.
 *
 * No network and no keys: the faux backend answers every model call.
 */

import { fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { runPrintMode } from "../helpers/print-mode-runner.js";

/** A `Workflow` tool call, the way the parent model would emit one. */
const workflowCall = (script: string, id = "wf-call-1") =>
  fauxToolCall("Workflow", { script }, { id });

/** Everything the faux backend was ever asked, flattened for substring checks. */
const asText = (context: { messages?: unknown[] }) => JSON.stringify(context.messages ?? []);

/** Poll until `predicate` holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("Workflow end to end", () => {
  it("runs a real script whose agents reach real sessions with the script's prompts", async () => {
    const script = [
      'export const meta = { name: "e2e-fanout", description: "spawn two agents", phases: [{ title: "Work" }] };',
      'phase("Work");',
      "const results = await parallel([",
      '  () => agent("FIRST-TASK-MARKER", { label: "one" }),',
      '  () => agent("SECOND-TASK-MARKER", { label: "two" }),',
      "]);",
      'log("collected " + results.length);',
      "return results;",
    ].join("\n");

    /** Prompts the faux backend saw on non-parent (i.e. subagent) calls. */
    const childPrompts: string[] = [];

    const run = await runPrintMode({
      prompt: "run the workflow",
      maxModelCalls: 32,
      respond: context => {
        const isParent = (context.tools ?? []).some(t => t.name === "Workflow");
        if (!isParent) {
          childPrompts.push(asText(context));
          return fauxText("SUBAGENT-DONE");
        }
        return asText(context).includes("Task ID")
          ? fauxText("workflow launched")
          : workflowCall(script);
      },
    });

    try {
      // The tool reported a background task rather than an error.
      expect(asText(run.parentSession as unknown as { messages?: unknown[] })).toContain("Task ID");

      // The detached run is still going when the parent turn ends — that is the
      // point of background dispatch — so wait for the children to actually run.
      const sawBoth = await waitFor(
        () =>
          childPrompts.some(p => p.includes("FIRST-TASK-MARKER")) &&
          childPrompts.some(p => p.includes("SECOND-TASK-MARKER")),
      );

      expect(sawBoth, `child prompts seen: ${childPrompts.length}`).toBe(true);
      await run.manager?.waitForAll();
    } finally {
      await run.dispose?.();
    }
  }, 90_000);

  it("surfaces a script that fails to parse instead of launching it", async () => {
    const childPrompts: string[] = [];

    const run = await runPrintMode({
      prompt: "run the broken workflow",
      maxModelCalls: 12,
      respond: context => {
        const isParent = (context.tools ?? []).some(t => t.name === "Workflow");
        if (!isParent) {
          childPrompts.push(asText(context));
          return fauxText("SUBAGENT-DONE");
        }
        return asText(context).includes("PURE LITERAL")
          ? fauxText("reported")
          : workflowCall(
              'export const meta = { name: computeName(), description: "x" };\n',
              "wf-call-2",
            );
      },
    });

    try {
      // The author-facing rejection reaches the model, not a stack trace.
      expect(asText(run.parentSession as unknown as { messages?: unknown[] })).toContain("PURE LITERAL");
      // And nothing was spawned for a script that never compiled.
      expect(childPrompts).toHaveLength(0);
    } finally {
      await run.dispose?.();
    }
  }, 60_000);
});
