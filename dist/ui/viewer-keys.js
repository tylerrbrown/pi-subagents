/**
 * viewer-keys.ts — Scroll key matchers for the conversation viewer.
 *
 * Resolves `tui.select.*` through the user's keybindings when pi provides a
 * manager, falling back to the previous hardcoded keys otherwise. The viewer's
 * k/j and shift+arrow aliases always work alongside whatever is bound.
 */
import { matchesKey } from "@earendil-works/pi-tui";
export function createViewerKeys(keybindings) {
    const matches = (data, id, fallback) => keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
    return {
        scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
        scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
        pageUp: (data) => matches(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up"),
        pageDown: (data) => matches(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down"),
    };
}
