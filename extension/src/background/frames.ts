import { ProtocolError } from '../protocol/errors';
import type { ChromeApi, FrameInfo } from './chrome-api';
import type { SessionStore } from './dedupe';
import { RefTable } from '../content/refs';
export type FrameError = {
    frameId: number;
    url?: string;
    code: 'FRAME_UNAVAILABLE';
    message: string;
};
export function frameRouter(api: ChromeApi, store: SessionStore) {
    const injected = new Map<string, {
        tabId: number;
        frame: FrameInfo;
    }>();
    async function list(tabId: number) { try {
        return await api.listFrames(tabId);
    }
    catch {
        throw new ProtocolError('FRAME_UNAVAILABLE', 'Cannot enumerate the tab documents.');
    } }
    async function inject(tabId: number, frame: FrameInfo) {
        try {
            const actual = await api.inject(tabId, frame);
            injected.set(`${tabId}:${actual.documentId}`, { tabId, frame: actual });
            return actual;
        }
        catch {
            throw new ProtocolError('FRAME_UNAVAILABLE', 'This frame could not be accessed.');
        }
    }
    async function resolve(tabId: number, ref?: string, operationId?: string): Promise<FrameInfo> {
        const frames = await list(tabId);
        if (ref) {
            const parsed = RefTable.parse(ref);
            if (!parsed)
                throw new ProtocolError('ELEMENT_NOT_FOUND', 'Use an element ref returned by browser_snapshot.');
            const binding = await store.binding(parsed.snapshotId, parsed.frameId);
            const current = frames.find(f => f.frameId === parsed.frameId);
            if (!binding || binding.operationId !== operationId || binding.tabId !== tabId || !current || binding.documentId !== current.documentId)
                throw new ProtocolError('STALE_ELEMENT', 'The element belongs to another tab or an old document. Take a new snapshot.');
            return current;
        }
        const top = frames.find(f => f.frameId === 0);
        if (!top)
            throw new ProtocolError('FRAME_UNAVAILABLE', 'The top document is unavailable.');
        return top;
    }
    function cancel(params: Record<string, unknown>) {
        for (const { tabId, frame } of injected.values())
            void api.sendToFrame(tabId, frame, { kind: 'cancel', ...params }).catch(() => { injected.delete(`${tabId}:${frame.documentId}`); });
    }
    return { list, inject, resolve, cancel };
}
