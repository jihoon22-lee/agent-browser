import { ProtocolError, type Req } from '../protocol/envelope';
import type { SessionStore } from './dedupe';
import type { ChromeApi, FrameInfo } from './chrome-api';
import type { FrameError } from './frames';
import { snapshotToken } from '../content/refs';
import { clipText } from '../content/text';
import { getTab, interruptible } from './tabs';

const SNAPSHOT_RESPONSE_BYTES = 28_000;
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export type SnapshotDeps = {
    api: ChromeApi;
    store: SessionStore;
    frames: { list(tabId: number): Promise<FrameInfo[]>; inject(tabId: number, frame: FrameInfo): Promise<unknown> };
    check: (req: Req, signal: AbortSignal) => Promise<void>;
    onPage: <T>(work: () => Promise<T>) => Promise<T>;
    hasFrameBudget: () => boolean;
    sendFrameSnapshot: (tabId: number, frame: FrameInfo, params: Record<string, unknown>) => Promise<any>;
    asError: (e: unknown) => ProtocolError;
    unanswered: (e: unknown) => boolean;
    errorPage: (url: string | undefined, executed: boolean) => ProtocolError;
    retry: (nextAttempt: number, deadline: number) => Promise<unknown>;
};

export async function readSnapshot(
    deps: SnapshotDeps,
    tab: chrome.tabs.Tab,
    tabId: number,
    req: Req,
    signal: AbortSignal,
    snapshotAttempt: number,
    snapshotDeadline: number,
): Promise<unknown> {
    const p = req.params;
    // A slow subresource must not prevent reading an already available DOM.
    const snapshotId = await deps.store.nextSnapshotId(), results: unknown[] = [], errors: FrameError[] = [], bindings: FrameInfo[] = [];
    const allFrames = (await deps.frames.list(tabId)).map(f => ({ ...f })).sort((a, b) => a.frameId - b.frameId);
    const frameOffset = Math.max(0, Number(p.frameOffset ?? 0));
    let used = 0, framesNextOffset: number | null = null;
    for (let index = frameOffset; index < allFrames.length; index++) {
        const f = allFrames[index]!;
        if (index - frameOffset >= 20) { framesNextOffset = index; break; }
        // Out of time after the first frame: hand back what was read; frameOffset reads on.
        if (index > frameOffset && !deps.hasFrameBudget()) { framesNextOffset = index; break; }
        await deps.check(req, signal);
        try {
            // Injection into a page blocked by a dialog never returns either.
            await deps.onPage(() => deps.frames.inject(tabId, f));
            const result = await deps.sendFrameSnapshot(tabId, f, {
                ...p, snapshotId, frameId: f.frameId, maxChars: p.maxChars ?? (f.frameId === 0 ? 4000 : 1000),
                offset: p.offset ?? 0, elementOffset: p.elementOffset ?? 0,
            });
            const withDocument = { ...result, documentId: f.documentId, frameRef: `s${snapshotToken(snapshotId)}f${f.frameId}` };
            const length = jsonBytes(withDocument);
            if (length > SNAPSHOT_RESPONSE_BYTES) throw new ProtocolError('FRAME_UNAVAILABLE', 'The frame exceeded the snapshot response budget.');
            if (used + length > SNAPSHOT_RESPONSE_BYTES) { framesNextOffset = index; break; }
            results.push(withDocument); bindings.push(f); used += length;
        } catch (e) {
            if (signal.aborted || deps.asError(e).code === 'CANCELLED') throw e;
            if (f.frameId === 0 && f.errorOccurred) throw deps.errorPage(tab.url, false);
            // A top document that does not answer at all will not answer a second attempt either.
            if (f.frameId === 0 && deps.unanswered(e)) throw e;
            const error: FrameError = { frameId: f.frameId, url: clipText(f.url, 2048), code: 'FRAME_UNAVAILABLE', message: clipText(deps.asError(e).message, 500) };
            const errorSize = jsonBytes(error);
            if (used + errorSize > SNAPSHOT_RESPONSE_BYTES) { framesNextOffset = index; break; }
            errors.push(error); used += errorSize;
        }
    }
    if (frameOffset === 0 && !bindings.some(f => f.frameId === 0)) {
        if (tab.status === 'loading' && Date.now() < snapshotDeadline) {
            await interruptible(new Promise(r => setTimeout(r, 50)), signal);
            return deps.retry(snapshotAttempt, snapshotDeadline);
        }
        if (snapshotAttempt < 2) return deps.retry(snapshotAttempt + 1, snapshotDeadline);
        throw new ProtocolError('FRAME_UNAVAILABLE', 'The top document could not be read.', 'safe', { frameErrors: errors });
    }
    const live = await deps.frames.list(tabId);
    const current = await getTab(deps.api, tabId);
    if (bindings.some(f => !live.some(now => now.frameId === f.frameId && now.documentId === f.documentId)) || current.url !== tab.url || current.pendingUrl) {
        if (snapshotAttempt < 2) return deps.retry(snapshotAttempt + 1, snapshotDeadline);
        throw new ProtocolError('FRAME_UNAVAILABLE', 'Navigation changed the snapshot repeatedly. Wait for the expected page state and take a fresh snapshot.', 'safe');
    }
    await deps.store.bind(snapshotId, bindings.map(f => ({ ...f, tabId, operationId: String(p.operationId) })));
    // A query answers for the whole page: a match in any frame clears every frame's "no match".
    const queryMatched = typeof p.query === 'string' && p.query.trim()
        // Totals count every match, not just the page returned (elementOffset/offset).
        ? results.some((f: any) => (f.elementsTotal ?? f.elements?.length ?? 0) > 0 || (f.text?.totalChars ?? (f.text?.content ? 1 : 0)) > 0) : undefined;
    if (queryMatched) for (const f of results as any[]) if (Array.isArray(f.limits)) f.limits = f.limits.filter((l: string) => l !== 'query-no-match');
    return {
        snapshotId, ...(queryMatched === undefined ? {} : { queryMatched }), loading: current.status === 'loading',
        url: tab.url === undefined ? undefined : clipText(tab.url, 2048), title: tab.title === undefined ? undefined : clipText(tab.title, 256),
        tabId, frames: results, frameErrors: errors,
        framesOffset: frameOffset, framesTotal: allFrames.length, framesNextOffset, framesTruncated: framesNextOffset !== null,
        limits: [...(Number(tab.url?.length) > 2048 ? ['url-truncated'] : []), ...(Number(tab.title?.length) > 256 ? ['title-truncated'] : [])],
        note: 'DOM element list, not the accessibility tree. After navigation, sorting, pagination, or rerender, wait for expected text then snapshot again and identify the target by name/href; never reuse an element index. Use frameOffset, elementOffset, or text offset to continue truncated results. Pass query to read only matching lines, rows and elements.',
    };
}
