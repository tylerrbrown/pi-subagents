/**
 * wait-ceiling-wiring.test.ts — b2 through the REAL extension's tools.
 *
 * The unit tests prove the primitives; this proves `get_subagent_result` uses
 * them: a lone blocking join returns a typed still-running result at the
 * ceiling (leaving the agent running and unconsumed so its completion
 * notification still fires), and a parallel join is refused outright.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { resetBlockingWaits, setWaitCeilingMs } from "../src/wait-ceiling.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

async function spawnBackground(tools: Map<string, any>, description: string): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description, subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

describe("get_subagent_result — bounded blocking join", () => {
  afterEach(() => {
    resetBlockingWaits();
    setWaitCeilingMs(undefined);
  });

  it("returns a typed still-running result at the ceiling and leaves the agent alone", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    setWaitCeilingMs(1000);

    const id = await spawnBackground(tools, "slow specialist");
    const result = await tools
      .get("get_subagent_result")
      .execute("tc-wait", { agent_id: id, wait: true }, undefined, undefined, ctx());

    const text = textOf(result);
    expect(text).toContain("still running");
    expect(text).toMatch(/wait ceiling/i);
    // Not stopped, and not consumed — the notification is still the way home.
    expect(text).toContain("Status: running");
    await lifecycle.get("session_shutdown")?.();
  }, 20_000);

  it("refuses a second concurrent blocking join instead of building a barrier", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    setWaitCeilingMs(2000);

    const a = await spawnBackground(tools, "reviewer");
    const b = await spawnBackground(tools, "security");

    const first = tools.get("get_subagent_result")
      .execute("tc-a", { agent_id: a, wait: true }, undefined, undefined, ctx());
    await flush();
    const second = await tools.get("get_subagent_result")
      .execute("tc-b", { agent_id: b, wait: true }, undefined, undefined, ctx());

    const refusal = textOf(second);
    expect(refusal).toMatch(/^Refused:/);
    expect(refusal).toMatch(/notified as each agent completes/i);
    const third = await tools.get("get_subagent_result")
      .execute("tc-c", { agent_id: b, wait: true }, undefined, undefined, ctx());
    expect(textOf(third)).toMatch(/^Refused:/);
    await first;
    await lifecycle.get("session_shutdown")?.();
  }, 30_000);

  it("a child extension lifecycle cannot reset the root wait gate", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const root = makePi();
    subagentsExtension(root.pi);
    setWaitCeilingMs(2000);
    const a = await spawnBackground(root.tools, "reviewer");
    const b = await spawnBackground(root.tools, "security");

    const first = root.tools.get("get_subagent_result")
      .execute("tc-root", { agent_id: a, wait: true }, undefined, undefined, ctx());
    await flush();

    const child = makePi();
    subagentsExtension(child.pi);
    await child.lifecycle.get("session_start")?.({}, ctx());
    const second = await root.tools.get("get_subagent_result")
      .execute("tc-root-2", { agent_id: b, wait: true }, undefined, undefined, ctx());
    expect(textOf(second)).toMatch(/^Refused:/);

    await first;
    await child.lifecycle.get("session_shutdown")?.({}, ctx());
    await root.lifecycle.get("session_shutdown")?.({}, ctx());
  }, 30_000);

  it("refuses the NEXT sequential join once one has hit the ceiling", async () => {
    // The shape that actually happens: pi executes a turn's tool calls one
    // after another, so a five-specialist batch is five SEQUENTIAL joins and
    // the barrier is five ceilings deep. One ceiling hit spends the budget.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    setWaitCeilingMs(1000);

    const a = await spawnBackground(tools, "reviewer");
    const b = await spawnBackground(tools, "security");

    const firstText = textOf(await tools.get("get_subagent_result")
      .execute("tc-a", { agent_id: a, wait: true }, undefined, undefined, ctx()));
    expect(firstText).toMatch(/wait ceiling/i);

    const secondText = textOf(await tools.get("get_subagent_result")
      .execute("tc-b", { agent_id: b, wait: true }, undefined, undefined, ctx()));
    expect(secondText).toMatch(/^Refused:/);
    await lifecycle.get("session_shutdown")?.();
  }, 30_000);

  it("admits blocking waits again after an agent settles", async () => {
    let settleFirst!: (value: any) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise(resolve => { settleFirst = resolve; }))
      .mockImplementation(() => new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    setWaitCeilingMs(1000);

    const a = await spawnBackground(tools, "reviewer");
    const b = await spawnBackground(tools, "security");
    await tools.get("get_subagent_result")
      .execute("tc-a", { agent_id: a, wait: true }, undefined, undefined, ctx());
    expect(textOf(await tools.get("get_subagent_result")
      .execute("tc-b1", { agent_id: b, wait: true }, undefined, undefined, ctx())))
      .toMatch(/^Refused:/);

    settleFirst({ responseText: "done", session: { messages: [] }, aborted: false, steered: false });
    await flush();
    const admitted = await tools.get("get_subagent_result")
      .execute("tc-b2", { agent_id: b, wait: true }, undefined, undefined, ctx());
    expect(textOf(admitted)).toMatch(/wait ceiling/i);
    await lifecycle.get("session_shutdown")?.();
  }, 30_000);

  it("does not refuse a non-blocking status check while a join is in flight", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    setWaitCeilingMs(2000);

    const a = await spawnBackground(tools, "reviewer");
    const first = tools.get("get_subagent_result")
      .execute("tc-a", { agent_id: a, wait: true }, undefined, undefined, ctx());
    await flush();
    const peek = await tools.get("get_subagent_result")
      .execute("tc-peek", { agent_id: a }, undefined, undefined, ctx());
    expect(textOf(peek)).toContain("Status: running");
    expect(textOf(peek)).not.toMatch(/^Refused:/);
    await first;
    await lifecycle.get("session_shutdown")?.();
  }, 30_000);
});
