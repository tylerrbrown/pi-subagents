/**
 * alias-warning-startup.test.ts — an alias naming a built-in default agent must
 * not warn at activation when `disableDefaultAgents` is set.
 *
 * The initial agent load runs hundreds of lines before settings are applied, so
 * it used to build the registry WITH defaults and warn that aliases such as
 * `Explore` collided with a built-in that the settings then disabled moments
 * later. Dispatch was already correct; only the warning was false.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents, resolveEnabledType, setDefaultsDisabled } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  return {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
}

const EXPLORER = "---\nname: explorer\ndescription: Research things; read-only.\naliases: [Explore, general-purpose]\n---\n\nBody.\n";

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function write(rel: string, text: string): void {
  const path = join(cwd, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function aliasWarnings(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes("Alias \""));
}

describe("alias conflict warnings respect disableDefaultAgents at startup", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "alias-warning-startup-"));
    process.chdir(cwd);
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write(".claude/agents/explorer.md", EXPLORER);
  });

  afterEach(() => {
    warn.mockRestore();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    setDefaultsDisabled(false);
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  it("does not warn about built-in names when defaults are disabled, and the alias resolves", () => {
    write(".pi/subagents.json", JSON.stringify({ disableDefaultAgents: true }));

    subagentsExtension(makePi());

    expect(aliasWarnings(warn)).toEqual([]);
    expect(resolveEnabledType("Explore")).toBe("explorer");
    expect(resolveEnabledType("general-purpose")).toBe("explorer");
  });

  it("still warns when defaults are enabled, because the built-in really wins", () => {
    subagentsExtension(makePi());

    const warnings = aliasWarnings(warn);
    expect(warnings.some((m) => m.includes("\"Explore\""))).toBe(true);
    expect(resolveEnabledType("Explore")).toBe("Explore");
  });
});
