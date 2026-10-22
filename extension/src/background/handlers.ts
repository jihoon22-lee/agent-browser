import { watchesLateNavigation } from './late-navigation';
import { ProtocolError, type Req, type RpcError } from '../protocol/envelope';
import type { SessionStore, Outcome } from './dedupe';
import type { ChromeApi, FrameInfo } from './chrome-api';
import { frameRouter, type FrameError } from './frames';
import { RefTable, snapshotToken } from '../content/refs';
import { getTab, describeTab, requireWeb, isWeb, loadedTab, aborted, interruptible } from './tabs';
import { readBookmarks } from './bookmarks';
import { trackCreatedTabs } from './tab-routing';
import { pageConditions, CONDITION_KEYS, type PageConditions } from '../protocol/conditions';
const WRITE = new Set(['browser.click', 'browser.upload', 'browser.fill', 'browser.select', 'browser.press', 'browser.scroll', 'browser.navigate', 'browser.tabs.create', 'browser.tabs.close']);
const CONTENT = new Set(['browser.click', 'browser.upload', 'browser.fill', 'browser.select', 'browser.press', 'browser.scroll', 'browser.wait', 'browser.extract']);
const SNAPSHOT_RESPONSE_BYTES = 28_000;
/** How long a click or key press that changed nothing is watched for a script navigation. */
const LATE_NAVIGATION_MS = 1000;
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const cancelled = () => new ProtocolError('CANCELLED', 'This browser command was stopped.');
const asError = (e: unknown) => e instanceof ProtocolError ? e : new ProtocolError('INTERNAL', String(e));
const unpack = (outcome: Outcome): unknown => { if (outcome.ok)
    return outcome.result; const e = outcome.error; throw new ProtocolError(e.code, e.message, e.retry, e.details); };
type Running = {
    req: Req;
    controller: AbortController;
    started: boolean;
    promise: Promise<unknown>;
    /** The action's confirmed result while only the late-navigation watch is still running. */
    confirmed?: unknown;
    /** Top document before child-frame input, to distinguish navigation from iframe removal. */
    sourceTopDocument?: string;
};
/** Trusted input, when the user enabled it: decides per tab whether clicks and keys go through the debugger. */
export type TrustedHooks = { ensure(tabId: number): Promise<boolean>; screenshot(tabId: number): Promise<string> };
/** The file of that name the person attached to the panel request now running, if any. */
export type AttachmentLookup = (name: string, panelRequestId: string | undefined) => Promise<{ name: string; mime: string; dataUrl: string } | undefined>;
const origin = (url: string | undefined) => { try { const value = url ? new URL(url).origin : "null"; return value === "null" ? undefined : value; } catch { return undefined; } };
export function createHandlers(api: ChromeApi, store: SessionStore, trusted?: TrustedHooks, attachment?: AttachmentLookup) {
    const frames = frameRouter(api, store), running = new Map<string, Running>();
    /** A link click may still be committing the next document; read the page it produced. Wait for
     * the commit, then give subresources only a short grace: slow ads must not delay a readable DOM. */
    async function settled(tabId: number, ms: number, signal: AbortSignal) {
        const deadline = Date.now() + Math.min(ms, 6000);
        let committedAt: number | undefined;
        while (Date.now() < deadline) {
            const tab = await getTab(api, tabId);
            if (tab.status === 'complete' && !tab.pendingUrl) return;
            if (!tab.pendingUrl && (await api.listFrames(tabId).catch(() => [] as FrameInfo[])).some(f => f.frameId === 0)) {
                committedAt ??= Date.now();
                if (Date.now() - committedAt >= 1500) return;
            } else committedAt = undefined;
            await interruptible(new Promise(r => setTimeout(r, 100)), signal);
        }
    }
    /** Hard navigation destroys the document before it can reply. A replaced document right after
     * a dispatched click or key press is that navigation, not an unknown outcome. */
    async function navigatedAway(tabId: number, frame: FrameInfo, sourceTopDocument?: string) {
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
            const tab = await api.tabsGet(tabId).catch(() => undefined);
            if (!tab) return false;
            const documents = await api.listFrames(tabId).catch(() => [] as FrameInfo[]);
            const live = documents.find(f => f.frameId === frame.frameId), top = documents.find(f => f.frameId === 0);
            // A subframe can vanish for unrelated reasons (rerender, closed ad slot); only a replaced
            // document, a missing top frame mid-commit, or a pending tab URL is evidence of navigation.
            if (tab.pendingUrl || (sourceTopDocument && top && top.documentId !== sourceTopDocument)
                || (live ? live.documentId !== frame.documentId : frame.frameId === 0)) return true;
            await new Promise(r => setTimeout(r, 100));
        }
        return false;
    }
    async function check(req: Req, signal: AbortSignal) {
        aborted(signal);
        if (await store.isCancelled(req.id, req.params))
            throw cancelled();
        aborted(signal);
    }
    async function send(tabId: number, frame: FrameInfo, method: string, params: Record<string, unknown>, run: Running) {
        await check(run.req, run.controller.signal);
        const tracksTabs = ['browser.click','browser.press'].includes(run.req.method);
        const inputState = async () => {
            try {
                const value: any = await interruptible(api.sendToFrame(tabId,frame,{kind:'input-state'}),run.controller.signal);
                return typeof value?.document === 'string' && Number.isSafeInteger(value?.epoch)
                    ? `${value.document}:${value.epoch}` : null;
            } catch { aborted(run.controller.signal); return null; }
        };
        const inputBefore = tracksTabs ? await inputState() : null;
        const startUrl = tracksTabs ? (await api.tabsGet(tabId).catch(() => undefined))?.url : undefined;
        if(tracksTabs && frame.frameId!==0 && run.req.params.waitFor)
            run.sourceTopDocument=(await interruptible(frames.list(tabId),run.controller.signal)).find(f=>f.frameId===0)?.documentId;
        // Off by default: only an enabled, attached debugger turns the content command into trusted input.
        if (tracksTabs && frame.frameId === 0 && trusted && await trusted.ensure(tabId).catch(() => false)) params = { ...params, trusted: true };
        await check(run.req, run.controller.signal);
        if (WRITE.has(run.req.method))
            run.started = true;
        const tabs = tracksTabs ? trackCreatedTabs(api,tabId,frame.frameId,run.controller.signal) : undefined;
        let response: any;
        try {
            response = await interruptible(api.sendToFrame(tabId, frame, { kind: 'cmd', method, params: { ...params, requestId: run.req.id } }), run.controller.signal);
        }
        catch (e) {
            tabs?.dispose();
            if (e instanceof ProtocolError)
                throw e;
            // An upload's change handler may submit or navigate too.
            if ((tracksTabs || run.req.method === 'browser.upload') && await navigatedAway(tabId, frame, run.sourceTopDocument))
                return { executed: true, verified: { navigated: true, urlChanged: true } };
            if (WRITE.has(run.req.method))
                throw new ProtocolError('EXECUTION_UNKNOWN', 'The document stopped replying after the command was sent. Take a snapshot before retrying.', 'unsafe');
            throw new ProtocolError('STALE_ELEMENT', 'The frame stopped replying. Take a fresh snapshot.');
        }
        if (!response?.ok) {
            tabs?.dispose();
            const e = response?.error as RpcError | undefined;
            if (e)
                throw new ProtocolError(e.code, e.message, e.retry, e.details);
            throw new ProtocolError('INTERNAL', 'Invalid content response.');
        }
        if (tabs) {
            // Only Chrome lifecycle metadata may claim a new tab; content replies
            // cannot nominate arbitrary user tabs as an action's descendants.
            const {openedTabs:_ignored,openedTabWarnings:_warnings,...result} = response.result ?? {};
            const children = await tabs.finish();
            if (children.openedTabs?.length) {
                // Check through the entire observation/load interval, even after
                // the action response. A user action in this frame is ambiguous.
                const inputAfter = await inputState();
                aborted(run.controller.signal);
                if (!inputBefore || inputBefore !== inputAfter) return {...result,openedTabWarnings:[
                    ...(children.openedTabWarnings ?? []),
                    ...children.openedTabs.map(tab => ({tabId:tab.tabId,reason:inputBefore && inputAfter ? 'user-intervention' : 'source-unavailable'})),
                ]};
            }
            const confirmed = {...result,...children};
            if (tracksTabs) run.confirmed = confirmed;
            return run.req.params.waitFor ? confirmed : lateNavigation(tabId, startUrl, confirmed, run.controller.signal);
        }
        // Only a click or key press is final once its frame replies; a snapshot still has frames to read.
        if (tracksTabs) run.confirmed = response.result;
        return run.req.params.waitFor ? response.result : lateNavigation(tabId, startUrl, response.result, run.controller.signal);
    }
    /** A script may navigate a moment after the click's own observation window closed. Only a
     * reply that saw no change at all is checked, and only for this observable tab condition. */
    async function lateNavigation(tabId: number, startUrl: string | undefined, result: any, signal: AbortSignal) {
        const verified = result?.verified;
        if (startUrl === undefined || !watchesLateNavigation(result)) return result;
        const deadline = Date.now() + LATE_NAVIGATION_MS;
        while (Date.now() < deadline && !signal.aborted) {
            const tab = await api.tabsGet(tabId).catch(() => undefined);
            if (!tab) return result;
            if (tab.pendingUrl || tab.url !== startUrl) return { ...result, verified: { ...verified, urlChanged: true, navigated: true, lateNavigation: true } };
            // The action already ran: a cancel during this watch ends the watch, not the result.
            try { await interruptible(new Promise(r => setTimeout(r, 100)), signal); } catch { return result; }
        }
        return result;
    }
    async function requireSnapshot(p:Record<string,unknown>, tabId?:number, documentId?:string) {
        if (!(await store.hasSnapshot(String(p.operationId),tabId,documentId)))
            throw new ProtocolError('STALE_ELEMENT','Take a fresh browser_snapshot for this operation before writing.');
    }
    async function dispatch(run: Running, snapshotAttempt = 0, snapshotDeadline = Date.now()+2000): Promise<unknown> {
        const { req, controller } = run, p = req.params, signal = controller.signal;
        await check(req, signal);
        const expected = p.waitFor == null ? undefined : pageConditions(p.waitFor);
        if(expected && (!['browser.click','browser.press'].includes(req.method)||p.newTab===true))
            throw new ProtocolError('INVALID_PARAMS','waitFor is for click/press in the same tab; newTab does not support it.');
        if(req.method==='browser.wait'&&p.match==='all'&&p.refGone!==undefined)
            throw new ProtocolError('INVALID_PARAMS','match=all supports text, textGone and urlIncludes. Wait for refGone separately.');
        if (req.method === 'browser.bookmarks') return readBookmarks(api.bookmarks,p);
        if (req.method === 'browser.tabs.list')
            return { tabs: (await api.tabsQuery(typeof p.windowId === 'number' ? {windowId:p.windowId} : {})).map(describeTab) };
        if (req.method === 'browser.windows.list')
            return {windows:(await api.windowsList?.() ?? []).map(w => ({windowId:w.id,focused:w.focused,state:w.state,type:w.type}))};
        if (req.method === 'browser.tabs.get') {
            const tab = await getTab(api, typeof p.tabId === 'number' ? p.tabId : undefined);
            return describeTab(tab);
        }
        if (req.method === 'browser.tabs.create') {
            const url = String(p.url ?? 'about:blank');
            if (url !== 'about:blank') requireWeb(url);
            const windowId = typeof p.windowId === 'number' ? p.windowId : typeof p.sourceTabId === 'number' ? (await getTab(api,p.sourceTabId)).windowId : undefined;
            await check(req, signal);
            run.started = true;
            const created = await api.tabsCreate({ url, active: false, ...(windowId === undefined ? {} : {windowId}) });
            if (!created.id)
                throw new ProtocolError('EXECUTION_UNKNOWN', 'Chrome did not return a new tab ID.', 'unsafe');
            const tab = await loadedTab(api, created.id, async () => { }, signal);
            return describeTab(tab);
        }
        const tab = await getTab(api, Number(p.tabId));
        const goto = req.method === 'browser.navigate' && (p.action ?? 'goto') === 'goto';
        if(req.method==='browser.snapshot'&&(tab.pendingUrl||(!isWeb(tab.url)&&tab.status==='loading'))){
            if(Date.now()>=snapshotDeadline)
                throw new ProtocolError('FRAME_UNAVAILABLE','Navigation has not committed. Wait for the destination document before taking a snapshot.','safe');
            await interruptible(new Promise(r=>setTimeout(r,50)),signal);
            return dispatch(run,snapshotAttempt,snapshotDeadline);
        }
        if(req.method==='browser.tabs.close'&&tab.url==='about:blank')
            throw new ProtocolError('UNSUPPORTED_PAGE','Blank tabs cannot be safely checked and are left open; navigate to an HTTP(S) page before closing, or leave the tab open.');
        if (!goto) requireWeb(tab.url);
        await check(req, signal);
        const tabId = tab.id!;
        if (req.method === 'browser.tabs.close') {
            const documents = (await frames.list(tabId)).map(frame => ({...frame}));
            const top = documents.find(f => f.frameId === 0);
            if (!top) throw new ProtocolError('FRAME_UNAVAILABLE', 'Cannot check the document before closing.');
            await requireSnapshot(p, tabId, top.documentId);
            const checkClean = async (frame: FrameInfo) => {
                const response = await interruptible(api.sendToFrame(tabId, frame, {kind:'cmd', method:'close-check', params:{...p,requestId:req.id}}), signal);
                if (!response?.ok) throw new ProtocolError('ELEMENT_NOT_INTERACTABLE', 'A frame has edited controls or cannot be checked; preserve the tab.');
            };
            const checkDocuments = async () => {
                const liveDocuments = await frames.list(tabId);
                if (liveDocuments.length !== documents.length || documents.some(frame => !liveDocuments.some(live => live.frameId === frame.frameId && live.documentId === frame.documentId)))
                    throw new ProtocolError('FRAME_UNAVAILABLE', 'A document changed during the close check. Preserve the tab and inspect a fresh snapshot.');
            };
            for (const frame of documents) {
                await frames.inject(tabId, frame);
                await checkClean(frame);
            }
            await checkDocuments();
            let resolve!: (value: unknown) => void;
            const removed = new Promise(r => { resolve = r; });
            const off = api.onTabRemoved(id => { if (id === tabId) resolve({closed:true}); });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await check(req, signal);
                // Earlier frames can become dirty while later frames are injected
                // and checked without changing documentId. Re-read every form once
                // after preflight, concurrently to avoid another sequential sweep.
                // This is bounded validation, never a retry of the close action.
                await Promise.all(documents.map(checkClean));
                await checkDocuments();
                aborted(signal);
                run.started = true;
                // Chrome's native close honors beforeunload even for existing
                // tabs and blank-created tabs with navigation history. Do not
                // await its promise (a cancelled dialog can leave it pending).
                // Only onRemoved confirms closure; never retry automatically.
                void api.tabsRemove(tabId).catch(()=>{});
                const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new ProtocolError('EXECUTION_UNKNOWN', 'Closure was not confirmed. A browser warning or another close restriction may be keeping the tab open. Inspect tabs; do not force-close or automatically retry.', 'unsafe')), 3000); });
                return await interruptible(Promise.race([removed, timeout]), signal);
            } finally { off(); clearTimeout(timer); }
        }
        if (req.method === 'browser.snapshot') {
            // A slow subresource must not prevent reading an already available DOM.
            const snapshotId = await store.nextSnapshotId(), results: unknown[] = [], errors: FrameError[] = [], bindings: FrameInfo[] = [];
            const allFrames = (await frames.list(tabId)).map(f => ({...f})).sort((a,b)=>a.frameId-b.frameId);
            const frameOffset = Math.max(0,Number(p.frameOffset??0));
            let used=0, framesNextOffset:number|null=null;
            for(let index=frameOffset;index<allFrames.length;index++) {
                const f=allFrames[index]!;
                if(index-frameOffset>=20){framesNextOffset=index;break;}
                await check(req,signal);
                try {
                    await frames.inject(tabId,f);
                    const result = await send(tabId,f,'snapshot',{...p,snapshotId,frameId:f.frameId,maxChars:p.maxChars??(f.frameId===0?4000:1000),offset:p.offset??0,elementOffset:p.elementOffset??0},run);
                    const withDocument={...result,documentId:f.documentId,frameRef:`s${snapshotToken(snapshotId)}f${f.frameId}`};
                    const length=jsonBytes(withDocument);
                    if(length>SNAPSHOT_RESPONSE_BYTES)throw new ProtocolError('FRAME_UNAVAILABLE','The frame exceeded the snapshot response budget.');
                    if(used+length>SNAPSHOT_RESPONSE_BYTES){framesNextOffset=index;break;}
                    results.push(withDocument);bindings.push(f);used+=length;
                }catch(e){
                    if(signal.aborted||asError(e).code==='CANCELLED')throw e;
                    const error:FrameError={frameId:f.frameId,url:f.url.slice(0,2048),code:'FRAME_UNAVAILABLE',message:asError(e).message.slice(0,500)};
                    const errorSize=jsonBytes(error);
                    if(used+errorSize>SNAPSHOT_RESPONSE_BYTES){framesNextOffset=index;break;}
                    errors.push(error);used+=errorSize;
                }
            }
            if(frameOffset===0&&!bindings.some(f=>f.frameId===0)) {
                if(tab.status==='loading'&&Date.now()<snapshotDeadline){
                    await interruptible(new Promise(r=>setTimeout(r,50)),signal);
                    return dispatch(run,snapshotAttempt,snapshotDeadline);
                }
                if (snapshotAttempt < 2) return dispatch(run, snapshotAttempt + 1,snapshotDeadline);
                throw new ProtocolError('FRAME_UNAVAILABLE','The top document could not be read.','safe',{frameErrors:errors});
            }
            const live = await frames.list(tabId);
            const current = await getTab(api, tabId);
            if (bindings.some(f => !live.some(now => now.frameId === f.frameId && now.documentId === f.documentId)) || current.url !== tab.url || current.pendingUrl) {
                if (snapshotAttempt < 2) return dispatch(run, snapshotAttempt + 1,snapshotDeadline);
                throw new ProtocolError('FRAME_UNAVAILABLE', 'Navigation changed the snapshot repeatedly. Wait for the expected page state and take a fresh snapshot.', 'safe');
            }
            await store.bind(snapshotId,bindings.map(f=>({...f,tabId,operationId:String(p.operationId)})));
            // A query answers for the whole page: a match in any frame clears every frame's "no match".
            const queryMatched = typeof p.query === 'string' && p.query.trim()
                // Totals count every match, not just the page returned (elementOffset/offset).
                ? results.some((f: any) => (f.elementsTotal ?? f.elements?.length ?? 0) > 0 || (f.text?.totalChars ?? (f.text?.content ? 1 : 0)) > 0) : undefined;
            if (queryMatched) for (const f of results as any[]) if (Array.isArray(f.limits)) f.limits = f.limits.filter((l: string) => l !== 'query-no-match');
            return {snapshotId,...(queryMatched === undefined ? {} : {queryMatched}),loading:current.status==='loading',url:tab.url?.slice(0,2048),title:tab.title?.slice(0,256),tabId,frames:results,frameErrors:errors,
                framesOffset:frameOffset,framesTotal:allFrames.length,framesNextOffset,framesTruncated:framesNextOffset!==null,
                limits:[...(Number(tab.url?.length)>2048?['url-truncated']:[]),...(Number(tab.title?.length)>256?['title-truncated']:[])],
                note:'DOM element list, not the accessibility tree. After navigation, sorting, pagination, or rerender, wait for expected text then snapshot again and identify the target by name/href; never reuse an element index. Use frameOffset, elementOffset, or text offset to continue truncated results. Pass query to read only matching lines, rows and elements.'};
        }
        if (req.method === 'browser.navigate') {
            const action = p.action ?? 'goto';
            if (action === 'goto')
                requireWeb(String(p.url ?? ''));
            const document = isWeb(tab.url) ? (await frames.list(tabId)).find(f=>f.frameId===0) : undefined;
            if (!document && (!goto || isWeb(tab.url))) throw new ProtocolError('FRAME_UNAVAILABLE', 'The top document is unavailable. Wait and take a fresh snapshot before navigating.');
            const actions: Record<string, () => Promise<unknown>> = { goto: () => api.tabsUpdate(tabId, { url: String(p.url) }), back: () => api.tabsGoBack(tabId, document?.documentId), forward: () => api.tabsGoForward(tabId, document?.documentId), reload: () => api.tabsReload(tabId) };
            const act = actions[String(action)];
            if (!act)
                throw new ProtocolError('INVALID_PARAMS', 'Unknown navigation action.');
            const result = await loadedTab(api, tabId, async () => { await check(req, signal); run.started = true; return act(); }, signal, true, action==='back'||action==='forward');
            return { executed: true, verified: { url: result.url, title: result.title } };
        }
        if (req.method === 'browser.screenshot') {
            if (!tab.active) {
                // Trusted input can capture a background tab without activating it.
                if (trusted && await trusted.ensure(tabId).catch(() => false)) {
                    const topDocument = async () => (await api.listFrames(tabId).catch(() => [])).find(f => f.frameId === 0)?.documentId;
                    const before = await topDocument();
                    const image = await interruptible(trusted.screenshot(tabId), signal), after = await getTab(api, tabId);
                    // Like the active-tab path: a page that changed during capture is never returned, even a same-address reload.
                    if (after.url !== tab.url || after.pendingUrl || after.windowId !== tab.windowId || before === undefined || await topDocument() !== before)
                        throw new ProtocolError('NEEDS_TAB_ACTIVATION', 'The tab changed during capture. The image was discarded.');
                    if (!image.startsWith('data:image/png;base64,')) throw new ProtocolError('INTERNAL', 'Chrome returned an invalid screenshot.');
                    return { mimeType: 'image/png', base64: image.slice('data:image/png;base64,'.length) };
                }
                throw new ProtocolError('NEEDS_TAB_ACTIVATION', 'Activate the operation tab before taking a screenshot.');
            }
            let changed = false;
            const off = api.onTabActivated(info => { if (info.windowId === tab.windowId && info.tabId !== tabId)
                changed = true; });
            const offUpdate = api.onTabUpdated((id, change) => { if (id === tabId && (change.url || change.status === 'loading'))
                changed = true; });
            try {
                const image = await interruptible(api.captureVisibleTab(tab.windowId), signal), after = await getTab(api, tabId);
                if (changed || !after.active || after.windowId !== tab.windowId || after.url !== tab.url)
                    throw new ProtocolError('NEEDS_TAB_ACTIVATION', 'The active tab changed during capture. The image was discarded.');
                if (!image.startsWith('data:image/png;base64,'))
                    throw new ProtocolError('INTERNAL', 'Chrome returned an invalid screenshot.');
                return { mimeType: 'image/png', base64: image.slice('data:image/png;base64,'.length) };
            }
            finally {
                off();
                offUpdate();
            }
        }
        if (CONTENT.has(req.method)) {
            // Resolve the attachment before touching the page: an unknown name never reaches it.
            const file = req.method === 'browser.upload' ? await attachment?.(String(p.file ?? ''), typeof p.panelRequestId === 'string' ? p.panelRequestId : undefined) : undefined;
            if (req.method === 'browser.upload' && !file)
                throw new ProtocolError('INVALID_PARAMS', `This request has no attachment named ${JSON.stringify(String(p.file ?? '').slice(0, 80))}; attach the file in the panel and send the request again.`);
            const ref = typeof p.ref === 'string' ? p.ref : typeof p.refGone === 'string' ? p.refGone : undefined;
            const frameRef=req.method==='browser.wait'&&typeof p.frameRef==='string'?p.frameRef:undefined;
            if(frameRef!==undefined)await frames.bound(tabId,ref,String(p.operationId),frameRef);
            if (typeof p.refGone === 'string') {
                const parsed = RefTable.parse(p.refGone);
                const binding = parsed ? await store.binding(parsed.snapshotId, parsed.frameId) : undefined;
                if (!binding || binding.operationId !== p.operationId || binding.tabId !== tabId)
                    throw new ProtocolError('STALE_ELEMENT', 'The ref does not belong to this tab.');
                const live = await frames.list(tabId);
                if (!live.some(f => f.frameId === binding.frameId && f.documentId === binding.documentId))
                    return { executed: false, verified: { met: 'refGone' } };
            }
            const prepare = async () => {
                const frame = await frames.resolve(tabId, ref, String(p.operationId),frameRef);
                if(WRITE.has(req.method))await requireSnapshot(p,tabId,frame.documentId);
                await frames.inject(tabId, frame);
                await check(req, signal);
                return frame;
            };
            if(req.method==='browser.wait'&&p.match==='all') {
                const frame=await prepare();
                return waitForConditions(tabId,frame,pageConditions(Object.fromEntries([...CONDITION_KEYS,'match','timeoutMs'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]))),run);
            }
            if (req.method === 'browser.wait' && typeof p.urlIncludes === 'string')
                return urlWait(tabId, p, run, prepare);
            const frame = await prepare();
            // A drag target is bound like the source ref: this operation and tab, and the same document.
            if (req.method === 'browser.click' && p.mode === 'drag' && typeof p.toRef === 'string') {
                const target = await frames.bound(tabId, p.toRef, String(p.operationId));
                if (target.frameId !== frame.frameId)
                    throw new ProtocolError('INVALID_PARAMS', 'toRef must be in the same frame as ref; dragging between frames is not supported.');
                if (target.documentId !== frame.documentId)
                    throw new ProtocolError('STALE_ELEMENT', 'toRef belongs to an old document. Take a new snapshot.');
            }
            // The person attached the file for the site they are on, not for an embedded frame from another site.
            if (file && (!origin(frame.url) || origin(frame.url) !== origin((await getTab(api, tabId)).url)))
                throw new ProtocolError('ELEMENT_NOT_INTERACTABLE', 'This file input is in a frame from another site; attachments are only uploaded to the page\'s own site.');
            if (req.method === 'browser.click' && p.newTab === true && p.mode !== undefined && p.mode !== 'click')
                throw new ProtocolError('INVALID_PARAMS', 'newTab opens a link with a plain click; omit mode.');
            if (req.method === 'browser.click' && p.newTab === true) {
                const link = await interruptible(api.sendToFrame(tabId,frame,{kind:'cmd',method:'link',params:{...p,requestId:req.id}}),signal);
                if (!link?.ok) { const e=link?.error; throw new ProtocolError(e?.code ?? 'ELEMENT_NOT_INTERACTABLE',e?.message ?? 'The ref is not an HTTP(S) anchor.'); }
                const url=String(link.result?.url ?? ''); requireWeb(url);
                await check(req,signal); run.started=true;
                const created=await api.tabsCreate({url,active:false,windowId:tab.windowId,openerTabId:tabId});
                if (!created.id) throw new ProtocolError('EXECUTION_UNKNOWN','New tab ID was not returned. Inspect tabs before retrying.','unsafe');
                // Register the created tab with the operation immediately. Loading
                // and page readiness are observed by later snapshot/wait calls.
                return {executed:true,openedTabs:[{...describeTab(created),pendingUrl:created.pendingUrl??(!isWeb(created.url)?url:undefined),sourceTabId:tabId,sourceFrameId:frame.frameId}]};
            }
            const result = await send(tabId, frame, req.method.slice('browser.'.length), file ? { ...p, file: undefined, panelRequestId: undefined, name: file.name, mime: file.mime, dataUrl: file.dataUrl } : p, run);
            if(expected)run.confirmed=result;
            return expected ? waitForConditions(tabId,frame,expected,run,result,tab.url) : result;
        }
        throw new ProtocolError('FORBIDDEN_METHOD', `Unknown browser method ${req.method}.`);
    }
    /** Re-read conditions in the current document; navigation retries only these read-only probes.
     * The click/key is never resent, and the whole waiter (including Chrome API calls) is bounded. */
    async function waitForConditions(tabId:number, original:FrameInfo, expected:PageConditions, run:Running, action?:any, sourceUrl?:string) {
        const executed=action!==undefined;
        if(action?.openedTabs?.length)throw new ProtocolError('ELEMENT_NOT_INTERACTABLE','The action opened another tab. Inspect its snapshot before waiting there.','never',{executed:true});
        const controller=new AbortController(),signal=controller.signal;
        const cancel=()=>controller.abort(run.controller.signal.reason??cancelled());
        run.controller.signal.addEventListener('abort',cancel,{once:true});
        if(run.controller.signal.aborted)cancel();
        const timer=setTimeout(()=>controller.abort(new ProtocolError('TIMEOUT','The requested page conditions were not met. Inspect the page before another action.',executed?'never':'safe',{executed,expectationMet:false})),expected.timeoutMs);
        const started=Date.now(),keys=CONDITION_KEYS.filter(k=>expected[k]!==undefined);
        let injected=original.documentId;
        try {
            return await interruptible((async()=>{
                while(true){
                    aborted(signal);
                    const tab=await interruptible(getTab(api,tabId),signal);
                    requireWeb(tab.url);
                    const checks:Record<string,boolean>={};
                    if(expected.urlIncludes!==undefined)checks.urlIncludes=!tab.pendingUrl&&!!tab.url?.includes(expected.urlIncludes);
                    let live:FrameInfo|undefined;
                    if(!tab.pendingUrl && (expected.text!==undefined||expected.textGone!==undefined)){
                        try{
                            const documents=await interruptible(frames.list(tabId),signal),top=documents.find(f=>f.frameId===0);
                            // A child can disappear without navigation. Follow frame 0 only after
                            // the enclosing document was actually replaced, including same-URL loads.
                            live=run.sourceTopDocument && top && top.documentId!==run.sourceTopDocument
                                ? top : documents.find(f=>f.frameId===original.frameId);
                            if(live){
                                if(injected!==live.documentId){await interruptible(frames.inject(tabId,live),signal);injected=live.documentId;}
                                const reply=await interruptible(api.sendToFrame(tabId,live,{kind:'cmd',method:'conditions',params:{...run.req.params,...expected,requestId:run.req.id+':conditions'}}),signal);
                                const current=(await interruptible(frames.list(tabId),signal)).find(f=>f.frameId===live!.frameId);
                                if(reply?.ok && current?.documentId===live.documentId) {
                                    for(const key of ['text','textGone'])if(typeof reply.result?.conditions?.[key]==='boolean')checks[key]=reply.result.conditions[key];
                                }
                            }
                        }catch(error){aborted(signal);if(error instanceof ProtocolError&&!['FRAME_UNAVAILABLE','STALE_ELEMENT'].includes(error.code))throw error;}
                    }
                    const met=keys.filter(k=>checks[k]===true);
                    if(expected.match==='all'?met.length===keys.length:met.length>0){
                        const current=await interruptible(getTab(api,tabId),signal);
                        if(current.pendingUrl||current.url!==tab.url)continue;
                        return {...(action??{executed:false}),verified:{...(action?.verified??{}),met:expected.match==='all'?'all':met[0],conditions:met,
                            ...(executed?{expectationMet:true,urlChanged:action?.verified?.urlChanged===true||(sourceUrl!==undefined&&tab.url!==sourceUrl)||(live!==undefined&&live.documentId!==original.documentId)}:{})},elapsedMs:Date.now()-started};
                    }
                    await interruptible(new Promise(r=>setTimeout(r,100)),signal);
                }
            })(),signal);
        }catch(error){
            if(executed && error instanceof ProtocolError)throw new ProtocolError(error.code,error.message,'never',{...(error.details&&typeof error.details==='object'?error.details:{}),executed:true,expectationMet:false});
            throw error;
        }finally{clearTimeout(timer);controller.abort(cancelled());run.controller.signal.removeEventListener('abort',cancel);}
    }
    async function urlWait(tabId: number, p: Record<string, unknown>, run: Running, prepare: () => Promise<FrameInfo>) {
        const signal = run.controller.signal;
        let frame: FrameInfo | undefined, finished=false;
        let resolve!: (r: unknown) => void, reject!: (e: unknown) => void;
        const url = new Promise((r, j) => { resolve = r; reject = j; });
        const match = (t: chrome.tabs.Tab) => { if (t.url?.includes(String(p.urlIncludes)))
            resolve({ executed: false, verified: { met: 'urlIncludes' } }); };
        const off = api.onTabUpdated((id, _change, t) => { if (id === tabId)
            match(t); });
        const timer = setTimeout(() => reject(new ProtocolError('TIMEOUT', 'The requested URL condition was not reached.', 'safe')), Math.min(Number(p.timeoutMs ?? 5000), 30000));
        void url.catch(() => { });
        try {
            match(await getTab(api, tabId));
            const content = (async () => {
                if (p.text === undefined && p.textGone === undefined && p.refGone === undefined) return url;
                frame = await prepare();
                if(finished)return url;
                // URL is always the tab URL, even when content conditions use an iframe.
                const {urlIncludes:_url,...contentParams}=p;
                return send(tabId, frame, 'wait', contentParams, run);
            })().catch(e => {
                if (['STALE_ELEMENT', 'FRAME_UNAVAILABLE'].includes(asError(e).code)) return url;
                throw e;
            });
            return await interruptible(Promise.race([url, content]), signal);
        }
        finally {
            finished=true;
            off();
            clearTimeout(timer);
            if (frame) void api.sendToFrame(tabId, frame, { kind: 'cancel', requestId: run.req.id }).catch(() => { });
        }
    }
    async function execute(run: Running) {
        const { req, controller } = run;
        let claimed = false;
        try {
            await check(req, controller.signal);
            if (WRITE.has(req.method)) {
                const entry = await store.claim(req.id);
                if (entry?.state === 'done')
                    return unpack(entry.outcome);
                if (entry)
                    throw new ProtocolError('EXECUTION_UNKNOWN', 'This request was interrupted before. Check the page before retrying.', 'unsafe');
                claimed = true;
            }
            if (req.method === 'browser.snapshot' && typeof req.params.settleMs === 'number')
                await settled(Number(req.params.tabId), req.params.settleMs, controller.signal);
            const result = await interruptible(dispatch(run), controller.signal);
            if (claimed)
                await store.saveResult(req.id, { ok: true, result });
            return result;
        }
        catch (e) {
            let error = asError(e);
            // Cancelled while only watching for a late navigation: the action ran and was confirmed.
            if (error.code === 'CANCELLED' && run.confirmed !== undefined) {
                if(req.params.waitFor)error=new ProtocolError('CANCELLED','Stopped after the action, before its expected page state was confirmed.','never',{executed:true,expectationMet:false});
                else {
                    if (claimed) await store.saveResult(req.id, { ok: true, result: run.confirmed });
                    return run.confirmed;
                }
            }
            if (run.started && error.code === 'INTERNAL')
                error = new ProtocolError('EXECUTION_UNKNOWN', 'The action was dispatched but its outcome could not be confirmed. Inspect the page before retrying.', 'unsafe');
            if (run.started && error.code === 'CANCELLED' && !(error.details as any)?.executed)
                error = new ProtocolError('EXECUTION_UNKNOWN', 'Stopped after dispatch; the action may have happened. Inspect the page before retrying.', 'unsafe');
            if (claimed)
                await store.saveResult(req.id, { ok: false, error: error.toRpc() });
            throw error;
        }
        finally {
            if (running.get(req.id) === run)
                running.delete(req.id);
        }
    }
    const handle = (req: Req): Promise<unknown> => {
        if (req.method === 'browser.cancel') {
            const p = req.params;
            const stored = store.cancel(p);
            for (const run of running.values())
                if ((p.requestId && p.requestId === run.req.id) || (p.operationId && p.operationId === run.req.params.operationId) || (!p.operationId && !p.requestId && typeof p.generation === 'number' && Number(run.req.params.generation) <= p.generation))
                    run.controller.abort(cancelled());
            frames.cancel(p);
            return stored.then(() => ({ ok: true }));
        }
        const duplicate = running.get(req.id);
        if (duplicate)
            return duplicate.promise;
        const run: Running = { req, controller: new AbortController(), started: false, promise: Promise.resolve() };
        running.set(req.id, run);
        run.promise = execute(run);
        return run.promise;
    };
    const disconnect = () => {
        for (const run of running.values()) {
            // Cache unknown outcomes for dispatched writes; do not mark the ID CANCELLED before a replay can read them.
            frames.cancel({ requestId: run.req.id });
            run.controller.abort(new ProtocolError(run.started ? 'EXECUTION_UNKNOWN' : 'BROWSER_DISCONNECTED', 'Bridge disconnected during the command.', run.started ? 'unsafe' : 'safe'));
        }
    };
    /** Whether a click or key press with this request id is executing on this tab right now. */
    const isRunning = (tabId: number, requestId: string, method: string) => {
        const run = running.get(requestId);
        return !!run && run.req.method === method && Number(run.req.params.tabId) === tabId;
    };
    return Object.assign(handle, { disconnect, isRunning });
}
