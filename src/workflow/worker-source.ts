/**
 * worker-source.ts — the JavaScript that runs inside the workflow worker thread.
 *
 * The host spawns this with `new Worker(WORKER_SOURCE, { eval: true })`, so the
 * source has to be an inlined string: `AGENTS.md` forbids dynamic `import()`,
 * and a file path would have to survive bundling. Keeping it as a template
 * literal costs editor tooling but nothing else — the worker is plain CommonJS
 * JavaScript and never sees the TypeScript pipeline.
 *
 * Two boundaries stack here, and they are not the same boundary:
 *
 *   host thread  ←postMessage→  worker thread  ←vm context→  workflow script
 *
 * The worker/host split exists for *killability*: `worker.terminate()` stops a
 * runaway script mid-loop, which an in-process `vm` timeout cannot do once the
 * script is inside an `await`. The vm context exists for *determinism and
 * accident-avoidance*, not security — see the note on `codeGeneration` below.
 *
 * ## Why the context gets no host built-ins
 *
 * `vm.createContext(sandbox)` gives the script a fresh realm that already owns
 * `Object`, `Array`, `JSON`, `Math`, `Date`, `Promise`, `Map`, `Set`. We inject
 * *only* our own globals on top. Injecting host built-ins instead would hand the
 * script `Object.constructor` → the **host** `Function`, i.e. a compiler for
 * arbitrary host-realm code.
 *
 * That said: our injected globals are themselves host closures, so
 * `agent.constructor` is still the host `Function`. The hygiene shrinks the
 * surface; it does not close the hole. **`codeGeneration: { strings: false }` is
 * the load-bearing defense** — it makes `Function("…")` and `eval("…")` throw
 * `EvalError`, so a captured host `Function` cannot compile anything. Treat this
 * as a determinism boundary, not a security boundary against a hostile script.
 *
 * ## Why determinism is a prelude and not a stub
 *
 * Because `Date` and `Math` come *from the realm*, they cannot be neutered by
 * injection — there is nothing to inject over. So the compiled source is
 * prefixed with a prelude that runs inside the realm and reassigns `Date.now`
 * and `Math.random` in place, then lexically shadows `Date` with a subclass
 * whose zero-argument constructor throws. Lexical shadowing rather than a global
 * assignment because a `const` in the IIFE scope cannot be reached around.
 *
 * Determinism is enforced because a workflow's journal is replayed by prefix on
 * resume: a script that reads the clock produces a different prefix on the
 * second run and the replay silently diverges.
 */

/**
 * Runs inside the realm, ahead of the script body, on a single line.
 *
 * One line matters: the body is compiled at `\n` + line 1, and the host passes
 * `lineOffset: -1` so reported line numbers match the file the author wrote. Any
 * newline in here shifts every stack frame in every workflow script.
 */
const DETERMINISM_PRELUDE =
  "const Date = (function () {" +
  " const RealDate = globalThis.Date;" +
  " const die = function (what) {" +
  " throw new Error(what + \" is unavailable in workflow scripts (breaks resume)." +
  " Stamp results after the workflow returns, or pass timestamps via `args`.\");" +
  " };" +
  " RealDate.now = function () { return die(\"Date.now()\"); };" +
  " Math.random = function () { return die(\"Math.random()\"); };" +
  " return class WorkflowDate extends RealDate {" +
  " constructor() { if (arguments.length === 0) die(\"new Date()\"); super(...arguments); }" +
  " };" +
  "})();";

export const WORKER_SOURCE = `"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const port = parentPort;
const ITEM_CAP = workerData.itemCap;
const PRELUDE = ${JSON.stringify(DETERMINISM_PRELUDE)};

/* ------------------------------------------------------------------ *
 * RPC to the host
 *
 * The script never touches the agent manager. Every effect leaves as a
 * "call" message and comes back as a "response", so the host owns the
 * semaphore, the caps, and the abort story.
 * ------------------------------------------------------------------ */

let nextCallId = 1;
const pendingCalls = new Map();

function callHost(method, payload) {
  // Drain first, so the phase() that named this agent reaches the host ahead of
  // the agent entry rather than a tick behind it.
  flushProgress();
  return new Promise(function (resolve, reject) {
    const callId = nextCallId++;
    pendingCalls.set(callId, { resolve: resolve, reject: reject });
    port.postMessage({ type: "call", callId: callId, method: method, payload: payload });
  });
}

port.on("message", function (message) {
  if (!message || message.type !== "response") return;
  const waiter = pendingCalls.get(message.callId);
  if (!waiter) return;
  pendingCalls.delete(message.callId);
  if (message.ok) {
    waiter.resolve(message.value);
    return;
  }
  const error = new Error(message.error || "The workflow host rejected the call.");
  // Fatal errors are the run's, not the item's: parallel() and pipeline()
  // swallow ordinary failures into null, and a cap breach must not be
  // silently absorbed that way.
  if (message.fatal) error.workflowFatal = true;
  waiter.reject(error);
});

function isFatal(error) {
  return !!(error && typeof error === "object" && error.workflowFatal === true);
}

/* ------------------------------------------------------------------ *
 * Progress entries
 * ------------------------------------------------------------------ */

let progressQueue = [];
let flushTimer = null;

function emit(entry) {
  progressQueue.push(entry);
  // Batched on a macrotask: a fan-out emits a burst of phase/log entries in one
  // turn, and the host renders once per batch rather than once per entry.
  if (flushTimer === null) flushTimer = setTimeout(flushProgress, 0);
}

function flushProgress() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (progressQueue.length === 0) return;
  const batch = progressQueue;
  progressQueue = [];
  port.postMessage({ type: "progress", entries: batch });
}

/* ------------------------------------------------------------------ *
 * The JSON boundary
 *
 * Checked here rather than relying on structured clone, which happily
 * carries cycles, BigInt and Maps that the progress log and the resume
 * journal cannot represent. Rejecting loudly beats writing a journal
 * that will not replay.
 * ------------------------------------------------------------------ */

let realmObjectPrototype = null;

function boundaryError(what, path) {
  return new Error(
    "Cannot pass " + what + " across the workflow VM boundary (at " + path + ")."
  );
}

function assertBoundary(value, path, seen) {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw boundaryError("a non-finite number", path);
    return;
  }
  if (kind === "undefined") {
    if (path === "the workflow result") return;
    throw boundaryError("undefined", path);
  }
  if (kind === "bigint") throw boundaryError("a BigInt", path);
  if (kind === "symbol") throw boundaryError("a symbol", path);
  if (kind === "function") throw boundaryError("a function", path);
  if (kind !== "object") throw boundaryError("a " + kind, path);

  if (seen.has(value)) throw boundaryError("a circular structure", path);
  seen.add(value);

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw boundaryError("an object with symbol keys", path);
  }

  if (Array.isArray(value)) {
    const length = value.length;
    for (let i = 0; i < length; i++) {
      // A sparse array round-trips through JSON as nulls, which silently
      // changes the data. Reject instead.
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw boundaryError("a sparse array", path + "[" + i + "]");
      }
      assertBoundary(value[i], path + "[" + i + "]", seen);
    }
    seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  // Two prototypes are legitimate: the realm's own Object.prototype (anything
  // the script built) and the worker's (arrays we hand back from parallel).
  // Everything else — Map, Set, Date, a class instance — loses meaning here.
  if (prototype !== null && prototype !== realmObjectPrototype && prototype !== Object.prototype) {
    throw boundaryError("a non-plain object", path);
  }

  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    assertBoundary(value[keys[i]], path + "." + keys[i], seen);
  }
  seen.delete(value);
}

function checkBoundary(value, path) {
  assertBoundary(value, path, new Set());
  return value;
}

/* ------------------------------------------------------------------ *
 * Realm helpers
 *
 * parallel() and pipeline() build their result arrays in worker code, but
 * the script should get an array its own realm recognises — otherwise
 * \`result instanceof Array\` is false and \`Array.isArray\` is the only thing
 * that works. Item values are moved across untouched.
 * ------------------------------------------------------------------ */

let realmNewArray = null;
let realmPush = null;

function toRealmArray(items) {
  const array = realmNewArray();
  for (let i = 0; i < items.length; i++) realmPush(array, items[i]);
  return array;
}

function toList(value, what) {
  if (!Array.isArray(value)) throw new Error(what + " expects an array.");
  const length = value.length >>> 0;
  if (length > ITEM_CAP) {
    throw new Error(
      what + " was given " + length + " items, over the limit of " + ITEM_CAP + "."
    );
  }
  const out = [];
  for (let i = 0; i < length; i++) out.push(value[i]);
  return out;
}

function requireText(value, what) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(what + " requires a non-empty string.");
  }
  return value;
}

function optionalText(value, what) {
  if (value === undefined || value === null) return undefined;
  return requireText(value, what);
}

/**
 * Reasoning effort a child may be spawned under — pi's \`ThinkingLevel\`.
 *
 * A superset of Claude Code's five, so a script written there runs here; the
 * extra \`minimal\` is pi's own. Validated in the worker rather than the host
 * because a typo should stop the script at the call that made it, not surface
 * later as an agent that quietly ran at the wrong depth.
 */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Every option \`agent()\` understands.
 *
 * Checked rather than ignored, because the alternative is the worst failure a
 * ported script can have. Claude Code's \`agent()\` also takes \`schema\`, and its
 * own canonical example uses it; quietly dropping it hands the script the
 * agent's raw text where it expected a validated object, and the run then dies
 * several lines later reading a field off a string. A typo behaves the same
 * way. Naming the option costs one error message and no model calls.
 */
const AGENT_OPTIONS = [
  "label",
  "phase",
  "model",
  "agentType",
  "isolation",
  "gate",
  "resume",
  "effort",
];

/** Claude Code options this runtime does not have, and why. */
const UNSUPPORTED_AGENT_OPTIONS = {
  schema: "there is no structured-output mode here, so the call would return the agent's raw text. "
    + "Ask for JSON in the prompt and JSON.parse what comes back.",
};

/* ------------------------------------------------------------------ *
 * Script globals
 * ------------------------------------------------------------------ */

let ambientPhaseIndex;
let ambientPhaseTitle;
let nextPhaseIndex = 0;
const phaseIndexByTitle = new Map();

function definePhase(title) {
  let index = phaseIndexByTitle.get(title);
  if (index !== undefined) return index;
  index = nextPhaseIndex++;
  phaseIndexByTitle.set(title, index);
  emit({ type: "workflow_phase", index: index, title: title });
  return index;
}

function phase(title) {
  const text = requireText(title, "phase(title)");
  ambientPhaseIndex = definePhase(text);
  ambientPhaseTitle = text;
}

function describe(value) {
  if (typeof value === "string") return value;
  // Duck-typed, not \`instanceof Error\`: an error thrown by the script belongs
  // to the vm realm, so it fails an instanceof check against the worker's.
  if (value && typeof value === "object" && typeof value.message === "string" && typeof value.stack === "string") {
    return value.message;
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    /* cycles and BigInt fall through to String() */
  }
  return String(value);
}

function log(message) {
  emit({ type: "workflow_log", message: describe(message) });
}

function makeConsole() {
  const write = function () {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) parts.push(describe(arguments[i]));
    emit({ type: "workflow_log", message: parts.join(" ") });
  };
  return { log: write, info: write, warn: write, error: write, debug: write };
}

async function agent(prompt, opts) {
  const text = requireText(prompt, "agent(prompt)");
  const options = opts === undefined || opts === null ? {} : opts;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error("agent(prompt, opts) expects opts to be an object.");
  }

  for (const key of Object.keys(options)) {
    if (AGENT_OPTIONS.indexOf(key) !== -1) continue;
    const why = UNSUPPORTED_AGENT_OPTIONS[key];
    throw new Error(
      why !== undefined
        ? "agent() opts." + key + " is not supported here: " + why
        : "agent() opts." + key + " is not a recognised option. Supported: " + AGENT_OPTIONS.join(", ") + "."
    );
  }

  const label = optionalText(options.label, "agent() opts.label");
  const phaseName = optionalText(options.phase, "agent() opts.phase");
  const model = optionalText(options.model, "agent() opts.model");
  const agentType = optionalText(options.agentType, "agent() opts.agentType");
  const isolation = optionalText(options.isolation, "agent() opts.isolation");
  if (isolation !== undefined && isolation !== "worktree") {
    throw new Error("agent() opts.isolation must be \\"worktree\\".");
  }
  const gate = optionalText(options.gate, "agent() opts.gate");
  const resume = optionalText(options.resume, "agent() opts.resume");
  const effort = optionalText(options.effort, "agent() opts.effort");
  if (effort !== undefined && EFFORT_LEVELS.indexOf(effort) === -1) {
    throw new Error("agent() opts.effort must be one of: " + EFFORT_LEVELS.join(", ") + ".");
  }

  // resume revives a child that already exists, so anything describing how to
  // *start* one is not a thing this call gets to decide — the revived child
  // keeps the agent, model and tool contract it was started with. Rejecting is
  // the point: silently ignoring these opts would look like they applied.
  if (resume !== undefined) {
    if (agentType !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.agentType are mutually exclusive: a resumed agent keeps the agent type it was started with."
      );
    }
    if (model !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.model are mutually exclusive: a resumed agent keeps the model it was started with."
      );
    }
    if (isolation !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.isolation are mutually exclusive: a resumed agent keeps the working tree it was started in."
      );
    }
    if (effort !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.effort are mutually exclusive: a resumed agent keeps the reasoning effort it was started with."
      );
    }
    if (gate !== undefined) {
      throw new Error("agent() opts.gate cannot be combined with opts.resume.");
    }
  }

  // An explicit opts.phase files this agent under that phase without moving
  // the ambient one, so a stray verify step does not re-point the phases that
  // follow it.
  const phaseIndex = phaseName !== undefined ? definePhase(phaseName) : ambientPhaseIndex;
  const phaseTitle = phaseName !== undefined ? phaseName : ambientPhaseTitle;

  const result = await callHost("agent", {
    prompt: text,
    label: label,
    model: model,
    agentType: agentType,
    isolation: isolation,
    phaseIndex: phaseIndex,
    phaseTitle: phaseTitle,
    gate: gate,
    resume: resume,
    effort: effort,
  });
  return result === undefined ? null : result;
}

/**
 * A barrier: every thunk starts now, and nothing past the await runs until all
 * of them have settled. A thunk that throws resolves to null rather than
 * failing its siblings — the script filters, it does not try/catch.
 */
async function parallel(thunks) {
  const list = toList(thunks, "parallel(thunks)");
  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== "function") {
      throw new Error("parallel(thunks) expects an array of functions; item " + i + " is not one.");
    }
  }
  const settled = await Promise.all(
    list.map(async function (thunk) {
      try {
        return await thunk();
      } catch (error) {
        if (isFatal(error)) throw error;
        return null;
      }
    })
  );
  return toRealmArray(settled);
}

/**
 * No barrier between stages. Each item walks its own chain, so item A can be
 * in stage 3 while item B is still in stage 1 — which is the whole point:
 * a barrier makes every stage wait on its slowest sibling, and with agents in
 * the stages that latency is measured in minutes.
 *
 * A stage that throws drops that item to null and skips its remaining stages.
 * Every stage sees (previousResult, originalItem, index).
 */
async function pipeline(items, ...stages) {
  const list = toList(items, "pipeline(items, ...stages)");
  for (let i = 0; i < stages.length; i++) {
    if (typeof stages[i] !== "function") {
      throw new Error("pipeline(items, ...stages) expects stages to be functions; stage " + i + " is not one.");
    }
  }
  const settled = await Promise.all(
    list.map(async function (item, index) {
      let value = item;
      for (let s = 0; s < stages.length; s++) {
        try {
          value = await stages[s](value, item, index);
        } catch (error) {
          if (isFatal(error)) throw error;
          return null;
        }
      }
      return value;
    })
  );
  return toRealmArray(settled);
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

async function main() {
  const sandbox = {
    agent: agent,
    parallel: parallel,
    pipeline: pipeline,
    phase: phase,
    log: log,
    console: makeConsole(),
  };
  const context = vm.createContext(sandbox, {
    name: "workflow",
    codeGeneration: { strings: false, wasm: false },
  });

  realmObjectPrototype = vm.runInContext("Object.prototype", context);
  realmNewArray = vm.runInContext("(function () { return []; })", context);
  realmPush = vm.runInContext("(function (array, value) { array.push(value); })", context);
  const realmParse = vm.runInContext("JSON.parse", context);

  // meta and args are materialised *inside* the realm rather than injected, so
  // the script sees objects whose prototype is its own Object.prototype and
  // whose .constructor is its own Function.
  sandbox.meta = realmParse(workerData.metaJson);
  sandbox.args = workerData.argsJson === undefined ? undefined : realmParse(workerData.argsJson);

  const script = new vm.Script("(async () => {" + PRELUDE + "\\n" + workerData.body + "\\n})()", {
    filename: "workflow.js",
    // The wrapper adds exactly one line above the body; undo it so a thrown
    // error points at the line the author wrote.
    lineOffset: -1,
  });

  const value = await script.runInContext(context);
  checkBoundary(value, "the workflow result");
  flushProgress();
  port.postMessage({
    type: "complete",
    resultJson: value === undefined ? undefined : JSON.stringify(value),
  });
}

main().catch(function (error) {
  flushProgress();
  port.postMessage({
    type: "error",
    message: error && error.message ? String(error.message) : String(error),
    stack: error && error.stack ? String(error.stack) : undefined,
  });
});
`;
