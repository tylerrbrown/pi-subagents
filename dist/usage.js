/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */
/**
 * Sum of lifetime *token* components for DISPLAY, or 0 if undefined.
 * Deliberately excludes `cacheRead` (see above) and `cost` — that is money, not
 * tokens, and lives on the same object only because it accumulates on the same
 * events.
 */
export function getLifetimeTotal(u) {
    return u ? u.input + u.output + u.cacheWrite : 0;
}
/** Accumulated cost in USD, or 0 when unpriced/undefined. */
export function getLifetimeCost(u) {
    return u?.cost ?? 0;
}
/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into, delta) {
    into.input += delta.input;
    into.output += delta.output;
    into.cacheWrite += delta.cacheWrite;
    if (delta.cacheRead)
        into.cacheRead = (into.cacheRead ?? 0) + delta.cacheRead;
    if (delta.cost)
        into.cost = (into.cost ?? 0) + delta.cost;
}
/**
 * Render an accumulator as a pi `Usage`, or undefined when nothing was spent —
 * callers attach nothing rather than a zero, so a consumer can tell "spent
 * nothing" from "never ran".
 *
 * `cacheRead` IS included, unlike in `getLifetimeTotal`: pi sums it across a
 * session's own assistant messages, and the prefix genuinely is re-read and
 * re-billed on every call. Only `total` is populated on the cost breakdown; pi
 * reads nothing else from it, and the per-kind split is not tracked.
 */
export function toReportedUsage(u) {
    const { input, output, cacheWrite, cacheRead = 0, cost = 0 } = u;
    if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0 && cost === 0)
        return undefined;
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    };
}
/**
 * Subagent spend that the parent session has not been told about yet.
 *
 * Subagents run in their own pi sessions, so none of what they spend appears in
 * the parent's `getSessionStats()`. Pi does aggregate `toolResult.usage` into
 * those stats, though — so the way back into the parent's footer and `/cost` is
 * to hang the spend on a tool result. Background and scheduled agents finish
 * between tool calls with nothing to hang it on, hence a pool: every assistant
 * message lands here as it happens, and the next tool result we return carries
 * whatever has accumulated.
 *
 * Drain empties it, so each message is reported exactly once no matter how many
 * results are returned or how many agents were running.
 */
export class PendingUsagePool {
    pending = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
    dirty = false;
    add(delta) {
        addUsage(this.pending, delta);
        this.dirty = true;
    }
    /**
     * Take everything accumulated so far as a pi `Usage`, resetting the pool.
     * Returns undefined when nothing is pending, so callers can leave the tool
     * result untouched rather than attaching a zero.
     */
    drain() {
        if (!this.dirty)
            return undefined;
        const drained = toReportedUsage(this.pending);
        this.pending = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
        this.dirty = false;
        return drained;
    }
}
/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats().tokens` for the *current* session window.
 *
 * RESETS at compaction — upstream replaces `session.state.messages` and the
 * stats are derived from that array. For a lifetime total that survives
 * compaction, use `getLifetimeTotal(lifetimeUsage)` instead, which reads
 * from an independent accumulator fed by `message_end` events.
 *
 * Avoids upstream's `tokens.total` field, which sums per-turn `cacheRead`
 * and so counts the cumulative cached prefix N times across N turns
 * (issue #38).
 */
export function getSessionTokens(session) {
    if (!session)
        return 0;
    try {
        const t = session.getSessionStats().tokens;
        return t.input + t.output + t.cacheWrite;
    }
    catch {
        return 0;
    }
}
/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session) {
    if (!session)
        return null;
    try {
        return session.getSessionStats().contextUsage?.percent ?? null;
    }
    catch {
        return null;
    }
}
