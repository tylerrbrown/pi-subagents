import { describe, expect, it } from "vitest";
import { composeHelperSessionName, intentWords, parentSubject } from "../src/helper-session-name.js";

describe("composeHelperSessionName", () => {
  it("composes <Parent subject> - <Role> <intent>#<id8>", () => {
    expect(composeHelperSessionName({
      parentName: "Inbox - Quarantine Release Work",
      role: "tester",
      prompt: "Quarantine release regression",
      agentId: "61f471ad9e3c",
    })).toBe("Inbox - Tester Quarantine Release Regression#61f471ad");
  });

  it("uses a two-word parent subject and omits # when there is no agentId", () => {
    expect(composeHelperSessionName({
      parentName: "LifeOS Sessions - Fix Session Namer Bugs",
      role: "builder",
      prompt: "Fix the Infra Network keyword pattern",
    })).toBe("LifeOS Sessions - Builder Fix Infra Network Keyword Pattern");
  });

  it("falls back to the old form when there is no parent name", () => {
    expect(composeHelperSessionName({ role: "Explore", prompt: "find the bug", agentId: "a1b2c3d4e5f6" }))
      .toBe("Explore#a1b2c3d4");
    expect(composeHelperSessionName({ parentName: "  ", role: "Explore", prompt: "find the bug" }))
      .toBe("Explore");
  });

  it("falls back to the old form when the prompt has too little intent for a 3-word detail", () => {
    expect(composeHelperSessionName({ parentName: "Inbox - Work", role: "Explore", prompt: "go", agentId: "a1b2c3d4e5" }))
      .toBe("Explore#a1b2c3d4");
  });

  it("uses a parent name without a delimiter as the subject", () => {
    expect(composeHelperSessionName({ parentName: "Inbox", role: "reviewer", prompt: "Review quarantine release diff" }))
      .toBe("Inbox - Reviewer Review Quarantine Release Diff");
  });

  it("skips a leading path-only line and uses the first plain intent line", () => {
    const prompt = [
      "C:\\Users\\tyler.TYWARE\\SynologyDrive\\Claude\\ops\\tmp\\task-brief.md",
      "",
      "Verify quarantine release regression",
    ].join("\n");
    expect(composeHelperSessionName({ parentName: "Inbox - Work", role: "verifier", prompt, agentId: "0123456789" }))
      .toBe("Inbox - Verifier Verify Quarantine Release Regression#01234567");
    expect(intentWords("Read /c/repo/ops/tmp/brief.md\nAudit helper session names", 5))
      .toEqual(["Audit", "Helper", "Session", "Names"]);
  });

  it("Title Cases words and keeps the detail within 3-6 words", () => {
    const name = composeHelperSessionName({
      parentName: "Inbox - Work",
      role: "loose-ends-sweeper",
      prompt: "sweep every runtime log and persisted state file for unresolved quarantine problems",
      agentId: "deadbeefcafe",
    });
    expect(name).toBe("Inbox - Loose-Ends-Sweeper Sweep Every Runtime Log Persisted#deadbeef");
    const detail = name.split(" - ")[1].replace(/#[0-9a-f]{8}$/, "");
    const words = detail.split(" ");
    expect(words.length).toBeGreaterThanOrEqual(3);
    expect(words.length).toBeLessThanOrEqual(6);
    for (const word of words) expect(word[0]).toBe(word[0].toUpperCase());
  });

  it("rejects unusable parent subjects", () => {
    expect(parentSubject("C:\\path\\file.md")).toBeUndefined();
    expect(parentSubject("one two three four five words long")).toBeUndefined();
    expect(parentSubject("Helm Inbox - Thing")).toBe("Helm Inbox");
  });
});
