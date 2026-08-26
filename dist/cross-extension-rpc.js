/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */
import { resolveModel } from "./model-resolver.js";
/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;
/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc(events, channel, fn) {
    return events.on(channel, async (raw) => {
        const params = raw;
        try {
            const data = await fn(params);
            const reply = { success: true };
            if (data !== undefined)
                reply.data = data;
            events.emit(`${channel}:reply:${params.requestId}`, reply);
        }
        catch (err) {
            events.emit(`${channel}:reply:${params.requestId}`, {
                success: false, error: err?.message ?? String(err),
            });
        }
    });
}
/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps) {
    const { events, pi, getCtx, manager } = deps;
    const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
        return { version: PROTOCOL_VERSION };
    });
    const unsubSpawn = handleRpc(events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
        const ctx = getCtx();
        if (!ctx)
            throw new Error("No active session");
        // Cross-extension RPC callers (e.g. pi-tasks TaskExecute) naturally
        // forward serializable values, so options.model can be a string like
        // "openai-codex/gpt-5.5". Resolve it to a real Model instance here
        // — same pattern the scheduler path already uses — so the spawned
        // agent's auth lookup doesn't crash with "No API key found for
        // undefined".
        let normalizedOptions = options ?? {};
        if (typeof normalizedOptions.model === "string") {
            const registry = ctx.modelRegistry;
            if (!registry) {
                throw new Error(`Model override "${normalizedOptions.model}" provided but ctx.modelRegistry is unavailable`);
            }
            const resolved = resolveModel(normalizedOptions.model, registry);
            if (typeof resolved === "string") {
                // resolveModel returns a human-readable error string when the
                // input doesn't match any available model. Surface it instead of
                // silently falling back so the caller sees the auth/typo issue.
                throw new Error(resolved);
            }
            normalizedOptions = { ...normalizedOptions, model: resolved };
        }
        return { id: manager.spawn(pi, ctx, type, prompt, normalizedOptions) };
    });
    const unsubStop = handleRpc(events, "subagents:rpc:stop", ({ agentId }) => {
        if (!manager.abort(agentId))
            throw new Error("Agent not found");
    });
    return { unsubPing, unsubSpawn, unsubStop };
}
