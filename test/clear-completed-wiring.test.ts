/**
 * clear-completed-wiring.test.ts — reproduces issue #108 end-to-end through the
 * REAL session lifecycle handlers + the REAL get_subagent_result tool.
 *
 * Completed results now survive in the parent session's append-only ledger,
 * rather than by leaking terminal AgentManager records across session switches.
 * These tests pin both halves: a switched-to session cannot see the old result,
 * while reopening the old branch reconstructs it through the real result tool.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>(); // pi.on(...) — session_start, session_before_switch, session_shutdown
  const events = new Map<string, any>(); // pi.events.on(...) — subagents:rpc:*, etc.
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        events.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn((customType: string, data?: unknown) => entries.push({ customType, data })),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, events, entries };
}

function ctx(branch: unknown[] = [], sessionId = "s1") {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => sessionId), getBranch: vi.fn(() => branch) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
// Let runAgent's resolved .then() chain settle so the record reaches "completed".
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

// Spawn a real background agent and drive it to status "completed" with
// resultConsumed=false (only get_subagent_result sets that flag for background).
async function spawnCompletedBackgroundAgent(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-RESULT-PAYLOAD",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  });
  const spawn = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "Review monero_en.rs in depth", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  expect(id, "background spawn should surface an agent id").toBeTruthy();
  await flush();
  return id as string;
}

describe("issue #108: unread completed background agents follow their parent session", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir, scheduling off, so session_start doesn't spin a
    // scheduler or touch the dev's filesystem — isolates the clearCompleted path.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-108-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-108-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("session_before_switch evicts the old session's terminal live record", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const id = await spawnCompletedBackgroundAgent(tools);

    await lifecycle.get("session_before_switch")?.();

    const res = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(res)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("waits for an aborted running A agent to settle and persist before B can activate", async () => {
    const { pi, tools, lifecycle, entries } = makePi();
    subagentsExtension(pi);
    const sessionA = ctx(entries, "session-a");
    await lifecycle.get("session_start")?.({}, sessionA);

    let aborted = false;
    let settle!: () => void;
    vi.mocked(runAgent).mockImplementation((_runCtx, _type, _prompt, options) =>
      new Promise(resolve => {
        options.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
        settle = () => resolve({
          responseText: "A-DEFERRED-RESULT",
          session: { dispose: vi.fn() } as any,
          aborted: false,
          steered: false,
        });
      }),
    );

    const spawned = await tools.get("Agent").execute(
      "tc-running-a",
      { prompt: "deferred", description: "Deferred A agent", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      sessionA,
    );
    const id = textOf(spawned).match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();

    let switched = false;
    const switching = lifecycle.get("session_before_switch")?.().then(() => { switched = true; });
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(switched).toBe(false);

    settle();
    await switching;
    expect(entries.some(entry =>
      entry.customType === "subagents:record"
      && JSON.stringify(entry.data).includes("A-DEFERRED-RESULT")
    )).toBe(true);
    const branchA = structuredClone(entries);

    const sessionB = ctx([], "session-b");
    await lifecycle.get("session_start")?.({}, sessionB);
    const fromB = await tools.get("get_subagent_result").execute("tc-b", { agent_id: id }, undefined, undefined, sessionB);
    expect(textOf(fromB)).toContain("Agent not found");
    await lifecycle.get("agent_settled")?.({}, sessionB);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await lifecycle.get("session_before_switch")?.();
    const reopenedA = ctx(branchA, "session-a");
    await lifecycle.get("session_start")?.({}, reopenedA);
    const fromA = await tools.get("get_subagent_result").execute("tc-a", { agent_id: id }, undefined, undefined, reopenedA);
    expect(textOf(fromA)).toContain("A-DEFERRED-RESULT");

    await lifecycle.get("session_shutdown")?.({}, reopenedA);
  });

  it("synchronously retries A persistence during switch before B can activate", async () => {
    const { pi, tools, lifecycle, entries } = makePi();
    subagentsExtension(pi);
    const sessionA = ctx(entries, "session-a");
    await lifecycle.get("session_start")?.({}, sessionA);

    let settle!: () => void;
    vi.mocked(runAgent).mockImplementation((_runCtx, _type, _prompt, options) =>
      new Promise(resolve => {
        settle = () => resolve({
          responseText: "A-TRANSIENT-APPEND-RESULT",
          session: { dispose: vi.fn() } as any,
          aborted: false,
          steered: false,
        });
        options.signal?.addEventListener("abort", () => {}, { once: true });
      }),
    );

    const spawned = await tools.get("Agent").execute(
      "tc-transient-a",
      { prompt: "transient", description: "Transient A append", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      sessionA,
    );
    const id = textOf(spawned).match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();

    const appendEntry = vi.mocked(pi.appendEntry);
    const append = appendEntry.getMockImplementation()!;
    let recordAttempts = 0;
    appendEntry.mockImplementation((customType: string, data?: unknown) => {
      if (customType === "subagents:record" && JSON.stringify(data).includes("A-TRANSIENT-APPEND-RESULT")) {
        recordAttempts++;
        if (recordAttempts === 1) throw new Error("transient A append failure");
      }
      return append(customType, data);
    });

    const switching = lifecycle.get("session_before_switch")?.();
    await Promise.resolve();
    settle();
    await switching;

    expect(recordAttempts).toBe(2);
    expect(entries.some(entry =>
      entry.customType === "subagents:record"
      && JSON.stringify(entry.data).includes("A-TRANSIENT-APPEND-RESULT")
    )).toBe(true);
    const branchA = structuredClone(entries);

    const sessionB = ctx([], "session-b");
    await lifecycle.get("session_start")?.({}, sessionB);
    expect(textOf(await tools.get("get_subagent_result").execute("tc-b", { agent_id: id }, undefined, undefined, sessionB)))
      .toContain("Agent not found");

    await lifecycle.get("session_before_switch")?.();
    const reopenedA = ctx(branchA, "session-a");
    await lifecycle.get("session_start")?.({}, reopenedA);
    expect(textOf(await tools.get("get_subagent_result").execute("tc-a", { agent_id: id }, undefined, undefined, reopenedA)))
      .toContain("A-TRANSIENT-APPEND-RESULT");

    await lifecycle.get("session_shutdown")?.({}, reopenedA);
  });

  it("warns after bounded switch retries are exhausted and never carries A into B", async () => {
    const { pi, tools, lifecycle, entries } = makePi();
    subagentsExtension(pi);
    const sessionA = ctx(entries, "session-a");
    await lifecycle.get("session_start")?.({}, sessionA);

    let settle!: () => void;
    vi.mocked(runAgent).mockImplementation(() =>
      new Promise(resolve => {
        settle = () => resolve({
          responseText: "A-EXHAUSTED-APPEND-RESULT",
          session: { dispose: vi.fn() } as any,
          aborted: false,
          steered: false,
        });
      }),
    );
    const spawned = await tools.get("Agent").execute(
      "tc-exhausted-a",
      { prompt: "exhausted", description: "Exhausted A append", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      sessionA,
    );
    const id = textOf(spawned).match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();

    const appendEntry = vi.mocked(pi.appendEntry);
    const append = appendEntry.getMockImplementation()!;
    let recordAttempts = 0;
    appendEntry.mockImplementation((customType: string, data?: unknown) => {
      if (customType === "subagents:record" && JSON.stringify(data).includes("A-EXHAUSTED-APPEND-RESULT")) {
        recordAttempts++;
        throw new Error("A record store offline");
      }
      return append(customType, data);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const switching = lifecycle.get("session_before_switch")?.();
    await Promise.resolve();
    settle();
    await switching;

    expect(recordAttempts).toBe(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(id as string));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not attached to the next session"));
    expect(entries.some(entry => JSON.stringify(entry.data).includes("A-EXHAUSTED-APPEND-RESULT"))).toBe(false);

    const sessionB = ctx([], "session-b");
    await lifecycle.get("session_start")?.({}, sessionB);
    await lifecycle.get("agent_settled")?.({}, sessionB);
    expect(recordAttempts).toBe(4);
    expect(textOf(await tools.get("get_subagent_result").execute("tc-b", { agent_id: id }, undefined, undefined, sessionB)))
      .toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, sessionB);
  });

  it("session B cannot read A while reopening A restores its ledger result", async () => {
    const { pi, tools, lifecycle, entries } = makePi();
    subagentsExtension(pi);
    const id = await spawnCompletedBackgroundAgent(tools);
    const branchA = structuredClone(entries);

    await lifecycle.get("session_before_switch")?.();
    await lifecycle.get("session_start")?.({}, ctx([], "session-b"));
    const fromB = await tools.get("get_subagent_result").execute("tc-b", { agent_id: id }, undefined, undefined, ctx([], "session-b"));
    expect(textOf(fromB)).toContain("Agent not found");

    await lifecycle.get("session_before_switch")?.();
    await lifecycle.get("session_start")?.({}, ctx(branchA, "session-a"));
    const fromA = await tools.get("get_subagent_result").execute("tc-a", { agent_id: id }, undefined, undefined, ctx(branchA, "session-a"));
    expect(textOf(fromA)).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("a consumed terminal live record is also evicted on switch", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const id = await spawnCompletedBackgroundAgent(tools);

    // LLM reads the result → resultConsumed=true.
    const first = await tools.get("get_subagent_result").execute("tc-read1", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(first)).toContain("THE-RESULT-PAYLOAD");

    // Session boundaries evict every terminal live manager record.
    await lifecycle.get("session_before_switch")?.();

    const second = await tools.get("get_subagent_result").execute("tc-read2", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(second)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
