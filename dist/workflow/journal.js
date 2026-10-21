/**
 * journal.ts — the record a workflow run leaves so a later run can skip work.
 *
 * ## What resume actually buys
 *
 * The documented iteration loop is "edit the persisted script and re-run it".
 * Without a journal that re-pays every agent from scratch, which for a 40-agent
 * audit is the entire cost of the run — to change one line of the last stage.
 * With one, the unchanged prefix comes back from disk and only the edit runs.
 *
 * ## Why a *prefix*, and not a lookup table
 *
 * Each entry is keyed by both its position in the run and a hash of everything
 * that decides what that agent does. A replay walks positions in order and
 * stops reusing at the first entry that does not match — every call from there
 * on runs live. Reusing later matches out of order would be reusing a result
 * produced under different upstream conditions: the same prompt at position 12
 * of a *different* run is not the same work, because what fed it changed.
 *
 * A failed agent is journaled as a failure and never replayed as one. Resuming
 * a run that died at agent 5 exists to retry agent 5, so the prefix ends there
 * and 5 onwards run live — the alternative would make a failure permanent.
 *
 * ## Runs that use `agent({ resume })`
 *
 * Those are not replayed at all. A replayed agent is text from a file, not a
 * live child, so there is no conversation in this run for a later `resume` to
 * continue — and the id map that would find one belongs to the run that did
 * the spawning. Rather than replay a prefix that strands the first `resume`
 * call, a journal carrying one declines the whole cache and the run pays in
 * full. Coarse on purpose: the alternative is tracking which label each entry
 * ran under and capping the prefix below the earliest one that gets resumed,
 * which is a second key concept for a case that costs one run.
 *
 * ## Ordering under concurrency
 *
 * Positions are assigned as calls arrive, and with `pipeline` that order
 * depends on which agent finished first. A replay usually reproduces it, since
 * cached calls answer in journal order, but it is not guaranteed. That is why
 * the key is checked as well as the position: a run that interleaves
 * differently loses cache hits, it never returns another agent's answer.
 *
 * The file is JSON Lines, appended as each agent settles, so a run that is
 * killed mid-flight still leaves everything it had finished.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
/** Stable hash of a call's payload. Field order is fixed here, not by the caller. */
export function journalKey(input) {
    const canonical = JSON.stringify([
        input.prompt,
        input.label ?? null,
        input.model ?? null,
        input.agentType ?? null,
        input.effort ?? null,
        input.isolation ?? null,
        input.gate ?? null,
        input.resume ?? null,
        // Appended only when present, which looks like a hack and is not: adding a
        // ninth slot unconditionally would change the canonical form of every entry
        // and invalidate every journal already on disk. Conditional, a schema-less
        // call keys exactly as it always did, and adding or changing a schema still
        // produces a different key.
        ...(input.schema !== undefined ? [input.schema] : []),
    ]);
    return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
/**
 * Read a journal file into position order.
 *
 * Never throws: a missing, truncated or hand-mangled journal means "nothing to
 * replay", which costs tokens. Refusing to run would cost the whole run.
 * A partial last line is normal — the file is appended to while agents settle.
 */
export function readJournal(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf-8");
    }
    catch {
        return [];
    }
    const entries = [];
    for (const line of raw.split("\n")) {
        if (line.trim() === "")
            continue;
        try {
            const parsed = JSON.parse(line);
            if (!isEntry(parsed))
                continue;
            entries.push(parsed);
        }
        catch {
            // A half-written final line, or someone editing the file. Skipping it
            // keeps what came before, and a shorter prefix is still a useful one.
        }
    }
    entries.sort((a, b) => a.index - b.index);
    return entries;
}
/** Append one settled call. Failure to write is not failure to run. */
export function appendJournal(path, entry) {
    try {
        appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
    }
    catch {
        // A journal that cannot be written costs a future resume, nothing more.
    }
}
function isEntry(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const entry = value;
    return (Number.isInteger(entry.index) &&
        entry.index >= 0 &&
        typeof entry.key === "string" &&
        typeof entry.ok === "boolean" &&
        (entry.text === undefined || typeof entry.text === "string") &&
        (entry.resumed === undefined || entry.resumed === true));
}
