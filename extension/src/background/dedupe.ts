import type { RpcError } from '../protocol/errors';
export type Outcome = {
    ok: true;
    result: unknown;
} | {
    ok: false;
    error: RpcError;
};
export type Entry = {
    state: 'inflight';
    at: number;
} | {
    state: 'done';
    at: number;
    outcome: Outcome;
};
export type Binding = {
    operationId: string;
    tabId: number;
    frameId: number;
    documentId: string;
};
export interface SessionStore {
    getResult(id: string): Promise<Entry | undefined>;
    claim(id: string): Promise<Entry | undefined>;
    release(id: string): Promise<void>;
    markInFlight(id: string): Promise<void>;
    saveResult(id: string, outcome: Outcome): Promise<void>;
    cancel(params: Record<string, unknown>): Promise<void>;
    isCancelled(id: string, params: Record<string, unknown>): Promise<boolean>;
    nextSnapshotId(): Promise<number>;
    hasSnapshot(operationId:string, tabId?:number, documentId?:string):Promise<boolean>;
    bind(snapshotId: number, frames: Binding[]): Promise<void>;
    binding(snapshotId: number, frameId: number): Promise<Binding | undefined>;
}
const KEY = 'commandSession';
const TTL = 10 * 60000;
const INFLIGHT_TTL = 4 * 60 * 60_000;
const INFLIGHT_CAP = 500;
const SNAPSHOT_EPOCH_MS = Date.UTC(2026, 0, 1);
const LEGACY_SEQUENCE = 1e12;
type State = {
    requests: Record<string, Entry>;
    cancelled: Record<string, number>;
    legacyGeneration: number;
    sequence: number;
    bindings: Record<string, {
        at: number;
        frames: Binding[];
    }>;
};
const empty = (): State => ({ requests: {}, cancelled: {}, legacyGeneration: 0, sequence: 0, bindings: {} });
export function memorySessionStore(backing = new Map<string, unknown>()): SessionStore {
    return storeOver(async () => structuredClone(backing.get(KEY) as State | undefined), async (s) => { backing.set(KEY, structuredClone(s)); });
}
export function chromeSessionStore(): SessionStore {
    return storeOver(async () => (await chrome.storage.session.get(KEY))[KEY] as State | undefined, s => chrome.storage.session.set({ [KEY]: s }));
}
function storeOver(read: () => Promise<State | undefined>, write: (s: State) => Promise<void>): SessionStore {
    let tail: Promise<unknown> = Promise.resolve();
    let cached: State | undefined;
    const transaction = <T>(fn: (s: State) => T, mutates = true): Promise<T> => {
        const work = tail.then(async () => {
            if (!cached) cached = (await read()) ?? empty();
            const s = cached;
            const now = Date.now();
            let pruned = false;
            let doneCount = 0, inflightCount = 0;
            for (const [k, v] of Object.entries(s.requests)) {
                if ((v.state === 'done' && now - v.at > TTL) || (v.state === 'inflight' && now - v.at > INFLIGHT_TTL)) {
                    delete s.requests[k]; pruned = true;
                } else if (v.state === 'done') doneCount++;
                else inflightCount++;
            }
            let bindingCount = 0;
            for (const [k, v] of Object.entries(s.bindings)) {
                if (now - v.at > TTL) {
                    delete s.bindings[k]; pruned = true;
                } else bindingCount++;
            }
            for (const [k, v] of Object.entries(s.cancelled))
                if (now - v > TTL) {
                    delete s.cancelled[k]; pruned = true;
                }
            const result = fn(s);
            if (mutates) {
                // Recount only when the mutation may have pushed counts over the eviction cap.
                if (doneCount >= 200) {
                    const done = Object.entries(s.requests).filter(([, e]) => e.state === 'done').sort((a, b) => b[1].at - a[1].at);
                    for (const [k] of done.slice(200)) { delete s.requests[k]; pruned = true; }
                }
                if (inflightCount >= INFLIGHT_CAP) {
                    const inflight = Object.entries(s.requests).filter(([, e]) => e.state === 'inflight').sort((a, b) => b[1].at - a[1].at);
                    for (const [k] of inflight.slice(INFLIGHT_CAP)) { delete s.requests[k]; pruned = true; }
                }
                if (bindingCount >= 200) {
                    const snaps = Object.entries(s.bindings).sort((a, b) => b[1].at - a[1].at);
                    for (const [k] of snaps.slice(200)) { delete s.bindings[k]; pruned = true; }
                }
            }
            if (mutates || pruned) {
                try { await write(s); }
                catch (error) { cached = undefined; throw error; }
            }
            return result;
        });
        tail = work.catch(() => { });
        return work;
    };
    return {
        getResult: id => transaction(s => s.requests[id], false),
        claim: id => transaction(s => { const previous = s.requests[id]; if (!previous)
            s.requests[id] = { state: 'inflight', at: Date.now() }; return previous; }),
        release: id => transaction(s => { if (s.requests[id]?.state === 'inflight') delete s.requests[id]; }),
        markInFlight: id => transaction(s => { s.requests[id] = { state: 'inflight', at: Date.now() }; }),
        saveResult: (id, outcome) => transaction(s => { s.requests[id] = { state: 'done', at: Date.now(), outcome }; }),
        cancel: p => transaction(s => {
            if (typeof p.operationId === 'string')
                s.cancelled['op:' + p.operationId] = Date.now();
            if (typeof p.requestId === 'string')
                s.cancelled['req:' + p.requestId] = Date.now();
            if (!p.operationId && !p.requestId && typeof p.generation === 'number')
                s.legacyGeneration = Math.max(s.legacyGeneration, p.generation);
        }),
        isCancelled: (id, p) => transaction(s => !!s.cancelled['req:' + id] || !!s.cancelled['op:' + p.operationId] || (!p.operationId && typeof p.generation === 'number' && p.generation <= s.legacyGeneration), false),
        hasSnapshot: (operationId,tabId,documentId) => transaction(s => Object.values(s.bindings).some(b => b.frames.some(f => f.operationId === operationId && (tabId === undefined || f.tabId === tabId) && (documentId === undefined || f.documentId === documentId))), false),
        // Deciseconds since 2026 stay short in base 36 and still increase after session storage is cleared.
        nextSnapshotId: () => transaction(s => { const floor = Math.floor((Date.now() - SNAPSHOT_EPOCH_MS) / 100); s.sequence = s.sequence >= LEGACY_SEQUENCE ? floor : Math.max(s.sequence + 1, floor); return s.sequence; }),
        bind: (id, frames) => transaction(s => { s.bindings[id] = { at: Date.now(), frames }; }),
        binding: (id, frameId) => transaction(s => s.bindings[id]?.frames.find(f => f.frameId === frameId), false),
    };
}
