import { ProtocolError } from '../protocol/errors';
import type { ChromeApi } from './chrome-api';
export function isWeb(url?: string): boolean {
    try {
        const u = new URL(url ?? '');
        return ['http:', 'https:'].includes(u.protocol) && u.hostname !== 'chromewebstore.google.com' && !(u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'));
    }
    catch {
        return false;
    }
}
export function requireWeb(url?: string) { if (!isWeb(url))
    throw new ProtocolError('UNSUPPORTED_PAGE', 'Only ordinary HTTP/HTTPS pages are supported. Chrome pages and the Web Store cannot be controlled.'); }
export async function getTab(api: ChromeApi, id?: number): Promise<chrome.tabs.Tab> {
    try {
        const tab = id === undefined ? (await api.tabsQuery({ active: true, lastFocusedWindow: true }))[0] : await api.tabsGet(id);
        if (!tab?.id)
            throw Error('missing');
        return tab;
    }
    catch {
        throw new ProtocolError('TAB_NOT_FOUND', 'The requested tab is no longer available.');
    }
}
export const describeTab = (t: chrome.tabs.Tab) => ({ tabId: t.id, windowId: t.windowId, url: t.url ?? '', title: t.title ?? '', active: t.active, index: t.index, openerTabId: t.openerTabId, status: t.status, pinned: t.pinned, attachable: isWeb(t.url) });
export function aborted(signal: AbortSignal) { if (signal.aborted)
    throw signal.reason; }
export function interruptible<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        void work.catch(() => { });
        return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
        const stop = () => reject(signal.reason);
        signal.addEventListener('abort', stop, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
}
/** Subscribe before the mutation so a fast navigation cannot lose its completion event. */
export async function loadedTab(api: ChromeApi, id: number, act: () => Promise<unknown>, signal: AbortSignal, expectNavigation = false, historyTraversal = false): Promise<chrome.tabs.Tab> {
    let resolve!: (t: chrome.tabs.Tab) => void;
    const completed = new Promise<chrome.tabs.Tab>(r => { resolve = r; });
    let observed = false, initiated = false;
    const before = expectNavigation ? await getTab(api, id) : undefined;
    const beforeDocument = expectNavigation && isWeb(before?.url) ? (await api.listFrames(id)).find(f => f.frameId === 0)?.documentId : undefined;
    const beforeEntry = historyTraversal && beforeDocument && api.historyEntry
        ? await interruptible(api.historyEntry(id,beforeDocument).catch(()=>{
            throw new ProtocolError('FRAME_UNAVAILABLE','The current document changed before history traversal. Take a fresh snapshot.','safe',{executed:false});
        }),signal) : undefined;
    if(historyTraversal && api.historyEntry && !beforeEntry)
        throw new ProtocolError('FRAME_UNAVAILABLE','Cannot identify the current history entry before traversal.','safe');
    const off = api.onTabUpdated((tid, change, tab) => {
        if (tid !== id) return;
        if (change.status === 'loading' || change.url) observed = true;
        if (change.status === 'complete' && (!expectNavigation || observed)) resolve(tab);
    });
    const offNavigation=api.onNavigationStarted?.(tabId=>{if(tabId===id)initiated=true;});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acknowledged = false, finished = false;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(acknowledged
            ? new ProtocolError('TIMEOUT', 'The tab did not finish loading within 30 seconds.', 'never', {executed:true})
            : new ProtocolError('EXECUTION_UNKNOWN', 'Chrome did not acknowledge navigation. Inspect the page before retrying.', 'unsafe')), 30_000);
    });
    try {
        const work = (async () => {
            aborted(signal);
            await act();
            acknowledged = true;
            const dispatchedAt=Date.now();
            aborted(signal);
            // Chrome may acknowledge before changing tabs.status. Do not return
            // the previous document's complete state as the navigation result.
            while (!finished) {
                aborted(signal);
                const current = await getTab(api, id);
                if(current.status==='loading')observed=true;
                let changed = !expectNavigation || observed || current.url !== before?.url ||
                    (beforeDocument!==undefined && (await api.listFrames(id)).find(f => f.frameId === 0)?.documentId !== beforeDocument);
                if(!changed && beforeEntry && beforeDocument){
                    const entry=await interruptible(api.historyEntry!(id,beforeDocument).catch(()=>undefined),signal);
                    if(!entry)throw new ProtocolError('EXECUTION_UNKNOWN','The history entry could not be verified after traversal. Inspect the page before continuing.','unsafe');
                    changed=entry!==beforeEntry;
                }
                if (current.status === 'complete' && changed) return current;
                if(historyTraversal&&!changed&&!initiated&&Date.now()-dispatchedAt>=1500)
                    throw new ProtocolError('ELEMENT_NOT_INTERACTABLE','No history entry was observed in that direction. Inspect the page before another navigation.','never',{executed:false});
                const result = await Promise.race([completed, new Promise<null>(r => setTimeout(() => r(null), 25))]);
                if (result) return result;
            }
            throw new ProtocolError('TIMEOUT', 'Navigation did not settle.', 'never', {executed: acknowledged});
        })();
        return await interruptible(Promise.race([work, deadline]), signal);
    } finally {
        finished = true;
        clearTimeout(timer);
        off();offNavigation?.();
    }
}
