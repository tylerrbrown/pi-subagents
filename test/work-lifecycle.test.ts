import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent-runner.js")>(),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));
vi.mock("../src/worktree.js", () => ({ createWorktree: vi.fn(), cleanupWorktree: vi.fn(), pruneWorktrees: vi.fn(), isWorktreeIsolationEnabled: () => true }));

import { AgentManager } from "../src/agent-manager.js";
import { bindExtensionsWithStartupObservation, resumeAgent, runAgent } from "../src/agent-runner.js";
import { canonicalWorkTerminalProofBytes, requestWork, requestWorkReply, retainedWorkSnapshots, validateWorkBinding, validateWorkRecovery, validateWorkReservation, validateWorkTerminalProof, workBindingDigest, workLaunchKey, workTerminalProofDigest } from "../src/work-lifecycle.js";
import { childSession, deferred, work, workAdapter, workContext } from "./helpers/work-adapter.js";

const launch = { launchKey: workLaunchKey("parent", "call"), parentSessionId: "parent", invocationId: "call", agentId: "agent", agentType: "general-purpose", description: "test", cwd: process.cwd(), work };
afterEach(() => vi.useRealTimers());
describe("Work wire protocol", () => {
  it("snapshots and canonicalizes explicit selected slices without adding absent optional fields", () => {
    const selectedSliceIds = ["S02", "S01"];
    const binding = validateWorkBinding({ ...work, selectedSliceIds })!;
    expect(binding.selectedSliceIds).toEqual(["S01", "S02"]);
    selectedSliceIds.push("S03");
    expect(binding.selectedSliceIds).toEqual(["S01", "S02"]);
    expect(validateWorkBinding(work)).not.toHaveProperty("selectedSliceIds");
    expect(validateWorkBinding({ ...work, selectedSliceIds: ["\u{10000}".repeat(256), "\ue000"] })?.selectedSliceIds)
      .toEqual(["\ue000", "\u{10000}".repeat(256)]);
  });
  it.each([[], [""], [" S01"], ["S01 "], ["S01\n"], ["S01", "S01"], [42],
    ["x".repeat(257)], Array.from({ length: 129 }, (_, index) => `S${index}`), null])(
    "rejects malformed selected slices %#", selectedSliceIds => {
      expect(() => validateWorkBinding({ ...work, selectedSliceIds })).toThrow();
    },
  );
  it("carries selected slices through real manager launch, resume, persistence and reconciliation", async () => {
    const adapter = workAdapter();
    const manager = new AgentManager(undefined, 1);
    const session = childSession();
    const selectedSliceIds = ["S02"];
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      return { session, responseText: "", aborted: false, timedOut: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });
    try {
      const id = manager.spawn(adapter.pi, workContext(), "verifier", "prompt", {
        description: "test", invocationId: "selected-slice-launch", work: { ...work, selectedSliceIds },
      });
      selectedSliceIds.push("S01");
      await manager.awaitStartup(id);
      await manager.getRecord(id)?.promise;
      expect(adapter.requests.reserve[0].work.selectedSliceIds).toEqual(["S02"]);
      expect(adapter.requests.bind[0].work.selectedSliceIds).toEqual(["S02"]);
      expect(adapter.entries[0].data.launch).not.toHaveProperty("recovery");
      expect(adapter.entries[0].data.launch).not.toHaveProperty("agentName");
      await expect(manager.resume(id, "next", undefined, {
        toolCallId: "changed-slices", work: { ...work, selectedSliceIds: ["S01"] },
      })).rejects.toThrow("Cannot change");
      await expect(manager.resume(id, "next", undefined, {
        toolCallId: "removed-slices", work,
      })).rejects.toThrow("Cannot change");
      expect(() => manager.spawn(adapter.pi, workContext(), "verifier", "prompt", {
        description: "test", invocationId: "selected-slice-launch", work: { ...work, selectedSliceIds: ["S01"] },
      })).toThrow("already launched");
      expect(adapter.requests.reserve).toHaveLength(1);
      await manager.resume(id, "next", undefined, { toolCallId: "same-slices" });
      expect(adapter.requests.reserve[1].work.selectedSliceIds).toEqual(["S02"]);
      await manager.reconcileWork(adapter.pi, adapter.entries);
      expect(adapter.requests.reconcile.every(request => request.launch.work.selectedSliceIds.join() === "S02")).toBe(true);
      expect(retainedWorkSnapshots(adapter.entries).every(snapshot => snapshot.launch.work.selectedSliceIds?.join() === "S02")).toBe(true);
    } finally { await manager.dispose(); }
  });
  it("revalidates a retained selector against Work even with a matching legacy ACK", async () => {
    const adapter = workAdapter();
    const manager = new AgentManager(undefined, 1);
    const selectedLaunch = { ...launch, work: { ...work, selectedSliceIds: ["S02"] },
      reservation: { reservationId: "assignment-selected" }, childSessionId: "child-selected", bound: true };
    const proof = {
      schemaVersion: 2 as const, reservationId: "assignment-selected", launchKey: launch.launchKey,
      childSessionId: "child-selected", bound: true, promptDelivered: false, modelTurnCount: 0,
      toolUseCount: 0, resultProduced: false, terminalStatus: "completed" as const, startupEffectsAbsent: false,
    };
    const branch = [
      { customType: "subagents:work-record", data: { version: 2, launch: selectedLaunch, proof } },
      { customType: "subagents:work-reconcile-ack", data: { version: 1, protocolVersion: 2,
        launchKey: launch.launchKey, snapshotDigest: workTerminalProofDigest(proof) } },
    ];
    adapter.refused.add("reconcile");
    try {
      await manager.reconcileWork(adapter.pi, branch);
      expect(adapter.requests.reconcile).toHaveLength(1);
      expect(adapter.requests.reconcile[0].launch.work.selectedSliceIds).toEqual(["S02"]);
      expect(adapter.entries.filter(entry => entry.customType === "subagents:work-reconcile-ack")).toHaveLength(0);
    } finally { await manager.dispose(); }
  });
  it.each(["changed", "removed"])("does not reuse an ACK after selected slices are %s", async change => {
    const adapter = workAdapter();
    const manager = new AgentManager(undefined, 1);
    const originalWork = { ...work, selectedSliceIds: ["S02"] };
    const changedWork = change === "removed" ? work : { ...work, selectedSliceIds: ["S01"] };
    const selectedLaunch = { ...launch, work: changedWork,
      reservation: { reservationId: "assignment-selected" }, childSessionId: "child-selected", bound: true };
    const proof = {
      schemaVersion: 2 as const, reservationId: "assignment-selected", launchKey: launch.launchKey,
      childSessionId: "child-selected", bound: true, promptDelivered: false, modelTurnCount: 0,
      toolUseCount: 0, resultProduced: false, terminalStatus: "completed" as const, startupEffectsAbsent: false,
    };
    const branch = [
      { customType: "subagents:work-record", data: { version: 2, launch: selectedLaunch, proof } },
      { customType: "subagents:work-reconcile-ack", data: { version: 1, protocolVersion: 2,
        launchKey: launch.launchKey, snapshotDigest: workTerminalProofDigest(proof), bindingDigest: workBindingDigest(originalWork) } },
    ];
    adapter.refused.add("reconcile");
    try {
      await manager.reconcileWork(adapter.pi, branch);
      expect(adapter.requests.reconcile).toHaveLength(1);
      expect(adapter.entries.filter(entry => entry.customType === "subagents:work-reconcile-ack")).toHaveLength(0);
    } finally { await manager.dispose(); }
  });
  it("revalidates a legacy ACK once and then reuses its binding-bound replacement", async () => {
    const adapter = workAdapter();
    const manager = new AgentManager(undefined, 1);
    const retainedLaunch = { ...launch, reservation: { reservationId: "assignment-old" }, childSessionId: "child-old", bound: true };
    const proof = {
      schemaVersion: 2 as const, reservationId: "assignment-old", launchKey: launch.launchKey,
      childSessionId: "child-old", bound: true, promptDelivered: false, modelTurnCount: 0,
      toolUseCount: 0, resultProduced: false, terminalStatus: "completed" as const, startupEffectsAbsent: false,
    };
    const branch = [
      { customType: "subagents:work-record", data: { version: 2, launch: retainedLaunch, proof } },
      { customType: "subagents:work-reconcile-ack", data: { version: 1, protocolVersion: 2,
        launchKey: launch.launchKey, snapshotDigest: workTerminalProofDigest(proof) } },
    ];
    adapter.held.add("reconcile");
    adapter.events.on("subagents:work:reconcile", request => adapter.events.emit(
      `subagents:work:reconcile:reply:${request.requestId}`,
      { success: true, data: { status: "already_applied", terminalSnapshotDigest: request.payload.terminalSnapshotDigest } },
    ));
    try {
      await manager.reconcileWork(adapter.pi, branch);
      expect(adapter.requests.reconcile).toHaveLength(1);
      expect(adapter.entries[0].data.bindingDigest).toBe(workBindingDigest(work));
      await manager.reconcileWork(adapter.pi, [...branch, ...adapter.entries]);
      expect(adapter.requests.reconcile).toHaveLength(1);
      expect(adapter.requests.reconcile[0].launch.work).not.toHaveProperty("selectedSliceIds");
    } finally { await manager.dispose(); }
  });
  it.each(["reserve", "bind", "finalize", "reconcile"] as const)("handles synchronous %s replies and detaches payloads", async action => {
    const adapter = workAdapter();
    const payload = action === "reserve" || action === "bind" ? launch : { version: 1 as const, launch, status: "completed" as const };
    await expect(requestWork(adapter.events, action, payload)).resolves.toEqual(action === "reserve" ? { reservationId: "reservation-04" } : undefined);
    const request = adapter.requests[action][0];
    (request.work ?? request.launch.work).scopes.push("unauthorized");
    expect(work.scopes).toEqual(["test/**"]);
  });
  it("fails closed for a missing adapter and ignores unrelated replies", async () => {
    vi.useFakeTimers();
    const adapter = workAdapter();
    adapter.held.add("reserve");
    const result = requestWork(adapter.events, "reserve", launch);
    const failure = expect(result).rejects.toThrow("did not reply");
    adapter.events.emit("subagents:work:reserve:reply:wrong-id", { success: true });
    await vi.advanceTimersByTimeAsync(65000);
    await failure;
  });
  it("sends the bounded v3 envelope and accepts a slow reply before its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const adapter = workAdapter();
    adapter.held.add("reserve");
    const sent: unknown[] = [];
    adapter.events.on("subagents:work:reserve", request => sent.push(request));
    const result = requestWork(adapter.events, "reserve", launch);
    const outcome = result.then(value => ({ value }), error => ({ error }));
    expect(sent[0]).toEqual({ requestId: expect.any(String), protocolVersion: 3, deadlineAt: 160000, payload: launch });
    await vi.advanceTimersByTimeAsync(6000);
    adapter.reply("reserve", adapter.requests.reserve[0]);
    expect(await outcome).toEqual({ value: { reservationId: "reservation-04" } });
  });
  it("does not accept success at the mutation deadline even during caller grace", async () => {
    vi.useFakeTimers();
    const adapter = workAdapter();
    adapter.held.add("bind");
    const outcome = requestWork(adapter.events, "bind", launch).catch(error => error);
    await vi.advanceTimersByTimeAsync(60000);
    adapter.reply("bind", adapter.requests.bind[0]);
    expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringContaining("indeterminate") }));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not expose arbitrary adapter error bodies", async () => {
    const adapter = workAdapter();
    adapter.refused.add("bind");
    await expect(requestWork(adapter.events, "bind", launch)).rejects.toThrow("Work bind adapter refused the request.");
  });
  it.each(["reserve", "bind", "finalize", "reconcile"] as const)("bounds %s watchdog and ignores late success without retry", async action => {
    vi.useFakeTimers();
    const adapter = workAdapter();
    adapter.held.add(action);
    const outcome = requestWorkReply(adapter.events, action, launch).catch(error => error);
    await vi.advanceTimersByTimeAsync(64999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const failure = await outcome;
    expect(failure).toEqual(expect.objectContaining({ message: expect.stringContaining("indeterminate") }));
    adapter.reply(action, adapter.requests[action][0]);
    expect(await outcome).toBe(failure);
    expect(adapter.requests[action]).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves typed terminal failure during reply grace without treating it as success", async () => {
    vi.useFakeTimers();
    const adapter = workAdapter();
    adapter.held.add("finalize");
    const outcome = requestWorkReply(adapter.events, "finalize", launch);
    await vi.advanceTimersByTimeAsync(61000);
    const error = { code: "indeterminate", retryable: false, action: "retry_exact_read" };
    adapter.events.emit(`subagents:work:finalize:reply:${adapter.requests.finalize[0].requestId}`, { success: false, error });
    expect(await outcome).toEqual({ success: false, error });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    null, [], {}, { ...work, extra: true }, { ...work, case: " " },
    { ...work, execution: "bad\nidentity" }, { ...work, actor: "x".repeat(257) },
    { ...work, scopes: [] }, { ...work, scopes: ["x", "x"] },
    { ...work, scopes: Array.from({ length: 65 }, (_, i) => String(i)) },
    { ...work, scopes: ["x".repeat(1025)] }, { ...work, intendedOutcome: "x".repeat(2049) },
  ])("rejects malformed work %#", input => expect(() => validateWorkBinding(input)).toThrow());
  it("allows omitted work and snapshots valid bindings", () => {
    expect(validateWorkBinding(undefined)).toBeUndefined();
    const copy = validateWorkBinding(work)!;
    expect(copy).toEqual(work);
    expect(copy.scopes).not.toBe(work.scopes);
  });
  it.each([{}, { reservationId: "" }, { reservationId: "r", privateResult: "x" }])("rejects invalid reservation %#", value => {
    expect(() => validateWorkReservation(value)).toThrow();
  });
  it("deduplicates valid retained identities and ignores corrupt launch keys", () => {
    const record = (status: string, extra = {}) => ({ customType: "subagents:work-record", data: { version: 1, launch: { ...launch, ...extra }, status } });
    const snapshots = retainedWorkSnapshots([record("running"), record("completed"), record("running", { launchKey: "forged" })]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].status).toBe("completed");
  });
  it("rejects malformed retained recovery descriptors", () => {
    const recovery = {
      mode: "prebind-recovery", predecessorAssignmentId: "not-an-agent", predecessorLaunchKey: launch.launchKey,
      proof: { status: "error", bound: false, reservationId: "r", toolUses: 0,
        usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
        resultPresent: false, substantiveOutputPresent: false },
    };
    expect(retainedWorkSnapshots([{ customType: "subagents:work-record", data: {
      version: 1, launch: { ...launch, recovery }, status: "running",
    } }])).toEqual([]);
  });
  it("reconcile receipts retain identities, not private prompt/result fields", () => {
    const [snapshot] = retainedWorkSnapshots([{ customType: "subagents:work-record", data: {
      version: 1, launch: { ...launch, prompt: "SYNTHETIC_PRIVATE_PROMPT" }, status: "completed",
      result: "SYNTHETIC_PRIVATE_RESULT", summary: "SYNTHETIC_PRIVATE_RESULT",
    } }]);
    expect(snapshot.launch.work).toEqual(work);
    expect(JSON.stringify(snapshot)).not.toContain("SYNTHETIC_PRIVATE");
  });
  it("matches the frozen v2 canonical proof bytes and SHA-256", () => {
    const fixture = JSON.parse(readFileSync("C:/Users/tyler.TYWARE/SynologyDrive/Claude/shared/lib/tests/fixtures/work_assignment_lifecycle_v2.json", "utf8"));
    expect(validateWorkTerminalProof(fixture.terminalProof)).toEqual(fixture.terminalProof);
    expect(canonicalWorkTerminalProofBytes(fixture.terminalProof).toString("utf8")).toBe(fixture.canonicalProofJson);
    expect(workTerminalProofDigest(fixture.terminalProof)).toBe(fixture.terminalProofDigest);
  });
  it("requires every explicit v2 proof field without coercion", () => {
    const proof = {
      schemaVersion: 2, reservationId: "assignment-1", launchKey: launch.launchKey,
      childSessionId: "child-1", bound: true, promptDelivered: false,
      modelTurnCount: 0, toolUseCount: 0, resultProduced: false,
      terminalStatus: "error", startupEffectsAbsent: true,
    };
    for (const key of Object.keys(proof)) {
      const missing = { ...proof } as Record<string, unknown>;
      delete missing[key];
      expect(() => validateWorkTerminalProof(missing)).toThrow();
    }
    expect(() => validateWorkTerminalProof({ ...proof, modelTurnCount: "0" })).toThrow();
    expect(() => validateWorkTerminalProof({ ...proof, toolUseCount: -1 })).toThrow();
    expect(() => validateWorkTerminalProof({ ...proof, privateResult: "secret" })).toThrow();
  });
  it("does not claim clean startup when bind fails before the runner observation", async () => {
    const adapter = workAdapter();
    adapter.refused.add("bind");
    const manager = new AgentManager(undefined, 1);
    const session = childSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      options.onStartupEffectsObserved?.(true);
      return { session, responseText: "", aborted: false, timedOut: false, steered: false };
    });
    const id = manager.spawn(adapter.pi, workContext(), "general-purpose", "prompt", {
      description: "test", invocationId: "failed-bind-call", work,
    });
    await expect(manager.awaitStartup(id)).rejects.toThrow("refused");
    expect(adapter.requests.finalize).toHaveLength(1);
    expect(adapter.requests.finalize[0]).toMatchObject({ version: 1, status: "error" });
    expect(adapter.requests.finalize[0].proof).toBeUndefined();
    await manager.dispose();
  });
  it("keeps startup effects non-authorizing when no-extension binding fails", async () => {
    const adapter = workAdapter();
    const manager = new AgentManager(undefined, 1);
    const session = childSession();
    session.bindExtensions = vi.fn(async () => { throw new Error("synthetic bind failure"); });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      await bindExtensionsWithStartupObservation(session, true, options.onStartupEffectsObserved, () => {});
      return { session, responseText: "", aborted: false, timedOut: false, steered: false };
    });
    const id = manager.spawn(adapter.pi, workContext(), "general-purpose", "prompt", {
      description: "test", invocationId: "extension-bind-failure", work,
    });
    await manager.awaitStartup(id);
    await manager.getRecord(id)?.promise;
    expect(session.bindExtensions).toHaveBeenCalledOnce();
    expect(adapter.requests.finalize[0]).toMatchObject({
      version: 2,
      proof: { terminalStatus: "error", startupEffectsAbsent: false },
    });
    await manager.dispose();
  });
  it.each(["aborted", "stopped"] as const)("requires confirmed disposal before v2 for %s", async terminal => {
    const adapter = workAdapter();
    const manager = new AgentManager(undefined, 1);
    const session = childSession();
    const done = deferred<any>();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      return done.promise;
    });
    const id = manager.spawn(adapter.pi, workContext(), "general-purpose", "prompt", {
      description: "test", invocationId: `fenced-${terminal}`, work,
    });
    await manager.awaitStartup(id);
    if (terminal === "stopped") manager.abort(id);
    done.resolve({ session, responseText: "", aborted: terminal === "aborted", timedOut: false, steered: false });
    await manager.getRecord(id)?.promise;
    expect(session.dispose).toHaveBeenCalled();
    expect(adapter.requests.finalize[0]).toMatchObject({ version: 2, proof: { terminalStatus: terminal } });
    await manager.dispose();
  });
  it.each(["aborted", "stopped"] as const)("keeps %s on v1 when disposal cannot confirm the fence", async terminal => {
    const adapter = workAdapter();
    const manager = new AgentManager(undefined, 1);
    const session = childSession();
    session.dispose.mockImplementation(() => { throw new Error("synthetic dispose failure"); });
    const done = deferred<any>();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      return done.promise;
    });
    const id = manager.spawn(adapter.pi, workContext(), "general-purpose", "prompt", {
      description: "test", invocationId: `unfenced-${terminal}`, work,
    });
    await manager.awaitStartup(id);
    if (terminal === "stopped") manager.abort(id);
    done.resolve({ session, responseText: "", aborted: terminal === "aborted", timedOut: false, steered: false });
    await manager.getRecord(id)?.promise;
    expect(session.dispose).toHaveBeenCalled();
    expect(adapter.requests.finalize[0]).toMatchObject({ version: 1, status: terminal });
    expect(adapter.requests.finalize[0].proof).toBeUndefined();
    await manager.dispose();
  });
  it("keeps an unfenced terminal child on v1 non-authorizing proof", async () => {
    const adapter = workAdapter();
    const manager = new AgentManager(undefined, 1);
    const session = childSession();
    session.dispose.mockImplementation(() => { throw new Error("synthetic dispose failure"); });
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      return { session, responseText: "", aborted: false, timedOut: false, steered: false, failure: "provider failed" };
    });
    const id = manager.spawn(adapter.pi, workContext(), "general-purpose", "prompt", {
      description: "test", invocationId: "unfenced-error-call", work,
    });
    await manager.awaitStartup(id);
    await manager.getRecord(id)?.promise;
    expect(session.dispose).toHaveBeenCalled();
    expect(adapter.requests.finalize[0]).toMatchObject({ version: 1, status: "error" });
    expect(adapter.requests.finalize[0].proof).toBeUndefined();
    await manager.dispose();
  });
  it("emits v2 terminal proof only after confirming the child fence", async () => {
    const adapter = workAdapter();
    const manager = new AgentManager(undefined, 1);
    const session = childSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      return { session, responseText: "", aborted: false, timedOut: false, steered: false, failure: "provider failed" };
    });
    const id = manager.spawn(adapter.pi, workContext(), "general-purpose", "prompt", {
      description: "test", invocationId: "fenced-error-call", work,
    });
    await manager.awaitStartup(id);
    await manager.getRecord(id)?.promise;
    expect(session.dispose).toHaveBeenCalled();
    expect(adapter.requests.finalize[0]).toMatchObject({ version: 2, proof: { terminalStatus: "error" } });
    await manager.dispose();
  });
  it("carries opaque distinct predecessor/current reservations without minting authority", async () => {
    const descriptor = {
      predecessorAssignmentId: "predecessor-assignment", predecessorLaunchKey: "attempt-1",
      recoveryAuthorizationId: "authorization-1", expectedTerminalSnapshotDigest: "a".repeat(64),
    };
    expect(validateWorkRecovery(descriptor)).toEqual(descriptor);
    expect(() => validateWorkRecovery({ ...descriptor, expectedTerminalSnapshotDigest: "bad" })).toThrow();

    const adapter = workAdapter();
    const manager = new AgentManager(undefined, 1);
    const session = childSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onSessionCreated?.(session);
      return { session, responseText: "", aborted: false, timedOut: false, steered: false };
    });
    const id = manager.spawn(adapter.pi, workContext(), "general-purpose", "prompt", {
      description: "test", invocationId: "successor-call", work, recovery: descriptor,
    });
    await expect(manager.awaitStartup(id)).resolves.toBeUndefined();
    await manager.getRecord(id)?.promise;
    expect(adapter.requests.reserve[0].recovery).toEqual(descriptor);
    expect(adapter.requests.reserve[0].reservation?.reservationId).toBeUndefined();
    expect(adapter.requests.bind[0].reservation.reservationId).toBe("reservation-04");
    expect(adapter.requests.bind[0].recovery.predecessorAssignmentId).toBe("predecessor-assignment");
    await manager.dispose();
  });
  it("retains validated v2 terminal proof while decoding v1 read-only", () => {
    const v2Launch = { ...launch, reservation: { reservationId: "assignment-1" }, childSessionId: "child-1", bound: true };
    const proof = {
      schemaVersion: 2 as const, reservationId: "assignment-1", launchKey: launch.launchKey,
      childSessionId: "child-1", bound: true, promptDelivered: false,
      modelTurnCount: 0, toolUseCount: 0, resultProduced: false,
      terminalStatus: "error" as const, startupEffectsAbsent: true,
    };
    const snapshots = retainedWorkSnapshots([
      { customType: "subagents:work-record", data: { version: 1, launch, status: "error" } },
      { customType: "subagents:work-record", data: { version: 2, launch: v2Launch, proof } },
    ]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ version: 2, proof });
  });
});
