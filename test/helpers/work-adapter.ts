import { vi } from "vitest";
import type { EventBus } from "../../src/cross-extension-rpc.js";

export const work = { case: "case-04", execution: "execution-04", actor: "tester", scopes: ["test/**"] };
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function workAdapter() {
  const listeners = new Map<string, Set<(data: any) => void>>();
  const events: EventBus = {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
      return () => { listeners.get(name)?.delete(listener); };
    },
    emit(name, data) { for (const listener of listeners.get(name) ?? []) listener(data); },
  };
  const requests: Record<string, any[]> = { reserve: [], bind: [], finalize: [], reconcile: [] };
  const held = new Set<string>();
  const refused = new Set<string>();
  function reply(action: string, request: any, success = true) {
    events.emit(`subagents:work:${action}:reply:${request.requestId}`, {
      success, data: action === "reserve" ? { reservationId: "reservation-04" } : undefined,
      ...(!success && { error: "SYNTHETIC_PRIVATE_ADAPTER_ERROR" }),
    });
  }
  for (const action of Object.keys(requests)) events.on(`subagents:work:${action}`, request => {
    requests[action].push(request);
    if (!held.has(action)) reply(action, request, !refused.has(action));
  });
  const entries: any[] = [];
  const pi = { events, appendEntry: vi.fn((customType, data) => entries.push({ customType, data: structuredClone(data) })) } as any;
  return { events, pi, requests, entries, held, refused, reply };
}
export function workContext() {
  return { cwd: process.cwd(), hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    modelRegistry: { find: vi.fn(), getAvailable: () => [] },
    getSystemPrompt: () => "parent",
    sessionManager: { getSessionId: () => "parent-session", getBranch: () => [] },
  } as any;
}
/** Observe writes without reading or copying any real environment values. */
export async function withSyntheticEnvironment<T>(run: (writes: ReturnType<typeof vi.fn>) => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "env")!;
  const writes = vi.fn();
  const synthetic = new Proxy(Object.create(null), {
    set: (_target, key) => { writes("set", key); return true; },
    deleteProperty: (_target, key) => { writes("delete", key); return true; },
    defineProperty: (_target, key) => { writes("define", key); return true; },
  });
  Object.defineProperty(process, "env", { configurable: true, get: () => synthetic, set: () => { writes("replace"); } });
  try { return await run(writes); }
  finally { Object.defineProperty(process, "env", original); }
}
export function childSession() {
  return { sessionManager: { getSessionId: () => "actual-child-session" },
    dispose: vi.fn(), abort: vi.fn(async () => {}), steer: vi.fn(async () => {}),
  } as any;
}
