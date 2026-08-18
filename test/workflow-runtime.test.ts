import { describe, expect, it } from "vitest";
import type { WorkflowAgentEntry, WorkflowEntry } from "../src/workflow/progress.js";
import {
  assertBoundarySafe,
  type RunWorkflowOptions,
  runWorkflow,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  type WorkflowControl,
  type WorkflowHost,
  type WorkflowRunResult,
  type WorkflowSpawnRequest,
  type WorkflowSpawnResult,
  workflowConcurrency,
} from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "probe", description: "a test workflow" };\n';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface Stub {
  host: WorkflowHost;
  calls: WorkflowSpawnRequest[];
  aborted: string[];
}

/**
 * A host that never spawns anything. `reply` sees each request and decides what
 * comes back; the default echoes the prompt so a script can assert plumbing.
 */
function stubHost(
  reply?: (request: WorkflowSpawnRequest) => Promise<WorkflowSpawnResult> | WorkflowSpawnResult,
): Stub {
  const calls: WorkflowSpawnRequest[] = [];
  const aborted: string[] = [];
  return {
    calls,
    aborted,
    host: {
      async spawnAgent(request) {
        calls.push(request);
        return reply ? await reply(request) : { ok: true, text: `ok:${request.prompt}` };
      },
      abortAgent(agentId) {
        aborted.push(agentId);
      },
    },
  };
}

/** Run `body` as a workflow, with `meta` prepended. */
function run(body: string, options: Omit<RunWorkflowOptions, "script">): Promise<WorkflowRunResult> {
  return runWorkflow({ script: HEAD + body, ...options });
}

const agentEntries = (progress: readonly WorkflowEntry[]): WorkflowAgentEntry[] =>
  progress.filter((entry): entry is WorkflowAgentEntry => entry.type === "workflow_agent");

describe("workflowConcurrency", () => {
  it("never returns zero on a small machine", () => {
    // min(16, cpus - 2) alone is 0 here, and a zero-permit semaphore deadlocks
    // before the first agent instead of failing.
    expect(workflowConcurrency(1)).toBe(1);
    expect(workflowConcurrency(2)).toBe(1);
    expect(workflowConcurrency(3)).toBe(1);
  });

  it("leaves two cores free and caps at 16", () => {
    expect(workflowConcurrency(8)).toBe(6);
    expect(workflowConcurrency(18)).toBe(16);
    expect(workflowConcurrency(64)).toBe(16);
  });
});

describe("script globals", () => {
  it("runs a script, returns its value and reports meta", async () => {
    const { host, calls } = stubHost();
    const result = await run('const answer = await agent("hello");\nreturn { answer };', { host });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ answer: "ok:hello" });
    expect(result.meta.name).toBe("probe");
    expect(result.agentCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].agentType).toBe("general-purpose");
    expect(calls[0].label).toBe("hello");
  });

  it("carries opts.effort to the spawn request", async () => {
    const { host, calls } = stubHost();
    const result = await run('await agent("deep", { effort: "xhigh" });\nreturn null;', { host });

    expect(result.status).toBe("completed");
    expect(calls[0].effort).toBe("xhigh");
  });

  it("leaves effort unset when the script does not ask for one", async () => {
    // Unset, not defaulted: the agent definition's `thinking` and then the
    // parent's still decide, exactly as they do for `model`.
    const { host, calls } = stubHost();
    await run('await agent("plain");\nreturn null;', { host });

    expect(calls[0].effort).toBeUndefined();
  });

  it("rejects an effort level pi does not have", async () => {
    const { host, calls } = stubHost();
    const result = await run('await agent("a", { effort: "ultra" });\nreturn null;', { host });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("agent() opts.effort must be one of");
    // Rejected at the call, so nothing was spawned at the wrong depth.
    expect(calls).toHaveLength(0);
  });

  it("passes args through verbatim and exposes meta to the script", async () => {
    const { host } = stubHost();
    const result = await run("return { got: args, name: meta.name };", {
      host,
      args: { files: ["a.ts", "b.ts"], depth: 2 },
    });
    expect(result.value).toEqual({ got: { files: ["a.ts", "b.ts"], depth: 2 }, name: "probe" });
  });

  it("records phases, logs and console output", async () => {
    const { host } = stubHost();
    const result = await run(
      [
        'phase("Scan");',
        'log("scanned 41 files");',
        'console.log("a", 1);',
        'await agent("one");',
        'phase("Verify");',
        'await agent("two");',
        'await agent("three", { phase: "Extra" });',
        "return null;",
      ].join("\n"),
      { host, concurrency: 4 },
    );

    expect(result.status).toBe("completed");
    expect(result.progress.filter(e => e.type === "workflow_phase")).toEqual([
      { type: "workflow_phase", index: 0, title: "Scan" },
      { type: "workflow_phase", index: 1, title: "Verify" },
      { type: "workflow_phase", index: 2, title: "Extra" },
    ]);
    expect(result.progress.filter(e => e.type === "workflow_log").map(e => e.message)).toEqual([
      "scanned 41 files",
      "a 1",
    ]);

    const byIndex = new Map(agentEntries(result.progress).map(e => [e.index, e]));
    expect(byIndex.get(0)?.phaseIndex).toBe(0);
    expect(byIndex.get(1)?.phaseIndex).toBe(1);
    // An explicit opts.phase files the agent elsewhere without moving the
    // ambient phase for whatever comes next.
    expect(byIndex.get(2)?.phaseIndex).toBe(2);
    expect(byIndex.get(2)?.phaseTitle).toBe("Extra");
  });

  it("reports line numbers that match the script the author wrote", async () => {
    const { host } = stubHost();
    // meta occupies line 1 and the leading newline is line 2, so the Error is
    // constructed on line 3 — the async wrapper the worker compiles must not
    // shift that.
    const result = await run('\nconst here = new Error("x").stack;\nreturn here;', { host });
    expect(result.value).toContain("workflow.js:3:");
  });

  it("maps a failed agent to null rather than throwing", async () => {
    const { host } = stubHost(request =>
      request.prompt === "bad" ? { ok: false, error: "child exploded" } : { ok: true, text: "fine" },
    );
    const result = await run('return [await agent("bad"), await agent("good")];', { host });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual([null, "fine"]);
    const failed = agentEntries(result.progress).find(e => e.state === "error");
    expect(failed?.error).toBe("child exploded");
  });
});

describe("parallel", () => {
  it("is a barrier and folds a throwing thunk to null", async () => {
    const { host } = stubHost(async request => {
      if (request.prompt === "slow") await sleep(60);
      return { ok: true, text: `ok:${request.prompt}` };
    });

    const result = await run(
      [
        "const order = [];",
        "const values = await parallel([",
        '  async () => { const r = await agent("fast"); order.push("fast"); return r; },',
        '  async () => { throw new Error("thunk exploded"); },',
        '  async () => { const r = await agent("slow"); order.push("slow"); return r; },',
        "]);",
        'order.push("after");',
        "return { values, order };",
      ].join("\n"),
      { host, concurrency: 4 },
    );

    expect(result.status).toBe("completed");
    const value = result.value as { values: (string | null)[]; order: string[] };
    // The thrown thunk becomes null; its siblings are untouched.
    expect(value.values).toEqual(["ok:fast", null, "ok:slow"]);
    // "after" last is the barrier: nothing past the await runs early.
    expect(value.order).toEqual(["fast", "slow", "after"]);
  });

  it("rejects more items than the cap allows", async () => {
    const { host } = stubHost();
    const result = await run("return await parallel(new Array(9).fill(async () => 1));", {
      host,
      itemCap: 8,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("9 items, over the limit of 8");
  });

  it("defaults the item cap to 4096", () => {
    expect(WORKFLOW_ITEM_CAP).toBe(4096);
  });
});

describe("pipeline", () => {
  it("overlaps stages — item A reaches stage 2 before item B leaves stage 1", async () => {
    // The whole reason pipeline exists. With a barrier between stages, B's slow
    // stage-1 agent would hold A out of stage 2.
    const { host } = stubHost(async request => {
      if (request.prompt === "s1:B") await sleep(80);
      return { ok: true, text: `ok:${request.prompt}` };
    });

    const result = await run(
      [
        "const order = [];",
        'const out = await pipeline(["A", "B"],',
        '  async (value) => { await agent("s1:" + value); order.push("s1-out:" + value); return value; },',
        '  async (value, item, index) => { order.push("s2-in:" + item + ":" + index); return value + "!"; },',
        ");",
        "return { order, out };",
      ].join("\n"),
      { host, concurrency: 4 },
    );

    expect(result.status).toBe("completed");
    const value = result.value as { order: string[]; out: string[] };
    expect(value.out).toEqual(["A!", "B!"]);
    expect(value.order.indexOf("s2-in:A:0")).toBeGreaterThanOrEqual(0);
    expect(value.order.indexOf("s1-out:B")).toBeGreaterThanOrEqual(0);
    expect(value.order.indexOf("s2-in:A:0")).toBeLessThan(value.order.indexOf("s1-out:B"));
    expect(value.order).toEqual(["s1-out:A", "s2-in:A:0", "s1-out:B", "s2-in:B:1"]);
  });

  it("hands every stage (previous, original, index)", async () => {
    const { host } = stubHost();
    const result = await run(
      [
        'return await pipeline(["x", "y"],',
        "  async (value) => value.toUpperCase(),",
        "  async (value, item, index) => [value, item, index].join(\"/\"),",
        ");",
      ].join("\n"),
      { host },
    );
    expect(result.value).toEqual(["X/x/0", "Y/y/1"]);
  });

  it("drops a throwing item to null without touching its siblings", async () => {
    const { host } = stubHost();
    const result = await run(
      [
        'return await pipeline(["keep", "drop"],',
        '  async (value) => { if (value === "drop") throw new Error("stage failed"); return value; },',
        '  async (value) => value + ":done",',
        ");",
      ].join("\n"),
      { host },
    );
    expect(result.value).toEqual(["keep:done", null]);
  });

  it("rejects more items than the cap allows", async () => {
    const { host } = stubHost();
    const result = await run("return await pipeline(new Array(5).fill(1), async v => v);", {
      host,
      itemCap: 4,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("over the limit of 4");
  });
});

describe("semaphore", () => {
  it("never exceeds the configured concurrency under a large fan-out", async () => {
    let active = 0;
    let peak = 0;
    const { host } = stubHost(async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
      return { ok: true, text: "done" };
    });

    const result = await run(
      'return (await parallel(new Array(24).fill(0).map((_, i) => () => agent("a" + i)))).length;',
      { host, concurrency: 3 },
    );

    expect(result.status).toBe("completed");
    expect(result.value).toBe(24);
    expect(peak).toBe(3);
  });

  it("holds the cap when fresh agents arrive while others are still queued", async () => {
    // A pipeline whose stages both spawn: stage-2 agents ask for a slot long
    // after the stage-1 fan-out queued up, so a permit that is released rather
    // than handed straight to a waiter lets the pool overfill.
    let active = 0;
    let peak = 0;
    const { host } = stubHost(async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
      return { ok: true, text: "done" };
    });

    const result = await run(
      [
        "return (await pipeline([0, 1, 2, 3, 4, 5],",
        '  async (item) => await agent("s1:" + item),',
        '  async (previous, item) => await agent("s2:" + item),',
        ")).length;",
      ].join("\n"),
      { host, concurrency: 2 },
    );

    expect(result.status).toBe("completed");
    expect(result.value).toBe(6);
    expect(peak).toBe(2);
  });

  it("queues agents it cannot start yet", async () => {
    const { host } = stubHost(async () => {
      await sleep(10);
      return { ok: true, text: "done" };
    });
    const result = await run(
      'return (await parallel(new Array(4).fill(0).map((_, i) => () => agent("a" + i)))).length;',
      { host, concurrency: 1 },
    );
    const queuedOnly = agentEntries(result.progress).filter(e => e.queuedAt != null && e.startedAt == null);
    expect(queuedOnly.length).toBeGreaterThan(0);
  });
});

describe("determinism prelude", () => {
  it("makes Date.now, new Date() and Math.random throw with guidance", async () => {
    const { host } = stubHost();
    const result = await run(
      [
        "const messages = [];",
        "const capture = (fn) => { try { fn(); messages.push(null); } catch (error) { messages.push(error.message); } };",
        "capture(() => Date.now());",
        "capture(() => new Date());",
        "capture(() => Math.random());",
        "return { messages, stamped: new Date(0).getTime() };",
      ].join("\n"),
      { host },
    );

    expect(result.status).toBe("completed");
    const value = result.value as { messages: string[]; stamped: number };
    expect(value.messages).toHaveLength(3);
    for (const message of value.messages) {
      expect(message).toContain("unavailable in workflow scripts (breaks resume)");
      expect(message).toContain(
        "Stamp results after the workflow returns, or pass timestamps via `args`.",
      );
    }
    expect(value.messages[0]).toContain("Date.now()");
    expect(value.messages[1]).toContain("new Date()");
    expect(value.messages[2]).toContain("Math.random()");
    // An explicit timestamp still works — only the clock reads are blocked.
    expect(value.stamped).toBe(0);
  });

  it("blocks code generation from strings", async () => {
    const { host } = stubHost();
    const result = await run(
      [
        "const seen = [];",
        'const capture = (fn) => { try { fn(); seen.push("no-throw"); } catch (error) { seen.push(error.name + ":" + (error instanceof EvalError)); } };',
        'capture(() => eval("1"));',
        'capture(() => Function("return 1"));',
        "return seen;",
      ].join("\n"),
      { host },
    );
    expect(result.value).toEqual(["EvalError:true", "EvalError:true"]);
  });
});

describe("the JSON boundary", () => {
  const cases: [string, string, string][] = [
    ["a cycle", "const a = {}; a.self = a; return a;", "a circular structure"],
    ["a BigInt", "return { n: 1n };", "a BigInt"],
    ["a function", "return () => 1;", "a function"],
    ["a Map", "return new Map();", "a non-plain object"],
    ["a sparse array", "const a = []; a[2] = 1; return a;", "a sparse array"],
    ["NaN", "return { n: 0 / 0 };", "a non-finite number"],
  ];

  for (const [name, body, expected] of cases) {
    it(`rejects ${name} on the way out`, async () => {
      const { host } = stubHost();
      const result = await run(body, { host });
      expect(result.status).toBe("failed");
      expect(result.error).toContain(expected);
      expect(result.error).toContain("across the workflow VM boundary");
    });
  }

  it("rejects args that cannot cross, before the worker starts", async () => {
    const { host } = stubHost();
    await expect(run("return 1;", { host, args: { when: new Date(0) } })).rejects.toThrow(
      /across the workflow VM boundary/,
    );
  });

  it("accepts plain JSON in both directions", () => {
    expect(() => assertBoundarySafe({ a: [1, "two", null, { b: true }] }, "args")).not.toThrow();
    expect(() => assertBoundarySafe(undefined, "args")).not.toThrow();
  });
});

describe("caps and validation", () => {
  it("defaults the agent cap to 1000", () => {
    expect(WORKFLOW_AGENT_CAP).toBe(1000);
  });

  it("fails the run when the agent cap is hit, rather than returning null", async () => {
    const { host, calls } = stubHost();
    const result = await run(
      'const seen = []; for (let i = 0; i < 4; i++) seen.push(await agent("a" + i)); return seen;',
      { host, agentCap: 2 },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("cap of 2 agents");
    expect(calls).toHaveLength(2);
  });

  it("does not let parallel swallow a cap breach into a null", async () => {
    const { host } = stubHost();
    const result = await run(
      'return await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);',
      { host, agentCap: 1, concurrency: 1 },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("cap of 1 agents");
  });

  it("rejects a script with control characters", async () => {
    const { host } = stubHost();
    await expect(runWorkflow({ script: `${HEAD}return "a\u0007b";`, host })).rejects.toThrow(
      /control characters/,
    );
  });

  it("rejects a script over the size limit", async () => {
    const { host } = stubHost();
    const script = HEAD + `return "${"x".repeat(600_000)}";`;
    await expect(runWorkflow({ script, host })).rejects.toThrow(/over the limit of 524288/);
  });

  it("rejects a script with no meta block", async () => {
    const { host } = stubHost();
    await expect(runWorkflow({ script: "return 1;", host })).rejects.toThrow(/must begin with/);
  });

  it("reports a script that throws as a failed run", async () => {
    const { host } = stubHost();
    const result = await run('throw new Error("script blew up");', { host });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("script blew up");
  });
});

describe("abort", () => {
  it("terminates the run and aborts every in-flight child", async () => {
    const controller = new AbortController();
    const { host, aborted } = stubHost(() => new Promise<WorkflowSpawnResult>(() => {}));

    let started = () => {};
    const running = new Promise<void>(resolve => {
      started = resolve;
    });

    const promise = run('await agent("hangs forever");\nreturn "unreachable";', {
      host,
      signal: controller.signal,
      onProgress(entries) {
        if (entries.some(e => e.type === "workflow_agent" && e.startedAt != null)) started();
      },
    });

    await running;
    controller.abort();
    const result = await promise;

    expect(result.status).toBe("killed");
    expect(result.error).toBe("Workflow aborted.");
    expect(aborted).toEqual(["wf-agent-0"]);
  });

  it("settles a script that never yields", async () => {
    const controller = new AbortController();
    const { host } = stubHost();

    let spinning = () => {};
    const running = new Promise<void>(resolve => {
      spinning = resolve;
    });

    // The agent call is the last thing the worker's event loop gets to do — the
    // loop below never yields, so nothing scheduled after it would ever run.
    const promise = run('await agent("start");\nfor (;;) {}', {
      host,
      signal: controller.signal,
      onProgress(entries) {
        if (entries.some(e => e.type === "workflow_agent" && e.state === "done")) spinning();
      },
    });

    await running;
    const baseline = process.cpuUsage();
    controller.abort();
    // Only terminate() can stop a synchronous loop; an in-process vm timeout
    // cannot, which is why the script runs on its own thread.
    expect((await promise).status).toBe("killed");

    // And the thread really is gone, not merely detached: cpuUsage() covers
    // every thread in the process, so a worker still spinning on `for (;;)`
    // would burn most of this window.
    await sleep(250);
    const spent = process.cpuUsage(baseline);
    expect((spent.user + spent.system) / 1000).toBeLessThan(150);
  });

  it("settles immediately when the signal is already aborted", async () => {
    const { host, calls } = stubHost();
    const result = await run('await agent("never");', { host, signal: AbortSignal.abort() });
    expect(result.status).toBe("killed");
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- *
 * Live control — pause, skip, retry
 * ------------------------------------------------------------------------- */

describe("run control", () => {
  /** A host whose children hang until the test lets them go, or are aborted. */
  function controllableHost() {
    const started: string[] = [];
    const aborted: string[] = [];
    const release = new Map<string, (r: WorkflowSpawnResult) => void>();
    const host: WorkflowHost = {
      spawnAgent(request) {
        started.push(request.agentId);
        return new Promise<WorkflowSpawnResult>(resolve => {
          release.set(request.agentId, resolve);
        });
      },
      abortAgent(agentId) {
        aborted.push(agentId);
        // What the real host does: the child is stopped, and a stopped child
        // comes back as a skipped result rather than a failure.
        release.get(agentId)?.({ ok: false, skipped: true, error: "Stopped." });
      },
    };
    return {
      host,
      started: () => started,
      aborted: () => aborted,
      finish: (agentId: string, text: string) => release.get(agentId)?.({ ok: true, text }),
    };
  }

  /** Wait until `predicate` holds, so a test never races the worker thread. */
  async function until(predicate: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return;
      await sleep(5);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it("stops starting agents while paused, and starts them again on resume", async () => {
    const stub = controllableHost();
    let control: WorkflowControl | undefined;
    const done = run(
      "const a = await agent('one'); const b = await agent('two'); return [a, b].join('|');",
      {
        host: stub.host,
        concurrency: 4,
        onControl: c => { control = c; },
      },
    );

    await until(() => stub.started().length === 1, "the first agent to start");
    control?.pause();
    expect(control?.isPaused()).toBe(true);
    stub.finish("wf-agent-0", "first");

    // The second call is held at the gate — it must not reach the host.
    await sleep(60);
    expect(stub.started()).toEqual(["wf-agent-0"]);

    control?.resume();
    await until(() => stub.started().length === 2, "the second agent to start");
    stub.finish("wf-agent-1", "second");

    expect((await done).value).toBe("first|second");
  });

  it("skips a running agent, so its call returns null", async () => {
    const stub = controllableHost();
    let control: WorkflowControl | undefined;
    const done = run("return await agent('one');", {
      host: stub.host,
      onControl: c => { control = c; },
    });

    await until(() => stub.started().length === 1, "the agent to start");
    expect(control?.skip(0)).toBe(true);

    const result = await done;
    expect(stub.aborted()).toEqual(["wf-agent-0"]);
    expect(result.value).toBeNull();
    expect(agentEntries(result.progress).at(-1)).toMatchObject({ state: "error", skipped: true });
  });

  it("skips an agent held at a pause without waiting for the resume", async () => {
    const stub = controllableHost();
    let control: WorkflowControl | undefined;
    const done = run(
      "const a = await agent('one'); const b = await agent('two'); return JSON.stringify([a, b]);",
      { host: stub.host, onControl: c => { control = c; } },
    );

    await until(() => stub.started().length === 1, "the first agent to start");
    control?.pause();
    stub.finish("wf-agent-0", "first");
    await until(() => control?.skip(1) === true, "the second call to reach the gate");

    const result = await done;
    // Never handed to the host at all, and the script saw a null for it.
    expect(stub.started()).toEqual(["wf-agent-0"]);
    expect(result.value).toBe('["first",null]');
  });

  it("retries a running agent into the same call", async () => {
    const stub = controllableHost();
    let control: WorkflowControl | undefined;
    const done = run("return await agent('one');", {
      host: stub.host,
      onControl: c => { control = c; },
    });

    await until(() => stub.started().length === 1, "the first attempt to start");
    expect(control?.retry(0)).toBe(true);

    // Same call, run again — the script is still awaiting it, which is the only
    // reason a retry can deliver anything.
    await until(() => stub.started().length === 2, "the second attempt to start");
    stub.finish("wf-agent-0", "second time lucky");

    const result = await done;
    expect(result.value).toBe("second time lucky");
    expect(agentEntries(result.progress).at(-1)).toMatchObject({
      state: "done",
      attempt: 2,
      lastAttemptReason: "user-retry",
    });
  });

  it("refuses to act on an agent that is not live", async () => {
    const stub = controllableHost();
    let control: WorkflowControl | undefined;
    const done = run("return await agent('one');", {
      host: stub.host,
      onControl: c => { control = c; },
    });

    await until(() => stub.started().length === 1, "the agent to start");
    // Nothing at index 9, and a retry needs a child to stop.
    expect(control?.skip(9)).toBe(false);
    expect(control?.retry(9)).toBe(false);

    stub.finish("wf-agent-0", "done");
    await done;
    // Settled: its value is already the script's, so there is nothing to redo.
    expect(control?.skip(0)).toBe(false);
    expect(control?.retry(0)).toBe(false);
  });

  it("does not leave an agent parked when a paused run is aborted", async () => {
    const stub = controllableHost();
    const abort = new AbortController();
    let control: WorkflowControl | undefined;
    const done = run(
      "const a = await agent('one'); return await agent('two');",
      { host: stub.host, signal: abort.signal, onControl: c => { control = c; } },
    );

    await until(() => stub.started().length === 1, "the first agent to start");
    control?.pause();
    stub.finish("wf-agent-0", "first");
    await sleep(40);

    abort.abort();
    // Resolves at all: a held agent must not outlive the run it belongs to.
    expect((await done).status).toBe("killed");
  });
});

describe("pause and the concurrency limit", () => {
  /** A host whose children hang until the test lets them go. */
  function holdingHost() {
    const started: string[] = [];
    const release = new Map<string, (r: WorkflowSpawnResult) => void>();
    const host: WorkflowHost = {
      spawnAgent(request) {
        started.push(request.agentId);
        return new Promise<WorkflowSpawnResult>(resolve => release.set(request.agentId, resolve));
      },
      abortAgent(agentId) {
        release.get(agentId)?.({ ok: false, skipped: true, error: "Stopped." });
      },
    };
    return { host, started: () => started, finish: (id: string, text: string) => release.get(id)?.({ ok: true, text }) };
  }

  it("holds back an agent that was already queued behind the limit", async () => {
    // The gate is before the semaphore, so an agent waiting for a permit when
    // the pause lands never passed it. Without a second look after the permit
    // arrives, a pause leaks exactly as many agents as happened to be queued.
    const stub = holdingHost();
    let control: WorkflowControl | undefined;
    const done = run(
      "const r = await parallel([() => agent('a'), () => agent('b')]); return JSON.stringify(r);",
      { host: stub.host, concurrency: 1, onControl: c => { control = c; } },
    );

    // One permit, so 'a' runs and 'b' is queued behind it.
    for (let i = 0; i < 40 && stub.started().length < 1; i++) await sleep(5);
    expect(stub.started()).toEqual(["wf-agent-0"]);

    control?.pause();
    stub.finish("wf-agent-0", "first");
    await sleep(80);
    // The freed permit must not start 'b' — the run is paused.
    expect(stub.started()).toEqual(["wf-agent-0"]);

    control?.resume();
    for (let i = 0; i < 40 && stub.started().length < 2; i++) await sleep(5);
    stub.finish("wf-agent-1", "second");
    expect((await done).value).toBe('["first","second"]');
  });
});

/* ------------------------------------------------------------------------- *
 * Scripts written for Claude Code
 * ------------------------------------------------------------------------- */

describe("Claude Code option compatibility", () => {
  it("names opts.schema instead of quietly returning raw text", async () => {
    // Claude Code's canonical example is `agent(p, {schema: FINDINGS})`, which
    // there returns a validated object. Ignoring it hands the script a string,
    // and the script then reads a field off it — so the run dies several lines
    // later with "cannot read properties of undefined", nowhere near the cause.
    const stub = stubHost();
    const result = await run("return await agent('go', { schema: { type: 'object' } });", {
      host: stub.host,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/opts\.schema/);
    // Named *and* answered: a ported script's author needs the workaround, not
    // just the word "unsupported".
    expect(result.error).toMatch(/JSON\.parse/);
    // And it never spent a model call finding out.
    expect(stub.calls).toHaveLength(0);
  });

  it("names a misspelt option rather than ignoring it", async () => {
    const stub = stubHost();
    const result = await run("return await agent('go', { agenttype: 'Explore' });", { host: stub.host });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/agenttype/);
    expect(result.error).toMatch(/agentType/);
  });

  it("accepts every option a Claude Code script actually uses", async () => {
    const stub = stubHost();
    const result = await run(
      "return await agent('go', { label: 'L', phase: 'P', agentType: 'general-purpose', model: 'haiku', effort: 'high', isolation: 'worktree' });",
      { host: stub.host },
    );

    expect(result.status).toBe("completed");
    expect(stub.calls[0]).toMatchObject({ label: "L", agentType: "general-purpose", effort: "high" });
  });

  it("passes each pipeline stage (previous, item, index), as Claude Code does", async () => {
    const result = await run(
      "return JSON.stringify(await pipeline(['a','b'], (p, item, i) => item + i, (p, item, i) => p + '/' + item + i));",
      { host: stubHost().host },
    );

    expect(result.value).toBe('["a0/a0","b1/b1"]');
  });
});
