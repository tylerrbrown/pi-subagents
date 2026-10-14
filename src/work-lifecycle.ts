/** Generic request/reply contract. No Case/Work storage or policy lives in this fork. */
import { createHash, randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { EventBus } from "./cross-extension-rpc.js";
import type { AgentStatus } from "./types.js";

export interface WorkBinding {
  case: string;
  execution: string;
  actor: string;
  scopes: string[];
  intendedOutcome?: string;
  selectedSliceIds?: string[];
}

export const WorkBindingSchema = Type.Object({
  case: Type.String({ minLength: 1, maxLength: 256 }),
  execution: Type.String({ minLength: 1, maxLength: 256 }),
  actor: Type.String({ minLength: 1, maxLength: 256 }),
  scopes: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 64, uniqueItems: true }),
  intendedOutcome: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  // TypeBox counts UTF-16 units. Runtime validation enforces 256 code points.
  selectedSliceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512,
    description: "Exact review slice ID, at most 256 Unicode characters; no surrounding whitespace or controls." }), { minItems: 1, maxItems: 128, uniqueItems: true })),
}, { additionalProperties: false });

export interface WorkReservation { reservationId: string }
export interface WorkSkipped {
  status: "skipped";
  reason: "review_budget_exhausted" | "verification_budget_exhausted" | "transport_budget_exhausted";
  action: "lead_continue";
  run_started: false;
  case_uid: string;
  execution_id: string;
  launch_key: string;
  slice_ids: string[];
  advisories: string[];
}

/** Only an explicit, identity-matched no-run result may bypass child startup. */
export function validateWorkSkipped(value: unknown, launch: WorkLaunch): WorkSkipped {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Work skip reply.");
  const row = value as Record<string, unknown>;
  const fields = ["status", "reason", "action", "run_started", "case_uid", "execution_id", "launch_key", "slice_ids", "advisories"];
  if (Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key))
    || row.status !== "skipped" || row.action !== "lead_continue" || row.run_started !== false
    || !["review_budget_exhausted", "verification_budget_exhausted", "transport_budget_exhausted"].includes(String(row.reason))
    || row.execution_id !== launch.work.execution || row.launch_key !== launch.launchKey
    || typeof row.case_uid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.case_uid)
    || !Array.isArray(row.advisories) || row.advisories.length > 4
    || row.advisories.some(code => !["predicted_scope_drift", "scope_mapping_inferred", "slice_selection_unresolved", "acceptance_changed"].includes(code))
    || new Set(row.advisories).size !== row.advisories.length) throw new Error("Invalid Work skip reply.");
  const slices = validateWorkBinding({ ...launch.work, selectedSliceIds: row.slice_ids })!.selectedSliceIds!;
  return { status: "skipped", reason: row.reason as WorkSkipped["reason"], action: "lead_continue", run_started: false,
    case_uid: row.case_uid, execution_id: launch.work.execution, launch_key: launch.launchKey,
    slice_ids: slices, advisories: [...row.advisories] as string[] };
}

/** Work-issued authority for one exact successor attempt. */
export interface WorkRecovery {
  predecessorAssignmentId: string;
  predecessorLaunchKey: string;
  recoveryAuthorizationId: string;
  expectedTerminalSnapshotDigest: string;
}

export interface WorkLaunch {
  launchKey: string;
  parentSessionId: string;
  invocationId: string;
  agentId: string;
  agentType: string;
  agentName?: string;
  description: string;
  cwd: string;
  work: WorkBinding;
  reservation?: WorkReservation;
  childSessionId?: string;
  bound?: boolean;
  recovery?: WorkRecovery;
}

export interface WorkTerminalProof {
  schemaVersion: 2;
  reservationId: string;
  launchKey: string;
  childSessionId: string | null;
  bound: boolean;
  promptDelivered: boolean;
  modelTurnCount: number;
  toolUseCount: number;
  resultProduced: boolean;
  terminalStatus: "completed" | "steered" | "aborted" | "stopped" | "timeout" | "error";
  startupEffectsAbsent: boolean;
}

export interface WorkSnapshotV1 {
  version: 1;
  launch: WorkLaunch;
  status: AgentStatus;
}

export interface WorkSnapshotV2 {
  version: 2;
  launch: WorkLaunch;
  proof: WorkTerminalProof;
  recovery?: WorkRecovery;
}

export type WorkSnapshot = WorkSnapshotV1 | WorkSnapshotV2;

export function assertWorkString(value: unknown, field: string, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${field} must be a nonempty string of at most ${max} characters without control characters.`);
  }
}

export function validateWorkBinding(value: unknown): WorkBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("work must be an object.");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["case", "execution", "actor", "scopes", "intendedOutcome", "selectedSliceIds"].includes(key))) throw new Error("Unknown work binding field.");
  assertWorkString(raw.case, "work.case", 256);
  assertWorkString(raw.execution, "work.execution", 256);
  assertWorkString(raw.actor, "work.actor", 256);
  if (!Array.isArray(raw.scopes) || raw.scopes.length < 1 || raw.scopes.length > 64) throw new Error("work.scopes must contain 1-64 scopes.");
  const scopes = raw.scopes.map(scope => { assertWorkString(scope, "work.scopes[]", 1024); return scope; });
  if (new Set(scopes).size !== scopes.length) throw new Error("work.scopes must be unique.");
  if (raw.intendedOutcome !== undefined) assertWorkString(raw.intendedOutcome, "work.intendedOutcome", 2048);
  let selectedSliceIds: string[] | undefined;
  if (raw.selectedSliceIds !== undefined) {
    if (!Array.isArray(raw.selectedSliceIds) || raw.selectedSliceIds.length < 1 || raw.selectedSliceIds.length > 128) throw new Error("work.selectedSliceIds must contain 1-128 IDs.");
    selectedSliceIds = raw.selectedSliceIds.map(id => {
      assertWorkString(id, "work.selectedSliceIds[]", 512);
      if (Array.from(id).length > 256) throw new Error("work.selectedSliceIds IDs must be at most 256 characters.");
      if (id.trim() !== id) throw new Error("work.selectedSliceIds must not have surrounding whitespace.");
      return id;
    });
    if (new Set(selectedSliceIds).size !== selectedSliceIds.length) throw new Error("work.selectedSliceIds must be unique.");
    // Match Work's Unicode code-point ordering, not JS's UTF-16 unit ordering.
    selectedSliceIds.sort((left, right) => {
      const a = Array.from(left, char => char.codePointAt(0)!);
      const b = Array.from(right, char => char.codePointAt(0)!);
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        if (a[index] !== b[index]) return a[index] - b[index];
      }
      return a.length - b.length;
    });
  }
  return { case: raw.case, execution: raw.execution, actor: raw.actor, scopes,
    ...(raw.intendedOutcome !== undefined && { intendedOutcome: raw.intendedOutcome as string }),
    ...(selectedSliceIds !== undefined && { selectedSliceIds }) };
}

export function workLaunchKey(parentSessionId: string, invocationId: string): string {
  assertWorkString(parentSessionId, "parentSessionId", 512);
  assertWorkString(invocationId, "invocationId", 512);
  return createHash("sha256").update(JSON.stringify([parentSessionId, invocationId])).digest("hex");
}

/** Fixed-field validated binding identity for local replay checkpoints. */
export function workBindingDigest(value: unknown): string {
  const binding = validateWorkBinding(value);
  if (!binding) throw new Error("Work checkpoint requires a binding.");
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}

export const WORK_RPC_PROTOCOL_VERSION = 3;
export const WORK_RPC_DEADLINE_MS = 60_000;
export const WORK_RPC_REPLY_GRACE_MS = 5_000;
export type WorkReply = { success: true; data: unknown } | { success: false; error: unknown };

/** One deadline includes adapter queueing; reply grace never authorizes late success. */
export function requestWorkReply(events: EventBus, action: "reserve" | "bind" | "finalize" | "reconcile", payload: WorkLaunch | WorkSnapshot): Promise<WorkReply> {
  const channel = `subagents:work:${action}`;
  const requestId = randomUUID();
  const deadlineAt = Date.now() + WORK_RPC_DEADLINE_MS;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const indeterminate = () => new Error(`Work ${action} adapter did not reply within its deadline; outcome indeterminate. Reconcile the exact assignment before retrying.`);
    const timer = setTimeout(() => finish(indeterminate()), WORK_RPC_DEADLINE_MS + WORK_RPC_REPLY_GRACE_MS);
    const finish = (error?: Error, reply?: WorkReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error); else resolve(reply!);
    };
    try {
      unsubscribe = events.on(`${channel}:reply:${requestId}`, raw => {
        const reply = raw as { success?: unknown; data?: unknown; error?: unknown } | null;
        if (reply?.success === true && Date.now() >= deadlineAt) finish(indeterminate());
        else if (reply?.success === true) finish(undefined, { success: true, data: reply.data });
        else finish(undefined, { success: false, error: reply?.error });
      });
      events.emit(channel, { requestId, payload: JSON.parse(JSON.stringify(payload)), protocolVersion: WORK_RPC_PROTOCOL_VERSION, deadlineAt });
    } catch { finish(new Error(`Work ${action} adapter unavailable.`)); }
  });
}

/** Launch failures redact adapter details; terminal callers retain typed refusals. */
export async function requestWork(events: EventBus, action: "reserve" | "bind" | "finalize" | "reconcile", payload: WorkLaunch | WorkSnapshot): Promise<unknown> {
  const reply = await requestWorkReply(events, action, payload);
  if (!reply.success) throw new Error(`Work ${action} adapter refused the request.`);
  return reply.data;
}

export function validateWorkReservation(value: unknown): WorkReservation {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "reservationId")) throw new Error("Invalid Work reservation reply.");
  const reservationId = (value as Record<string, unknown>).reservationId;
  assertWorkString(reservationId, "reservationId", 512);
  return { reservationId };
}

export function validateWorkRecovery(value: unknown): WorkRecovery {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Work recovery descriptor.");
  const raw = value as Record<string, unknown>;
  const fields = ["predecessorAssignmentId", "predecessorLaunchKey", "recoveryAuthorizationId", "expectedTerminalSnapshotDigest"];
  if (Object.keys(raw).length !== fields.length || Object.keys(raw).some(key => !fields.includes(key))) throw new Error("Invalid Work recovery descriptor.");
  assertWorkString(raw.predecessorAssignmentId, "predecessorAssignmentId", 512);
  assertWorkString(raw.predecessorLaunchKey, "predecessorLaunchKey", 512);
  assertWorkString(raw.recoveryAuthorizationId, "recoveryAuthorizationId", 512);
  assertWorkString(raw.expectedTerminalSnapshotDigest, "expectedTerminalSnapshotDigest", 64);
  if (!/^[0-9a-f]{64}$/.test(raw.expectedTerminalSnapshotDigest)) throw new Error("Invalid Work terminal snapshot digest.");
  return {
    predecessorAssignmentId: raw.predecessorAssignmentId,
    predecessorLaunchKey: raw.predecessorLaunchKey,
    recoveryAuthorizationId: raw.recoveryAuthorizationId,
    expectedTerminalSnapshotDigest: raw.expectedTerminalSnapshotDigest,
  };
}

const TERMINAL_STATUSES = ["completed", "steered", "aborted", "stopped", "timeout", "error"] as const;

export function validateWorkTerminalProof(value: unknown): WorkTerminalProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Work terminal proof.");
  const raw = value as Record<string, unknown>;
  const fields = ["schemaVersion", "reservationId", "launchKey", "childSessionId", "bound", "promptDelivered", "modelTurnCount", "toolUseCount", "resultProduced", "terminalStatus", "startupEffectsAbsent"];
  if (Object.keys(raw).length !== fields.length || Object.keys(raw).some(key => !fields.includes(key)) || raw.schemaVersion !== 2) throw new Error("Invalid Work terminal proof.");
  assertWorkString(raw.reservationId, "proof.reservationId", 512);
  assertWorkString(raw.launchKey, "proof.launchKey", 512);
  if (raw.childSessionId !== null) assertWorkString(raw.childSessionId, "proof.childSessionId", 512);
  if (typeof raw.bound !== "boolean" || typeof raw.promptDelivered !== "boolean" || typeof raw.resultProduced !== "boolean" || typeof raw.startupEffectsAbsent !== "boolean") throw new Error("Invalid Work terminal proof boolean.");
  if (!Number.isSafeInteger(raw.modelTurnCount) || (raw.modelTurnCount as number) < 0 || !Number.isSafeInteger(raw.toolUseCount) || (raw.toolUseCount as number) < 0) throw new Error("Invalid Work terminal proof counter.");
  if (!TERMINAL_STATUSES.includes(raw.terminalStatus as WorkTerminalProof["terminalStatus"]) || (raw.bound && raw.childSessionId === null)) throw new Error("Invalid Work terminal proof state.");
  return {
    schemaVersion: 2, reservationId: raw.reservationId, launchKey: raw.launchKey,
    childSessionId: raw.childSessionId as string | null, bound: raw.bound,
    promptDelivered: raw.promptDelivered, modelTurnCount: raw.modelTurnCount as number,
    toolUseCount: raw.toolUseCount as number, resultProduced: raw.resultProduced,
    terminalStatus: raw.terminalStatus as WorkTerminalProof["terminalStatus"],
    startupEffectsAbsent: raw.startupEffectsAbsent,
  };
}

/** UTF-8, lexicographically keyed, whitespace-free JSON shared with Work. */
export function canonicalWorkTerminalProofBytes(value: unknown): Buffer {
  const proof = validateWorkTerminalProof(value);
  return Buffer.from(JSON.stringify({
    bound: proof.bound, childSessionId: proof.childSessionId, launchKey: proof.launchKey,
    modelTurnCount: proof.modelTurnCount, promptDelivered: proof.promptDelivered,
    reservationId: proof.reservationId, resultProduced: proof.resultProduced,
    schemaVersion: proof.schemaVersion, startupEffectsAbsent: proof.startupEffectsAbsent,
    terminalStatus: proof.terminalStatus, toolUseCount: proof.toolUseCount,
  }), "utf8");
}

export function workTerminalProofDigest(value: unknown): string {
  return createHash("sha256").update(canonicalWorkTerminalProofBytes(value)).digest("hex");
}

function normalizedLaunch(launch: WorkLaunch): WorkLaunch {
  if (!validateWorkBinding(launch.work) || launch.launchKey !== workLaunchKey(launch.parentSessionId, launch.invocationId)) throw new Error("Invalid Work launch.");
  assertWorkString(launch.agentId, "agentId", 128);
  assertWorkString(launch.agentType, "agentType", 128);
  assertWorkString(launch.description, "description", 1024);
  assertWorkString(launch.cwd, "cwd", 4096);
  if (launch.agentName !== undefined) assertWorkString(launch.agentName, "agentName", 64);
  if (launch.childSessionId !== undefined) assertWorkString(launch.childSessionId, "childSessionId", 512);
  if (launch.bound !== undefined && typeof launch.bound !== "boolean") throw new Error("Invalid bound state.");
  return {
    launchKey: launch.launchKey, parentSessionId: launch.parentSessionId, invocationId: launch.invocationId,
    agentId: launch.agentId, agentType: launch.agentType,
    ...(launch.agentName !== undefined && { agentName: launch.agentName }),
    description: launch.description, cwd: launch.cwd, work: validateWorkBinding(launch.work)!,
    ...(launch.reservation !== undefined && { reservation: validateWorkReservation(launch.reservation) }),
    ...(launch.childSessionId !== undefined && { childSessionId: launch.childSessionId }),
    ...(launch.bound !== undefined && { bound: launch.bound }),
    ...(launch.recovery !== undefined && { recovery: validateWorkRecovery(launch.recovery) }),
  };
}

/** V1 is retained for diagnostics/reconciliation only; it carries no recovery proof. */
export function retainedWorkSnapshots(branch: readonly unknown[]): WorkSnapshot[] {
  const retained = new Map<string, WorkSnapshot>();
  for (const raw of branch) {
    try {
      const entry = raw as { customType?: string; data?: WorkSnapshot };
      if (entry?.customType !== "subagents:work-record" || !entry.data) continue;
      const snapshot = entry.data;
      if (snapshot.version === 1) {
        if (!["queued", "running", "skipped", ...TERMINAL_STATUSES].includes(snapshot.status)) continue;
        const launch = normalizedLaunch(snapshot.launch);
        if (retained.get(launch.launchKey)?.version === 2) continue;
        retained.set(launch.launchKey, { version: 1, launch, status: snapshot.status });
      } else if (snapshot.version === 2) {
        const launch = normalizedLaunch(snapshot.launch);
        const proof = validateWorkTerminalProof(snapshot.proof);
        if (!launch.reservation || proof.reservationId !== launch.reservation.reservationId || proof.launchKey !== launch.launchKey
          || proof.childSessionId !== (launch.childSessionId ?? null) || proof.bound !== launch.bound || proof.reservationId === launch.agentId) continue;
        retained.set(launch.launchKey, { version: 2, launch, proof, recovery: snapshot.recovery && validateWorkRecovery(snapshot.recovery) });
      }
    } catch { /* Corrupt retained receipts never authorize a launch. */ }
  }
  return [...retained.values()];
}
