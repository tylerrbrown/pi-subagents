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
}

export const WorkBindingSchema = Type.Object({
  case: Type.String({ minLength: 1, maxLength: 256 }),
  execution: Type.String({ minLength: 1, maxLength: 256 }),
  actor: Type.String({ minLength: 1, maxLength: 256 }),
  scopes: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 64, uniqueItems: true }),
  intendedOutcome: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
}, { additionalProperties: false });

export interface WorkReservation { reservationId: string }

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
  if (Object.keys(raw).some(key => !["case", "execution", "actor", "scopes", "intendedOutcome"].includes(key))) throw new Error("Unknown work binding field.");
  assertWorkString(raw.case, "work.case", 256);
  assertWorkString(raw.execution, "work.execution", 256);
  assertWorkString(raw.actor, "work.actor", 256);
  if (!Array.isArray(raw.scopes) || raw.scopes.length < 1 || raw.scopes.length > 64) throw new Error("work.scopes must contain 1-64 scopes.");
  const scopes = raw.scopes.map(scope => { assertWorkString(scope, "work.scopes[]", 1024); return scope; });
  if (new Set(scopes).size !== scopes.length) throw new Error("work.scopes must be unique.");
  if (raw.intendedOutcome !== undefined) assertWorkString(raw.intendedOutcome, "work.intendedOutcome", 2048);
  return { case: raw.case, execution: raw.execution, actor: raw.actor, scopes, ...(raw.intendedOutcome !== undefined && { intendedOutcome: raw.intendedOutcome as string }) };
}

export function workLaunchKey(parentSessionId: string, invocationId: string): string {
  assertWorkString(parentSessionId, "parentSessionId", 512);
  assertWorkString(invocationId, "invocationId", 512);
  return createHash("sha256").update(JSON.stringify([parentSessionId, invocationId])).digest("hex");
}

/** Register the reply listener BEFORE emitting, including for synchronous adapters. */
export function requestWork(events: EventBus, action: "reserve" | "bind" | "finalize" | "reconcile", payload: WorkLaunch | WorkSnapshot): Promise<unknown> {
  const channel = `subagents:work:${action}`;
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Work ${action} adapter did not reply.`)); }, 5000);
    const finish = (error?: Error, data?: unknown) => {
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error); else resolve(data);
    };
    try {
      unsubscribe = events.on(`${channel}:reply:${requestId}`, raw => {
        const reply = raw as { success?: unknown; data?: unknown } | null;
        if (!reply || reply.success !== true) finish(new Error(`Work ${action} adapter refused the request.`));
        else finish(undefined, reply.data);
      });
      events.emit(channel, { ...JSON.parse(JSON.stringify(payload)), requestId });
    } catch { finish(new Error(`Work ${action} adapter unavailable.`)); }
  });
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
    agentId: launch.agentId, agentType: launch.agentType, agentName: launch.agentName,
    description: launch.description, cwd: launch.cwd, work: validateWorkBinding(launch.work)!,
    reservation: launch.reservation && validateWorkReservation(launch.reservation),
    childSessionId: launch.childSessionId, bound: launch.bound,
    recovery: launch.recovery && validateWorkRecovery(launch.recovery),
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
        if (!["queued", "running", ...TERMINAL_STATUSES].includes(snapshot.status)) continue;
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
