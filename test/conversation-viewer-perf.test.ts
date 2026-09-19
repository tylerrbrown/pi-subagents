import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type * as PiTui from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentRecord, ViewerMarkdownMode } from "../src/types.js";
import { ConversationViewer, RESULT_MAX_CHARS } from "../src/ui/conversation-viewer.js";

const counts = vi.hoisted(() => ({ constructions: 0, renders: 0, wraps: 0, maxInput: 0, fail: false }));
vi.mock("@earendil-works/pi-tui", async (original) => {
  const actual = await original<typeof PiTui>();
  return {
    ...actual,
    Markdown: class extends actual.Markdown {
      constructor(...args: ConstructorParameters<typeof actual.Markdown>) {
        super(...args);
        counts.constructions++;
        counts.maxInput = Math.max(counts.maxInput, args[0].length);
      }
      render(width: number) {
        counts.renders++;
        if (counts.fail) throw new RangeError("unsafe Markdown");
        return super.render(width);
      }
    },
    wrapTextWithAnsi(text: string, width: number) {
      counts.wraps++;
      counts.maxInput = Math.max(counts.maxInput, text.length);
      return actual.wrapTextWithAnsi(text, width);
    },
  };
});

beforeEach(() => {
  Object.assign(counts, { constructions: 0, renders: 0, wraps: 0, maxInput: 0, fail: false });
});

function mount(messages: unknown[], mode: ViewerMarkdownMode = "assistant") {
  const tui = { terminal: { rows: 30, columns: 80 }, requestRender: vi.fn() } as unknown as TUI;
  const session = { messages, subscribe: () => vi.fn() } as unknown as AgentSession;
  const record = { type: "test", description: "perf", status: "completed", toolUses: 0, startedAt: 0 } as AgentRecord;
  return new ConversationViewer(tui, session, record, undefined,
    { fg: (_color, text) => text, bold: text => text }, vi.fn(), undefined, undefined, undefined, false, () => mode);
}

it.each(["off", "assistant", "all"] as const)("bounds huge result work and never scans the hidden tail (%s)", mode => {
  const text = `visible\n${" ".repeat(2_000_000)}`;
  const viewer = mount([
    { role: "toolResult", content: [{ type: "text", text }] },
    { role: "bashExecution", command: "cat log", output: text },
  ], mode);
  let maxSplit = 0;
  let maxTrim = 0;
  const split = String.prototype.split;
  const trim = String.prototype.trim;
  const splitSpy = vi.spyOn(String.prototype, "split").mockImplementation(function (this: string, separator, limit) {
    maxSplit = Math.max(maxSplit, this.length);
    return split.call(this, separator, limit);
  });
  const trimSpy = vi.spyOn(String.prototype, "trim").mockImplementation(function (this: string) {
    maxTrim = Math.max(maxTrim, this.length);
    return trim.call(this);
  });
  try {
    viewer.render(80);
    viewer.handleInput("k");
    viewer.render(40);
  } finally {
    splitSpy.mockRestore();
    trimSpy.mockRestore();
  }
  expect(counts.maxInput).toBeLessThanOrEqual(RESULT_MAX_CHARS);
  expect(maxSplit).toBeLessThanOrEqual(RESULT_MAX_CHARS);
  expect(maxTrim).toBeLessThanOrEqual(RESULT_MAX_CHARS);
  expect(counts.constructions).toBe(mode === "all" ? 1 : 0);
});

it.each([
  ["spaces", "> "],
  ["horizontal tabs", ">\t"],
])("preflights pathological nested blockquotes separated with %s before calling the Markdown renderer", (_label, marker) => {
  const nested = `${marker.repeat(60)}payload`;
  const viewer = mount([{ role: "assistant", content: [{ type: "text", text: nested }] }]);
  const started = performance.now();
  const output = viewer.render(80).join("\n");
  expect(performance.now() - started).toBeLessThan(500);
  expect(counts.renders).toBe(0);
  expect(output).toContain("payload");
});

it("never retries a known-bad prefix on scrolling, resize, mode cycling or append", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "> broken" }] };
  const viewer = mount([message]);
  counts.fail = true;
  viewer.render(80);
  for (let i = 0; i < 10; i++) {
    message.content[0].text += "\nmore";
    viewer.handleInput("k");
    viewer.handleInput("m");
    viewer.render(40 + i);
  }
  expect(counts.renders).toBe(1);
  expect(counts.constructions).toBe(1);
  message.content[0].text = "# replacement";
  counts.fail = false;
  viewer.handleInput("m"); // all -> off
  viewer.handleInput("m"); // off -> assistant
  expect(viewer.render(80).join("\n")).toContain("replacement");
  expect(counts.renders).toBe(2);
});

it.each(["off", "assistant"] as const)("render leaf calls remain linear in message count (%s)", mode => {
  const work = (n: number) => {
    const messages = Array.from({ length: n }, () => ({ role: "assistant", content: [{ type: "text", text: "# heading" }] }));
    const viewer = mount(messages, mode);
    viewer.render(80);
    const first = counts.constructions;
    counts.renders = 0;
    counts.wraps = 0;
    viewer.render(80);
    expect(counts.constructions).toBe(first);
    return counts.renders + counts.wraps;
  };
  const small = work(10);
  const large = work(100);
  expect(small).toBeGreaterThan(0);
  expect(large).toBeLessThanOrEqual(small * 10);
});

it.each(["assistant", "toolResult"])("retries Markdown after shortening a failed %s prefix", role => {
  const message = { role, content: [{ type: "text", text: "# safe\n> unsafe suffix" }] };
  const viewer = mount([message], "all");
  counts.fail = true;
  viewer.render(80);
  expect(counts.renders).toBe(1);
  counts.fail = false;
  viewer.render(40);
  expect(counts.renders).toBe(1);
  message.content[0].text = "# safe";
  const output = viewer.render(80).join("\n");
  expect(output).toContain("safe");
  expect(output).not.toContain("# safe");
  expect(counts.renders).toBe(2);
  expect(counts.constructions).toBe(1);
});

it("bounds multipart block traversal once the visible result cap is full", () => {
  let reads = 0;
  const content = new Proxy(Array.from({ length: RESULT_MAX_CHARS * 4 }, () => ({ type: "text", text: "x" })), {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const viewer = mount([{ role: "toolResult", content }]);
  const output = viewer.render(80).join("\n");
  expect(reads).toBeLessThanOrEqual(RESULT_MAX_CHARS + 1);
  expect(output).toContain("truncated, at least 1 more character");
});

it.each(["off", "assistant", "all"] as const)("caps multipart results before joining and counts separators (%s)", mode => {
  const prefix = "x".repeat(RESULT_MAX_CHARS - 1);
  const tail = "z".repeat(2_000_000);
  const message = { role: "toolResult", content: [
    { type: "text", text: prefix },
    { type: "image", data: "ignored" },
    { type: "text", text: tail },
  ] };
  const viewer = mount([message], mode);
  const join = Array.prototype.join;
  let joinedHiddenTail = false;
  const spy = vi.spyOn(Array.prototype, "join").mockImplementation(function (this: unknown[], separator) {
    if (this.includes(tail)) joinedHiddenTail = true;
    return join.call(this, separator);
  });
  try {
    viewer.render(80);
    viewer.handleInput("k");
    viewer.render(40);
  } finally {
    spy.mockRestore();
  }
  expect(joinedHiddenTail).toBe(false);
  expect(counts.maxInput).toBeLessThanOrEqual(RESULT_MAX_CHARS);
  // The boundary newline uses the final visible code unit. Both the astral
  // character and the trailing blank are hidden, even though rendering trims.
  message.content[2].text = "😀 ";
  viewer.handleInput("[F");
  expect(viewer.render(80).join("\n")).toContain("truncated, 3 more characters");
});

it("bounds inspection of a result made of invisible blocks", () => {
  let reads = 0;
  const content = new Proxy(Array.from({ length: 640_000 }, () => ({ type: "image", data: "ignored" })), {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const output = mount([{ role: "toolResult", content }]).render(80).join("\\n");
  expect(reads).toBeLessThanOrEqual(20_000);
  expect(output).toContain("truncated, additional result blocks not inspected");
});

it.each(["", " ", "  ", "   "])("preflights nested blockquotes on a later line with %j indentation", indent => {
  const text = `intro\n\n${indent}${"> ".repeat(60)}payload`;
  // Tripwire prevents a synchronous parser stall if preflight regresses.
  counts.fail = true;
  const viewer = mount([{ role: "assistant", content: [{ type: "text", text }] }]);
  expect(viewer.render(80).join("\n")).toContain("payload");
  expect(counts.renders).toBe(0);
});

it.each([
  ["spaces", "> > **ordinary quote**"],
  ["horizontal tabs", ">\t>\t**ordinary quote**"],
])("still renders ordinary nested blockquotes separated with %s as Markdown", (_label, text) => {
  const viewer = mount([{ role: "assistant", content: [{ type: "text", text }] }]);
  const output = viewer.render(80).join("\n");
  expect(counts.renders).toBe(1);
  expect(output).toContain("ordinary quote");
  expect(output).not.toContain("**ordinary quote**");
});

it("uses floor-safe lower-bound truncation counts", () => {
  const content = [
    { type: "text", text: "x".repeat(RESULT_MAX_CHARS - 1) },
    { type: "text", text: "y".repeat(1999) },
    { type: "text", text: "z" },
  ];
  const output = mount([{ role: "toolResult", content }], "all").render(80).join("\n");
  expect(output).toContain("truncated, at least 1.9k more characters");
  expect(output).not.toContain("at least 2k");
});

it.each(["text", "image"])("does not read hidden payloads after a full prefix (boundary %s)", type => {
  const boundary = { type, get text(): string { throw new Error("hidden payload read"); } };
  const content = [
    { type: "text", text: "x".repeat(RESULT_MAX_CHARS) },
    boundary,
  ];
  Object.defineProperty(content, 2, { get() { throw new Error("hidden block traversed"); } });
  const output = mount([{ role: "toolResult", content }], "all").render(80).join("\n");
  expect(output).toContain(type === "text"
    ? "truncated, at least 1 more character"
    : "truncated, additional result blocks not inspected");
});
