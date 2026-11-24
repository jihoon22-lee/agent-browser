import { ProtocolError, type Req } from '../protocol/envelope';
import type { ChromeApi, FrameInfo } from './chrome-api';
import { getTab, requireWeb, aborted, interruptible } from './tabs';
import { CONDITION_KEYS, type PageConditions } from '../protocol/conditions';

export type WaitRunContext = {
    req: Req;
    controller: AbortController;
    sourceTopDocument?: string;
};

export type WaitDeps = {
    api: ChromeApi;
    frames: { list(tabId: number): Promise<FrameInfo[]>; inject(tabId: number, frame: FrameInfo): Promise<unknown> };
    within: (ms: number) => number;
    cancelled: () => ProtocolError;
    asError: (e: unknown) => ProtocolError;
    sendWait: (tabId: number, frame: FrameInfo, params: Record<string, unknown>) => Promise<unknown>;
};

/** Re-read conditions in the current document; navigation retries only these read-only probes.
 * The click/key is never resent, and the whole waiter (including Chrome API calls) is bounded. */
export async function waitForConditions(
    deps: WaitDeps,
    tabId: number,
    original: FrameInfo,
    expected: PageConditions,
    run: WaitRunContext,
    action?: any,
    sourceUrl?: string,
) {
    const executed = action !== undefined;
    if (action?.openedTabs?.length) throw new ProtocolError('ELEMENT_NOT_INTERACTABLE', 'The action opened another tab. Inspect its snapshot before waiting there.', 'never', { executed: true });
    const controller = new AbortController(), signal = controller.signal;
    const cancel = () => controller.abort(run.controller.signal.reason ?? deps.cancelled());
    run.controller.signal.addEventListener('abort', cancel, { once: true });
    if (run.controller.signal.aborted) cancel();
    const waitBudget = Math.max(50, deps.within(expected.timeoutMs));
    const timer = setTimeout(() => controller.abort(new ProtocolError('TIMEOUT', 'The requested page conditions were not met. Inspect the page before another action.', executed ? 'never' : 'safe', { executed, expectationMet: false })), waitBudget);
    const started = Date.now(), keys = CONDITION_KEYS.filter(k => expected[k] !== undefined), originalDocumentId = original.documentId;
    const staleWait = () => new ProtocolError('STALE_ELEMENT', 'The waited-for document changed. Take a fresh snapshot before waiting again.');
    let injected = originalDocumentId;
    try {
        return await interruptible((async () => {
            while (true) {
                aborted(signal);
                const tab = await interruptible(getTab(deps.api, tabId), signal);
                requireWeb(tab.url);
                const checks: Record<string, boolean> = {};
                if (expected.urlIncludes !== undefined) checks.urlIncludes = !tab.pendingUrl && !!tab.url?.includes(expected.urlIncludes);
                let live: FrameInfo | undefined;
                if (!tab.pendingUrl && (expected.text !== undefined || expected.textGone !== undefined)) {
                    try {
                        const documents = await interruptible(deps.frames.list(tabId), signal), top = documents.find(f => f.frameId === 0);
                        // A child can disappear without navigation. Follow frame 0 only after
                        // the enclosing document was actually replaced, including same-URL loads.
                        live = run.sourceTopDocument && top && top.documentId !== run.sourceTopDocument
                            ? top : documents.find(f => f.frameId === original.frameId);
                        if (!executed && live?.documentId !== originalDocumentId) throw staleWait();
                        if (live) {
                            if (injected !== live.documentId) { await interruptible(deps.frames.inject(tabId, live), signal); injected = live.documentId; }
                            const reply = await interruptible(deps.api.sendToFrame(tabId, live, { kind: 'cmd', method: 'conditions', params: { ...run.req.params, ...expected, requestId: run.req.id + ':conditions' } }), signal);
                            const current = (await interruptible(deps.frames.list(tabId), signal)).find(f => f.frameId === live!.frameId);
                            if (!executed && current?.documentId !== originalDocumentId) throw staleWait();
                            if (reply?.ok && current?.documentId === live.documentId) {
                                for (const key of ['text', 'textGone']) if (typeof reply.result?.conditions?.[key] === 'boolean') checks[key] = reply.result.conditions[key];
                            }
                        }
                    } catch (error) { aborted(signal); if (error instanceof ProtocolError && ((!executed && error.code === 'STALE_ELEMENT') || !['FRAME_UNAVAILABLE', 'STALE_ELEMENT'].includes(error.code))) throw error; }
                }
                const met = keys.filter(k => checks[k] === true);
                if (expected.match === 'all' ? met.length === keys.length : met.length > 0) {
                    const current = await interruptible(getTab(deps.api, tabId), signal);
                    if (current.pendingUrl || current.url !== tab.url) continue;
                    if (live) {
                        const finalFrame = (await interruptible(deps.frames.list(tabId), signal)).find(f => f.frameId === live!.frameId);
                        if (!executed && finalFrame?.documentId !== originalDocumentId) throw staleWait();
                        if (finalFrame?.documentId !== live.documentId) continue;
                    }
                    return {
                        ...(action ?? { executed: false }),
                        verified: {
                            ...(action?.verified ?? {}), met: expected.match === 'all' ? 'all' : met[0], conditions: met,
                            ...(executed ? { expectationMet: true, urlChanged: action?.verified?.urlChanged === true || (sourceUrl !== undefined && tab.url !== sourceUrl) || (live !== undefined && live.documentId !== originalDocumentId) } : {}),
                        },
                        elapsedMs: Date.now() - started,
                    };
                }
                await interruptible(new Promise(r => setTimeout(r, 100)), signal);
            }
        })(), signal);
    } catch (error) {
        if (executed && error instanceof ProtocolError) throw new ProtocolError(error.code, error.message, 'never', { ...(error.details && typeof error.details === 'object' ? error.details : {}), executed: true, expectationMet: false });
        throw error;
    } finally { clearTimeout(timer); controller.abort(deps.cancelled()); run.controller.signal.removeEventListener('abort', cancel); }
}

export async function urlWait(
    deps: WaitDeps,
    tabId: number,
    p: Record<string, unknown>,
    run: WaitRunContext,
    prepare: () => Promise<FrameInfo>,
) {
    const signal = run.controller.signal;
    let frame: FrameInfo | undefined, finished = false, matched = false;
    let resolve!: (r: unknown) => void, reject!: (e: unknown) => void;
    const url = new Promise((r, j) => { resolve = r; reject = j; });
    const match = (t: chrome.tabs.Tab) => {
        if (t.url?.includes(String(p.urlIncludes))) {
            matched = true;
            resolve({ executed: false, verified: { met: 'urlIncludes' } });
        }
    };
    const off = deps.api.onTabUpdated((id, _change, t) => { if (id === tabId) match(t); });
    const timer = setTimeout(() => reject(new ProtocolError('TIMEOUT', 'The requested URL condition was not reached.', 'safe')), Math.max(50, deps.within(Math.min(Number(p.timeoutMs ?? 5000), 30000))));
    void url.catch(() => { });
    try {
        match(await getTab(deps.api, tabId));
        if (matched) return await interruptible(url, signal);
        const content = (async () => {
            if (p.text === undefined && p.textGone === undefined && p.refGone === undefined) return url;
            frame = await prepare();
            if (finished) return url;
            // URL is always the tab URL, even when content conditions use an iframe.
            const { urlIncludes: _url, ...contentParams } = p;
            return deps.sendWait(tabId, frame, contentParams);
        })().catch(e => {
            if (['STALE_ELEMENT', 'FRAME_UNAVAILABLE'].includes(deps.asError(e).code)) return url;
            throw e;
        });
        return await interruptible(Promise.race([url, content]), signal);
    } finally {
        finished = true;
        off();
        clearTimeout(timer);
        if (frame) void deps.api.sendToFrame(tabId, frame, { kind: 'cancel', requestId: run.req.id }).catch(() => { });
    }
}
