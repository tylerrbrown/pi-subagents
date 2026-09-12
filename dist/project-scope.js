import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
/**
 * Project read scopes, root first and cwd last, bounded by the nearest Git
 * worktree root. A .git file is a boundary too; its target is never followed.
 * Without a Git boundary, retain the historical current-directory-only scope.
 * This is for reads only: settings writes must continue to target cwd.
 */
export function projectReadScopes(cwd) {
    const scopes = [];
    let dir = resolve(cwd);
    for (;;) {
        scopes.push(dir);
        if (existsSync(join(dir, ".git")))
            return scopes.reverse();
        const parent = dirname(dir);
        if (parent === dir)
            return [cwd];
        dir = parent;
    }
}
