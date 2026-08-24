/**
 * Regression coverage for durable, idle-gated background completion delivery.
 *
 * These are wiring tests: they activate the real extension, call its registered
 * Agent/get_subagent_result tools, and drive its real session lifecycle hooks.
 * Only the child model boundary and Pi host surfaces are controllable fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, resumeAgent: vi.fn(), runAgent: vi.fn() };
});

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { foldNotificationLedger } from "../src/notification-ledger.js";
import { type Hermetic, hermeticDir } from "./helpers/boot-extension.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
}

interface RegisteredTool {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: unknown,
  ) => Promise<ToolResult>;
}

interface CapturedEntry {
  type: "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data?: unknown;
  sequence: number;
}

interface SentMessage {
  message: unknown;
  options: unknown;
  sequence: number;
}

type LifecycleHandler = (event: Record<string, unknown>, context: TestContext) => unknown | Promise<unknown>;

interface TestContext {
  mode: "tui";
  hasUI: false;
  ui: {
    setStatus: ReturnType<typeof vi.fn>;
    setWidget: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    addAutocompleteProvider: ReturnType<typeof vi.fn>;
  };
  cwd: string;
  model: undefined;
  modelRegistry: { find: ReturnType<typeof vi.fn>; getAvailable: ReturnType<typeof vi.fn> };
  sessionManager: {
    getSessionId: ReturnType<typeof vi.fn>;
    getBranch: ReturnType<typeof vi.fn>;
  };
  getSystemPrompt: ReturnType<typeof vi.fn>;
  isIdle: ReturnType<typeof vi.fn>;
  hasPendingMessages: ReturnType<typeof vi.fn>;
}

interface Harness {
  pi: ExtensionAPI;
  tools: Map<string, RegisteredTool>;
  lifecycle: Map<string, LifecycleHandler[]>;
  entries: CapturedEntry[];
  sent: SentMessage[];
  followUps: SentMessage[];
  context: TestContext;
  idle: { value: boolean };
  pendingMessages: { value: boolean };
  nextSequence: () => number;
  shutdown: boolean;
}

interface Outcome {
  result: string;
  transcript: string;
  failure?: string;
}

let hermetic: Hermetic | undefined;
const harnesses: Harness[] = [];

function cloneEntries(entries: CapturedEntry[]): CapturedEntry[] {
  return JSON.parse(JSON.stringify(entries)) as CapturedEntry[];
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function entryMarks(entry: CapturedEntry, agentId: string, marker: "consum" | "claim"): boolean {
  const body = serialized(entry.data).toLowerCase();
  if (!body.includes(agentId.toLowerCase())) return false;
  if (entry.customType.toLowerCase().includes(marker)) return true;
  if (!entry.data || typeof entry.data !== "object") return false;
  for (const [key, value] of Object.entries(entry.data)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes(marker)) return true;
    if (["action", "delivery", "event", "kind", "state"].includes(normalizedKey)) {
      if (String(value).toLowerCase().includes(marker)) return true;
    }
  }
  return false;
}

function wakeText(harness: Harness): string {
  return harness.sent.map(({ message }) => {
    if (message && typeof message === "object" && "content" in message) return String(message.content);
    return serialized(message);
  }).join("\n");
}

function makeHarness(seed: CapturedEntry[] = [], idleInitially = false, sessionId = "notification-replay-session"): Harness {
  const tools = new Map<string, RegisteredTool>();
  const lifecycle = new Map<string, LifecycleHandler[]>();
  const entries = cloneEntries(seed);
  const sent: SentMessage[] = [];
  const followUps: SentMessage[] = [];
  const idle = { value: idleInitially };
  const pendingMessages = { value: false };
  let sequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
  const nextSequence = () => ++sequence;

  const context: TestContext = {
    mode: "tui",
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      addAutocompleteProvider: vi.fn(),
    },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: vi.fn(() => sessionId),
      getBranch: vi.fn(() => entries),
    },
    getSystemPrompt: vi.fn(() => "parent"),
    isIdle: vi.fn(() => idle.value),
    hasPendingMessages: vi.fn(() => pendingMessages.value),
  };

  const piShape = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerMarkdownTransformer: vi.fn(),
    registerTool: vi.fn((tool: RegisteredTool) => tools.set((tool as RegisteredTool & { name: string }).name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: LifecycleHandler) => {
      const handlers = lifecycle.get(event) ?? [];
      handlers.push(handler);
      lifecycle.set(event, handlers);
    }),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      const entry: CapturedEntry = {
        type: "custom",
        id: `entry-${sequence + 1}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        customType,
        data,
        sequence: nextSequence(),
      };
      entries.push(entry);
    }),
    sendMessage: vi.fn((message: unknown, options?: unknown) => {
      const call = { message, options, sequence: nextSequence() };
      sent.push(call);
      const delivery = options as { deliverAs?: string } | undefined;
      if (delivery?.deliverAs === "followUp") followUps.push(call);
    }),
  };

  const harness: Harness = {
    pi: piShape as unknown as ExtensionAPI,
    tools,
    lifecycle,
    entries,
    sent,
    followUps,
    context,
    idle,
    pendingMessages,
    nextSequence,
    shutdown: false,
  };
  harnesses.push(harness);
  subagentsExtension(harness.pi);
  return harness;
}

async function fire(harness: Harness, event: string, payload: Record<string, unknown> = {}): Promise<void> {
  for (const handler of harness.lifecycle.get(event) ?? []) {
    await handler({ type: event, ...payload }, harness.context);
  }
}

async function activate(seed: CapturedEntry[] = [], idleInitially = false, sessionId?: string): Promise<Harness> {
  const harness = makeHarness(seed, idleInitially, sessionId);
  await fire(harness, "session_start", { reason: "startup" });
  return harness;
}

async function shutdown(harness: Harness): Promise<void> {
  if (harness.shutdown) return;
  harness.shutdown = true;
  await fire(harness, "session_shutdown", { reason: "quit" });
}

function queueOutcome(outcome: Outcome): void {
  vi.mocked(runAgent).mockImplementationOnce(async (_context, _type, _prompt, options) => {
    const session = {
      messages: [
        { role: "user", content: outcome.transcript },
        {
          role: "assistant",
          content: [{ type: "text", text: outcome.result }],
          usage: {
            input: 100,
            output: 20,
            cacheRead: 7,
            cacheWrite: 5,
            cost: { total: 0.0125 },
          },
        },
      ],
      steer: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
      getActiveToolNames: vi.fn(() => []),
    };
    options.onSessionCreated?.(session as never);
    options.onAssistantUsage?.({ input: 100, output: 20, cacheRead: 7, cacheWrite: 5, cost: 0.0125 });
    return {
      responseText: outcome.result,
      session: session as never,
      aborted: false,
      steered: false,
      failure: outcome.failure,
    };
  });
}

async function spawnCompleted(harness: Harness, outcome: Outcome): Promise<string> {
  queueOutcome(outcome);
  const result = await harness.tools.get("Agent")!.execute(
    `spawn-${outcome.transcript}`,
    {
      prompt: outcome.transcript,
      description: outcome.transcript,
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    harness.context,
  );
  const id = /Agent ID: (\S+)/.exec(textOf(result))?.[1];
  expect(id, "background spawn should return its real agent id").toBeTruthy();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return id as string;
}

async function readResult(harness: Harness, id: string, verbose = false): Promise<ToolResult> {
  return harness.tools.get("get_subagent_result")!.execute(
    `read-${id}`,
    { agent_id: id, verbose },
    undefined,
    undefined,
    harness.context,
  );
}

async function advanceDelivery(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
}

function persistedData(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id,
    handles: { handle: "explore" },
    type: "Explore",
    description: "strict persisted record",
    status: "completed",
    result: "persisted result",
    toolUses: 2,
    startedAt: 100,
    completedAt: 200,
    lifetimeUsage: { input: 10, output: 5, cacheWrite: 1, cacheRead: 2, cost: 0.01 },
    compactionCount: 0,
    contextPercent: 25,
    isBackground: true,
    output: {},
    conversation: "persisted conversation",
    notificationPending: true,
    ...overrides,
  };
}

function customEntry(customType: string, data: unknown): Record<string, unknown> {
  return { type: "custom", customType, data };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  hermetic = hermeticDir({
    settings: {
      schedulingEnabled: false,
      outputTranscript: false,
      defaultJoinMode: "async",
    },
  });
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await shutdown(harness);
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")];
  hermetic?.restore();
  hermetic = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("durable notification replay", () => {
  it("keeps busy completions out of sendMessage/followUp and durably consumes before get_subagent_result resolves", async () => {
    const harness = await activate([], false);
    const pendingId = await spawnCompleted(harness, {
      result: "PENDING-BUSY-RESULT",
      transcript: "pending busy transcript",
    });
    const consumedId = await spawnCompleted(harness, {
      result: "CONSUMED-BEFORE-SETTLED",
      transcript: "consumed busy transcript",
    });

    const result = await readResult(harness, consumedId, true);
    const resolvedAt = harness.nextSequence();
    await advanceDelivery();

    const consumedAck = harness.entries.find((entry) => entryMarks(entry, consumedId, "consum"));
    expect.soft(consumedAck, "consumption must be appended as a custom audit entry").toBeDefined();
    expect.soft(consumedAck?.sequence ?? Number.POSITIVE_INFINITY, "the durable acknowledgment must precede tool resolution").toBeLessThan(resolvedAt);
    expect.soft(textOf(result)).toContain("CONSUMED-BEFORE-SETTLED");
    expect.soft(harness.sent, `busy completion ${pendingId} must not call pi.sendMessage`).toHaveLength(0);
    expect.soft(harness.followUps, "busy completion must never enter Pi's followUp queue").toHaveLength(0);

    harness.idle.value = true;
    await fire(harness, "agent_settled");
    await advanceDelivery();
    expect(wakeText(harness)).not.toContain(consumedId);
  });

  it("coalesces several busy completions into one wake at agent_settled without dropping ids or results", async () => {
    const harness = await activate([], false);
    const outcomes = [
      { result: "BATCH-RESULT-ALPHA", transcript: "batch alpha" },
      { result: "BATCH-RESULT-BETA", transcript: "batch beta" },
      { result: "BATCH-RESULT-GAMMA", transcript: "batch gamma" },
    ];
    const ids: string[] = [];
    for (const outcome of outcomes) ids.push(await spawnCompleted(harness, outcome));

    await advanceDelivery();
    expect.soft(harness.sent, "nothing may wake the parent while its context is busy").toHaveLength(0);
    expect.soft(harness.lifecycle.has("agent_settled"), "the extension must register the idle delivery hook").toBe(true);

    harness.idle.value = true;
    await fire(harness, "agent_settled");
    await advanceDelivery();

    expect.soft(harness.sent, "all pending completions must use one bounded wake").toHaveLength(1);
    const wake = wakeText(harness);
    for (const id of ids) expect.soft(wake).toContain(id);
    for (const outcome of outcomes) expect.soft(wake).toContain(outcome.result);
  });

  it("replays captured entries and wakes only pending success/failure completions", async () => {
    const original = await activate([], false);

    const consumedId = await spawnCompleted(original, {
      result: "MUST-NOT-REPLAY-CONSUMED",
      transcript: "consumed replay transcript",
    });
    await readResult(original, consumedId);

    const claimedId = await spawnCompleted(original, {
      result: "MUST-NOT-REPLAY-CLAIMED",
      transcript: "claimed replay transcript",
    });
    original.idle.value = true;
    await fire(original, "agent_settled");
    await advanceDelivery();

    original.idle.value = false;
    const pendingSuccessId = await spawnCompleted(original, {
      result: "REPLAY-PENDING-SUCCESS",
      transcript: "pending success transcript",
    });
    const pendingFailureId = await spawnCompleted(original, {
      result: "REPLAY-PENDING-FAILURE",
      transcript: "pending failure transcript",
      failure: "REPLAY-PROVIDER-FAILURE",
    });

    const captured = cloneEntries(original.entries);
    await shutdown(original);

    const replay = await activate(captured, true);
    await advanceDelivery();
    await fire(replay, "agent_settled");
    await advanceDelivery();

    expect.soft(replay.sent, "pending success and failure must coalesce into one replay wake").toHaveLength(1);
    const wake = wakeText(replay);
    expect.soft(wake).toContain(pendingSuccessId);
    expect.soft(wake).toContain("REPLAY-PENDING-SUCCESS");
    expect.soft(wake).toContain(pendingFailureId);
    expect.soft(wake).toMatch(/REPLAY-PENDING-FAILURE|REPLAY-PROVIDER-FAILURE/);
    expect.soft(wake).not.toContain(consumedId);
    expect.soft(wake).not.toContain("MUST-NOT-REPLAY-CONSUMED");
    expect.soft(wake).not.toContain(claimedId);
    expect.soft(wake).not.toContain("MUST-NOT-REPLAY-CLAIMED");
  });

  it("treats duplicate session_start and agent_settled delivery as idempotent", async () => {
    const original = await activate([], false);
    const pendingId = await spawnCompleted(original, {
      result: "IDEMPOTENT-PENDING-RESULT",
      transcript: "idempotent replay transcript",
    });
    const captured = cloneEntries(original.entries);
    await shutdown(original);

    const replay = await activate(captured, true);
    await fire(replay, "session_start", { reason: "reload" });
    await fire(replay, "session_start", { reason: "reload" });
    await advanceDelivery();
    await fire(replay, "agent_settled");
    await fire(replay, "agent_settled");
    await advanceDelivery();

    expect.soft(replay.sent, "duplicate lifecycle delivery must still produce exactly one wake").toHaveLength(1);
    expect.soft(wakeText(replay)).toContain(pendingId);
    expect.soft(wakeText(replay).match(/IDEMPOTENT-PENDING-RESULT/g) ?? []).toHaveLength(1);
  });

  it("restores result, verbose transcript, usage, and consumed delivery audit after restart", async () => {
    const original = await activate([], false);
    const id = await spawnCompleted(original, {
      result: "DURABLE-RESULT-AFTER-RESTART",
      transcript: "DURABLE-TRANSCRIPT-AFTER-RESTART",
    });
    await readResult(original, id, true);
    const consumedAck = original.entries.find((entry) => entryMarks(entry, id, "consum"));
    expect.soft(consumedAck, "the pre-restart read must have a durable consumed acknowledgment").toBeDefined();

    const captured = cloneEntries(original.entries);
    await shutdown(original);
    const replay = await activate(captured, true);

    const restored = await readResult(replay, id, true);
    const output = textOf(restored);
    expect.soft(output).not.toContain("Agent not found");
    expect.soft(output).toContain("DURABLE-RESULT-AFTER-RESTART");
    expect.soft(output).toContain("DURABLE-TRANSCRIPT-AFTER-RESTART");
    expect.soft(output).toMatch(/125\s+tokens?/i);
    expect.soft(serialized(restored)).toMatch(/claim/i);
    expect.soft(serialized(restored)).toMatch(/consum/i);
  });

  it("keeps a claimed completion retrievable and never creates a second wake when it is consumed", async () => {
    const harness = await activate([], false);
    const id = await spawnCompleted(harness, {
      result: "DELIVER-THEN-CONSUME-RESULT",
      transcript: "deliver before consume transcript",
    });

    harness.idle.value = true;
    await fire(harness, "agent_settled");
    await advanceDelivery();
    expect.soft(harness.sent).toHaveLength(1);

    const result = await readResult(harness, id, true);
    expect.soft(textOf(result)).toContain("DELIVER-THEN-CONSUME-RESULT");
    expect.soft(harness.entries.some((entry) => entryMarks(entry, id, "claim"))).toBe(true);
    expect.soft(harness.entries.some((entry) => entryMarks(entry, id, "consum"))).toBe(true);

    await fire(harness, "agent_settled");
    await advanceDelivery();
    expect.soft(harness.sent, "consuming an already-claimed result must not enqueue another wake").toHaveLength(1);
  });

  it("requires both idle state and an empty pending-message queue before waking", async () => {
    const harness = await activate([], true);
    harness.pendingMessages.value = true;
    const id = await spawnCompleted(harness, { result: "GATED-RESULT", transcript: "gated transcript" });

    await advanceDelivery();
    await fire(harness, "agent_settled");
    expect.soft(harness.sent).toHaveLength(0);

    harness.pendingMessages.value = false;
    await fire(harness, "agent_settled");
    expect.soft(harness.sent).toHaveLength(1);
    expect.soft(wakeText(harness)).toContain(id);
  });

  it("coalesces concurrent live success and failure completions", async () => {
    const harness = await activate([], false);
    const outcomes = [
      { result: "CONCURRENT-ONE", transcript: "concurrent one" },
      { result: "CONCURRENT-TWO", transcript: "concurrent two", failure: "LIVE-FAILURE" },
      { result: "CONCURRENT-THREE", transcript: "concurrent three" },
    ];
    const ids = await Promise.all(outcomes.map((outcome) => spawnCompleted(harness, outcome)));

    harness.idle.value = true;
    await fire(harness, "agent_settled");

    expect.soft(harness.sent).toHaveLength(1);
    const wake = wakeText(harness);
    for (const id of ids) expect.soft(wake).toContain(id);
    expect.soft(wake).toMatch(/CONCURRENT-TWO|LIVE-FAILURE/);
  });

  it("replaces XML-invalid controls and lone surrogates before escaping notifications", async () => {
    const harness = await activate([], true);
    const hostile = "bad\u0000\u0001\u000b\ud800<&";
    await spawnCompleted(harness, { result: hostile, transcript: hostile });

    await advanceDelivery();

    const wake = wakeText(harness);
    expect(wake).toContain("bad���");
    expect(wake).toContain("&lt;&amp;");
    expect(wake).not.toMatch(/[\u0000\u0001\u000b\ud800-\udfff]/u);
  });

  it("keeps one complete bounded wake and renderer details for hostile high-cardinality results", async () => {
    const harness = await activate([], false);
    const ids: string[] = [];
    for (let index = 0; index < 14; index++) {
      ids.push(await spawnCompleted(harness, {
        result: `LARGE-${index}-` + "<&".repeat(20_000),
        transcript: `large transcript ${index}`,
      }));
    }

    harness.idle.value = true;
    await fire(harness, "agent_settled");

    expect.soft(harness.sent).toHaveLength(1);
    const sent = harness.sent[0].message as { content: string; details: unknown };
    expect.soft(sent.content.length).toBeLessThanOrEqual(12_000);
    expect.soft((sent.content.match(/<task-notification>/g) ?? []).length)
      .toBe((sent.content.match(/<\/task-notification>/g) ?? []).length);
    expect.soft(sent.content).toMatch(/14 finished/i);
    expect.soft(sent.content).toMatch(/omitted/i);
    expect.soft(serialized(sent.details).length).toBeLessThanOrEqual(12_000);

    const claim = harness.entries.find((entry) => entryMarks(entry, ids[0], "claim"));
    for (const id of ids) expect.soft(serialized(claim?.data)).toContain(id);
    const omitted = await readResult(harness, ids.at(-1)!);
    expect.soft(textOf(omitted)).toContain("LARGE-13-");
    expect.soft(textOf(omitted).length).toBeGreaterThan(40_000);
  });

  it("automatically retries a wake claim append failure without sending first", async () => {
    const harness = await activate([], false);
    const id = await spawnCompleted(harness, { result: "CLAIM-RETRY-RESULT", transcript: "claim retry transcript" });
    const appendEntry = vi.mocked(harness.pi.appendEntry);
    const original = appendEntry.getMockImplementation()!;
    appendEntry.mockImplementationOnce(() => {
      throw new Error("claim append unavailable");
    });

    harness.idle.value = true;
    await fire(harness, "agent_settled");
    expect.soft(harness.sent).toHaveLength(0);
    expect.soft(harness.entries.some((entry) => entryMarks(entry, id, "claim"))).toBe(false);

    appendEntry.mockImplementation(original);
    await advanceDelivery();
    expect.soft(harness.sent).toHaveLength(1);
    expect.soft(harness.entries.some((entry) => entryMarks(entry, id, "claim"))).toBe(true);
  });

  it("automatically persists a transiently failed completion before making it eligible", async () => {
    const harness = await activate([], true);
    vi.mocked(harness.pi.appendEntry).mockImplementationOnce(() => {
      throw new Error("record append unavailable");
    });
    const id = await spawnCompleted(harness, { result: "RETRYABLE-FULL-RESULT", transcript: "retryable transcript" });

    expect.soft(harness.sent).toHaveLength(0);
    expect.soft(harness.entries.some((entry) => entry.customType === "subagents:record")).toBe(false);

    await advanceDelivery();

    const snapshot = harness.entries.find((entry) => entry.customType === "subagents:record");
    const claim = harness.entries.find((entry) => entryMarks(entry, id, "claim"));
    expect.soft(snapshot?.sequence ?? Infinity).toBeLessThan(claim?.sequence ?? -Infinity);
    expect.soft(harness.sent).toHaveLength(1);
    expect.soft(wakeText(harness)).toContain("RETRYABLE-FULL-RESULT");
  });

  it("bounds exhausted snapshot retries without spinning and leaves the live result retrievable", async () => {
    const harness = await activate([], true);
    const appendEntry = vi.mocked(harness.pi.appendEntry);
    const original = appendEntry.getMockImplementation()!;
    let snapshotAttempts = 0;
    appendEntry.mockImplementation((customType: string, data?: unknown) => {
      if (customType === "subagents:record") {
        snapshotAttempts++;
        throw new Error("record store offline");
      }
      return original(customType, data);
    });

    const id = await spawnCompleted(harness, { result: "LIVE-AFTER-EXHAUSTION", transcript: "retry exhaustion" });
    await vi.advanceTimersByTimeAsync(60_000);
    const exhaustedAttempts = snapshotAttempts;
    await vi.advanceTimersByTimeAsync(60_000);

    expect.soft(exhaustedAttempts).toBeGreaterThan(1);
    expect.soft(exhaustedAttempts).toBeLessThanOrEqual(5);
    expect.soft(snapshotAttempts).toBe(exhaustedAttempts);
    expect.soft(harness.sent).toHaveLength(0);

    appendEntry.mockImplementation(original);
    const result = await readResult(harness, id, true);
    expect.soft(textOf(result)).toContain("LIVE-AFTER-EXHAUSTION");
  });

  it("leaves a terminal live result unconsumed when the consumed append fails, then retries", async () => {
    const harness = await activate([], false);
    const id = await spawnCompleted(harness, { result: "CONSUME-RETRY-RESULT", transcript: "consume retry transcript" });
    const appendEntry = vi.mocked(harness.pi.appendEntry);
    const original = appendEntry.getMockImplementation()!;
    appendEntry.mockImplementation((customType: string, data?: unknown) => {
      if (customType === "subagents:notification" && serialized(data).includes("consumed")) {
        throw new Error("consumed append unavailable");
      }
      return original(customType, data);
    });

    await expect(readResult(harness, id)).rejects.toThrow("consumed append unavailable");
    expect.soft(harness.entries.some((entry) => entryMarks(entry, id, "consum"))).toBe(false);
    const live = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")] as {
      getRecord: (agentId: string) => { resultConsumed?: boolean } | undefined;
    };
    expect.soft(live.getRecord(id)?.resultConsumed).not.toBe(true);

    appendEntry.mockImplementation(original);
    await expect(readResult(harness, id)).resolves.toEqual(expect.objectContaining({ content: expect.any(Array) }));
    expect.soft(harness.entries.some((entry) => entryMarks(entry, id, "consum"))).toBe(true);
  });

  it("persists a fresh foreground-resume snapshot as consumed before returning", async () => {
    const original = await activate([], false);
    const id = await spawnCompleted(original, { result: "OLD-RUN", transcript: "old run transcript" });
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "FRESH-FOREGROUND-RESUME", failure: undefined });

    const resumed = await original.tools.get("Agent")!.execute(
      "foreground-resume",
      {
        prompt: "continue",
        description: "continue agent",
        subagent_type: "general-purpose",
        resume: id,
        run_in_background: false,
      },
      undefined,
      undefined,
      original.context,
    );
    expect.soft(textOf(resumed)).toContain("FRESH-FOREGROUND-RESUME");

    const captured = cloneEntries(original.entries);
    await shutdown(original);
    const replay = await activate(captured, true);
    const restored = await readResult(replay, id);
    expect.soft(textOf(restored)).toContain("FRESH-FOREGROUND-RESUME");
    expect.soft(textOf(restored)).not.toContain("OLD-RUN");
    await advanceDelivery();
    expect.soft(replay.sent).toHaveLength(0);
  });

  it("bounds the durable fallback conversation while retaining full-result and transcript references", async () => {
    const harness = await activate([], false);
    const sessionFile = "/sessions/full-child-transcript.jsonl";
    vi.mocked(runAgent).mockImplementationOnce(async (_context, _type, _prompt, options) => {
      const session = {
        messages: [
          { role: "user", content: "z".repeat(5_500_000) },
          { role: "assistant", content: [{ type: "text", text: "FULL-RESULT-UNCHANGED" }] },
        ],
        sessionManager: { getSessionFile: () => sessionFile },
        steer: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(() => vi.fn()),
        dispose: vi.fn(),
      };
      options.onSessionCreated?.(session as never);
      return {
        responseText: "FULL-RESULT-UNCHANGED",
        session: session as never,
        aborted: false,
        steered: false,
      };
    });

    const spawned = await harness.tools.get("Agent")!.execute(
      "bounded-snapshot",
      {
        prompt: "capture a large transcript",
        description: "large transcript",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      harness.context,
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1];
    expect(id).toBeTruthy();
    for (let index = 0; index < 5; index++) await Promise.resolve();

    const snapshot = harness.entries.findLast((entry) => entry.customType === "subagents:record")?.data as {
      result?: string;
      conversation?: string;
      output?: { sessionFile?: string };
    };
    expect(snapshot.result).toBe("FULL-RESULT-UNCHANGED");
    expect(snapshot.conversation?.length).toBeLessThanOrEqual(5_000_000);
    expect(snapshot.conversation).toContain("Conversation truncated");
    expect(snapshot.output?.sessionFile).toBe(sessionFile);
  });

  it("separates switched sessions while reopening the old branch restores its pending result", async () => {
    const sessionA = await activate([], false, "session-a");
    const id = await spawnCompleted(sessionA, { result: "SESSION-A-RESULT", transcript: "session A transcript" });
    const branchA = cloneEntries(sessionA.entries);
    await fire(sessionA, "session_before_switch", { reason: "switch" });
    await shutdown(sessionA);

    const sessionB = await activate([], true, "session-b");
    expect.soft(textOf(await readResult(sessionB, id))).toContain("Agent not found");
    await shutdown(sessionB);

    const reopenedA = await activate(branchA, true, "session-a");
    expect.soft(textOf(await readResult(reopenedA, id, true))).toContain("SESSION-A-RESULT");
    await fire(reopenedA, "agent_settled");
    await advanceDelivery();
    expect.soft(reopenedA.sent).toHaveLength(0);
  });
});

describe("strict notification ledger ingestion", () => {
  const id = "01234567-89ab-cde";

  it("accepts exact v1 and truly unversioned legacy terminal records", () => {
    const legacyId = "fedcba98-7654-321";
    const state = foldNotificationLedger([
      customEntry("subagents:record", persistedData(id)),
      customEntry("subagents:record", {
        id: legacyId,
        type: "Explore",
        description: "legacy",
        status: "error",
        error: "legacy failure",
        result: "legacy partial",
        startedAt: 10,
        completedAt: 20,
      }),
    ]);

    expect.soft(state.records.get(id)?.result).toBe("persisted result");
    expect.soft(state.pending.has(id)).toBe(true);
    expect.soft(state.records.get(legacyId)?.version).toBe(0);
    expect.soft(state.pending.has(legacyId)).toBe(false);
  });

  it("rejects future, pseudo-unversioned, malformed, foreground-pending, and absurd records without overwriting valid state", () => {
    const hostile = "x".repeat(6_000_000);
    const state = foldNotificationLedger([
      customEntry("subagents:record", persistedData(id)),
      customEntry("subagents:record", persistedData(id, { status: "surprise" })),
      customEntry("subagents:record", persistedData(id, { version: 2, result: "future overwrite" })),
      customEntry("subagents:record", persistedData("not-an-agent-id")),
      customEntry("subagents:record", persistedData("11111111-1111-111", { version: 0 })),
      customEntry("subagents:record", persistedData("22222222-2222-222", { isBackground: false })),
      customEntry("subagents:record", persistedData("33333333-3333-333", { description: hostile })),
      customEntry("subagents:record", persistedData("44444444-4444-444", { startedAt: Number.NaN })),
    ]);

    expect.soft(state.records.size).toBe(1);
    expect.soft(state.records.get(id)?.result).toBe("persisted result");
  });

  it("ignores transitions for unknown records and folds duplicate known transitions idempotently", () => {
    const unknown = "99999999-9999-999";
    const state = foldNotificationLedger([
      customEntry("subagents:notification", { version: 1, action: "wake_claimed", agentIds: [unknown] }),
      customEntry("subagents:record", persistedData(id)),
      customEntry("subagents:notification", { version: 1, action: "wake_claimed", agentIds: [id] }),
      customEntry("subagents:notification", { version: 1, action: "wake_claimed", agentIds: [id] }),
      customEntry("subagents:notification", { version: 1, action: "consumed", agentIds: [unknown] }),
    ]);

    expect.soft(state.pending.size).toBe(0);
    expect.soft(state.claimed).toEqual(new Set([id]));
    expect.soft(state.consumed.size).toBe(0);
  });
});
