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
    async function bound(tabId: number, ref?: string, operationId?: string, frameRef?: string) {
        const match=frameRef===undefined?undefined:/^s(\d+)f(\d+)$/.exec(frameRef);
        if(frameRef!==undefined&&!match)throw new ProtocolError('INVALID_PARAMS','Use frameRef returned by browser_snapshot.');
        const explicit=match?{snapshotId:Number(match[1]),frameId:Number(match[2])}:undefined;
        const element=ref?RefTable.parse(ref):undefined;
        if(explicit&&ref&&(!element||explicit.snapshotId!==element.snapshotId||explicit.frameId!==element.frameId))
            throw new ProtocolError('INVALID_PARAMS','frameRef and element ref must belong to the same snapshot frame.');
        const parsed=explicit??element;
        if(!parsed)throw new ProtocolError('ELEMENT_NOT_FOUND','Use an element ref returned by browser_snapshot.');
        const binding=await store.binding(parsed.snapshotId,parsed.frameId);
        if(!binding||binding.operationId!==operationId||binding.tabId!==tabId)
            throw new ProtocolError('STALE_ELEMENT','The ref does not belong to this operation and tab.');
        return binding;
    }
    async function resolve(tabId: number, ref?: string, operationId?: string, frameRef?: string): Promise<FrameInfo> {
        const frames = await list(tabId);
        if(ref||frameRef!==undefined){
            const binding=await bound(tabId,ref,operationId,frameRef);
            const current=frames.find(f=>f.frameId===binding.frameId);
            if(!current||binding.documentId!==current.documentId)
                throw new ProtocolError('STALE_ELEMENT','The element belongs to an old document. Take a new snapshot.');
            return current;
        }
        const top=frames.find(f=>f.frameId===0);
        if(!top)throw new ProtocolError('FRAME_UNAVAILABLE','The top document is unavailable.');
        return top;
    }
    function cancel(params: Record<string, unknown>) {
        for (const { tabId, frame } of injected.values())
            void api.sendToFrame(tabId, frame, { kind: 'cancel', ...params }).catch(() => { injected.delete(`${tabId}:${frame.documentId}`); });
    }
    return { list, inject, resolve, bound, cancel };
}
