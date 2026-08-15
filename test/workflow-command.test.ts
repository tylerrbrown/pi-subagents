/**
 * workflow-command.test.ts — the `/workflows` slash command.
 *
 * The dialog itself is covered by workflow-dialog.test.ts; what is untested
 * until here is the command around it: what happens with no runs, one run, or
 * several, and that stopping from the dialog actually aborts the run rather
 * than only looking like it did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

/** Boot the real extension and hand back its `/workflows` command. */
function bootCommand() {
  const booted = makePi();
  subagentsExtension(booted.pi);
  const command = booted.commands.get("workflows");
  if (!command) throw new Error("the extension did not register /workflows");
  return { ...booted, command };
}

/**
 * A command ctx whose `ui.custom` immediately builds the component, captures it,
 * and closes it — enough to exercise the wiring without a terminal.
 */
function commandCtx() {
  const notes: { text: string; level?: string }[] = [];
  const built: unknown[] = [];
  let selectFrom: string[] = [];
  let selectPick: string | undefined;
  const context = ctx({
    ui: {
      notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
      select: vi.fn(async (_title: string, options: string[]) => {
        selectFrom = options;
        return selectPick;
      }),
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown) => {
        const tui = { requestRender: () => {} };
        const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
        const instance = factory(tui, theme, {}, () => {}) as { dispose?: () => void };
        built.push(instance);
        instance.dispose?.();
        return undefined;
      }),
    },
  });
  return {
    context,
    notes,
    built,
    setPick: (value: string | undefined) => { selectPick = value; },
    offered: () => selectFrom,
  };
}

describe("/workflows", () => {
  let hermetic: Hermetic;

  beforeEach(() => { hermetic = hermeticDir(); });
  afterEach(() => { hermetic.restore(); });

  it("is registered with a description", () => {
    const { command } = bootCommand();
    expect(typeof command.handler).toBe("function");
    expect(command.description).toMatch(/workflow/i);
  });

  it("says so when the session has no workflows", async () => {
    const { command } = bootCommand();
    const ui = commandCtx();
    await command.handler("", ui.context);
    expect(ui.notes.map(n => n.text).join("\n")).toMatch(/No workflows/i);
    // Nothing to inspect, so no dialog should have been opened.
    expect(ui.built).toHaveLength(0);
  });

  it("does not prompt for a choice when there is nothing to choose", async () => {
    const { command } = bootCommand();
    const ui = commandCtx();
    await command.handler("", ui.context);
    expect(ui.context.ui.select).not.toHaveBeenCalled();
  });

  describe("with runs in the session", () => {
    const script = (name: string) =>
      `export const meta = { name: "${name}", description: "d" };\nreturn 1;\n`;

    /** Boot, then start `count` workflows so the session has tasks to inspect. */
    async function withRuns(count: number) {
      const booted = bootCommand();
      const runCtx = ctx({ cwd: hermetic.dir });
      for (let i = 0; i < count; i++) {
        await booted.tools.get("Workflow").execute(`tc-${i}`, { script: script(`wf-${i}`) }, undefined, undefined, runCtx);
      }
      return booted;
    }

    it("opens the dialog directly when exactly one run exists", async () => {
      const { command } = await withRuns(1);
      const ui = commandCtx();
      await command.handler("", ui.context);
      // Straight to the dialog — asking which of one is noise.
      expect(ui.context.ui.select).not.toHaveBeenCalled();
      expect(ui.built).toHaveLength(1);
    });

    it("asks which run when several exist, newest first", async () => {
      const { command } = await withRuns(3);
      const ui = commandCtx();
      ui.setPick(undefined);
      await command.handler("", ui.context);
      const offered = ui.offered();
      expect(offered).toHaveLength(3);
      // Most recent at the top: that is nearly always the one being asked about.
      expect(offered[0]).toContain("wf-2");
      expect(offered[2]).toContain("wf-0");
      // Cancelling the picker must not open anything.
      expect(ui.built).toHaveLength(0);
    });

    it("actually aborts the run when stopped from the dialog", async () => {
      // The consequential action: it must abort, not merely look like it did.
      const { command } = await withRuns(1);
      const ui = commandCtx();
      await command.handler("", ui.context);
      const dialog = ui.built[0] as { handleInput(data: string): void };
      dialog.handleInput("x");
      expect(ui.notes.map(n => n.text).join("\n")).toMatch(/Stopped workflow "wf-0"/);
    });

    it("does not re-announce a stop for an already-aborted run", async () => {
      const { command } = await withRuns(1);
      const ui = commandCtx();
      await command.handler("", ui.context);
      const dialog = ui.built[0] as { handleInput(data: string): void };
      dialog.handleInput("x");
      dialog.handleInput("x");
      const stops = ui.notes.filter(n => /Stopped workflow/.test(n.text));
      expect(stops).toHaveLength(1);
    });

    it("opens the run the user picked", async () => {
      const { command } = await withRuns(2);
      const ui = commandCtx();
      await command.handler("", ui.context);
      const offered = ui.offered();
      ui.setPick(offered[1]);
      await command.handler("", ui.context);
      expect(ui.built).toHaveLength(1);
    });
  });
});
