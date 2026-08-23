import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig, resolveJoinMode, validateCapabilityAdditions } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "Test agent",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers agent config over tool-call params for locked fields", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
        maxTurns: 42,
        inheritContext: false,
        runInBackground: false,
        isolated: false,
        isolation: "worktree",
      }),
      {
        model: "provider/param-model",
        thinking: "minimal",
        max_turns: 1,
        inherit_context: true,
        run_in_background: true,
        isolated: true,
        isolation: "worktree",
      },
    );

    expect(resolved.modelInput).toBe("provider/config-model");
    expect(resolved.modelFromParams).toBe(false);
    expect(resolved.thinking).toBe("high");
    expect(resolved.maxTurns).toBe(42);
    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(false);
    expect(resolved.isolated).toBe(false);
    expect(resolved.isolation).toBe("worktree");
  });

  it("keeps per-run capability additions separate from the agent definition", () => {
    const config = makeConfig({ skills: ["base-skill"], extensions: ["base-ext"] });
    const resolved = resolveAgentInvocationConfig(config, {
      tools: ["bash"],
      skills: ["run-skill"],
      extensions: ["run-ext"],
    });

    expect(resolved.tools).toEqual(["bash"]);
    expect(resolved.skills).toEqual(["run-skill"]);
    expect(resolved.extensions).toEqual(["run-ext"]);
    expect(config).toEqual(makeConfig({ skills: ["base-skill"], extensions: ["base-ext"] }));
  });

  it("normalizes known per-run tools and rejects raw extension tool names", () => {
    expect(validateCapabilityAdditions({ tools: ["Read", "Glob", "ext:chrome/find"] })).toEqual({
      tools: ["read", "find", "ext:chrome/find"],
      skills: undefined,
      extensions: undefined,
    });
    expect(() => validateCapabilityAdditions({ tools: ["chrome_find"] })).toThrow(/Unknown per-run tool/);
  });

  it("rejects per-run extension paths while allowing extension identifiers", () => {
    expect(validateCapabilityAdditions({ extensions: ["chrome-profile-bridge", "recall-inject"] }).extensions)
      .toEqual(["chrome-profile-bridge", "recall-inject"]);
    for (const path of ["./local.ts", "C:/local.ts", "/tmp/local.ts", "~/.pi/local.ts", "dir/local.ts", "dir\\local.ts", "https://host/ext.ts", "@scope/extension"]) {
      expect(() => validateCapabilityAdditions({ extensions: [path] })).toThrow(/identifier, not a path/);
    }
  });

  it("uses tool-call params when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model",
      thinking: "minimal",
      max_turns: 3,
      inherit_context: true,
      run_in_background: true,
      isolated: true,
      isolation: "worktree",
    });

    expect(resolved.modelInput).toBe("provider/param-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.thinking).toBe("minimal");
    expect(resolved.maxTurns).toBe(3);
    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
    expect(resolved.isolated).toBe(true);
    expect(resolved.isolation).toBe("worktree");
  });

  it("lets parent fill in booleans when config leaves them undefined", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
        isolated: undefined,
      }),
      {
        inherit_context: true,
        run_in_background: true,
        isolated: true,
      },
    );

    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
    expect(resolved.isolated).toBe(true);
  });

  it("defaults booleans to false when neither config nor params set them", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
        isolated: undefined,
      }),
      {},
    );

    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(false);
    expect(resolved.isolated).toBe(false);
  });

  // "off" exists so a model that cannot bring itself to omit an optional field
  // has a legal way to say no (#231). It is an input spelling only — the
  // resolver collapses it to undefined so no consumer downstream grows a branch.
  it('collapses a param isolation of "off" to undefined', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: undefined }), { isolation: "off" });
    expect(resolved.isolation).toBeUndefined();
  });

  // Agent config outranks tool-call params, so "off" in frontmatter is the only
  // way to veto a caller's worktree — before #231 no value could do this.
  it('lets a config isolation of "off" veto a param "worktree"', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "off" }), { isolation: "worktree" });
    expect(resolved.isolation).toBeUndefined();
  });

  it('still honours a param "worktree" when the config leaves isolation unset', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: undefined }), { isolation: "worktree" });
    expect(resolved.isolation).toBe("worktree");
  });

  it("drops worktree isolation when the project disallows it", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "worktree" }), { isolation: "worktree" }, { worktreeAllowed: false });
    expect(resolved.isolation).toBeUndefined();
  });

  it("keeps worktree isolation when the project allows it", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "worktree" }), {}, { worktreeAllowed: true });
    expect(resolved.isolation).toBe("worktree");
  });
});

describe("resolveJoinMode", () => {
  it("returns the global default for background agents", () => {
    expect(resolveJoinMode("smart", true)).toBe("smart");
    expect(resolveJoinMode("async", true)).toBe("async");
  });

  it("ignores join mode for foreground agents", () => {
    expect(resolveJoinMode("smart", false)).toBeUndefined();
    expect(resolveJoinMode("group", false)).toBeUndefined();
  });
});
