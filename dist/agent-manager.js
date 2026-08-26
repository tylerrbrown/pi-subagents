/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway), and so do
 * nested children — see `occupiesPoolSlot`.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resumeAgent, runAgent } from "./agent-runner.js";
import { assignHandle, handleBase, isReservedHandle } from "./mention.js";
import { classifyRunFailure } from "./status-note.js";
import { addUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees, } from "./worktree.js";
/**
 * Default max concurrent background agents.
 *
 * Raised from 4 when top-level spawns started defaulting to background
 * (`backgroundByDefault`): foreground agents bypass this pool entirely, so
 * while foreground was the default a fan-out of six ran six. With background
 * as the default every top-level agent takes a slot, and a limit of 4 would
 * have silently queued the tail of exactly the parallel fan-outs the `Agent`
 * tool description tells the model to send.
 */
const DEFAULT_MAX_CONCURRENT = 10;
/**
 * How many evicted agents stay addressable by name. Only a bound on memory —
 * a session that spawns hundreds of agents shouldn't retain every one — and
 * far above the handful anyone keeps in their head.
 */
const MAX_TOMBSTONES = 100;
/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd) {
    if (cwd == null)
        return;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) {
        throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
    }
    let isDirectory = false;
    try {
        isDirectory = statSync(cwd).isDirectory();
    }
    catch {
        throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
    }
    if (!isDirectory) {
        throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
    }
}
/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
function occupiesPoolSlot(record) {
    return !!record.isBackground && record.parentAgentId === undefined;
}
/** Best-effort ceiling on one child's shutdown handlers, so teardown can't strand a quit. */
const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;
/** Stamp a terminal boundary that never precedes the run boundary. */
function completeRecord(record) {
    record.completedAt = Math.max(record.completedAt ?? Date.now(), record.startedAt);
}
/**
 * Close the extension lifecycle `runAgent` opened with `bindExtensions`, then dispose.
 *
 * `AgentSession.dispose()` only calls `ExtensionRunner.invalidate()` — pi emits the event
 * itself in `AgentSessionRuntime.dispose()` beforehand, and this is the one place that binds
 * extensions onto a session without going through that path. Without the emit, everything an
 * extension armed in `session_start` leaks once per spawn, and its next tick throws
 * `assertActive()` from a bare timer callback — an uncaughtException that kills pi (#242).
 */
async function shutdownChildSession(session) {
    try {
        const runner = session?.extensionRunner;
        // Optional all the way down: on a pi without the getter, or a stubbed session from a
        // partial `onSessionCreated`, skip the emit — the same degrade as before this fix.
        if (runner?.hasHandlers?.("session_shutdown")) {
            // Raced, not awaited outright. `emit` runs every handler serially with no timeout of
            // its own, and dispose() is reached from pi's own `session_shutdown` with the TUI
            // already torn down — one hung handler would leave a dead terminal.
            await Promise.race([
                runner.emit({ type: "session_shutdown", reason: "quit" }),
                new Promise(resolve => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS).unref()),
            ]);
        }
    }
    catch { /* a partial session must degrade, not take the teardown down with it */ }
    // Always, even on timeout: disposal is what this function ultimately exists to do.
    try {
        session?.dispose?.();
    }
    catch { /* ignore */ }
}
/** How long a record whose result has been read is kept, purely to bound memory. */
const CONSUMED_RETENTION_MS = 10 * 60_000;
/**
 * How long a completed-but-uncollected result is kept. Sized to outlast a long
 * review batch, not to be permanent — an abandoned result is still evicted.
 */
const UNCONSUMED_RETENTION_MS = 60 * 60_000;
export class AgentManager {
    getReservedTypeNames;
    agents = new Map();
    cleanupInterval;
    onComplete;
    onStart;
    onCompact;
    onUsage;
    maxConcurrent;
    /** Base repos worktrees were created from — so dispose() can prune them all,
     *  not just the parent repo (caller-supplied cwd can target other repos). */
    worktreeRepos = new Set();
    /**
     * Evicted agents that can still be reached by name, keyed by handle. Outlives
     * the 10-minute record cleanup — that timer exists to bound memory, not to
     * expire a conversation the user might still want — and is cleared alongside
     * completed records on session start/switch.
     */
    tombstones = new Map();
    /** Queue of background agents waiting to start. */
    queue = [];
    /** Top-level background records that currently own a concurrency slot. */
    backgroundSlots = new Set();
    acquireBackgroundSlot(record) {
        if (occupiesPoolSlot(record))
            this.backgroundSlots.add(record.id);
    }
    releaseBackgroundSlot(record) {
        return this.backgroundSlots.delete(record.id);
    }
    constructor(onComplete, maxConcurrent = DEFAULT_MAX_CONCURRENT, onStart, onCompact, onUsage, getReservedTypeNames) {
        this.getReservedTypeNames = getReservedTypeNames;
        this.onComplete = onComplete;
        this.onStart = onStart;
        this.onCompact = onCompact;
        this.onUsage = onUsage;
        this.maxConcurrent = maxConcurrent;
        // Cleanup completed agents after 10 minutes (but keep sessions for resume)
        this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
        this.cleanupInterval.unref();
    }
    /** Update the max concurrent background agents limit. */
    setMaxConcurrent(n) {
        this.maxConcurrent = Math.max(1, n);
        // Start queued agents if the new limit allows
        this.drainQueue();
    }
    getMaxConcurrent() {
        return this.maxConcurrent;
    }
    /**
     * Spawn an agent and return its ID immediately (for background use).
     * If the concurrency limit is reached, the agent is queued.
     */
    spawn(pi, ctx, type, prompt, options) {
        // Validate before the queue branch — a queued spawn should fail at the
        // call, not minutes later at drain. Throw (not warn): programmatic callers
        // can fix and retry; the RPC layer converts throws into error envelopes.
        assertValidSpawnCwd(options.cwd);
        const id = randomUUID().slice(0, 17);
        const abortController = new AbortController();
        const taken = this.takenHandles();
        let handle;
        let alias;
        if (options.parentAgentId === undefined) {
            if (options.reclaim) {
                // Resuming reclaims the conversation's existing names exactly.
                handle = options.reclaim.handle;
                alias = options.reclaim.alias;
            }
            else {
                handle = assignHandle(handleBase(type), taken);
                if (options.name !== undefined) {
                    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(options.name)) {
                        throw new Error("Agent name must use 1-64 letters, digits, underscores, or hyphens.");
                    }
                    const requested = handleBase(options.name);
                    if (isReservedHandle(requested)) {
                        throw new Error(`Agent name "${options.name}" is reserved.`);
                    }
                    const ownTypeHandle = handleBase(type);
                    const reservedForOtherType = (this.getReservedTypeNames?.() ?? [])
                        .some((name) => handleBase(name) === requested && handleBase(name) !== ownTypeHandle);
                    if (reservedForOtherType) {
                        throw new Error(`Agent name "${options.name}" is reserved for agent type "${requested}".`);
                    }
                    if (requested !== handle) {
                        if (taken.has(requested)) {
                            throw new Error(`Agent name "${options.name}" is already in use. Choose another name or resume that agent.`);
                        }
                        alias = requested;
                    }
                }
            }
        }
        const startedAt = Date.now();
        const record = {
            id,
            type,
            // Nested children are filtered out of every top-level surface, so no
            // handle: nothing can address them and they must not consume a name a
            // top-level sibling could otherwise take.
            handle,
            description: options.description,
            alias,
            status: options.isBackground ? "queued" : "running",
            toolUses: 0,
            startedAt,
            lastProgressAt: startedAt,
            abortController,
            lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
            compactionCount: 0,
            // Raw tri-state (not coerced to a boolean): true = background, false =
            // foreground (has an inline tool-result surface), undefined = caller never
            // declared it (e.g. a cross-extension RPC spawn). The widget's background-
            // only filter excludes only explicit `false`, so undefined agents — which
            // have no inline surface — stay visible instead of vanishing.
            isBackground: options.isBackground,
            invocation: options.invocation,
            depth: options.depth ?? 1,
            parentAgentId: options.parentAgentId,
            maxSubagentDepth: options.maxSubagentDepth,
            rootSessionId: options.rootSessionId,
        };
        this.agents.set(id, record);
        const args = { pi, ctx, type, prompt, options };
        if (occupiesPoolSlot(record) && !options.bypassQueue && this.backgroundSlots.size >= this.maxConcurrent) {
            // Queue it — will be started when a running agent completes
            this.queue.push({ id, start: () => this.startAgent(id, record, args) });
            return id;
        }
        // startAgent can throw (e.g. strict worktree-isolation failure) — clean
        // up the record so callers don't see an orphan in `listAgents()`.
        try {
            this.startAgent(id, record, args);
        }
        catch (err) {
            const released = this.releaseBackgroundSlot(record);
            this.agents.delete(id);
            if (released)
                this.drainQueue();
            throw err;
        }
        return id;
    }
    /** Actually start an agent (called immediately or from queue drain). */
    startAgent(id, record, { pi, ctx, type, prompt, options }) {
        // Re-validate a caller-supplied cwd: queued spawns can start minutes after
        // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
        // curated errors; drainQueue parks a throw on the record as an error.
        assertValidSpawnCwd(options.cwd);
        // Single resolution point for the caller-supplied cwd — the worktree base
        // repo and both cleanup calls below MUST agree on this value forever.
        const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
        const baseCwd = customCwd ?? ctx.cwd;
        // Worktree isolation: try to create a temporary git worktree. Strict —
        // fail loud if not possible (no silent fallback to main tree). Done
        // BEFORE state mutation so a throw doesn't leave the record half-running.
        // The project switch is enforced here as well as at the tool boundary
        // because cross-extension RPC forwards its options unvalidated — a schema
        // that omits the field can't stop a caller that never saw the schema.
        let worktreeCwd;
        if (options.isolation === "worktree" && isWorktreeIsolationEnabled()) {
            const wt = createWorktree(baseCwd, id);
            if (!wt) {
                throw new Error('Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
                    'Initialize git and commit at least once, or omit `isolation`.');
            }
            record.worktree = wt;
            // workPath preserves subdirectory scoping for caller-supplied cwds: a
            // cwd deep in a monorepo maps to the same subdir inside the copy, not
            // the copied repo's root. Plain worktree spawns keep the historical
            // behavior (agent at the copy's root) — moving them to workPath would
            // also move .pi config discovery when the parent session sits in a repo
            // subdirectory, silently dropping extensions/skills.
            worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
            this.worktreeRepos.add(baseCwd);
        }
        record.status = "running";
        record.startedAt = Date.now();
        record.lastProgressAt = record.startedAt;
        this.acquireBackgroundSlot(record);
        this.onStart?.(record);
        // Wire parent abort signal to stop the subagent when the parent is interrupted
        let detachParentSignal;
        if (options.signal) {
            const onParentAbort = () => this.abort(id);
            options.signal.addEventListener("abort", onParentAbort, { once: true });
            detachParentSignal = () => options.signal.removeEventListener("abort", onParentAbort);
        }
        const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };
        const promise = runAgent(ctx, type, prompt, {
            pi,
            agentId: id,
            model: options.model,
            maxTurns: options.maxTurns,
            runDeadlineMs: options.runDeadlineMs,
            isolated: options.isolated,
            inheritContext: options.inheritContext,
            thinkingLevel: options.thinkingLevel,
            tools: options.tools,
            skills: options.skills,
            extensions: options.extensions,
            resumeSessionFile: options.resumeSessionFile,
            nested: options.parentAgentId !== undefined,
            // Worktree wins for the working dir (the agent must run in the copy —
            // which, with a custom cwd, was created from that target). Config stays
            // with the parent project when a caller-supplied cwd is in play; it must
            // stay undefined otherwise so plain worktree runs keep resolving config
            // (incl. relative extension paths and memory) inside the worktree copy.
            cwd: worktreeCwd ?? customCwd,
            // Set iff a worktree was created (see above) — names the directory the
            // copy came from, so the prompt can tell the agent not to work there.
            worktreeBase: worktreeCwd ? baseCwd : undefined,
            configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
            signal: record.abortController.signal,
            onToolActivity: (activity) => {
                record.lastProgressAt = Date.now();
                if (activity.type === "end")
                    record.toolUses++;
                options.onToolActivity?.(activity);
            },
            onTurnEnd: (turnCount) => {
                record.lastProgressAt = Date.now();
                options.onTurnEnd?.(turnCount);
            },
            onTextDelta: (delta, fullText) => {
                record.lastProgressAt = Date.now();
                options.onTextDelta?.(delta, fullText);
            },
            onAssistantUsage: (usage) => {
                record.lastProgressAt = Date.now();
                addUsage(record.lifetimeUsage, usage);
                this.onUsage?.(record, usage);
                options.onAssistantUsage?.(usage);
            },
            onCompaction: (info) => {
                record.lastProgressAt = Date.now();
                record.compactionCount++;
                this.onCompact?.(record, info);
                options.onCompaction?.(info);
            },
            nestedRuntime: {
                manager: this,
                parentAgentId: id,
                depth: record.depth ?? 1,
                maxSubagentDepth: record.maxSubagentDepth,
            },
            onSessionCreated: (session) => {
                record.session = session;
                // Capture now, while the session object exists: after eviction this
                // path is the only thing that can reopen the conversation, and an
                // in-memory session reports undefined, which correctly means
                // "nothing to come back to".
                // Optional chaining, not defensiveness for its own sake: this is the
                // only field read off the session at creation, so an older pi or a
                // stubbed session must degrade to "not resumable" rather than throw
                // and take the whole spawn down with it.
                record.sessionFile = session.sessionManager?.getSessionFile?.();
                // Flush any steers that arrived before the session was ready
                if (record.pendingSteers?.length) {
                    for (const msg of record.pendingSteers) {
                        session.steer(msg).catch(() => { });
                    }
                    record.pendingSteers = undefined;
                }
                options.onSessionCreated?.(session);
            },
        })
            .then(({ responseText, session, aborted, timedOut, steered, failure }) => {
            // Don't overwrite status if externally stopped via abort()
            if (record.status !== "stopped") {
                // Precedence: the wall clock outranks the turn budget — a deadline
                // abort can let graceTurns elapse on its way out, and "ran out of
                // time" is both the true cause and the actionable one. Then a hard
                // abort keeps "aborted"; then a failed final turn (provider error
                // that pi resolved instead of rejecting, #144) is an honest "error"
                // — not a completion with an empty or stale result.
                if (timedOut) {
                    record.status = "timeout";
                    record.stopReason = "timeout";
                }
                else if (aborted) {
                    record.status = "aborted";
                }
                else if (failure) {
                    record.status = "error";
                    record.error = failure;
                    record.failureKind = classifyRunFailure(failure);
                }
                else {
                    record.status = steered ? "steered" : "completed";
                }
            }
            record.result = responseText;
            record.session = session;
            completeRecord(record);
            detach();
            // Final flush of streaming output file
            if (record.outputCleanup) {
                try {
                    record.outputCleanup();
                }
                catch { /* ignore */ }
                record.outputCleanup = undefined;
            }
            // Clean up worktree if used
            if (record.worktree) {
                const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
                record.worktreeResult = wtResult;
                if (wtResult.hasChanges && wtResult.branch) {
                    // With a caller-supplied cwd the branch lives in THAT repo, not the
                    // parent session's — say so, or the orchestrator merges in the wrong repo.
                    const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
                    record.result = (record.result ?? "") +
                        `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
                }
            }
            this.abortOwnedChildren(id);
            // Fire onComplete for foreground agents too — lifecycle symmetry.
            // Mark resultConsumed so the callback skips notifications (result returned inline).
            if (!options.isBackground) {
                record.resultConsumed = true;
                try {
                    this.onComplete?.(record);
                }
                catch { /* ignore completion side-effect errors */ }
            }
            else {
                this.releaseBackgroundSlot(record);
                try {
                    this.onComplete?.(record);
                }
                catch { /* ignore completion side-effect errors */ }
                this.drainQueue();
            }
            return responseText;
        })
            .catch((err) => {
            // Don't overwrite status if externally stopped via abort()
            if (record.status !== "stopped") {
                record.status = "error";
            }
            record.error = err instanceof Error ? err.message : String(err);
            record.failureKind = classifyRunFailure(record.error);
            completeRecord(record);
            detach();
            // Final flush of streaming output file on error
            if (record.outputCleanup) {
                try {
                    record.outputCleanup();
                }
                catch { /* ignore */ }
                record.outputCleanup = undefined;
            }
            // Best-effort worktree cleanup on error
            if (record.worktree) {
                try {
                    const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
                    record.worktreeResult = wtResult;
                }
                catch { /* ignore cleanup errors */ }
            }
            this.abortOwnedChildren(id);
            // Fire onComplete for foreground agents too — lifecycle symmetry.
            // Mark resultConsumed so the callback skips notifications (result returned inline).
            if (!options.isBackground) {
                record.resultConsumed = true;
                this.onComplete?.(record);
            }
            else {
                this.releaseBackgroundSlot(record);
                this.onComplete?.(record);
                this.drainQueue();
            }
            return "";
        });
        record.promise = promise;
        // Notify caller that spawn is complete (record is in the map, promise is set).
        // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
        // Used by spawnAndWait to let the caller set up output files before streaming starts.
        this.onSpawned?.(id);
    }
    /**
     * Stop the nested children a settled parent owns. Nested records are hidden
     * from the UI and only their owner can consume them, so a child outliving its
     * parent would burn tokens unseen with no way to reach it. Grandchildren are
     * covered transitively — each abort lands in that child's own settle path.
     */
    abortOwnedChildren(parentId) {
        for (const [id, record] of this.agents) {
            if (record.parentAgentId === parentId)
                this.abort(id, "parent");
        }
    }
    /** Start queued agents up to the concurrency limit. */
    drainQueue() {
        while (this.queue.length > 0 && this.backgroundSlots.size < this.maxConcurrent) {
            const next = this.queue.shift();
            const record = this.agents.get(next.id);
            if (!record || record.status !== "queued")
                continue;
            try {
                next.start();
            }
            catch (err) {
                // Late failure (e.g. strict worktree-isolation) — surface on the record
                // so the user/agent can see it via /agents, then keep draining.
                this.releaseBackgroundSlot(record);
                record.status = "error";
                record.error = err instanceof Error ? err.message : String(err);
                completeRecord(record);
                this.onComplete?.(record);
            }
        }
    }
    /**
     * Called synchronously right after spawn, before onSessionCreated fires.
     * Lets the caller set up the output file path on the record.
     * The record is guaranteed to be in this.agents at this point.
     */
    onSpawned;
    /**
     * Spawn an agent and wait for completion (foreground use).
     * Foreground agents bypass the concurrency queue.
     * Returns { id, record } so callers can access the agent ID.
     *
     * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
     *   Use this to set record.outputFile so streamToOutputFile can pick it up.
     */
    async spawnAndWait(pi, ctx, type, prompt, options, onSpawned) {
        // Temporarily register the onSpawned hook so startAgent can call it.
        const prevOnSpawned = this.onSpawned;
        this.onSpawned = onSpawned;
        let id;
        try {
            // spawn() invokes onSpawned synchronously before returning. Restore the
            // shared hook immediately so unrelated concurrent spawns cannot inherit
            // this foreground caller's callback while its run is awaited.
            id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
        }
        finally {
            this.onSpawned = prevOnSpawned;
        }
        const record = this.agents.get(id);
        await record.promise;
        return { id, record };
    }
    /**
     * Resume an existing agent session with a new prompt.
     */
    async resume(id, prompt, signal, options) {
        const record = this.agents.get(id);
        if (!record?.session)
            return undefined;
        // Background resume: settle asynchronously and notify on completion exactly
        // like a background spawn, returning immediately with the record still
        // "running" — or "queued" when at the concurrency limit. Previously
        // run_in_background was ignored on resume (the Agent tool's resume branch
        // returned before its background branch, and resume() only ever awaited
        // inline), so a resumed agent always blocked the caller until it finished.
        if (options?.isBackground) {
            // Never re-enter a run that is still in flight. Detaching means the caller
            // gets control back while the record stays "running", so nothing stops the
            // model from resuming the same agent again. Starting a second run would
            // overwrite record.abortController — orphaning the live run beyond the
            // reach of `/agents` stop and abortAll() — double-count the pool slot, and
            // then reject from session.prompt() with "Agent is already processing",
            // whose settle path would abort the LIVE run's children and report a
            // failure for a run that is still going. Refuse instead, leaving the
            // record untouched; the caller decides whether to wait or steer.
            if (record.status === "running" || record.status === "queued")
                return undefined;
            record.isBackground = true;
            record.resultConsumed = false;
            record.result = undefined;
            record.error = undefined;
            record.completedAt = undefined;
            record.status = "queued";
            const start = () => this.startResume(id, record, prompt, signal, options);
            if (occupiesPoolSlot(record) && this.backgroundSlots.size >= this.maxConcurrent) {
                // At the concurrency limit — queue it, drains when a slot frees.
                this.queue.push({ id, start });
            }
            else {
                start();
            }
            return record;
        }
        // Foreground resume: establish the new run boundary before work begins.
        record.status = "running";
        record.startedAt = Math.max(Date.now(), record.startedAt + 1);
        record.lastProgressAt = record.startedAt;
        record.completedAt = undefined;
        record.result = undefined;
        record.error = undefined;
        try {
            const { text, failure, timedOut } = await resumeAgent(record.session, prompt, {
                onToolActivity: (activity) => {
                    record.lastProgressAt = Date.now();
                    if (activity.type === "end")
                        record.toolUses++;
                    options?.onToolActivity?.(activity);
                },
                onTextDelta: (delta, fullText) => {
                    record.lastProgressAt = Date.now();
                    options?.onTextDelta?.(delta, fullText);
                },
                onTurnEnd: (turnCount) => {
                    record.lastProgressAt = Date.now();
                    options?.onTurnEnd?.(turnCount);
                },
                onAssistantUsage: (usage) => {
                    record.lastProgressAt = Date.now();
                    addUsage(record.lifetimeUsage, usage);
                    this.onUsage?.(record, usage);
                    options?.onAssistantUsage?.(usage);
                },
                onCompaction: (info) => {
                    record.lastProgressAt = Date.now();
                    record.compactionCount++;
                    this.onCompact?.(record, info);
                    options?.onCompaction?.(info);
                },
                signal,
            });
            // Same contract as the spawn path (#144): a failed final turn is an
            // error, not a completion — but the resumed text stays available.
            if (timedOut) {
                record.status = "timeout";
                record.stopReason = "timeout";
            }
            else {
                record.status = failure ? "error" : "completed";
                if (failure) {
                    record.error = failure;
                    record.failureKind = classifyRunFailure(failure);
                }
            }
            record.result = text;
            completeRecord(record);
        }
        catch (err) {
            record.status = "error";
            record.error = err instanceof Error ? err.message : String(err);
            record.failureKind = classifyRunFailure(record.error);
            completeRecord(record);
        }
        // Same contract as the spawn settle paths: children spawned during the
        // resumed turn must not outlive it — nothing else can see or reach them.
        this.abortOwnedChildren(id);
        return record;
    }
    /**
     * Start a background resume run: detached, settling and notifying like
     * startAgent's background path. Invoked immediately, or from drainQueue when
     * a concurrency slot frees. The session already exists (resume reuses it), so
     * there is no onSessionCreated to hang per-run wiring off — callers use
     * `options.onStarted`, which fires on both the immediate and the drained path.
     */
    startResume(id, record, prompt, parentSignal, options) {
        if (!record.session)
            return;
        record.status = "running";
        // A queued resume retains the previous run's timestamp until this exact
        // start point; frozen/low-resolution clocks still produce a fresh boundary.
        record.startedAt = Math.max(Date.now(), record.startedAt + 1);
        record.lastProgressAt = record.startedAt;
        this.acquireBackgroundSlot(record);
        this.onStart?.(record);
        // Fresh abort controller so /agents stop and steering target THIS run rather
        // than the previous one's settled controller.
        const abortController = new AbortController();
        record.abortController = abortController;
        // Optional, and NOT what the Agent tool passes for a detached resume: a
        // parent signal aborts on the parent's own interrupt (user Esc), which is
        // right for a foreground run whose result the caller is awaiting, and wrong
        // for a detached one — background spawns omit it for exactly this reason.
        let detachParentSignal;
        if (parentSignal) {
            const onParentAbort = () => this.abort(id);
            parentSignal.addEventListener("abort", onParentAbort, { once: true });
            detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
        }
        // Per-run side effects (output streaming) — see ResumeOptions.onStarted.
        // After the record is in its running shape, before the run is kicked off.
        try {
            options.onStarted?.();
        }
        catch { /* ignore caller wiring errors */ }
        const settle = () => {
            detachParentSignal?.();
            detachParentSignal = undefined;
            // Final flush of streaming output file
            if (record.outputCleanup) {
                try {
                    record.outputCleanup();
                }
                catch { /* ignore */ }
                record.outputCleanup = undefined;
            }
            // Children spawned during the resumed turn must not outlive it.
            this.abortOwnedChildren(id);
            this.releaseBackgroundSlot(record);
            try {
                this.onComplete?.(record);
            }
            catch { /* ignore completion side-effect errors */ }
            this.drainQueue();
        };
        const promise = resumeAgent(record.session, prompt, {
            onToolActivity: (activity) => {
                record.lastProgressAt = Date.now();
                if (activity.type === "end")
                    record.toolUses++;
                options.onToolActivity?.(activity);
            },
            onTextDelta: (delta, fullText) => {
                record.lastProgressAt = Date.now();
                options.onTextDelta?.(delta, fullText);
            },
            onTurnEnd: (turnCount) => {
                record.lastProgressAt = Date.now();
                options.onTurnEnd?.(turnCount);
            },
            onAssistantUsage: (usage) => {
                record.lastProgressAt = Date.now();
                addUsage(record.lifetimeUsage, usage);
                this.onUsage?.(record, usage);
                options.onAssistantUsage?.(usage);
            },
            onCompaction: (info) => {
                record.lastProgressAt = Date.now();
                record.compactionCount++;
                this.onCompact?.(record, info);
                options.onCompaction?.(info);
            },
            signal: abortController.signal,
        })
            .then(({ text, failure, timedOut }) => {
            // Don't overwrite status if externally stopped via abort().
            if (record.status !== "stopped") {
                // Same precedence as the spawn path: wall clock first, then a failed
                // final turn (#144) — an error, not a completion, though the resumed
                // text stays available.
                if (timedOut) {
                    record.status = "timeout";
                    record.stopReason = "timeout";
                }
                else {
                    record.status = failure ? "error" : "completed";
                    if (failure) {
                        record.error = failure;
                        record.failureKind = classifyRunFailure(failure);
                    }
                }
            }
            record.result = text;
            completeRecord(record);
            settle();
            return text;
        })
            .catch((err) => {
            if (record.status !== "stopped") {
                record.status = "error";
                record.error = err instanceof Error ? err.message : String(err);
                record.failureKind = classifyRunFailure(record.error);
            }
            completeRecord(record);
            settle();
            return "";
        });
        record.promise = promise;
    }
    /**
     * Send a steering message to an agent from the UI (mirrors the steer_subagent
     * tool). A live session delivers it now — it interrupts the agent after its
     * current tool execution and appears as a user message. If the session isn't
     * ready yet, the message is queued on `pendingSteers` and flushed when the
     * session is created. Returns false if the agent can't accept steering
     * (unknown id, or no longer running/queued).
     */
    steer(id, message) {
        const record = this.agents.get(id);
        if (!record)
            return false;
        if (record.status !== "running" && record.status !== "queued")
            return false;
        if (record.session) {
            record.session.steer(message).catch(() => { });
        }
        else {
            if (!record.pendingSteers)
                record.pendingSteers = [];
            record.pendingSteers.push(message);
        }
        return true;
    }
    getRecord(id) {
        return this.agents.get(id);
    }
    /** Handles already in use, so a fresh spawn can pick an unclaimed one. */
    takenHandles() {
        const taken = new Set();
        for (const record of this.agents.values()) {
            if (record.handle)
                taken.add(record.handle);
            if (record.alias)
                taken.add(record.alias);
        }
        // Tombstones hold their names too: an evicted `@explore` is still
        // resurrectable, so a later Explore must become `explore-2` rather than
        // shadowing a conversation the user can still reach.
        for (const entry of this.tombstones.values()) {
            taken.add(entry.handle);
            if (entry.alias)
                taken.add(entry.alias);
        }
        return taken;
    }
    /**
     * Resolve an `@name` from the prompt. Matches a top-level agent's handle
     * case-insensitively, preferring one that can still be steered and otherwise
     * the most recently started (which is the one a resume should continue), then
     * falls back to an exact agent id so `@<agentId>` works too.
     */
    resolveMention(name) {
        const wanted = name.toLowerCase();
        let fallback;
        for (const record of this.agents.values()) {
            if (record.parentAgentId !== undefined)
                continue;
            // Handle and alias share one namespace, so at most one agent answers a
            // name and it makes no difference which of the two matched.
            if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted)
                continue;
            if (record.status === "running" || record.status === "queued")
                return { kind: "live", record };
            if (!fallback || record.startedAt > fallback.startedAt)
                fallback = record;
        }
        if (fallback)
            return { kind: "live", record: fallback };
        const byId = this.agents.get(name);
        if (byId?.parentAgentId === undefined && byId !== undefined)
            return { kind: "live", record: byId };
        // Only once nothing live answers: a tombstone is a conversation to reopen,
        // and reopening one while its record still exists would fork the session.
        for (const entry of this.tombstones.values()) {
            if (entry.handle.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted || entry.id === name) {
                return { kind: "tombstone", entry };
            }
        }
        return undefined;
    }
    /**
     * Forget an evicted agent, by handle. For the case where its session file has
     * gone: the entry can then only ever fail, while still holding the name
     * against the type that would otherwise start a fresh agent under it.
     *
     * A *successful* resume does not drop its tombstone — the live record it
     * creates already wins in `resolveMention`, and overwrites the entry in place
     * when it is itself evicted.
     */
    dropTombstone(handle) {
        this.tombstones.delete(handle);
    }
    /**
     * The remains of an evicted agent, by id, handle, or alias. What
     * `get_subagent_result` falls back to so a collection arriving after the
     * sweep returns the run's output instead of `Agent not found`.
     */
    getTombstone(ref) {
        const raw = ref.trim();
        if (!raw)
            return undefined;
        const byName = this.tombstones.get(raw);
        if (byName)
            return byName;
        const lower = raw.toLowerCase();
        for (const entry of this.tombstones.values()) {
            if (entry.id === raw || entry.handle.toLowerCase() === lower || entry.alias?.toLowerCase() === lower) {
                return entry;
            }
        }
        return undefined;
    }
    /** Evicted agents whose conversation can still be reopened, newest first. */
    listTombstones() {
        return [...this.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
    }
    listAgents() {
        return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
    }
    /**
     * Stop an agent, recording WHO stopped it.
     *
     * Defaults to `"user"` because the two UI stop buttons (conversation viewer,
     * FleetView) are the only callers that pass nothing, and they are a human.
     * Every non-human path names itself — otherwise a shutdown or an extension
     * abort reads as "STOPPED BY THE USER" and the status lies about the cause.
     */
    abort(id, reason = "user") {
        const record = this.agents.get(id);
        if (!record)
            return false;
        // Remove from queue if queued
        if (record.status === "queued") {
            this.queue = this.queue.filter(q => q.id !== id);
            record.status = "stopped";
            record.stopReason = reason;
            completeRecord(record);
            return true;
        }
        if (record.status !== "running")
            return false;
        record.abortController?.abort();
        record.status = "stopped";
        record.stopReason = reason;
        completeRecord(record);
        return true;
    }
    /** Dispose a record's session and remove it from the map. */
    removeRecord(id, record) {
        this.tombstone(record);
        const session = record.session;
        // Detached before the shutdown starts, so the record leaves the map at once and
        // nothing can observe a session that is half torn down.
        record.session = undefined;
        this.agents.delete(id);
        const released = this.releaseBackgroundSlot(record);
        if (released)
            this.drainQueue();
        // Fire-and-forget is right here and only here: this runs from the 60s cleanup timer
        // and from `clearCompleted()` on session boundaries, with the process staying alive,
        // so handlers get their full window. The quit path awaits instead — see dispose().
        void shutdownChildSession(session);
    }
    /**
     * Preserve enough of a departing record for `@handle` to reopen its
     * conversation later. Nothing to keep unless it has both a handle to be
     * addressed by and a session file to reopen — an in-memory session leaves no
     * transcript, so the mention would have nothing to continue from.
     */
    tombstone(record) {
        // ponytail: a record with no session file still leaves nothing behind, so a
        // non-persisted agent's result dies with its record (bounded now by the
        // 60-minute unconsumed retention above). Widening this would change what
        // `@handle` resolves to, which is a different contract — see the mention
        // tests. Revisit if `rememberAgents: false` projects start losing results.
        if (!record.handle || !record.sessionFile)
            return;
        this.tombstones.set(record.handle, {
            handle: record.handle,
            alias: record.alias,
            id: record.id,
            type: record.type,
            description: record.description,
            sessionFile: record.sessionFile,
            completedAt: record.completedAt ?? Date.now(),
            // Carried so a LATE collection still returns the work. Eviction is a
            // memory bound, not an expiry of the answer.
            status: record.status,
            stopReason: record.stopReason,
            result: record.result,
            error: record.error,
            toolUses: record.toolUses,
            startedAt: record.startedAt,
        });
        // Bound the memory a long session can accumulate. Oldest first, since the
        // agent someone still wants to reach is the one they used most recently.
        while (this.tombstones.size > MAX_TOMBSTONES) {
            const oldest = [...this.tombstones.values()].reduce((a, b) => (a.completedAt <= b.completedAt ? a : b));
            this.tombstones.delete(oldest.handle);
        }
    }
    /**
     * Eviction ages. The short one bounds memory for results the LLM has already
     * read; the long one exists because the short one was the whole reason a long
     * batch lost its early finishers.
     *
     * A blocking join on a slow specialist can hold the Lead's turn for hours. A
     * sibling that finished in five minutes was evicted at ten and answered
     * `Agent not found` when the turn finally came back — so the model re-ran or
     * re-resumed work that was already done. An unread result is the one thing
     * this timer must not throw away on that scale.
     */
    cleanup() {
        const now = Date.now();
        const consumedCutoff = now - CONSUMED_RETENTION_MS;
        const unconsumedCutoff = now - UNCONSUMED_RETENTION_MS;
        for (const [id, record] of this.agents) {
            if (record.status === "running" || record.status === "queued")
                continue;
            // `resultConsumed` is only ever set true by a read (or by the foreground
            // path, which returned the result inline), so falsy means "nobody has
            // seen this yet" for every spawn path.
            const cutoff = record.resultConsumed ? consumedCutoff : unconsumedCutoff;
            if ((record.completedAt ?? 0) >= cutoff)
                continue;
            this.removeRecord(id, record);
        }
    }
    /**
     * Remove all completed/stopped/errored records immediately.
     * Called on session start/switch so tasks from a prior session don't persist.
     * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
     * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
     */
    clearCompleted(skipUnconsumed = false) {
        for (const [id, record] of this.agents) {
            if (record.status === "running" || record.status === "queued")
                continue;
            if (skipUnconsumed && !record.resultConsumed)
                continue;
            this.removeRecord(id, record);
        }
        // Unconditional: both callers are session boundaries (`session_start` and
        // `session_before_switch`), and `skipUnconsumed` only spares records whose
        // results the LLM has yet to read — it does not make the sweep partial in
        // the sense that matters here. A new session means new handles, or
        // `@explore` would silently reach an agent the user never started. Claude
        // Code resets its registry on `/clear` for the same reason.
        this.tombstones.clear();
    }
    /** Whether any agents are still running or queued. */
    hasRunning() {
        return [...this.agents.values()].some(r => r.status === "running" || r.status === "queued");
    }
    /**
     * Abort all running and queued agents immediately. Its one production caller
     * is `session_shutdown`, so that is the default attribution — a session going
     * down must not be reported as a human pressing stop.
     */
    abortAll(reason = "shutdown") {
        let count = 0;
        // Clear queued agents first
        for (const queued of this.queue) {
            const record = this.agents.get(queued.id);
            if (record) {
                record.status = "stopped";
                record.stopReason = reason;
                completeRecord(record);
                count++;
            }
        }
        this.queue = [];
        // Abort running agents
        for (const record of this.agents.values()) {
            if (record.status === "running") {
                record.abortController?.abort();
                record.status = "stopped";
                record.stopReason = reason;
                completeRecord(record);
                count++;
            }
        }
        return count;
    }
    /** Wait for all running and queued agents to complete (including queued ones). */
    async waitForAll() {
        // Loop because drainQueue respects the concurrency limit — as running
        // agents finish they start queued ones, which need awaiting too.
        while (true) {
            this.drainQueue();
            const records = [...this.agents.values()];
            const pending = records
                .map(record => record.promise)
                .filter((promise) => promise !== undefined);
            const active = records.some(record => record.status === "running" || record.status === "queued");
            if (pending.length === 0)
                break;
            if (!active) {
                // abortAll() marks records stopped synchronously, but their promises
                // still own the final result/persistence callback. Wait for that work;
                // if a child ignores abort, reuse the child-session shutdown ceiling so
                // a session switch cannot hang forever.
                let timeout;
                const timedOut = await Promise.race([
                    Promise.allSettled(pending).then(() => false),
                    new Promise(resolve => {
                        timeout = setTimeout(() => resolve(true), CHILD_SHUTDOWN_TIMEOUT_MS);
                        timeout.unref();
                    }),
                ]);
                if (timeout !== undefined)
                    clearTimeout(timeout);
                if (timedOut) {
                    await Promise.all(records.map(record => shutdownChildSession(record.session)));
                }
                break;
            }
            await Promise.allSettled(pending);
        }
    }
    async dispose() {
        clearInterval(this.cleanupInterval);
        // Clear queue
        this.queue = [];
        const records = [...this.agents.values()];
        const sessions = records.map(record => record.session);
        for (const record of records)
            this.releaseBackgroundSlot(record);
        this.agents.clear();
        // Awaited, unlike the eviction path: pi awaits this extension's `session_shutdown`
        // handler and the process exits right after it returns, so anything left unawaited
        // here never runs at all. Bounded — each call carries its own ceiling, concurrently.
        await Promise.all(sessions.map(session => shutdownChildSession(session)));
        // Prune any orphaned git worktrees (crash recovery)
        try {
            pruneWorktrees(process.cwd());
        }
        catch { /* ignore */ }
        // Also prune repos that caller-supplied cwds created worktrees in — a clean
        // exit with in-flight agents would otherwise leave stale registrations there.
        for (const repo of this.worktreeRepos) {
            try {
                pruneWorktrees(repo);
            }
            catch { /* ignore */ }
        }
    }
}
