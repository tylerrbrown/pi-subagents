import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { streamToOutputFile, writeInitialEntry } from "../src/output-file.js";

it("declares host TypeBox as a peer and retains the compiled entry", () => {
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  expect(manifest.dependencies).not.toHaveProperty("@sinclair/typebox");
  expect(manifest.dependencies).not.toHaveProperty("typebox");
  expect(manifest.peerDependencies.typebox).toBe("*");
  expect(manifest.pi.extensions).toEqual(["./dist/index.js"]);
  expect(manifest.scripts.build).toBe("tsc");
});

it("streams Pi 1.3 history without duplicate prompts or system records", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi13-transcript-"));
  try {
    const output = join(directory, "agent.output");
    const session = {
      messages: [
        { role: "system", content: "initial system" },
        { role: "user", content: "original prompt" },
        { role: "assistant", content: [{ type: "text", text: "first result" }] },
        { role: "system", content: "changed tools" },
        { role: "user", content: "follow-up" },
        { role: "assistant", content: [{ type: "text", text: "second result" }] },
      ],
      subscribe: vi.fn(() => () => {}),
    };
    writeInitialEntry(output, "pi13", "original prompt", directory);
    streamToOutputFile(session as unknown as AgentSession, output, "pi13", directory)();
    const entries = readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries.map(entry => entry.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(entries.filter(entry => entry.message.content === "original prompt")).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
