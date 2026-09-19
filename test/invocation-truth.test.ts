import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Runner from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof Runner>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual("../src/worktree.js");
  return { ...actual, pruneWorktrees: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { type EventBus, type RpcReply, registerRpcHandlers } from "../src/cross-extension-rpc.js";
import extension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { buildInvocationTags, formatAgentPosture } from "../src/ui/agent-widget.js";
import { ctx, makePi } from "./helpers/boot-extension.js";

const models = [
  { provider: "openai-codex", id: "astra", name: "Astra" },
  { provider: "pi-sub-anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];
let dir: string;
let oldCwd: string;
let boot: ReturnType<typeof makePi>;
let context: ReturnType<typeof ctx>;
let child: AgentSession;
const registry = () => Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as {
  getRecord(id: string): AgentRecord;
  abort(id: string): boolean;
  spawn: (...args: unknown[]) => string;
};

beforeEach(() => {
  oldCwd = process.cwd();
  dir = mkdtempSync(join(import.meta.dirname, "invocation-fixture-"));
  mkdirSync(join(dir, ".pi"));
  mkdirSync(join(dir, ".claude/agents"), { recursive: true });
  writeFileSync(join(dir, ".pi/subagents.json"), JSON.stringify({ outputTranscript: false, schedulingEnabled: false }));
  writeFileSync(join(dir, ".claude/agents/pinned.md"), "---\ndescription: pinned\nmodel: pi-sub-anthropic/claude-haiku-4-5\nthinking: low\n---\nWork.\n");
  vi.stubEnv("HOME", dir);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "global"));
  process.chdir(dir);
  child = {
    model: models[1], thinkingLevel: "off", messages: [],
    dispose: vi.fn(), subscribe: vi.fn(() => vi.fn()),
  } as unknown as AgentSession;
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(child);
    options.onTextDelta?.("done", "done");
    return { session: child, responseText: "done", aborted: false, steered: false, timedOut: false };
  });
  vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed", timedOut: false });
  context = ctx({ model: models[0], thinkingLevel: "medium", modelRegistry: {
    find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
    getAvailable: () => models,
  } });
  boot = makePi();
  extension(boot.pi);
});

afterEach(async () => {
  await boot.lifecycle.get("session_shutdown")?.({}, context);
  process.chdir(oldCwd);
  vi.unstubAllEnvs();
  registerAgents(new Map());
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function call(params: Record<string, unknown> = {}) {
  return boot.tools.get("Agent").execute("tc", {
    prompt: "go", description: "work", subagent_type: "general-purpose", run_in_background: false, ...params,
  }, undefined, vi.fn(), context);
}

it("records the actual session and retains the raw requested model and clamped thinking", async () => {
  const result = await call({ model: "astra", thinking: "max" });
  const invocation = registry().getRecord(result.details.agentId).invocation;
  expect(invocation).toMatchObject({
    modelId: "pi-sub-anthropic/claude-haiku-4-5", thinking: "off",
    requestedModel: "astra", requestedModelId: "openai-codex/astra", requestedThinking: "max",
  });
  expect(result.details.tags).toContain("thinking: off (asked max)");
  expect(result.details.modelName).toContain("asked astra");
});

it("preserves caller requests when agent-file pins win", async () => {
  const result = await call({ subagent_type: "pinned", model: "astra", thinking: "max" });
  expect(registry().getRecord(result.details.agentId).invocation).toMatchObject({ requestedModel: "astra", requestedThinking: "max", thinking: "off" });
  expect(result.details.modelName).toContain("asked astra");
});

it("keeps an honored alias without falsely disclosing a model mismatch", async () => {
  const result = await call({ subagent_type: "pinned", model: "haiku", thinking: "off" });
  expect(registry().getRecord(result.details.agentId).invocation?.requestedModel).toBe("haiku");
  expect(result.details.modelName).toBe("haiku 4.5");
});

it("captures inherited parent thinking before capability clamping", async () => {
  const result = await call();
  expect(registry().getRecord(result.details.agentId).invocation).toMatchObject({ requestedThinking: "medium", thinking: "off" });
});

it.each([false, true])("resume reads the session, not the new call's prediction (background=%s)", async background => {
  const first = await call();
  const result = await call({ resume: first.details.agentId, model: "astra", thinking: "max", run_in_background: background });
  expect(result.details.tags).toContain("thinking: off (asked max)");
  expect(registry().getRecord(first.details.agentId).invocation?.thinking).toBe("off");
});

it.each(["running", "queued"] as const)("does not mutate posture when a %s background resume is rejected", async status => {
  const first = await call({ model: "haiku", thinking: "off" });
  const record = registry().getRecord(first.details.agentId);
  const before = { ...record.invocation };
  record.status = status;

  const rejected = await call({
    resume: first.details.agentId,
    model: "astra",
    thinking: "max",
    run_in_background: true,
  });

  expect(rejected.content[0].text).toContain(`still ${status}`);
  expect(resumeAgent).not.toHaveBeenCalled();
  expect(record.invocation).toEqual(before);
});

it.each(["running", "queued"] as const)("does not mutate anything when a foreground %s resume is rejected", async status => {
  const first = await call({ model: "haiku", thinking: "off" });
  const record = registry().getRecord(first.details.agentId);
  const beforeInvocation = { ...record.invocation };
  const beforeSession = record.session;
  record.status = status;

  const rejected = await call({
    resume: first.details.agentId,
    model: "astra",
    thinking: "max",
    run_in_background: false,
  });

  expect(rejected.content[0].text).toContain(`still ${status}`);
  expect(resumeAgent).not.toHaveBeenCalled();
  expect(record.status).toBe(status);
  expect(record.session).toBe(beforeSession);
  expect(record.invocation).toEqual(beforeInvocation);
});

it.each([
  { status: "running", isBackground: false },
  { status: "queued", isBackground: false },
  { status: "running", isBackground: true },
  { status: "queued", isBackground: true },
] as const)("manager rejects $status resume without mutation (background=$isBackground)", async ({ status, isBackground }) => {
  const manager = new AgentManager();
  try {
    const { id, record } = await manager.spawnAndWait(boot.pi, context, "general-purpose", "go", {
      description: "direct manager",
    });
    record.status = status;
    const before = { ...record, invocation: { ...record.invocation } };
    const beforeSession = record.session;
    const beforeInvocation = record.invocation;
    // A differing live posture makes even premature synchronization observable.
    Object.assign(child, { model: models[0], thinkingLevel: "low" });

    const rejected = await manager.resume(id, "continue", undefined, { isBackground });

    expect(rejected).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(record.status).toBe(status);
    expect(record.session).toBe(beforeSession);
    expect(record.invocation).toBe(beforeInvocation);
    expect(record).toEqual(before);
  } finally {
    await manager.dispose();
  }
});

it("uses an agent-file model for queued posture before a session exists", () => {
  const manager = new AgentManager(undefined, 0);
  try {
    const id = manager.spawn(boot.pi, context, "pinned", "go", {
      description: "queued pinned",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.status).toBe("queued");
    expect(record.session).toBeUndefined();
    expect(record.invocation).toMatchObject({
      requestedModel: "pi-sub-anthropic/claude-haiku-4-5",
      modelId: "pi-sub-anthropic/claude-haiku-4-5",
    });
    expect(buildInvocationTags(record.invocation).modelName).toBe("haiku 4.5");
    expect(formatAgentPosture(record)).toBe("claude-haiku-4-5/low/low");
  } finally {
    manager.dispose();
  }
});

it("synchronizes a mutated session when spawn rejects", async () => {
  vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(child);
    Object.assign(child, { model: models[0], thinkingLevel: "low" });
    throw new Error("provider rejected");
  });

  const result = await call({ model: "haiku", thinking: "max" });
  expect(registry().getRecord(result.details.agentId).invocation).toMatchObject({
    requestedModel: "haiku",
    requestedThinking: "max",
    modelId: "openai-codex/astra",
    thinking: "low",
  });
});

it.each([false, true])("synchronizes a mutated session when resume rejects (background=%s)", async background => {
  const first = await call({ model: "haiku", thinking: "max" });
  vi.mocked(resumeAgent).mockImplementationOnce(async session => {
    Object.assign(session, { model: models[0], thinkingLevel: "low" });
    throw new Error("resume rejected");
  });

  await call({ resume: first.details.agentId, run_in_background: background });
  const record = registry().getRecord(first.details.agentId);
  await record.promise;
  expect(record.invocation).toMatchObject({
    requestedModel: "haiku",
    requestedThinking: "max",
    modelId: "openai-codex/astra",
    thinking: "low",
  });
});

it("external spawns without a UI snapshot record effective and requested values", async () => {
  const id = registry().spawn(boot.pi, context, "general-purpose", "go", {
    description: "external", model: models[0], thinkingLevel: "max",
  });
  await registry().getRecord(id).promise;
  expect(registry().getRecord(id).invocation).toMatchObject({
    modelId: "pi-sub-anthropic/claude-haiku-4-5", requestedModel: "openai-codex/astra", requestedThinking: "max", thinking: "off",
  });
});

it("compact posture retains requested/effective columns after the session is gone", async () => {
  const result = await call({ thinking: "max" });
  const record = registry().getRecord(result.details.agentId);
  record.session = undefined;
  expect(formatAgentPosture(record)).toContain("claude-haiku-4-5/max/off");
  expect(buildInvocationTags(record.invocation).tags).toContain("thinking: off (asked max)");
});

it("retains inherited model identity, not only inherited thinking", async () => {
  const result = await call();
  expect(registry().getRecord(result.details.agentId).invocation).toMatchObject({
    requestedModel: "openai-codex/astra", requestedModelId: "openai-codex/astra",
    requestedThinking: "medium", modelId: "pi-sub-anthropic/claude-haiku-4-5", thinking: "off",
  });
  expect(result.details.modelName).toContain("asked openai-codex/astra");
});

it("retains unopposed agent-file model and thinking requests", async () => {
  const result = await call({ subagent_type: "pinned" });
  expect(registry().getRecord(result.details.agentId).invocation).toMatchObject({
    requestedModel: "pi-sub-anthropic/claude-haiku-4-5",
    requestedModelId: "pi-sub-anthropic/claude-haiku-4-5", requestedThinking: "low",
    modelId: "pi-sub-anthropic/claude-haiku-4-5", thinking: "off",
  });
  expect(result.details.modelName).toBe("haiku 4.5");
  expect(result.details.tags).toContain("thinking: off (asked low)");
});

it("shows no mismatch text or marker when both requests are honored", async () => {
  const result = await call({ model: "haiku", thinking: "off" });
  const record = registry().getRecord(result.details.agentId);
  expect(record.invocation).toMatchObject({ requestedModel: "haiku", requestedThinking: "off", thinking: "off" });
  expect(result.details.modelName).toBe("haiku 4.5");
  expect(result.details.tags).toContain("thinking: off");
  expect(JSON.stringify(result.details)).not.toContain("asked");
  expect(formatAgentPosture(record)).toBe("claude-haiku-4-5/off/off");
});

it("detects a provider mismatch even when the model id and name match", async () => {
  child = { ...child, model: { ...models[0], provider: "other-provider" } } as unknown as AgentSession;
  const result = await call({ model: "astra", thinking: "off" });
  const record = registry().getRecord(result.details.agentId);
  expect(record.invocation).toMatchObject({ requestedModelId: "openai-codex/astra", modelId: "other-provider/astra" });
  expect(result.details.modelName).toBe("astra (asked astra)");
  expect(formatAgentPosture(record)).toBe("≠ astra/off/off");
});

it("refreshes actual settings at completion without overwriting the request", async () => {
  vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
    options.onSessionCreated?.(child);
    const finalSession = { ...child, model: models[0], thinkingLevel: "low" } as unknown as AgentSession;
    return { session: finalSession, responseText: "done", aborted: false, steered: false, timedOut: false };
  });
  const result = await call({ model: "haiku", thinking: "max" });
  expect(registry().getRecord(result.details.agentId).invocation).toMatchObject({
    requestedModel: "haiku", requestedThinking: "max", modelId: "openai-codex/astra", thinking: "low",
  });
  expect(result.details.modelName).toBe("astra (asked haiku)");
  expect(result.details.tags).toContain("thinking: low (asked max)");
});

it.each([false, true])("refreshes completion-time resume changes while retaining prior requests (background=%s)", async background => {
  const first = await call({ model: "haiku", thinking: "max" });
  vi.mocked(resumeAgent).mockImplementationOnce(async () => {
    Object.assign(child, { model: models[0], thinkingLevel: "low" });
    return { text: "resumed", timedOut: false };
  });
  await call({ resume: first.details.agentId, run_in_background: background });
  const record = registry().getRecord(first.details.agentId);
  await record.promise;
  expect(record.invocation).toMatchObject({
    requestedModel: "haiku", requestedThinking: "max", modelId: "openai-codex/astra", thinking: "low",
  });
  expect(formatAgentPosture(record)).toBe("≠ astra/max/low");
});

it.each(["astra", "haiku"])("RPC preserves raw alias %s through the real manager to the display", async model => {
  const listeners = new Map<string, (data: unknown) => void>();
  const events: EventBus = {
    on: (event, handler) => {
      listeners.set(event, handler);
      return () => { listeners.delete(event); };
    },
    emit: (event, data) => { listeners.get(event)?.(data); },
  };
  registerRpcHandlers({ events, pi: boot.pi, getCtx: () => context, manager: registry() });
  const response = new Promise<RpcReply<{ id: string }>>(resolve => {
    events.on("subagents:rpc:spawn:reply:truth", data => resolve(data as RpcReply<{ id: string }>));
  });
  events.emit("subagents:rpc:spawn", {
    requestId: "truth", type: "general-purpose", prompt: "go",
    options: { model, thinkingLevel: "max", description: "RPC truth" },
  });
  const reply = await response;
  expect(reply.success).toBe(true);
  if (!reply.success || !reply.data) throw new Error("RPC spawn failed");
  const record = registry().getRecord(reply.data.id);
  await record.promise;
  expect(record.invocation).toMatchObject({
    requestedModel: model, requestedThinking: "max",
    requestedModelId: model === "astra" ? "openai-codex/astra" : "pi-sub-anthropic/claude-haiku-4-5",
    modelId: "pi-sub-anthropic/claude-haiku-4-5", thinking: "off",
  });
  expect(buildInvocationTags(record.invocation)).toEqual({
    modelName: model === "astra" ? "haiku 4.5 (asked astra)" : "haiku 4.5",
    tags: ["thinking: off (asked max)"],
  });
});
