import { describeModel } from "./model-resolver.js";
/** Pi resolves defaults and clamps capabilities; the session is authoritative. */
export function syncEffectiveInvocation(record, session) {
    record.invocation ??= {};
    const invocation = record.invocation;
    invocation.requestedThinking ??= invocation.thinking;
    if (session.model)
        Object.assign(invocation, describeModel(session.model));
    if (session.thinkingLevel != null)
        invocation.thinking = session.thinkingLevel;
}
export function hasModelMismatch(invocation) {
    return !!(invocation?.requestedModel && invocation.modelId
        && (invocation.requestedModelId ?? invocation.requestedModel) !== invocation.modelId);
}
