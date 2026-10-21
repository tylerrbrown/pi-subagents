/**
 * completion-outbox.ts — When background completions reach the parent.
 *
 * Claude Code queues each completion and, after every tool batch, hands the
 * model everything that queued up in one go: a busy parent sees what finished
 * during the batch before its next model call, and nothing waits for a sibling.
 * pi's steering queue would split those into one model call each under its
 * default `one-at-a-time` mode, so the outbox holds them and sends ONE message
 * at the boundary instead.
 *
 * - Parent busy: held until `turn_end`, which pi emits after the tool batch and
 *   before it reads the steering queue.
 * - Parent idle: sent after a short hold, so near-simultaneous completions
 *   share a turn and `get_subagent_result` still gets a moment to consume one.
 * - Parent turn aborted (Esc) or failed: held through it — pi clears its own
 *   queues on Esc — and sent once the run has ended, starting a turn. Claude
 *   Code keeps an agent's completion queued through Esc the same way and runs
 *   it as soon as the interrupted turn stops.
 */
/** How long an idle parent's notification is held before it is sent. */
export const NOTIFICATION_HOLD_MS = 200;
export class CompletionOutbox {
    send;
    parentRunning;
    items = [];
    timer;
    constructor(
    /** Delivers one message as a steer that triggers a turn when the parent is idle. */
    send, 
    /** Whether the parent has a run in flight, so a `turn_end` is coming. */
    parentRunning) {
        this.send = send;
        this.parentRunning = parentRunning;
    }
    /** A newer completion of the same agent (a resume) replaces its pending one. */
    add(item) {
        for (const id of item.ids)
            this.cancel(id);
        this.items.push(item);
        if (!this.parentRunning())
            this.arm();
    }
    /** The parent finished a turn: its tool batch is done, the next model call is not. */
    onTurnEnd(stopReason) {
        // An aborted turn ends its run; a failed one may be retried. Either way
        // what is held waits for the next boundary or the run's end — sent now,
        // it would sit in a queue pi is about to clear.
        if (stopReason !== "aborted" && stopReason !== "error")
            this.flush();
    }
    /** The agent's result was read: it must not also be notified. */
    cancel(id) {
        for (const item of this.items)
            item.ids = item.ids.filter(i => i !== id);
        this.items = this.items.filter(item => item.ids.length > 0);
    }
    /**
     * Completions that landed after the run's last `turn_end` would otherwise wait for the next run.
     * Called at `agent_end` and again at `agent_settled`: one can land while the ending run is still open.
     */
    onAgentEnd() {
        if (this.items.length > 0)
            this.arm();
    }
    dispose() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        this.items = [];
    }
    /** Not reset by later items: the first completion is never pushed back. */
    arm() {
        this.timer ??= setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, NOTIFICATION_HOLD_MS);
    }
    flush() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        const items = this.items;
        this.items = [];
        const messages = items.map(item => item.build(item.ids));
        if (messages.length === 0)
            return;
        // A send from a timer can outlive the session it was meant for (pi -p
        // tearing down): pi throws on the stale context, and nothing is left to tell.
        try {
            this.send(combine(messages));
        }
        catch { /* stale context */ }
    }
}
/** One message stays as it was built; several become one message with every agent's details. */
function combine(messages) {
    if (messages.length === 1)
        return messages[0];
    const [first, ...rest] = messages.flatMap(({ details: { others, ...own } }) => [own, ...(others ?? [])]);
    return {
        content: `${messages.length} background tasks finished.\n\n${messages.map(m => m.content).join("\n\n")}`,
        details: { ...first, others: rest },
    };
}
