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
}

export interface WorkSnapshot {
  version: 1;
  launch: WorkLaunch;
  /** Typed terminal status is the only outcome a Work receipt carries; never private result prose. */
  status: AgentStatus;
}

export function assertWorkString(value: unknown, field: string, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${field} must be a nonempty string of at most ${max} characters without control characters.`);
  }
}

export function validateWorkBinding(value: unknown): WorkBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("work must be an object.");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["case", "execution", "actor", "scopes", "intendedOutcome"].includes(key))) {
    throw new Error("Unknown work binding field.");
  }
  assertWorkString(raw.case, "work.case", 256);
  assertWorkString(raw.execution, "work.execution", 256);
  assertWorkString(raw.actor, "work.actor", 256);
  if (!Array.isArray(raw.scopes) || raw.scopes.length < 1 || raw.scopes.length > 64) throw new Error("work.scopes must contain 1-64 scopes.");
  const scopes = raw.scopes.map(scope => {
    assertWorkString(scope, "work.scopes[]", 1024);
    return scope;
  });
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
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Work ${action} adapter did not reply.`));
    }, 5000);
    const finish = (error?: Error, data?: unknown) => {
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve(data);
    };
    try {
      unsubscribe = events.on(`${channel}:reply:${requestId}`, raw => {
        const reply = raw as { success?: unknown; data?: unknown } | null;
        // Do not echo an adapter's arbitrary error body into terminal events.
        if (!reply || reply.success !== true) finish(new Error(`Work ${action} adapter refused the request.`));
        else finish(undefined, reply.data);
      });
      // Detached JSON data prevents a listener from mutating the authorization state.
      events.emit(channel, { ...JSON.parse(JSON.stringify(payload)), requestId });
    } catch {
      finish(new Error(`Work ${action} adapter unavailable.`));
    }
  });
}

export function validateWorkReservation(value: unknown): WorkReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => key !== "reservationId")) throw new Error("Invalid Work reservation reply.");
  const reservationId = (value as Record<string, unknown>).reservationId;
  assertWorkString(reservationId, "reservationId", 512);
  return { reservationId };
}

/** Corrupt retained receipts are ignored; they can never authorize a launch. */
export function retainedWorkSnapshots(branch: readonly unknown[]): WorkSnapshot[] {
  const retained = new Map<string, WorkSnapshot>();
  for (const raw of branch) {
    try {
      const entry = raw as { customType?: string; data?: WorkSnapshot };
      if (entry?.customType !== "subagents:work-record" || entry.data?.version !== 1) continue;
      const snapshot = entry.data;
      const launch = snapshot.launch;
      if (!validateWorkBinding(launch.work) || launch.launchKey !== workLaunchKey(launch.parentSessionId, launch.invocationId)) continue;
      assertWorkString(launch.agentId, "agentId", 128);
      assertWorkString(launch.agentType, "agentType", 128);
      assertWorkString(launch.description, "description", 1024);
      assertWorkString(launch.cwd, "cwd", 4096);
      if (launch.agentName !== undefined) assertWorkString(launch.agentName, "agentName", 64);
      if (launch.childSessionId !== undefined) assertWorkString(launch.childSessionId, "childSessionId", 512);
      if (launch.reservation !== undefined) validateWorkReservation(launch.reservation);
      if (!["queued", "running", "completed", "steered", "aborted", "stopped", "timeout", "error"].includes(snapshot.status)) continue;
      // Reconstruct the wire allowlist rather than forwarding persisted arbitrary fields.
      retained.set(launch.launchKey, {
        version: 1,
        launch: {
          launchKey: launch.launchKey, parentSessionId: launch.parentSessionId, invocationId: launch.invocationId,
          agentId: launch.agentId, agentType: launch.agentType, agentName: launch.agentName,
          description: launch.description, cwd: launch.cwd, work: validateWorkBinding(launch.work)!,
          reservation: launch.reservation && validateWorkReservation(launch.reservation),
          childSessionId: launch.childSessionId, bound: launch.bound === true,
        },
        status: snapshot.status,
      });
    } catch { /* Invalid receipt; never respawn from replay. */ }
  }
  return [...retained.values()];
}
