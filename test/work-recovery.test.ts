import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent-runner.js")>(),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));
vi.mock("../src/custom-agents.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/custom-agents.js")>(),
  loadCustomAgents: () => [],
}));
vi.mock("../src/settings.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/settings.js")>(),
  loadSettings: () => ({ schedulingEnabled: false, outputTranscript: false }),
  applyAndEmitLoaded: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { foldNotificationLedger, workRecoveryDescriptor } from "../src/notification-ledger.js";
import * as lifecycle from "../src/work-lifecycle.js";
import { makePi, textOf } from "./helpers/boot-extension.js";
import { work, workAdapter, workContext } from "./helpers/work-adapter.js";

const assignmentId = "00000000-0000-4000-8000-000000000001";
const agentId = "01234567-89ab-cde";
const launchKey = "attempt-launch-002";
const proof = {
  schemaVersion: 2,
  reservationId: assignmentId,
  launchKey,
  childSessionId: "01a0e600-0000-7000-8000-000000000002",
  bound: true,
  promptDelivered: false,
  modelTurnCount: 0,
  toolUseCount: 0,
  resultProduced: false,
  terminalStatus: "error",
  startupEffectsAbsent: true,
} as const;
const canonicalProofJson = "{\"bound\":true,\"childSessionId\":\"01a0e600-0000-7000-8000-000000000002\",\"launchKey\":\"attempt-launch-002\",\"modelTurnCount\":0,\"promptDelivered\":false,\"reservationId\":\"00000000-0000-4000-8000-000000000001\",\"resultProduced\":false,\"schemaVersion\":2,\"startupEffectsAbsent\":true,\"terminalStatus\":\"error\",\"toolUseCount\":0}";
const proofDigest = "f2c0abed87d025e08cd2f6765041dcdc6737050a7f1e5874647e6dbb3be68a83";

function exported(name: string): (...args: unknown[]) => unknown {
  const value = Reflect.get(lifecycle, name);
  expect(value, `${name} must be exported by the lifecycle-v2 boundary`).toBeTypeOf("function");
  return value as (...args: unknown[]) => unknown;
}

function validate(value: unknown): Record<string, unknown> {
  return exported("validateWorkTerminalProof")(value) as Record<string, unknown>;
}

const harnesses: Array<{ lifecycle: Map<string, (event: unknown, ctx: any) => Promise<void> | void>; ctx: any }> = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.lifecycle.get("session_shutdown")?.({}, harness.ctx);
  }
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")];
  vi.restoreAllMocks();
});

describe("lifecycle-v2 proof contract", () => {
  it("keeps Assignment/reservation identity distinct from Agent identity in the predecessor descriptor", () => {
    expect(assignmentId).not.toBe(agentId);
    const descriptor = exported("validateWorkRecovery")({
      predecessorAssignmentId: assignmentId,
      predecessorLaunchKey: launchKey,
      recoveryAuthorizationId: "recovery-authorization-001",
      expectedTerminalSnapshotDigest: proofDigest,
    }) as Record<string, unknown>;
    expect(descriptor).toMatchObject({
      predecessorAssignmentId: assignmentId,
      predecessorLaunchKey: launchKey,
      recoveryAuthorizationId: "recovery-authorization-001",
      expectedTerminalSnapshotDigest: proofDigest,
    });
    expect(descriptor.predecessorAssignmentId).toBe(proof.reservationId);
    expect(descriptor.predecessorAssignmentId).not.toBe(agentId);
  });

  it("matches the frozen Python canonical proof bytes and SHA-256 digest exactly", () => {
    const bytes = exported("canonicalWorkTerminalProofBytes")({
      // Deliberately reverse the fixture order: canonicalization, not insertion order, owns the bytes.
      toolUseCount: 0,
      terminalStatus: "error",
      startupEffectsAbsent: true,
      schemaVersion: 2,
      resultProduced: false,
      reservationId: assignmentId,
      promptDelivered: false,
      modelTurnCount: 0,
      launchKey,
      childSessionId: proof.childSessionId,
      bound: true,
    });
    const buffer = Buffer.from(bytes as Uint8Array);
    expect(buffer.toString("utf8")).toBe(canonicalProofJson);
    expect(createHash("sha256").update(buffer).digest("hex")).toBe(proofDigest);
    expect(exported("workTerminalProofDigest")(proof)).toBe(proofDigest);
  });

  it.each([
    ["missing bound", { bound: undefined }],
    ["coerced bound", { bound: 0 }],
    ["missing prompt observation", { promptDelivered: undefined }],
    ["coerced prompt observation", { promptDelivered: "false" }],
    ["missing result observation", { resultProduced: undefined }],
    ["missing startup observation", { startupEffectsAbsent: undefined }],
    ["missing model counter", { modelTurnCount: undefined }],
    ["missing tool counter", { toolUseCount: undefined }],
    ["fractional counter", { modelTurnCount: 0.5 }],
    ["negative counter", { toolUseCount: -1 }],
    ["unsafe counter", { modelTurnCount: Number.MAX_SAFE_INTEGER + 1 }],
    ["coerced counter", { modelTurnCount: "0" }],
  ])("refuses %s rather than coercing or defaulting", (_label, change) => {
    const validator = exported("validateWorkTerminalProof");
    expect(() => validator({ ...proof, ...change })).toThrow();
  });

  it("preserves distinct bound=true and bound=false zero-turn shapes", () => {
    const bound = validate(proof);
    const unbound = validate({ ...proof, bound: false, childSessionId: null });
    expect(bound).toMatchObject({ bound: true, childSessionId: proof.childSessionId });
    expect(unbound).toMatchObject({ bound: false, childSessionId: null });
    expect(bound).not.toEqual(unbound);
  });

  it("refuses contradictory bound proof", () => {
    const validator = exported("validateWorkTerminalProof");
    expect(() => validator({ ...proof, childSessionId: null })).toThrow();
  });

  it("retains non-zero observations as proof facts rather than erasing them", () => {
    expect(validate({
      ...proof,
      promptDelivered: true,
      modelTurnCount: 1,
      toolUseCount: 1,
      resultProduced: true,
      startupEffectsAbsent: false,
    })).toMatchObject({
      promptDelivered: true,
      modelTurnCount: 1,
      toolUseCount: 1,
      resultProduced: true,
      startupEffectsAbsent: false,
    });
  });
});

describe("durable terminal-proof transport", () => {
  const replayLaunchKey = lifecycle.workLaunchKey("parent-session", "original-call");
  const replayProof = { ...proof, launchKey: replayLaunchKey };

  function retainedV2(currentProof: Record<string, any> = replayProof) {
    const launch = {
      launchKey: currentProof.launchKey,
      parentSessionId: "parent-session",
      invocationId: "original-call",
      agentId,
      agentType: "general-purpose",
      description: "original assignment",
      cwd: process.cwd(),
      work,
      reservation: { reservationId: currentProof.reservationId },
      childSessionId: currentProof.childSessionId ?? undefined,
      bound: currentProof.bound,
    };
    return { customType: "subagents:work-record", data: { version: 2, launch, proof: currentProof } };
  }

  it("replays the exact v2 proof and digest without reserve, bind, or child creation", async () => {
    const adapter = workAdapter();
    const manager = new AgentManager();
    try {
      await manager.reconcileWork(adapter.pi, [retainedV2()]);
      expect(adapter.requests.reconcile).toHaveLength(1);
      expect(adapter.requests.reconcile[0].proof).toEqual(replayProof);
      expect(JSON.stringify(adapter.requests.reconcile[0])).toContain(
        lifecycle.workTerminalProofDigest(replayProof),
      );
      expect(adapter.requests.reserve).toHaveLength(0);
      expect(adapter.requests.bind).toHaveLength(0);
      expect(runAgent).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
    }
  });

  it("backs off retryable refusals and stops after the bounded attempt budget", async () => {
    vi.useFakeTimers();
    const adapter = workAdapter();
    adapter.held.add("reconcile");
    adapter.events.on("subagents:work:reconcile", request => {
      adapter.events.emit(`subagents:work:reconcile:reply:${request.requestId}`, {
        success: false,
        error: { status: "pending", code: "coordinator_busy", action: "retry", retryable: true },
      });
    });
    const manager = new AgentManager();
    try {
      const replay = manager.reconcileWork(adapter.pi, [retainedV2()]);
      await Promise.resolve();
      expect(adapter.requests.reconcile).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(24);
      expect(adapter.requests.reconcile).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(adapter.requests.reconcile).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(49);
      expect(adapter.requests.reconcile).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await replay;
      expect(adapter.requests.reconcile).toHaveLength(3);
      expect(adapter.entries).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("bounds replay concurrency and never duplicates an in-flight terminal proof", async () => {
    const adapter = workAdapter();
    adapter.held.add("reconcile");
    const manager = new AgentManager();
    const records = Array.from({ length: 100 }, (_, index) => {
      const invocationId = `replay-${index}`;
      const launchKey = lifecycle.workLaunchKey("parent-session", invocationId);
      const currentProof = {
        ...proof,
        reservationId: `assignment-${index}`,
        launchKey,
        childSessionId: `child-${index}`,
      };
      return {
        customType: "subagents:work-record",
        data: {
          version: 2,
          launch: {
            ...retainedV2().data.launch,
            launchKey,
            invocationId,
            reservation: { reservationId: currentProof.reservationId },
            childSessionId: currentProof.childSessionId,
          },
          proof: currentProof,
        },
      };
    });
    const replay = manager.reconcileWork(adapter.pi, records);
    try {
      await Promise.resolve();
      expect(adapter.requests.reconcile.length).toBeGreaterThan(0);
      expect(adapter.requests.reconcile.length).toBeLessThan(records.length);
      expect(new Set(adapter.requests.reconcile.map(request => request.launch.launchKey)).size)
        .toBe(adapter.requests.reconcile.length);
    } finally {
      let replied = 0;
      while (replied < records.length) {
        while (replied < adapter.requests.reconcile.length) {
          adapter.reply("reconcile", adapter.requests.reconcile[replied++]);
        }
        await Promise.resolve();
      }
      await replay;
      await manager.dispose();
    }
  });
});

describe("restart recovery authority projection", () => {
  const predecessorLaunchKey = lifecycle.workLaunchKey("parent-session", "original-call");
  const recovery = {
    predecessorAssignmentId: assignmentId,
    predecessorLaunchKey,
    recoveryAuthorizationId: "recovery-authorization-001",
    expectedTerminalSnapshotDigest: proofDigest,
  };

  function persistedRecord(id: string, currentLaunchKey: string, reservationId: string, copiedRecovery?: typeof recovery) {
    return {
      customType: "subagents:record",
      data: {
        version: 1,
        id,
        handles: { handle: "general-purpose" },
        type: "general-purpose",
        description: "recover me",
        status: "error",
        error: "provider unavailable",
        toolUses: 0,
        startedAt: 1,
        completedAt: 2,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
        compactionCount: 0,
        contextPercent: null,
        toolCallId: "original-call",
        work,
        workLaunch: {
          launchKey: currentLaunchKey,
          parentSessionId: "parent-session",
          invocationId: currentLaunchKey === predecessorLaunchKey ? "original-call" : "successor-call",
          agentId: id,
          agentType: "general-purpose",
          description: "recover me",
          cwd: process.cwd(),
          work,
          reservation: { reservationId },
          childSessionId: `child-${id}`,
          bound: true,
          ...(copiedRecovery && { recovery: copiedRecovery }),
        },
        invocation: { modelId: "pi-sub-anthropic/claude-haiku-4-5", thinking: "low", runInBackground: true },
        isBackground: true,
        output: {},
        notificationPending: false,
      },
    };
  }

  it("does not let a successor record re-present copied predecessor authority after restart", () => {
    const successorId = "11234567-89ab-cde";
    const successorLaunchKey = lifecycle.workLaunchKey("parent-session", "successor-call");
    const ledger = foldNotificationLedger([
      persistedRecord(successorId, successorLaunchKey, "successor-assignment", recovery),
    ]);

    expect(workRecoveryDescriptor(ledger.records.get(successorId)!)).toBeUndefined();
  });

  it("projects successor authority only from the predecessor's matching ACK", () => {
    const predecessor = persistedRecord(agentId, predecessorLaunchKey, assignmentId);
    const ledger = foldNotificationLedger([
      predecessor,
      {
        customType: "subagents:work-reconcile-ack",
        data: {
          version: 1,
          protocolVersion: 2,
          launchKey: predecessorLaunchKey,
          snapshotDigest: proofDigest,
          recovery,
        },
      },
    ]);

    expect(workRecoveryDescriptor(ledger.records.get(agentId)!)).toEqual(recovery);
  });
});

describe("legacy retained records", () => {
  it.each(["error", "aborted", "stopped"] as const)("never turns a v1 %s record with inferred zero usage into recovery authority", async terminalStatus => {
    const predecessorLaunch = {
      launchKey: lifecycle.workLaunchKey("parent-session", "original-call"),
      parentSessionId: "parent-session",
      invocationId: "original-call",
      agentId,
      agentType: "general-purpose",
      description: "original assignment",
      cwd: process.cwd(),
      work,
      reservation: { reservationId: assignmentId },
      childSessionId: proof.childSessionId,
      bound: false,
    };
    const record = {
      customType: "subagents:record",
      data: {
        version: 1,
        id: agentId,
        handles: { handle: "general-purpose", alias: "original-assignment" },
        type: "general-purpose",
        description: "original assignment",
        status: terminalStatus,
        toolUses: 0,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
        toolCallId: "original-call",
        work,
        workLaunch: predecessorLaunch,
        invocation: { modelId: "pi-sub-anthropic/claude-haiku-4-5", thinking: "low", runInBackground: true },
        isBackground: true,
      },
    };
    const adapter = workAdapter();
    const host = makePi();
    Object.assign(host.pi, adapter.pi);
    subagentsExtension(host.pi);
    const ctx = workContext();
    ctx.modelRegistry.find = vi.fn((provider: string, id: string) => ({ provider, id, name: id }));
    ctx.sessionManager.getBranch = () => [
      { customType: "subagents:work-record", data: { version: 1, launch: predecessorLaunch, status: terminalStatus } },
      record,
    ];
    await host.lifecycle.get("session_start")?.({}, ctx);
    harnesses.push({ lifecycle: host.lifecycle, ctx });

    const result = await host.tools.get("Agent").execute("recovery", {
      subagent_type: "general-purpose",
      description: "continue",
      prompt: "retry",
      resume: agentId,
      run_in_background: true,
    }, undefined, undefined, ctx);
    expect(textOf(result)).toContain("Agent not found");
    expect(runAgent).not.toHaveBeenCalled();
    expect(adapter.requests.reserve).toHaveLength(0);
  });
});
