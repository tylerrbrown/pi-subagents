import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const boundary = vi.hoisted(() => ({ hidden: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, existsSync: (path: any) => boundary.hidden && /[\\/]\.git$/.test(String(path)) ? false : fs.existsSync(path) };
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCustomAgents } from "../src/custom-agents.js";
import { loadSettings, saveSettings } from "../src/settings.js";
import { buildAgentRegistry, resolveSpawnTypeIn, setFallbackSubagent } from "../src/agent-types.js";

// This suite calls real loaders and the dispatch decision point. No runner,
// session, network client, or subprocess is constructed.
let base: string;
let root: string;
let leaf: string;
function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function agent(dir: string, filename = "cartographer", description = "root") {
  put(join(dir, ".claude/agents", `${filename}.md`),
    `---\nname: cartographer\ndescription: ${description}\ntools: read, grep, bash\n---\nMap.\n`);
}
function settings(dir: string, value: object) {
  put(join(dir, ".pi/subagents.json"), JSON.stringify(value));
}
// All fixture writes stay under the invoking test workspace, including on Windows.
beforeEach(() => {
  base = mkdtempSync(join(import.meta.dirname, "inheritance-fixture-"));
  root = join(base, "repo");
  leaf = join(root, "automations/AWS");
  mkdirSync(leaf, { recursive: true });
  mkdirSync(join(root, ".git"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(base, "global"));
  put(join(base, "global/subagents.json"), JSON.stringify({ maxConcurrent: 2, fallbackSubagent: "general-purpose" }));
  agent(root);
  settings(root, { fallbackSubagent: "none", graceTurns: 7 });
});
afterEach(() => {
  boundary.hidden = false;
  setFallbackSubagent(undefined);
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

describe("bounded project inheritance", () => {
  it("discovers root specialists from nested cwd", () => {
    expect(loadCustomAgents(leaf).get("cartographer")?.builtinToolNames).toEqual(["read", "grep", "bash"]);
  });
  it("inherits strict dispatch policy and refuses unknown types", () => {
    const loaded = loadSettings(leaf);
    expect(loaded).toEqual({ maxConcurrent: 2, fallbackSubagent: "none", graceTurns: 7 });
    setFallbackSubagent(loaded.fallbackSubagent);
    const registry = buildAgentRegistry(loadCustomAgents(leaf));
    expect(resolveSpawnTypeIn(registry, "cartographer")).toEqual({ ok: true, type: "cartographer" });
    expect(resolveSpawnTypeIn(registry, "missing").ok).toBe(false);
  });
  it("preserves root behavior and global defaults", () => {
    expect(loadCustomAgents(root).size).toBe(1);
    expect(loadSettings(root)).toEqual({ maxConcurrent: 2, fallbackSubagent: "none", graceTurns: 7 });
  });
  it("merges root to leaf with nearer values and declared type names winning", () => {
    const middle = dirname(leaf);
    agent(middle, "different-filename", "middle");
    settings(middle, { maxConcurrent: 4 });
    agent(leaf, "leaf-name", "leaf");
    settings(leaf, { graceTurns: 3 });
    expect(loadCustomAgents(leaf).get("cartographer")?.description).toBe("leaf");
    expect(loadCustomAgents(middle).get("cartographer")?.description).toBe("middle");
    expect(loadSettings(leaf)).toEqual({ maxConcurrent: 4, fallbackSubagent: "none", graceTurns: 3 });
  });
  it("recognizes a .git file without reading its target or crossing its boundary", () => {
    rmSync(join(root, ".git"), { recursive: true });
    put(join(root, ".git"), "gitdir: /not-followed\n");
    agent(base, "outside", "outside");
    settings(base, { runDeadlineMs: 99 });
    expect(loadCustomAgents(leaf).get("cartographer")?.description).toBe("root");
    expect(loadSettings(leaf).runDeadlineMs).toBeUndefined();
    expect(loadSettings(leaf).fallbackSubagent).toBe("none");
  });
  it("does not cross a nested Git repository", () => {
    mkdirSync(join(dirname(leaf), ".git"));
    expect(loadCustomAgents(leaf).size).toBe(0);
    expect(loadSettings(leaf)).toEqual({ maxConcurrent: 2, fallbackSubagent: "general-purpose" });
  });
  it("keeps non-Git cwd current-only", () => {
    rmSync(join(root, ".git"), { recursive: true });
    // Hide the enclosing staging repository's marker without touching it.
    boundary.hidden = true;
    expect(loadCustomAgents(leaf).size).toBe(0);
    expect(loadSettings(leaf)).toEqual({ maxConcurrent: 2, fallbackSubagent: "general-purpose" });
    boundary.hidden = false;
  });
  it("saves only at cwd, never into inherited root settings", () => {
    const before = readFileSync(join(root, ".pi/subagents.json"), "utf8");
    expect(saveSettings({ graceTurns: 1 }, leaf)).toBe(true);
    expect(readFileSync(join(root, ".pi/subagents.json"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(leaf, ".pi/subagents.json"), "utf8"))).toEqual({ graceTurns: 1 });
  });
});
