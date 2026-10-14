import type { ContextGuardState } from "./context-guard.js";
import type { AgentInvocation } from "./types.js";
import type { LifetimeUsage } from "./usage.js";
import { retainedWorkSnapshots, validateWorkBinding, validateWorkRecovery, type WorkBinding, type WorkLaunch, type WorkRecovery } from "./work-lifecycle.js";

export const SUBAGENT_RECORD_VERSION = 1 as const;
export const SUBAGENT_NOTIFICATION_VERSION = 1 as const;
export const WORK_RECONCILE_CHECKPOINT_VERSION = 1 as const;

export interface WorkReconcileLedgerState {
  acknowledged: Set<string>;
  quarantined: Map<string, string>;
  diagnostics: Set<string>;
}

function workReconcileKey(protocolVersion: number, launchKey: string, snapshotDigest: string): string {
  return `${protocolVersion}:${launchKey}:${snapshotDigest}`;
}

const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}$/;
const HANDLE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_RECORDS = 10_000;
const MAX_TRANSITION_IDS = 10_000;
const MAX_HANDLE_CHARS = 64;
const MAX_TYPE_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 1_024;
const MAX_STATUS_TEXT_CHARS = 8_192;
const MAX_TOOL_CALL_ID_CHARS = 512;
const MAX_PATH_CHARS = 4_096;
export const MAX_CAPTURE_CHARS = 5_000_000;
const MAX_CAPTURED_RECORD_CHARS = 8_000_000;
const MAX_COUNT = 1_000_000_000;

export type PersistedAgentStatus = "completed" | "steered" | "aborted" | "stopped" | "timeout" | "error" | "skipped";

export interface PersistedAgentSnapshot {
  version: typeof SUBAGENT_RECORD_VERSION;
  id: string;
  handles: { handle?: string; alias?: string };
  type: string;
  description: string;
  status: PersistedAgentStatus;
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt: number;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  contextPercent: number | null;
  contextGuard?: ContextGuardState;
  contextAborted?: boolean;
  contextSteered?: boolean;
  toolCallId?: string;
  work?: WorkBinding;
  workLaunch?: WorkLaunch;
  invocation?: AgentInvocation;
  isBackground?: boolean;
  output: { file?: string; sessionFile?: string };
  conversation?: string;
  notificationPending: boolean;
}

export interface PersistedAgentRecord extends Omit<PersistedAgentSnapshot, "version"> {
  version: 0 | typeof SUBAGENT_RECORD_VERSION;
}

export type NotificationAction = "consumed" | "wake_claimed";

export interface NotificationTransition {
  version: typeof SUBAGENT_NOTIFICATION_VERSION;
  action: NotificationAction;
  agentIds: string[];
}

export interface NotificationLedgerState {
  records: Map<string, PersistedAgentRecord>;
  pending: Set<string>;
  claimed: Set<string>;
  consumed: Set<string>;
}

interface CustomEntry {
  customType?: unknown;
  data?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(object, key);
}

function boundedString(value: unknown, max: number, allowEmpty = true): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);
}

function optionalBoundedString(value: unknown, max: number): value is string | undefined {
  return value === undefined || boundedString(value, max);
}

function finiteNonnegative(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}

function count(value: unknown): value is number {
  return finiteNonnegative(value, MAX_COUNT) && Number.isInteger(value);
}

function isTerminalStatus(value: unknown): value is PersistedAgentStatus {
  return value === "completed" || value === "steered" || value === "aborted" || value === "stopped" || value === "timeout" || value === "error" || value === "skipped";
}

function normalizeHandle(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  if (!boundedString(value, MAX_HANDLE_CHARS) || !HANDLE.test(value)) return false;
  return value;
}

function normalizeInvocation(value: unknown): AgentInvocation | undefined | false {
  if (value === undefined) return undefined;
  if (!isObject(value)) return false;
  if (Object.keys(value).some(key => !["modelName", "modelId", "thinking", "requestedModel", "requestedModelId", "requestedThinking", "maxTurns", "isolated", "inheritContext", "runInBackground", "isolation"].includes(key))) return false;
  const thinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (!optionalBoundedString(value.modelName, 512)
    || !optionalBoundedString(value.modelId, 512)
    || !optionalBoundedString(value.requestedModel, 512)
    || !optionalBoundedString(value.requestedModelId, 512)
    || (value.thinking !== undefined && !thinking.has(value.thinking as string))
    || (value.requestedThinking !== undefined && !thinking.has(value.requestedThinking as string))
    || (value.maxTurns !== undefined && !count(value.maxTurns))
    || (value.isolated !== undefined && typeof value.isolated !== "boolean")
    || (value.inheritContext !== undefined && typeof value.inheritContext !== "boolean")
    || (value.runInBackground !== undefined && typeof value.runInBackground !== "boolean")
    || (value.isolation !== undefined && value.isolation !== "worktree" && value.isolation !== "off")) return false;
  return {
    ...(value.modelName !== undefined && { modelName: value.modelName as string }),
    ...(value.modelId !== undefined && { modelId: value.modelId as string }),
    ...(value.thinking !== undefined && { thinking: value.thinking as AgentInvocation["thinking"] }),
    ...(value.requestedModel !== undefined && { requestedModel: value.requestedModel as string }),
    ...(value.requestedModelId !== undefined && { requestedModelId: value.requestedModelId as string }),
    ...(value.requestedThinking !== undefined && { requestedThinking: value.requestedThinking as AgentInvocation["requestedThinking"] }),
    ...(value.maxTurns !== undefined && { maxTurns: value.maxTurns as number }),
    ...(value.isolated !== undefined && { isolated: value.isolated as boolean }),
    ...(value.inheritContext !== undefined && { inheritContext: value.inheritContext as boolean }),
    ...(value.runInBackground !== undefined && { runInBackground: value.runInBackground as boolean }),
    ...(value.isolation !== undefined && { isolation: value.isolation as AgentInvocation["isolation"] }),
  };
}

function normalizeContextGuard(value: unknown): ContextGuardState | undefined {
  if (!isObject(value)
    || !finiteNonnegative(value.warnPercent, 100) || value.warnPercent <= 0
    || !finiteNonnegative(value.stopPercent, 100) || value.stopPercent <= value.warnPercent
    || typeof value.warned !== "boolean" || typeof value.stopped !== "boolean"
    || (value.peakPercent !== null && !finiteNonnegative(value.peakPercent, 100))) return undefined;
  return {
    warnPercent: value.warnPercent,
    stopPercent: value.stopPercent,
    warned: value.warned,
    stopped: value.stopped,
    peakPercent: value.peakPercent as number | null,
  };
}

function normalizeUsage(value: unknown, required: boolean): LifetimeUsage | undefined {
  if (!isObject(value)) return required ? undefined : { input: 0, output: 0, cacheWrite: 0 };
  if (!finiteNonnegative(value.input, MAX_COUNT)
    || !finiteNonnegative(value.output, MAX_COUNT)
    || !finiteNonnegative(value.cacheWrite, MAX_COUNT)
    || (value.cacheRead !== undefined && !finiteNonnegative(value.cacheRead, MAX_COUNT))
    || (value.cost !== undefined && !finiteNonnegative(value.cost, MAX_COUNT))) return undefined;
  return {
    input: value.input,
    output: value.output,
    cacheWrite: value.cacheWrite,
    ...(value.cacheRead !== undefined && { cacheRead: value.cacheRead }),
    ...(value.cost !== undefined && { cost: value.cost }),
  };
}

function normalizeRecord(data: unknown): PersistedAgentRecord | undefined {
  if (!isObject(data)) return undefined;
  const versioned = hasOwn(data, "version");
  if (versioned && data.version !== SUBAGENT_RECORD_VERSION) return undefined;
  if (!boundedString(data.id, 17, false) || !AGENT_ID.test(data.id)) return undefined;
  if (!boundedString(data.type, MAX_TYPE_CHARS, false)
    || !boundedString(data.description, MAX_DESCRIPTION_CHARS, false)
    || !isTerminalStatus(data.status)
    || !optionalBoundedString(data.result, MAX_CAPTURE_CHARS)
    || !optionalBoundedString(data.error, MAX_STATUS_TEXT_CHARS)
    || !finiteNonnegative(data.startedAt)
    || !finiteNonnegative(data.completedAt)
    || data.completedAt < data.startedAt) return undefined;

  const capturedChars = (data.result?.length ?? 0) + (data.conversation && typeof data.conversation === "string" ? data.conversation.length : 0);
  if (capturedChars > MAX_CAPTURED_RECORD_CHARS) return undefined;

  if (!versioned) {
    const handle = normalizeHandle(data.handle);
    const alias = normalizeHandle(data.alias);
    if (handle === false || alias === false) return undefined;
    return {
      version: 0,
      id: data.id,
      handles: { handle, alias },
      type: data.type,
      description: data.description,
      status: data.status,
      result: data.result,
      error: data.error,
      toolUses: 0,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      contextPercent: null,
      output: {},
      notificationPending: false,
    };
  }

  if (!isObject(data.handles) || !isObject(data.output)) return undefined;
  const handle = normalizeHandle(data.handles.handle);
  const alias = normalizeHandle(data.handles.alias);
  const usage = normalizeUsage(data.lifetimeUsage, true);
  const invocation = normalizeInvocation(data.invocation);
  const contextGuard = data.contextGuard === undefined ? undefined : normalizeContextGuard(data.contextGuard);
  if (handle === false || alias === false || invocation === false || !usage
    || (data.contextGuard !== undefined && !contextGuard)
    || !count(data.toolUses)
    || !count(data.compactionCount)
    || (data.contextPercent !== null && !finiteNonnegative(data.contextPercent, 100))
    || (data.contextAborted !== undefined && typeof data.contextAborted !== "boolean")
    || (data.contextSteered !== undefined && typeof data.contextSteered !== "boolean")
    || !optionalBoundedString(data.toolCallId, MAX_TOOL_CALL_ID_CHARS)
    || (data.isBackground !== undefined && typeof data.isBackground !== "boolean")
    || !optionalBoundedString(data.output.file, MAX_PATH_CHARS)
    || !optionalBoundedString(data.output.sessionFile, MAX_PATH_CHARS)
    || !optionalBoundedString(data.conversation, MAX_CAPTURE_CHARS)
    || typeof data.notificationPending !== "boolean"
    || (data.notificationPending && data.isBackground === false)) return undefined;

  let work: WorkBinding | undefined;
  let workLaunch: WorkLaunch | undefined;
  try {
    work = validateWorkBinding(data.work);
    if (data.workLaunch !== undefined) {
      workLaunch = retainedWorkSnapshots([{ customType: "subagents:work-record", data: {
        version: 1, launch: data.workLaunch, status: data.status,
      } }])[0]?.launch;
      if (!workLaunch || workLaunch.agentId !== data.id || JSON.stringify(work) !== JSON.stringify(workLaunch.work)) return undefined;
    }
    if (work && !workLaunch) return undefined;
  } catch { return undefined; }

  return {
    version: SUBAGENT_RECORD_VERSION,
    work,
    workLaunch,
    id: data.id,
    handles: { handle, alias },
    type: data.type,
    description: data.description,
    status: data.status,
    result: data.result,
    error: data.error,
    toolUses: data.toolUses,
    startedAt: data.startedAt,
    completedAt: data.completedAt,
    lifetimeUsage: usage,
    compactionCount: data.compactionCount,
    contextPercent: data.contextPercent,
    contextGuard,
    contextAborted: data.contextAborted as boolean | undefined,
    contextSteered: data.contextSteered as boolean | undefined,
    toolCallId: data.toolCallId,
    invocation,
    isBackground: data.isBackground,
    output: { file: data.output.file, sessionFile: data.output.sessionFile },
    conversation: data.conversation,
    notificationPending: data.notificationPending,
  };
}

export function isPersistedAgentSnapshot(data: unknown): data is PersistedAgentSnapshot {
  return normalizeRecord(data)?.version === SUBAGENT_RECORD_VERSION;
}

/** Fold append-only terminal replay checkpoints. Invalid entries never suppress replay. */
export function foldWorkReconcileLedger(branch: readonly unknown[]): WorkReconcileLedgerState {
  const state: WorkReconcileLedgerState = {
    acknowledged: new Set(), quarantined: new Map(), diagnostics: new Set(),
  };
  for (const rawEntry of branch) {
    if (!isObject(rawEntry)) continue;
    const entry = rawEntry as CustomEntry;
    if (!isObject(entry.data) || entry.data.version !== WORK_RECONCILE_CHECKPOINT_VERSION
      || entry.data.protocolVersion !== 2
      || !boundedString(entry.data.launchKey, 512, false)
      || !boundedString(entry.data.snapshotDigest, 64, false)
      || !/^[0-9a-f]{64}$/.test(entry.data.snapshotDigest)) continue;
    if (entry.data.bindingDigest !== undefined && (!boundedString(entry.data.bindingDigest, 64, false)
      || !/^[0-9a-f]{64}$/.test(entry.data.bindingDigest))) continue;
    const key = workReconcileCheckpointKey(2, entry.data.launchKey, entry.data.snapshotDigest, entry.data.bindingDigest as string | undefined);
    if (entry.customType === "subagents:work-reconcile-ack") {
      if (Object.keys(entry.data).some(field => !["version", "protocolVersion", "launchKey", "snapshotDigest", "bindingDigest", "recovery"].includes(field))) continue;
      if (entry.data.recovery !== undefined) {
        try {
          const recovery = validateWorkRecovery(entry.data.recovery);
          if (recovery.predecessorLaunchKey !== entry.data.launchKey
            || recovery.expectedTerminalSnapshotDigest !== entry.data.snapshotDigest) continue;
        } catch { continue; }
      }
      state.acknowledged.add(key);
    } else if (entry.customType === "subagents:work-reconcile-diagnostic") {
      if (Object.keys(entry.data).some(field => !["version", "protocolVersion", "launchKey", "snapshotDigest", "bindingDigest", "failureDigest", "code", "action"].includes(field))
        || !boundedString(entry.data.failureDigest, 64, false) || !/^[0-9a-f]{64}$/.test(entry.data.failureDigest)
        || !boundedString(entry.data.code, 128, false) || !boundedString(entry.data.action, 128, false)) continue;
      state.quarantined.set(key, entry.data.failureDigest);
      state.diagnostics.add(entry.data.failureDigest);
    }
  }
  return state;
}

export function workReconcileCheckpointKey(protocolVersion: number, launchKey: string, snapshotDigest: string, bindingDigest?: string): string {
  return workReconcileKey(protocolVersion, launchKey, snapshotDigest) + (bindingDigest === undefined ? "" : `:${bindingDigest}`);
}

/**
 * A retained v1 record cannot mint successor authority. S04 will persist and
 * return the exact Work-issued v2 descriptor after authorization; until then,
 * missing proof fails closed rather than inferring zero work from usage.
 */
export function workRecoveryDescriptor(record: PersistedAgentRecord): WorkRecovery | undefined {
  const launch = record.workLaunch;
  const recovery = launch?.recovery;
  if (!launch || !recovery
    || recovery.predecessorAssignmentId !== launch.reservation?.reservationId
    || recovery.predecessorLaunchKey !== launch.launchKey) return undefined;
  return recovery;
}

function normalizeTransition(data: unknown): NotificationTransition | undefined {
  if (!isObject(data) || data.version !== SUBAGENT_NOTIFICATION_VERSION) return undefined;
  if (data.action !== "consumed" && data.action !== "wake_claimed") return undefined;
  if (!Array.isArray(data.agentIds) || data.agentIds.length === 0 || data.agentIds.length > MAX_TRANSITION_IDS) return undefined;
  const agentIds: string[] = [];
  const unique = new Set<string>();
  for (const id of data.agentIds) {
    if (!boundedString(id, 17, false) || !AGENT_ID.test(id) || unique.has(id)) return undefined;
    unique.add(id);
    agentIds.push(id);
  }
  return { version: SUBAGENT_NOTIFICATION_VERSION, action: data.action, agentIds };
}

/**
 * Local pi session files are trusted input. Validation below bounds corruption
 * and resource use; it is not an authenticity or tamper-verification boundary.
 */
export function foldNotificationLedger(branch: readonly unknown[]): NotificationLedgerState {
  const state: NotificationLedgerState = {
    records: new Map(),
    pending: new Set(),
    claimed: new Set(),
    consumed: new Set(),
  };

  for (const rawEntry of branch) {
    if (!isObject(rawEntry)) continue;
    const entry = rawEntry as CustomEntry;
    if (entry.customType === "subagents:record") {
      const record = normalizeRecord(entry.data);
      if (!record) continue;
      const previous = state.records.get(record.id);
      if (!previous && state.records.size >= MAX_RECORDS) continue;
      if (previous?.version === SUBAGENT_RECORD_VERSION && record.version === 0) continue;
      if (previous && (record.startedAt < previous.startedAt
        || (record.startedAt === previous.startedAt && record.completedAt < previous.completedAt))) continue;

      const freshRun = previous !== undefined && (
        record.startedAt !== previous.startedAt
        || record.completedAt !== previous.completedAt
        || (record.notificationPending && record.result !== previous.result)
      );
      state.records.set(record.id, record);
      state.pending.delete(record.id);
      if (freshRun) {
        state.claimed.delete(record.id);
        state.consumed.delete(record.id);
      }
      if (record.version === SUBAGENT_RECORD_VERSION
        && record.notificationPending
        && !state.claimed.has(record.id)
        && !state.consumed.has(record.id)) state.pending.add(record.id);
      continue;
    }
    if (entry.customType !== "subagents:notification") continue;
    const transition = normalizeTransition(entry.data);
    if (!transition) continue;
    for (const id of transition.agentIds) {
      if (!state.records.has(id)) continue;
      state.pending.delete(id);
      if (transition.action === "wake_claimed") state.claimed.add(id);
      else state.consumed.add(id);
    }
  }

  // Project only Work-issued, digest-bound successor authority into memory;
  // historical session records stay append-only and unchanged.
  const recoveries = new Map<string, WorkRecovery>();
  for (const rawEntry of branch) {
    if (!isObject(rawEntry)) continue;
    const entry = rawEntry as CustomEntry;
    if (entry.customType !== "subagents:work-reconcile-ack" || !isObject(entry.data)
      || entry.data.version !== WORK_RECONCILE_CHECKPOINT_VERSION || entry.data.protocolVersion !== 2
      || !boundedString(entry.data.launchKey, 512, false) || !boundedString(entry.data.snapshotDigest, 64, false)) continue;
    try {
      const recovery = validateWorkRecovery(entry.data.recovery);
      if (recovery.predecessorLaunchKey === entry.data.launchKey
        && recovery.expectedTerminalSnapshotDigest === entry.data.snapshotDigest) recoveries.set(entry.data.launchKey, recovery);
    } catch { /* ACKs without successor authority are normal. */ }
  }
  for (const [id, record] of state.records) {
    const recovery = record.workLaunch && recoveries.get(record.workLaunch.launchKey);
    if (recovery && recovery.predecessorAssignmentId === record.workLaunch?.reservation?.reservationId) {
      state.records.set(id, { ...record, workLaunch: { ...record.workLaunch, recovery } });
    }
  }
  return state;
}
