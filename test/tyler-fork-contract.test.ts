import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf-8");

describe("Tyler fork contract", () => {
  it("keeps agent definitions read-only in the /agents UI", () => {
    for (const action of [
      "Create new agent",
      "Eject (export as .md)",
      'choice === "Edit"',
      'choice === "Delete"',
      'choice === "Disable"',
      'choice === "Enable"',
      'choice === "Reset to default"',
    ]) {
      expect(source).not.toContain(action);
    }
    expect(source).toContain("Running agents (");
    expect(source).toContain("Agent types (");
    expect(source).toContain("viewAgentConversation");
  });

  it("advertises only the shared agent source", () => {
    expect(source).toContain(".claude/agents/<name>.md");
    expect(source).not.toContain("Custom agents from .claude/agents");
    expect(source).not.toContain("Custom agents can be defined in .claude/agents");
  });
});
