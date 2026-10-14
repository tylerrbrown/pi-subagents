import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async original => ({ ...await original<Record<string, unknown>>(), runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/custom-agents.js", async original => ({ ...await original<Record<string, unknown>>(), loadCustomAgents: () => [] }));
vi.mock("../src/settings.js", async original => ({ ...await original<Record<string, unknown>>(), loadSettings: () => ({}), applyAndEmitLoaded: vi.fn() }));
vi.mock("../src/output-file.js", async original => ({ ...await original<Record<string, unknown>>(), getOutputTranscriptDefault: () => false }));

import { resumeAgent, runAgent, setDefaultContextThresholds } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { makePi, textOf } from "./helpers/boot-extension.js";
import { childSession, workContext } from "./helpers/work-adapter.js";

let shutdown: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  // Synchronous runner doubles still cross distinct run boundaries.
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now += 10);
  registerAgents([]);
  setDefaultContextThresholds(undefined, undefined);
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    const session = Object.assign(childSession(), { messages: [], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 10 } }) });
    await options?.onSessionCreated?.(session);
    return { session, responseText: "done", aborted: false, timedOut: false, steered: false, contextAborted: false, contextSteered: false,
      contextGuardState: { warnPercent: 60, stopPercent: 80, warned: false, stopped: false, peakPercent: 10 } };
  });
  vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options) => ({
    text: "resumed", timedOut: false, contextAborted: false, contextSteered: false, steered: false,
    contextGuardState: { warnPercent: options?.contextWarnPercent ?? 60, stopPercent: options?.contextStopPercent ?? 80, warned: false, stopped: false, peakPercent: 10 },
  }));
});
afterEach(async () => { await shutdown?.(); shutdown = undefined; vi.restoreAllMocks(); });

async function setup() {
  const host = makePi();
  subagentsExtension(host.pi);
  const ctx = workContext();
  shutdown = async () => { await host.lifecycle.get("session_shutdown")?.({}, ctx); };
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as {
    spawn: (pi: unknown, ctx: unknown, type: string, prompt: string, options: unknown) => string;
    awaitStartup: (id: string) => Promise<void>;
    getRecord: (id: string) => AgentRecord;
  };
  const id = registry.spawn(host.pi, ctx, "general-purpose", "start", { description: "context contract", isBackground: false, contextWarnPercent: 60, contextStopPercent: 80 });
  await registry.awaitStartup(id);
  const record = registry.getRecord(id);
  await record.promise;
  return { agent: host.tools.get("Agent"), ctx, id, record };
}

it("accepts a partial resume override against retained thresholds, not global defaults", async () => {
  const { agent, ctx, id } = await setup();
  const result = await agent.execute("resume-valid", { subagent_type: "general-purpose", description: "resume", prompt: "continue", resume: id, run_in_background: false, context_warn_percent: 65 }, undefined, undefined, ctx);
  expect(textOf(result)).toContain("resumed");
  expect(resumeAgent).toHaveBeenCalledOnce();
  expect(vi.mocked(resumeAgent).mock.calls[0][2]).toMatchObject({ contextWarnPercent: 65 });
});

it("rejects an invalid partial resume override before changing requested posture", async () => {
  const { agent, ctx, id, record } = await setup();
  const posture = { ...record.invocation };
  const result = await agent.execute("resume-invalid", { subagent_type: "general-purpose", description: "resume", prompt: "continue", resume: id, run_in_background: false, context_stop_percent: 50, thinking: "low" }, undefined, undefined, ctx);
  expect(textOf(result)).toContain("0 < warn < stop <= 100");
  expect(record.invocation).toEqual(posture);
  expect(resumeAgent).not.toHaveBeenCalled();
});
