/**
 * overload-policy.test.ts — b5: a provider-overload stall is typed, bounded,
 * and never rerouted.
 *
 * On 08/24 the reviewer and security specialists ended in `overloaded_error`
 * while the Lead held a blocking join; the run had no wall-clock bound and the
 * failure reached the parent as an undifferentiated error string. Policy:
 *
 *  - classify overload distinctly from an ordinary run failure, so the parent
 *    can tell "the provider is busy, retry later" from "this agent is broken";
 *  - do NOT fall back to another provider. Per user-preferences.md § MIN AI
 *    provider default, no automatic AWS/Bedrock reroute while Tyler has
 *    Anthropic/OpenAI/Grok credits — the reroute is his call, not the fork's.
 *  - the wall-clock deadline (b1) and the wait ceiling (b2) are what bound the
 *    stall itself; this is the naming, not the bounding.
 */

import { describe, expect, it } from "vitest";
import { classifyRunFailure, getFailureNote } from "../src/status-note.js";

describe("classifyRunFailure", () => {
  it("names the provider-overload family", () => {
    for (const msg of [
      "overloaded_error",
      "Error: Overloaded",
      "429 Too Many Requests",
      "rate limit exceeded for model",
      "503 Service Unavailable",
      "upstream server is overloaded, please retry",
    ]) {
      expect(classifyRunFailure(msg), msg).toBe("overload");
    }
  });

  it("leaves an ordinary failure alone", () => {
    for (const msg of [
      "run hit the output token limit before producing any text",
      "provider error with no output",
      "ENOENT: no such file or directory",
      "invalid api key",
    ]) {
      expect(classifyRunFailure(msg), msg).toBe("other");
    }
  });

  it("treats a missing message as ordinary", () => {
    expect(classifyRunFailure(undefined)).toBe("other");
    expect(classifyRunFailure("")).toBe("other");
  });
});

describe("getFailureNote", () => {
  it("tells the parent an overload is transient and was not rerouted", () => {
    const note = getFailureNote("overload");
    expect(note).toMatch(/overload/i);
    expect(note).toMatch(/not rerouted|no fallback/i);
  });

  it("adds nothing for an ordinary failure", () => {
    expect(getFailureNote("other")).toBe("");
    expect(getFailureNote(undefined)).toBe("");
  });
});

describe("no automatic provider fallback", () => {
  it("keeps the fork free of a Bedrock reroute path", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["../src/agent-runner.ts", "../src/agent-manager.ts", "../src/status-note.ts", "../src/model-resolver.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf-8");
      expect(src, file).not.toMatch(/amazon-bedrock|us\.anthropic\./);
    }
  });
});
