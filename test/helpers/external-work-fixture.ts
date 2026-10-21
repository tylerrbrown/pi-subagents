import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

type FixtureSetting = "PI_SUBAGENTS_TEST_WORK_GUARD" | "PI_SUBAGENTS_TEST_WORK_CWD" | "PI_SUBAGENTS_TEST_ROOT_AGENT";

export function requireExternalWorkFixture(setting: FixtureSetting, kind: "file" | "directory" = "file"): string {
  const path = process.env[setting];
  const blocked = () => new Error(`BLOCKED external Work fixture: set ${setting} to an absolute existing ${kind}; no adapter substitute is provided.`);
  if (!path || !isAbsolute(path)) throw blocked();
  try {
    const stat = statSync(path);
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw blocked();
  } catch {
    throw blocked();
  }
  return path;
}
