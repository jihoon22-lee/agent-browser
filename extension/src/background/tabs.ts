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
export const describeTab = (t: chrome.tabs.Tab) => ({ tabId: t.id, windowId: t.windowId, url: t.url ?? '', title: t.title ?? '', active: t.active, attachable: isWeb(t.url) });
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
export async function loadedTab(api: ChromeApi, id: number, act: () => Promise<unknown>, signal: AbortSignal): Promise<chrome.tabs.Tab> {
    let resolve!: (t: chrome.tabs.Tab) => void;
    const completed = new Promise<chrome.tabs.Tab>(r => { resolve = r; });
    const off = api.onTabUpdated((tid, change, tab) => {
        if (tid === id && change.status === 'complete') resolve(tab);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acknowledged = false;
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
            aborted(signal);
            const current = await getTab(api, id);
            if (current.status === 'complete') return current;
            return completed;
        })();
        return await interruptible(Promise.race([work, deadline]), signal);
    } finally {
        clearTimeout(timer);
        off();
    }
}
