import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { cleanupWorktree, createWorktree, pruneWorktrees } from "../src/worktree.js";

const ok: ExecResult = { stdout: "", stderr: "", code: 0, killed: false };

it("creation yields to the event loop while Pi's Git execution is pending", async () => {
  let release!: (value: ExecResult) => void;
  const exec = vi.fn(() => new Promise<ExecResult>(resolve => { release = resolve; }));
  const pending = createWorktree({ exec } as unknown as ExtensionAPI, process.cwd(), "async-probe");
  expect(exec).toHaveBeenCalledWith("git", ["rev-parse", "--is-inside-work-tree"], { cwd: process.cwd(), timeout: 5000 });
  let tick = false;
  await new Promise<void>(resolve => setImmediate(() => { tick = true; resolve(); }));
  expect(tick).toBe(true);
  release({ ...ok, code: 1 });
  expect(await pending).toBeUndefined();
});

it("a timeout with code zero is a failed Git operation, not a successful probe", async () => {
  const exec = vi.fn(async () => ({ ...ok, killed: true }));
  expect(await createWorktree({ exec } as unknown as ExtensionAPI, process.cwd(), "timeout")).toBeUndefined();
  expect(exec).toHaveBeenCalledOnce();
});

it("cleanup and prune also use the asynchronous Pi seam with bounded timeouts", async () => {
  const exec = vi.fn(async () => ok);
  const pi = { exec } as unknown as ExtensionAPI;
  const cwd = process.cwd();
  await cleanupWorktree(pi, cwd, { path: cwd, workPath: cwd, baseSha: "", branch: "unused" }, "clean");
  expect(exec.mock.calls).toEqual([
    ["git", ["status", "--porcelain"], { cwd, timeout: 10000 }],
    ["git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 }],
    ["git", ["worktree", "remove", "--force", cwd], { cwd, timeout: 10000 }],
  ]);
  await pruneWorktrees(pi, cwd);
  expect(exec).toHaveBeenLastCalledWith("git", ["worktree", "prune"], { cwd, timeout: 5000 });
});

it("removes a partially created directory when worktree add is killed", async () => {
  let partial: string | undefined;
  const exec = vi.fn<ExtensionAPI["exec"]>(async (_command, args) => {
    if (args[0] === "rev-parse") return { ...ok, stdout: args[1] === "--show-prefix" ? "" : process.cwd() };
    if (args[1] === "add") {
      partial = args[3];
      mkdirSync(partial, { recursive: true });
      return { ...ok, killed: true };
    }
    // Git cannot unregister an interrupted copy; pruning alone cannot delete it.
    if (args[1] === "remove") return { ...ok, code: 1 };
    return ok;
  });
  try {
    expect(await createWorktree({ exec } as unknown as ExtensionAPI, process.cwd(), "partial")).toBeUndefined();
    expect(partial).toBeDefined();
    expect(existsSync(partial!)).toBe(false);
    expect(exec).toHaveBeenLastCalledWith("git", ["worktree", "prune"], { cwd: process.cwd(), timeout: 5000 });
  } finally {
    if (partial) rmSync(partial, { recursive: true, force: true });
  }
});

describe("dirty-output preservation failures", () => {
  it.each(["add", "commit", "branch"])("retains and reports the worktree when git %s fails", async (failedStep) => {
    const path = mkdtempSync(join(tmpdir(), "pi-wt-retained-"));
    const exec = vi.fn<ExtensionAPI["exec"]>(async (_command, args) => {
      const step = args[0];
      if (step === "status") return { ...ok, stdout: "?? output.txt" };
      if (step === failedStep) return { ...ok, code: 1, stderr: `${failedStep} denied` };
      return ok;
    });
    const marker = Buffer.from([0, 255, 13, 10, 0, 129, 254, 65]);
    const markerPath = join(path, "output.bin");
    writeFileSync(markerPath, marker);
    try {
      const result = await cleanupWorktree(
        { exec } as unknown as ExtensionAPI,
        process.cwd(),
        { path, workPath: path, baseSha: "base", branch: "pi-agent-retain" },
        "retain me",
      );

      expect(result).toEqual({
        hasChanges: true,
        path,
        error: `${failedStep} denied`,
      });
      expect(existsSync(path)).toBe(true);
      expect(join(result.path!, "output.bin")).toBe(markerPath);
      expect(readFileSync(markerPath)).toEqual(marker);
      expect(exec.mock.calls.some(([, args]) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});

describe("workPath containment", () => {
  it("uses the native Windows 8.3 spelling without treating the repo as escaped", async () => {
    if (process.platform !== "win32") return;
    const cwd = process.cwd();
    const shortCwd = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `cmd.exe /d /c 'for %I in ("${cwd}") do @echo %~sI'`],
      { encoding: "utf8" },
    ).trim();
    expect(shortCwd.toUpperCase()).toMatch(/^C:\\WORKTR~1\\/);

    let addedPath: string | undefined;
    const exec = vi.fn<ExtensionAPI["exec"]>(async (_command, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { ...ok, stdout: "abc" };
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ...ok, stdout: shortCwd };
      if (args[0] === "rev-parse" && args[1] === "--show-prefix") return { ...ok, stdout: "packages/api/" };
      if (args[0] === "worktree" && args[1] === "add") addedPath = args[3];
      return ok;
    });

    const result = await createWorktree({ exec } as unknown as ExtensionAPI, cwd, "native-83");
    expect(result).toBeDefined();
    expect(result!.path).toBe(addedPath);
    expect(result!.workPath).toBe(join(addedPath!, "packages", "api"));
  });

  it.each([
    ["long cwd / short Git top-level", String.raw`C:\Worktrees\repo-long\packages\api`, String.raw`C:\REPO~1`, "packages/api/"],
    ["short cwd / long Git top-level", String.raw`C:\REPO~1\packages\api`, String.raw`C:\Worktrees\repo-long`, "packages/api/"],
  ])("accepts deterministic injected long/short spellings (%s)", async (_label, cwd, topLevel, prefix) => {
    let addedPath: string | undefined;
    const exec = vi.fn<ExtensionAPI["exec"]>(async (_command, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { ...ok, stdout: "abc" };
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ...ok, stdout: topLevel };
      if (args[0] === "rev-parse" && args[1] === "--show-prefix") return { ...ok, stdout: prefix };
      if (args[0] === "worktree" && args[1] === "add") addedPath = args[3];
      return ok;
    });

    const result = await createWorktree({ exec } as unknown as ExtensionAPI, cwd, `injected-${_label}`);
    expect(result).toBeDefined();
    expect(result!.workPath).toBe(join(result!.path, "packages", "api"));
    expect(result!.path).toBe(addedPath);
  });

  it.each([
    ["repo root", ""],
    ["monorepo subdirectory", "packages/api/"],
  ])("uses Git's normalized prefix across a long/short-path mismatch at the %s", async (_label, prefix) => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-wt-cwd-"));
    const differentlySpelledTopLevel = mkdtempSync(join(tmpdir(), "pi-wt-top-"));
    let addedPath: string | undefined;
    const exec = vi.fn<ExtensionAPI["exec"]>(async (_command, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { ...ok, stdout: "abc" };
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ...ok, stdout: differentlySpelledTopLevel };
      if (args[0] === "rev-parse" && args[1] === "--show-prefix") return { ...ok, stdout: prefix };
      if (args[0] === "worktree" && args[1] === "add") addedPath = args[3];
      return ok;
    });
    try {
      const result = await createWorktree({ exec } as unknown as ExtensionAPI, cwd, `contain-${prefix || "root"}`);
      expect(result).toBeDefined();
      expect(result!.workPath).toBe(prefix ? join(result!.path, "packages", "api") : result!.path);
      expect(result!.path).toBe(addedPath);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(differentlySpelledTopLevel, { recursive: true, force: true });
    }
  });

  it.each([
    "../escape/",
    String.raw`..\escape`,
    "C:/absolute/escape/",
    String.raw`C:\absolute\escape`,
    "//server/share/escape/",
    String.raw`\\server\share\escape`,
    "/rooted/escape/",
  ])("fails closed on absolute, drive, UNC, and traversing Git prefix %s before worktree add", async (prefix) => {
    const cwd = process.cwd();
    const exec = vi.fn<ExtensionAPI["exec"]>(async (_command, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { ...ok, stdout: "abc" };
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ...ok, stdout: cwd };
      if (args[0] === "rev-parse" && args[1] === "--show-prefix") return { ...ok, stdout: prefix };
      return ok;
    });

    expect(await createWorktree({ exec } as unknown as ExtensionAPI, cwd, "traversal")).toBeUndefined();
    expect(exec.mock.calls.some(([, args]) => args[0] === "worktree" && args[1] === "add")).toBe(false);
  });
});
