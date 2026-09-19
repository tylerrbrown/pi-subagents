import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describeModel } from "./model-resolver.js";
import type { AgentInvocation, AgentRecord } from "./types.js";

/** Pi resolves defaults and clamps capabilities; the session is authoritative. */
export function syncEffectiveInvocation(record: AgentRecord, session: AgentSession): void {
  record.invocation ??= {};
  const invocation = record.invocation;
  invocation.requestedThinking ??= invocation.thinking;
  if (session.model) Object.assign(invocation, describeModel(session.model));
  if (session.thinkingLevel != null) invocation.thinking = session.thinkingLevel;
}

export function hasModelMismatch(invocation: AgentInvocation | undefined): boolean {
  return !!(invocation?.requestedModel && invocation.modelId
    && (invocation.requestedModelId ?? invocation.requestedModel) !== invocation.modelId);
}
