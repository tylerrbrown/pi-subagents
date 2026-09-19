import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Real asynchronous Git, with Pi's result (rather than rejection) contract. */
export const worktreePi = {
  exec: (command, args, options) => new Promise(resolve => {
    execFile(command, args, { cwd: options?.cwd, timeout: options?.timeout, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : error ? 1 : 0, killed: error?.killed ?? false });
    });
  }),
} as Pick<ExtensionAPI, "exec"> as ExtensionAPI;
