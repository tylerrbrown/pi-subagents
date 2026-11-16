import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { requireExternalWorkFixture } from "./helpers/external-work-fixture.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["agent-runner", "work-guard-runner", "work-lifecycle"])("%s fixtures do not embed private checkout paths", name => {
  const source = readFileSync(new URL(`./${name}.test.ts`, import.meta.url), "utf8");
  expect(/[A-Za-z]:[\\/](?:Users|Worktrees)[\\/]|SynologyDrive[\\/]/.test(source)).toBe(false);
});

it.each([undefined, "", "relative/guard.js"])("refuses an unset or relative external fixture %#", path => {
  vi.stubEnv("PI_SUBAGENTS_TEST_WORK_GUARD", path);
  expect(() => requireExternalWorkFixture("PI_SUBAGENTS_TEST_WORK_GUARD")).toThrow("BLOCKED external Work fixture");
});

it("validates explicit fixture paths without executing their contents or accepting the wrong kind", () => {
  const root = mkdtempSync(join(tmpdir(), "external-work-fixture-"));
  try {
    const file = join(root, "not-an-adapter.txt");
    writeFileSync(file, "path validation only");
    mkdirSync(join(root, "directory"));
    vi.stubEnv("PI_SUBAGENTS_TEST_WORK_GUARD", file);
    expect(requireExternalWorkFixture("PI_SUBAGENTS_TEST_WORK_GUARD")).toBe(file);
    expect(() => requireExternalWorkFixture("PI_SUBAGENTS_TEST_WORK_GUARD", "directory")).toThrow("BLOCKED");
    vi.stubEnv("PI_SUBAGENTS_TEST_WORK_CWD", root);
    expect(requireExternalWorkFixture("PI_SUBAGENTS_TEST_WORK_CWD", "directory")).toBe(root);
    expect(() => requireExternalWorkFixture("PI_SUBAGENTS_TEST_WORK_CWD")).toThrow("BLOCKED");
    vi.stubEnv("PI_SUBAGENTS_TEST_WORK_GUARD", join(root, "missing.js"));
    expect(() => requireExternalWorkFixture("PI_SUBAGENTS_TEST_WORK_GUARD")).toThrow("BLOCKED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
