import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof import("../src/worktree.js")>("../src/worktree.js");
  return { ...actual, pruneWorktrees: vi.fn(async () => {}) };
});

import subagentsExtension from "../src/index.js";
import { pruneWorktrees } from "../src/worktree.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;

afterEach(async () => {
  hermetic?.restore();
  hermetic = undefined;
  vi.mocked(pruneWorktrees).mockClear();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
});

describe("extension shutdown worktree pruning", () => {
  it("prunes the primary repository when no agent was spawned", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const boot = makePi();
    subagentsExtension(boot.pi);

    await boot.lifecycle.get("session_shutdown")?.({}, ctx());

    expect(pruneWorktrees).toHaveBeenCalledWith(boot.pi, process.cwd());
  });
});
