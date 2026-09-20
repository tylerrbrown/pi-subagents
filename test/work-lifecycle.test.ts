import { afterEach, describe, expect, it, vi } from "vitest";
import { requestWork, retainedWorkSnapshots, validateWorkBinding, validateWorkReservation, workLaunchKey } from "../src/work-lifecycle.js";
import { work, workAdapter } from "./helpers/work-adapter.js";

const launch = { launchKey: workLaunchKey("parent", "call"), parentSessionId: "parent", invocationId: "call", agentId: "agent", agentType: "general-purpose", description: "test", cwd: process.cwd(), work };
afterEach(() => vi.useRealTimers());
describe("Work wire protocol", () => {
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
    await vi.advanceTimersByTimeAsync(5000);
    await failure;
  });
  it("does not expose arbitrary adapter error bodies", async () => {
    const adapter = workAdapter();
    adapter.refused.add("bind");
    await expect(requestWork(adapter.events, "bind", launch)).rejects.toThrow("Work bind adapter refused the request.");
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
  it("reconcile receipts retain identities, not private prompt/result fields", () => {
    const [snapshot] = retainedWorkSnapshots([{ customType: "subagents:work-record", data: {
      version: 1, launch: { ...launch, prompt: "SYNTHETIC_PRIVATE_PROMPT" }, status: "completed",
      result: "SYNTHETIC_PRIVATE_RESULT", summary: "SYNTHETIC_PRIVATE_RESULT",
    } }]);
    expect(snapshot.launch.work).toEqual(work);
    expect(JSON.stringify(snapshot)).not.toContain("SYNTHETIC_PRIVATE");
  });
});
