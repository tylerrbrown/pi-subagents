import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps the integrated workflow engine disabled unless explicitly configured", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  expect(source).toMatch(/let workflowsEnabled = false;/);
  expect(source).toContain("if (isWorkflowsEnabled()) pi.registerTool(workflowTool);");
});
