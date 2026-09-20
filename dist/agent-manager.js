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
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resumeAgent, runAgent } from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import { syncEffectiveInvocation } from "./invocation-truth.js";
import { assignHandle, handleBase, isReservedHandle } from "./mention.js";
import { describeModel, describeRequestedModel, resolveModel } from "./model-resolver.js";
import { classifyRunFailure } from "./status-note.js";
import { addUsage } from "./usage.js";
import { assertWorkString, requestWork, retainedWorkSnapshots, validateWorkBinding, validateWorkReservation, workLaunchKey } from "./work-lifecycle.js";
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
const AWS_MODEL_PROVIDERS = new Set(["amazon-bedrock", "bedrock-mantle"]);
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
export function assertValidSpawnCwd(cwd) {
    if (cwd == null)
        return;
    if (typeof cwd !== "string" || cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(cwd) || !isAbsolute(cwd)) {
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
/** Fail closed unless a child working directory is inside its copy root. */
function isContainedWorkPath(root, candidate) {
    const rel = relative(resolve(root), resolve(candidate));
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
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
    /** Startup is separate from the run: spawn still returns an ID synchronously. */
    startups = new Map();
    pi;
    workFinalizations = new Map();
    workLaunches = new Set();
    queuedWorkSignals = new Map();
    /** A stopped record is not resumable until its asynchronous continuation settles. */
    workRuns = new Map();
    pendingWorkStarts = new WeakSet();
    ownsWorkRun(record, run) {
        return !run || (this.workRuns.get(record)?.token === run.token
            && record.workLaunch === run.launch && record.abortController === run.controller);
    }
    assertWorkRun(record, run, active = true) {
        if (!this.ownsWorkRun(record, run) || (active && (record.status !== "running"
            || (run?.controller ?? record.abortController)?.signal.aborted))) {
            throw new Error("Work run no longer owns this launch or was cancelled.");
        }
    }
    watchQueuedWork(record, signal) {
        if (!record.workLaunch || !signal)
            return;
        if (signal.aborted) {
            this.abort(record.id);
            return;
        }
        const abort = () => this.abort(record.id);
        signal.addEventListener("abort", abort, { once: true });
        this.queuedWorkSignals.set(record.id, () => signal.removeEventListener("abort", abort));
    }
    finalizeQueuedWork(record) {
        const run = this.workRuns.get(record);
        void this.finalizeWork(record, run).finally(() => {
            if (run && this.ownsWorkRun(record, run))
                this.workRuns.delete(record);
        });
    }
    detachQueuedWork(id) {
        this.queuedWorkSignals.get(id)?.();
        this.queuedWorkSignals.delete(id);
    }
    workSnapshot(record) {
        // Receipts carry only bounded identities and the typed terminal status; never the child's private result.
        return { version: 1, launch: structuredClone(record.workLaunch), status: record.status };
    }
    persistWork(record) {
        if (record.workLaunch)
            this.pi.appendEntry("subagents:work-record", this.workSnapshot(record));
    }
    finalizeWork(record, run = this.workRuns.get(record)) {
        if (!this.ownsWorkRun(record, run))
            return Promise.resolve();
        const launch = run?.launch ?? record.workLaunch;
        if (!launch || !this.pi)
            return Promise.resolve();
        // Preserve late child identity even when an abort already sent the receipt.
        // Persistence failure must not suppress the live receipt; reconcile retries on reconnect.
        try {
            this.persistWork(record);
        }
        catch { /* adapter still receives the receipt */ }
        const previous = this.workFinalizations.get(launch.launchKey);
        if (previous)
            return previous;
        const snapshot = this.workSnapshot(record);
        const receipt = requestWork(this.pi.events, "finalize", snapshot).then(() => { }, () => { });
        this.workFinalizations.set(launch.launchKey, receipt);
        return receipt;
    }
    async reconcileWork(pi, branch) {
        this.pi = pi;
        const retained = new Map(retainedWorkSnapshots(branch).map(snapshot => [snapshot.launch.launchKey, snapshot]));
        for (const key of retained.keys())
            this.workLaunches.add(key);
        for (const record of this.agents.values()) {
            if (record.workLaunch)
                retained.set(record.workLaunch.launchKey, this.workSnapshot(record));
        }
        await Promise.allSettled([...retained.values()].map(snapshot => requestWork(pi.events, "reconcile", snapshot)));
    }
    async reserveWork(record, run = this.workRuns.get(record)) {
        this.assertWorkRun(record, run);
        const launch = run?.launch ?? record.workLaunch;
        if (!launch)
            return;
        this.persistWork(record);
        const reservation = await requestWork(this.pi.events, "reserve", launch);
        this.assertWorkRun(record, run, false);
        launch.reservation = validateWorkReservation(reservation);
        this.persistWork(record);
        this.assertWorkRun(record, run);
    }
    async bindWork(record, session, run = this.workRuns.get(record)) {
        this.assertWorkRun(record, run);
        const launch = run?.launch ?? record.workLaunch;
        if (!launch)
            return;
        const childSessionId = session.sessionManager.getSessionId();
        assertWorkString(childSessionId, "childSessionId", 512);
        launch.childSessionId = childSessionId;
        this.persistWork(record);
        if (!launch.reservation)
            throw new Error("Work launch has no reservation.");
        // Adapter enforcement boundary: bind must authorize this exact reservation,
        // Work identity, cwd and child session before extensions or prompts can run.
        // A successful transport reply alone is not authorization; the adapter must enforce it.
        await requestWork(this.pi.events, "bind", launch);
        this.assertWorkRun(record, run);
        launch.bound = true;
        this.persistWork(record);
        if (record.pendingSteers?.length) {
            for (const message of record.pendingSteers) {
                this.assertWorkRun(record, run);
                await session.steer(message);
            }
            this.assertWorkRun(record, run);
            record.pendingSteers = undefined;
        }
    }
    /** Idempotent cleanup shared by settlement and shutdown. */
    worktreeCleanups = new Map();
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
    constructor(onComplete, maxConcurrent = DEFAULT_MAX_CONCURRENT, onStart, onCompact, onUsage, getReservedTypeNames, pi) {
        this.getReservedTypeNames = getReservedTypeNames;
        this.onComplete = onComplete;
        this.onStart = onStart;
        this.onCompact = onCompact;
        this.onUsage = onUsage;
        this.maxConcurrent = maxConcurrent;
        this.pi = pi;
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
     * If the concurrency limit is reached, the agent is queued. Worktree startup
     * is asynchronous; awaitStartup(id) surfaces startup failures to the caller.
     */
    spawn(pi, ctx, type, prompt, options) {
        // Validate before the queue branch — a queued spawn should fail at the
        // call, not minutes later at drain. Throw (not warn): programmatic callers
        // can fix and retry; the RPC layer converts throws into error envelopes.
        assertValidSpawnCwd(options.cwd);
        const work = validateWorkBinding(options.work);
        if (work && (options.isolation === "worktree" || getAgentConfig(type)?.isolation === "worktree")) {
            throw new Error("Work binding cannot be combined with Agent worktree isolation.");
        }
        if (work) {
            assertWorkString(type, "agentType", 128);
            assertWorkString(options.description, "description", 1024);
            if (options.name !== undefined)
                assertWorkString(options.name, "agentName", 64);
        }
        // Snapshot caller-owned data before queued/asynchronous startup.
        options = { ...options, work };
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
        const config = getAgentConfig(type);
        const resolvedConfigModel = !options.model && config?.model && ctx.modelRegistry
            ? resolveModel(config.model, ctx.modelRegistry)
            : undefined;
        // An agent-file pin outranks the parent model when the session is created.
        // Resolve that pin for queued/pre-session display; if it cannot be resolved,
        // omit the prediction rather than briefly reporting a mismatch that may not
        // exist once Pi establishes the actual session.
        const predictedModel = options.model
            ?? (typeof resolvedConfigModel === "string" ? undefined : resolvedConfigModel)
            ?? (config?.model ? undefined : ctx.model);
        const requestedModel = options.requestedModel
            ?? (options.model ? describeModel(options.model).modelId : config?.model)
            ?? (ctx.model ? describeModel(ctx.model).modelId : undefined);
        const thinking = options.thinkingLevel ?? config?.thinking ?? ctx.thinkingLevel;
        const invocation = {
            ...(predictedModel ? describeModel(predictedModel) : {}),
            thinking,
            requestedThinking: thinking,
            ...(requestedModel && ctx.modelRegistry
                ? describeRequestedModel(requestedModel, ctx.modelRegistry)
                : { requestedModel, requestedModelId: requestedModel }),
            ...options.invocation,
        };
        invocation.requestedThinking ??= thinking;
        const record = {
            id,
            type,
            work,
            toolCallId: options.toolCallId,
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
            invocation,
            depth: options.depth ?? 1,
            parentAgentId: options.parentAgentId,
            maxSubagentDepth: options.maxSubagentDepth,
            rootSessionId: options.rootSessionId,
        };
        if (work) {
            const parentSessionId = ctx.sessionManager?.getSessionId?.();
            const invocationId = options.toolCallId ?? options.invocationId;
            assertWorkString(invocationId, "invocationId (required for work)", 512);
            assertWorkString(parentSessionId, "parentSessionId", 512);
            assertWorkString(options.cwd ?? ctx.cwd, "cwd", 4096);
            record.workLaunch = {
                launchKey: workLaunchKey(parentSessionId, invocationId), parentSessionId, invocationId,
                agentId: id, agentType: type, agentName: options.name, description: options.description,
                cwd: options.cwd ?? ctx.cwd, work,
            };
            if (this.workLaunches.has(record.workLaunch.launchKey)) {
                throw new Error("Work invocation already launched; reconcile or retrieve its existing record.");
            }
        }
        this.agents.set(id, record);
        this.pi = pi;
        try {
            this.persistWork(record);
        }
        catch (err) {
            this.agents.delete(id);
            throw err;
        }
        if (record.workLaunch)
            this.workLaunches.add(record.workLaunch.launchKey);
        const args = { pi, ctx, type, prompt, options };
        // Warn on the EFFECTIVE model, not just an explicit override: a spawn that
        // omits `model` inherits the parent's, so an inherited AWS model must warn
        // too. Every AWS launch is visibly flagged before it runs.
        const effectiveModel = options.model ?? ctx.model;
        if (effectiveModel && AWS_MODEL_PROVIDERS.has(effectiveModel.provider?.toLowerCase())) {
            ctx.ui?.notify(`Using AWS model ${effectiveModel.provider}/${effectiveModel.id}; this may incur AWS charges.`, "warning");
        }
        if (occupiesPoolSlot(record) && !options.bypassQueue && this.backgroundSlots.size >= this.maxConcurrent) {
            // Queue it — will be started when a running agent completes
            this.queue.push({ id, start: () => { void this.launch(id, record, args, true); } });
            this.watchQueuedWork(record, options.signal);
            return id;
        }
        void this.launch(id, record, args, false);
        return id;
    }
    /** Register startup before returning the ID; drain-time errors stay on the record. */
    launch(id, record, args, queued) {
        if (record.workLaunch)
            this.pendingWorkStarts.add(record);
        const startup = this.startAgent(id, record, args).then(() => { this.startups.delete(id); }, async (err) => {
            this.startups.delete(id);
            this.releaseBackgroundSlot(record);
            const message = err instanceof Error ? err.message : String(err);
            if (record.workLaunch && record.promise) {
                await record.promise;
                this.drainQueue();
                throw err;
            }
            if (record.status === "stopped") {
                // Cancellation during asynchronous startup is terminal too. Keep the
                // stopped record (and any retained worktree result) while rejecting
                // every waiter instead of reporting a successful spawn with no run.
                record.error = message;
                record.failureKind = classifyRunFailure(message);
                completeRecord(record);
                try {
                    this.onComplete?.(record);
                }
                catch { /* ignore completion side-effect errors */ }
            }
            else if (queued || record.workLaunch) {
                record.status = "error";
                record.error = message;
                record.failureKind = classifyRunFailure(record.error);
                completeRecord(record);
                try {
                    this.onComplete?.(record);
                }
                catch { /* ignore completion side-effect errors */ }
            }
            else {
                this.agents.delete(id);
            }
            await this.finalizeWork(record);
            this.pendingWorkStarts.delete(record);
            this.drainQueue();
            throw err;
        });
        this.startups.set(id, startup);
        return startup.catch(() => { });
    }
    /** Await in the same tick as spawn: failures replace its former synchronous throw. */
    awaitStartup(id) {
        return this.startups.get(id) ?? Promise.resolve();
    }
    /** Actually start an agent (called immediately or from queue drain). */
    async startAgent(id, record, { pi, ctx, type, prompt, options }) {
        // Re-validate a caller-supplied cwd: queued spawns can start minutes after
        // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
        // curated errors; drainQueue parks a throw on the record as an error.
        assertValidSpawnCwd(options.cwd);
        // Single resolution point for the caller-supplied cwd — the worktree base
        // repo and both cleanup calls below MUST agree on this value forever.
        const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
        const baseCwd = customCwd ?? ctx.cwd;
        // Reserve the slot before yielding, so another spawn/drain cannot overbook
        // it and stop/abortAll can reach a copy still in progress.
        record.status = "running";
        record.startedAt = Date.now();
        record.lastProgressAt = record.startedAt;
        this.acquireBackgroundSlot(record);
        let detachParentSignal;
        if (options.signal) {
            if (options.signal.aborted)
                this.abort(id);
            else {
                const onParentAbort = () => this.abort(id);
                options.signal.addEventListener("abort", onParentAbort, { once: true });
                detachParentSignal = () => options.signal.removeEventListener("abort", onParentAbort);
            }
        }
        const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };
        // Worktree isolation: try to create a temporary git worktree. Strict —
        // fail loud if not possible (no silent fallback to main tree). Done
        // BEFORE launching the child so a failure never falls back to the main tree.
        // The project switch is enforced here as well as at the tool boundary
        // because cross-extension RPC forwards its options unvalidated — a schema
        // that omits the field can't stop a caller that never saw the schema.
        let worktreeCwd;
        let cleanupCopy;
        let preservationFailure;
        try {
            if (record.workLaunch)
                await this.reserveWork(record);
            if (record.status === "running" && options.isolation === "worktree" && isWorktreeIsolationEnabled()) {
                const wt = await createWorktree(pi, baseCwd, id);
                if (!wt) {
                    throw new Error('Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
                        'Initialize git and commit at least once, or omit `isolation`.');
                }
                record.worktree = wt;
                let cleanup;
                cleanupCopy = () => {
                    cleanup ??= cleanupWorktree(pi, baseCwd, wt, options.description)
                        .finally(() => { this.worktreeCleanups.delete(id); });
                    return cleanup;
                };
                this.worktreeCleanups.set(id, cleanupCopy);
                // Defense in depth: even a malformed or future createWorktree result
                // cannot steer the child outside the isolated copy.
                if (!isContainedWorkPath(wt.path, wt.workPath)) {
                    throw new Error(`Worktree working directory escapes the isolated copy: ${wt.workPath}`);
                }
                // workPath preserves subdirectory scoping for caller-supplied cwds: a
                // cwd deep in a monorepo maps to the same subdir inside the copy, not
                // the copied repo's root. Plain worktree spawns keep the historical
                // behavior (agent at the copy's root) — moving them to workPath would
                // also move .pi config discovery when the parent session sits in a repo
                // subdirectory, silently dropping extensions/skills.
                worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
                this.worktreeRepos.add(baseCwd);
            }
            // A stop may have landed while Git was copying. Never launch a child after
            // that stop; retain the slot until its new worktree is fully removed.
            if (record.status !== "running") {
                if (record.worktree) {
                    record.worktreeResult = await cleanupCopy();
                }
                detach();
                const retained = record.worktreeResult?.error
                    ? ` Worktree output was not preserved: ${record.worktreeResult.error}. Recover it at \`${record.worktreeResult.path ?? record.worktree?.path}\`.`
                    : "";
                throw new Error(`Agent startup cancelled before the child was launched.${retained}`);
            }
            this.onStart?.(record);
            let boundReady;
            let bindingFailed;
            const binding = record.workLaunch ? new Promise((resolve, reject) => { boundReady = resolve; bindingFailed = reject; }) : undefined;
            const promise = runAgent(ctx, type, prompt, {
                bindBeforeExtensions: !!record.workLaunch,
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
                onSessionCreated: async (session) => {
                    if (record.workLaunch)
                        await this.bindWork(record, session);
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
                    syncEffectiveInvocation(record, session);
                    // Flush any steers that arrived before the session was ready
                    if (record.pendingSteers?.length) {
                        for (const msg of record.pendingSteers) {
                            session.steer(msg).catch(() => { });
                        }
                        record.pendingSteers = undefined;
                    }
                    await options.onSessionCreated?.(session);
                    boundReady?.();
                },
            })
                .then(async ({ responseText, session, aborted, timedOut, steered, failure }) => {
                syncEffectiveInvocation(record, session);
                record.result = responseText;
                if (timedOut) {
                    await shutdownChildSession(session);
                    record.session = undefined;
                }
                else {
                    record.session = session;
                }
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
                    const wtResult = await cleanupCopy();
                    record.worktreeResult = wtResult;
                    if (wtResult.error) {
                        preservationFailure = `Worktree output was not preserved: ${wtResult.error}. Recover it at \`${wtResult.path ?? record.worktree.path}\`.`;
                        record.result = (record.result ?? "") + `\n\n---\n${preservationFailure}`;
                    }
                    else if (wtResult.hasChanges && wtResult.branch) {
                        // With a caller-supplied cwd the branch lives in THAT repo, not the
                        // parent session's — say so, or the orchestrator merges in the wrong repo.
                        const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
                        record.result = (record.result ?? "") +
                            `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
                    }
                }
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
                    else if (preservationFailure) {
                        record.status = "error";
                        record.error = preservationFailure;
                        record.failureKind = classifyRunFailure(preservationFailure);
                    }
                    else {
                        record.status = steered ? "steered" : "completed";
                    }
                }
                completeRecord(record);
                await this.finalizeWork(record);
                detach();
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
                .catch(async (err) => {
                bindingFailed?.(err);
                if (record.session)
                    syncEffectiveInvocation(record, record.session);
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
                        const wtResult = await cleanupCopy();
                        record.worktreeResult = wtResult;
                        if (wtResult.error) {
                            preservationFailure = `Worktree output was not preserved: ${wtResult.error}. Recover it at \`${wtResult.path ?? record.worktree.path}\`.`;
                        }
                    }
                    catch { /* ignore cleanup errors */ }
                }
                // Don't overwrite status if externally stopped via abort()
                if (record.status !== "stopped") {
                    record.status = "error";
                }
                const runError = err instanceof Error ? err.message : String(err);
                record.error = preservationFailure ? `${runError} ${preservationFailure}` : runError;
                record.failureKind = classifyRunFailure(record.error);
                completeRecord(record);
                await this.finalizeWork(record);
                detach();
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
            record.promise = promise.finally(() => this.pendingWorkStarts.delete(record));
            // Notify caller that spawn is complete (record is in the map, promise is set).
            // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
            // Used by spawnAndWait to let the caller set up output files before streaming starts.
            options.onSpawned?.(id);
            if (binding)
                await binding;
        }
        catch (err) {
            detach();
            // Synchronous runner/callback failures after creation still own a copy.
            if (record.worktree && !record.promise) {
                record.worktreeResult = await cleanupCopy();
            }
            throw err;
        }
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
            this.detachQueuedWork(next.id);
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
                this.finalizeQueuedWork(record);
                this.onComplete?.(record);
            }
        }
    }
    /**
     * Spawn an agent and wait for completion (foreground use).
     * Foreground agents bypass the concurrency queue.
     * Returns { id, record } so callers can access the agent ID.
     *
     * @param onSpawned - Called once the run promise is installed, before onSessionCreated.
     *   With isolation this follows the awaited copy. Use it to wire record.outputFile.
     */
    async spawnAndWait(pi, ctx, type, prompt, options, onSpawned) {
        const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false, onSpawned });
        const record = this.agents.get(id);
        await this.awaitStartup(id);
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
        // Refuse active records before synchronizing posture or resetting either run
        // mode: direct manager callers must leave the live run untouched.
        if (record.status === "running" || record.status === "queued"
            || this.workRuns.has(record) || this.pendingWorkStarts.has(record))
            return undefined;
        const requestedWork = validateWorkBinding(options?.work);
        if (requestedWork && !record.workLaunch)
            throw new Error("Cannot add Work binding to an unbound session; start a fresh agent.");
        const priorBackgroundState = record.workLaunch && options?.isBackground ? {
            workLaunch: record.workLaunch,
            abortController: record.abortController,
            stopReason: record.stopReason,
            invocation: record.invocation ? { ...record.invocation } : undefined,
            isBackground: record.isBackground,
            resultConsumed: record.resultConsumed,
            result: record.result,
            error: record.error,
            failureKind: record.failureKind,
            completedAt: record.completedAt,
            status: record.status,
        } : undefined;
        if (record.workLaunch) {
            if (requestedWork && JSON.stringify(requestedWork) !== JSON.stringify(record.workLaunch.work)) {
                throw new Error("Cannot change a resumed session's Work binding.");
            }
            if (options?.cwd !== undefined && options.cwd !== record.workLaunch.cwd)
                throw new Error("Cannot change a bound session's cwd on resume.");
            const invocationId = options?.toolCallId ?? options?.invocationId;
            assertWorkString(invocationId, "invocationId (required for bound resume)", 512);
            const launchKey = workLaunchKey(record.workLaunch.parentSessionId, invocationId);
            if (this.workLaunches.has(launchKey))
                throw new Error("Work invocation already launched.");
            this.workLaunches.add(launchKey);
            record.workLaunch = { ...record.workLaunch, invocationId, launchKey, reservation: undefined, bound: false };
            record.abortController = new AbortController();
            this.workRuns.set(record, Object.freeze({ token: Symbol("work-resume"), launch: record.workLaunch, controller: record.abortController }));
            record.stopReason = undefined;
        }
        const workRun = this.workRuns.get(record);
        syncEffectiveInvocation(record, record.session);
        // Background resume: settle asynchronously and notify on completion exactly
        // like a background spawn, returning immediately with the record still
        // "running" — or "queued" when at the concurrency limit. Previously
        // run_in_background was ignored on resume (the Agent tool's resume branch
        // returned before its background branch, and resume() only ever awaited
        // inline), so a resumed agent always blocked the caller until it finished.
        if (options?.isBackground) {
            record.isBackground = true;
            record.resultConsumed = false;
            record.result = undefined;
            record.error = undefined;
            record.failureKind = undefined;
            record.completedAt = undefined;
            record.status = "queued";
            try {
                this.persistWork(record);
            }
            catch (err) {
                if (priorBackgroundState && workRun) {
                    // No queue entry, reservation, or child run exists yet. Undo this
                    // launch locally rather than issuing a terminal Work receipt.
                    this.workLaunches.delete(workRun.launch.launchKey);
                    this.workRuns.delete(record);
                    Object.assign(record, priorBackgroundState);
                }
                throw err;
            }
            const start = () => this.startResume(id, record, prompt, signal, options, workRun);
            if (occupiesPoolSlot(record) && this.backgroundSlots.size >= this.maxConcurrent) {
                // At the concurrency limit — queue it, drains when a slot frees.
                this.queue.push({ id, start });
                this.watchQueuedWork(record, signal);
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
        record.failureKind = undefined;
        const abortBoundResume = () => this.abort(id);
        if (record.workLaunch && signal) {
            if (signal.aborted)
                abortBoundResume();
            else
                signal.addEventListener("abort", abortBoundResume, { once: true });
        }
        try {
            if (workRun) {
                await this.reserveWork(record, workRun);
                await this.bindWork(record, record.session, workRun);
                this.assertWorkRun(record, workRun);
            }
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
                signal: workRun ? workRun.controller.signal : signal,
                runDeadlineMs: options?.runDeadlineMs,
            });
            if (!this.ownsWorkRun(record, workRun))
                return record;
            syncEffectiveInvocation(record, record.session);
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
            if (timedOut) {
                await shutdownChildSession(record.session);
                record.session = undefined;
            }
            completeRecord(record);
        }
        catch (err) {
            if (!this.ownsWorkRun(record, workRun))
                return record;
            // resumeAgent can reject after Pi has already changed the live session's
            // posture; persist that final truth before the record settles.
            if (record.session)
                syncEffectiveInvocation(record, record.session);
            record.status = "error";
            record.error = err instanceof Error ? err.message : String(err);
            record.failureKind = classifyRunFailure(record.error);
            completeRecord(record);
        }
        if (workRun) {
            signal?.removeEventListener("abort", abortBoundResume);
            if (workRun.controller.signal.aborted)
                record.status = "stopped";
            await this.finalizeWork(record, workRun);
        }
        // Same contract as the spawn settle paths: children spawned during the
        // resumed turn must not outlive it — nothing else can see or reach them.
        this.abortOwnedChildren(id);
        if (workRun && this.ownsWorkRun(record, workRun))
            this.workRuns.delete(record);
        return record;
    }
    /**
     * Start a background resume run: detached, settling and notifying like
     * startAgent's background path. Invoked immediately, or from drainQueue when
     * a concurrency slot frees. The session already exists (resume reuses it), so
     * there is no onSessionCreated to hang per-run wiring off — callers use
     * `options.onStarted`, which fires on both the immediate and the drained path.
     */
    startResume(id, record, prompt, parentSignal, options, workRun = this.workRuns.get(record)) {
        if (!this.ownsWorkRun(record, workRun))
            return;
        if (!record.session) {
            if (workRun)
                this.workRuns.delete(record);
            return;
        }
        syncEffectiveInvocation(record, record.session);
        record.status = "running";
        // A queued resume retains the previous run's timestamp until this exact
        // start point; frozen/low-resolution clocks still produce a fresh boundary.
        record.startedAt = Math.max(Date.now(), record.startedAt + 1);
        record.lastProgressAt = record.startedAt;
        this.acquireBackgroundSlot(record);
        this.onStart?.(record);
        // Fresh abort controller so /agents stop and steering target THIS run rather
        // than the previous one's settled controller.
        const abortController = workRun?.controller ?? new AbortController();
        record.abortController = abortController;
        // Optional, and NOT what the Agent tool passes for a detached resume: a
        // parent signal aborts on the parent's own interrupt (user Esc), which is
        // right for a foreground run whose result the caller is awaiting, and wrong
        // for a detached one — background spawns omit it for exactly this reason.
        let detachParentSignal;
        if (parentSignal) {
            if (record.workLaunch && parentSignal.aborted)
                this.abort(id);
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
            if (!this.ownsWorkRun(record, workRun))
                return;
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
        const session = record.session;
        const run = () => {
            if (workRun)
                this.assertWorkRun(record, workRun);
            return resumeAgent(session, prompt, {
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
                runDeadlineMs: options.runDeadlineMs,
            });
        };
        const authorizedRun = workRun
            ? this.reserveWork(record, workRun).then(() => this.bindWork(record, session, workRun)).then(run)
            : run();
        const promise = authorizedRun
            .then(async ({ text, failure, timedOut }) => {
            if (!this.ownsWorkRun(record, workRun))
                return "";
            syncEffectiveInvocation(record, session);
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
            if (timedOut) {
                await shutdownChildSession(session);
                record.session = undefined;
            }
            completeRecord(record);
            await this.finalizeWork(record, workRun);
            settle();
            return text;
        })
            .catch(async (err) => {
            if (!this.ownsWorkRun(record, workRun))
                return "";
            syncEffectiveInvocation(record, session);
            if (record.status !== "stopped") {
                record.status = "error";
                record.error = err instanceof Error ? err.message : String(err);
                record.failureKind = classifyRunFailure(record.error);
            }
            completeRecord(record);
            await this.finalizeWork(record, workRun);
            settle();
            return "";
        })
            .finally(() => {
            if (workRun && this.ownsWorkRun(record, workRun))
                this.workRuns.delete(record);
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
        if (record.session && (!record.workLaunch || record.workLaunch.bound)) {
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
            this.detachQueuedWork(id);
            this.queue = this.queue.filter(q => q.id !== id);
            record.status = "stopped";
            record.stopReason = reason;
            completeRecord(record);
            this.finalizeQueuedWork(record);
            return true;
        }
        if (record.status !== "running")
            return false;
        record.abortController?.abort();
        record.status = "stopped";
        record.stopReason = reason;
        completeRecord(record);
        // Startup settlement includes any late reservation/child identity in its receipt.
        if (!this.startups.has(id) && !this.workRuns.has(record))
            void this.finalizeWork(record);
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
            work: record.work,
            cwd: record.workLaunch?.cwd,
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
            this.detachQueuedWork(queued.id);
            const record = this.agents.get(queued.id);
            if (record) {
                record.status = "stopped";
                record.stopReason = reason;
                completeRecord(record);
                count++;
            }
        }
        for (const queued of this.queue) {
            const record = this.agents.get(queued.id);
            if (record)
                this.finalizeQueuedWork(record);
        }
        this.queue = [];
        // Abort running agents
        for (const record of this.agents.values()) {
            if (record.status === "running") {
                record.abortController?.abort();
                record.status = "stopped";
                record.stopReason = reason;
                completeRecord(record);
                if (!this.startups.has(record.id) && !this.workRuns.has(record))
                    void this.finalizeWork(record);
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
            // Startup has no run promise yet. Git has its own bounded timeouts; do
            // not apply the shorter child-shutdown ceiling to a copy/cleanup.
            if (this.startups.size > 0) {
                await Promise.allSettled(this.startups.values());
                continue;
            }
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
                    await Promise.allSettled([...this.worktreeCleanups.values()].map(cleanup => cleanup()));
                }
                break;
            }
            await Promise.allSettled(pending);
        }
    }
    async dispose() {
        clearInterval(this.cleanupInterval);
        this.abortAll();
        // A copy in progress must finish its stopped-startup cleanup before quit.
        await Promise.allSettled(this.startups.values());
        this.startups.clear();
        await Promise.allSettled(this.workFinalizations.values());
        // Clear queue
        this.queue = [];
        const records = [...this.agents.values()];
        const sessions = records.map(record => record.session);
        // Close child tools before removing their working directories.
        await Promise.all(sessions.map(session => shutdownChildSession(session)));
        await Promise.allSettled([...this.worktreeCleanups.values()].map(cleanup => cleanup()));
        for (const record of records)
            this.releaseBackgroundSlot(record);
        this.agents.clear();
        // Prune any orphaned git worktrees (crash recovery)
        if (this.pi)
            await pruneWorktrees(this.pi, process.cwd());
        // Also prune repos that caller-supplied cwds created worktrees in — a clean
        // exit with in-flight agents would otherwise leave stale registrations there.
        for (const repo of this.worktreeRepos) {
            if (this.pi)
                await pruneWorktrees(this.pi, repo);
        }
    }
}
