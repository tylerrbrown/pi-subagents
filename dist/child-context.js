import { AsyncLocalStorage } from "node:async_hooks";
/**
 * Marks resource loading/session construction performed for a subagent. This is
 * async-context-local so concurrent top-level extension work is unaffected.
 */
const childSessionContext = new AsyncLocalStorage();
export function inChildSessionContext() {
    return childSessionContext.getStore() === true;
}
export function runInChildSessionContext(fn) {
    return childSessionContext.run(true, fn);
}
