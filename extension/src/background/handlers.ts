import { ProtocolError, type Req, type RpcError } from '../protocol/envelope';
import type { SessionStore, Outcome } from './dedupe';
import type { ChromeApi, FrameInfo } from './chrome-api';
import { frameRouter, type FrameError } from './frames';
import { RefTable } from '../content/refs';
import { getTab, describeTab, requireWeb, isWeb, loadedTab, aborted, interruptible } from './tabs';
import { trackCreatedTabs } from './tab-routing';
const WRITE = new Set(['browser.click', 'browser.fill', 'browser.select', 'browser.press', 'browser.scroll', 'browser.navigate', 'browser.tabs.create', 'browser.tabs.close']);
const CONTENT = new Set(['browser.click', 'browser.fill', 'browser.select', 'browser.press', 'browser.scroll', 'browser.wait', 'browser.extract']);
const cancelled = () => new ProtocolError('CANCELLED', 'This browser command was stopped.');
const asError = (e: unknown) => e instanceof ProtocolError ? e : new ProtocolError('INTERNAL', String(e));
const unpack = (outcome: Outcome): unknown => { if (outcome.ok)
    return outcome.result; const e = outcome.error; throw new ProtocolError(e.code, e.message, e.retry, e.details); };
type Running = {
    req: Req;
    controller: AbortController;
    started: boolean;
    promise: Promise<unknown>;
};
export function createHandlers(api: ChromeApi, store: SessionStore) {
    const frames = frameRouter(api, store), running = new Map<string, Running>();
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
            return {...result,...children};
        }
        return response.result;
    }
    async function requireSnapshot(p:Record<string,unknown>, tabId?:number, documentId?:string) {
        if (!(await store.hasSnapshot(String(p.operationId),tabId,documentId)))
            throw new ProtocolError('STALE_ELEMENT','Take a fresh browser_snapshot for this operation before writing.');
    }
    async function dispatch(run: Running, snapshotAttempt = 0): Promise<unknown> {
        const { req, controller } = run, p = req.params, signal = controller.signal;
        await check(req, signal);
        if (req.method === 'browser.tabs.list')
            return { tabs: (await api.tabsQuery({})).map(describeTab) };
        if (req.method === 'browser.tabs.get') {
            const tab = await getTab(api, typeof p.tabId === 'number' ? p.tabId : undefined);
            requireWeb(tab.url);
            return describeTab(tab);
        }
        if (req.method === 'browser.tabs.create') {
            const url = String(p.url ?? '');
            requireWeb(url);
            await requireSnapshot(p);
            await check(req, signal);
            run.started = true;
            const created = await api.tabsCreate({ url, active: false });
            if (!created.id)
                throw new ProtocolError('EXECUTION_UNKNOWN', 'Chrome did not return a new tab ID.', 'unsafe');
            const tab = await loadedTab(api, created.id, async () => { }, signal);
            return describeTab(tab);
        }
        const tab = await getTab(api, Number(p.tabId));
        requireWeb(tab.url);
        await check(req, signal);
        const tabId = tab.id!;
        if (req.method === 'browser.tabs.close') {
            const documents = await frames.list(tabId);
            const top = documents.find(f => f.frameId === 0);
            if (!top) throw new ProtocolError('FRAME_UNAVAILABLE', 'Cannot check the document before closing.');
            await requireSnapshot(p, tabId, top.documentId);
            for (const frame of documents) {
                await frames.inject(tabId, frame);
                const response = await interruptible(api.sendToFrame(tabId, frame, {kind:'cmd', method:'close-check', params:{...p,requestId:req.id}}), signal);
                if (!response?.ok) throw new ProtocolError('ELEMENT_NOT_INTERACTABLE', 'A frame has edited controls or cannot be checked; preserve the tab.');
            }
            let resolve!: (value: unknown) => void;
            const removed = new Promise(r => { resolve = r; });
            const off = api.onTabRemoved(id => { if (id === tabId) resolve({closed:true}); });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await check(req, signal);
                run.started = true;
                // window.close preserves Chrome beforeunload/script-close rules.
                // A disappearing reply is expected; ONLY onRemoved confirms success.
                void api.sendToFrame(tabId, top, {kind:'cmd',method:'close',params:{...p,requestId:req.id}}).catch(() => {});
                const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new ProtocolError('EXECUTION_UNKNOWN', 'Closure was not confirmed. A browser warning or script-close restriction may be keeping the tab open. Inspect tabs; do not force-close or automatically retry.', 'unsafe')), 3000); });
                return await interruptible(Promise.race([removed, timeout]), signal);
            } finally { off(); clearTimeout(timer); }
        }
        if (req.method === 'browser.snapshot') {
            if (tab.status === 'loading') await loadedTab(api, tabId, async () => {}, signal);
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
                    const withDocument={...result,documentId:f.documentId,frameRef:`s${snapshotId}f${f.frameId}`};
                    const length=JSON.stringify(withDocument).length;
                    if(length>60_000)throw new ProtocolError('FRAME_UNAVAILABLE','The frame exceeded the snapshot response budget.');
                    if(used+length>60_000){framesNextOffset=index;break;}
                    results.push(withDocument);bindings.push(f);used+=length;
                }catch(e){
                    if(signal.aborted||asError(e).code==='CANCELLED')throw e;
                    const error:FrameError={frameId:f.frameId,url:f.url.slice(0,2048),code:'FRAME_UNAVAILABLE',message:asError(e).message.slice(0,500)};
                    const errorSize=JSON.stringify(error).length;
                    if(used+errorSize>60_000){framesNextOffset=index;break;}
                    errors.push(error);used+=errorSize;
                }
            }
            if(frameOffset===0&&!bindings.some(f=>f.frameId===0)) {
                if (snapshotAttempt < 2) return dispatch(run, snapshotAttempt + 1);
                throw new ProtocolError('FRAME_UNAVAILABLE','The top document could not be read.','safe',{frameErrors:errors});
            }
            const live = await frames.list(tabId);
            const current = await getTab(api, tabId);
            if (bindings.some(f => !live.some(now => now.frameId === f.frameId && now.documentId === f.documentId)) || current.url !== tab.url || current.status === 'loading') {
                if (snapshotAttempt < 2) return dispatch(run, snapshotAttempt + 1);
                throw new ProtocolError('FRAME_UNAVAILABLE', 'Navigation changed the snapshot repeatedly. Wait for the expected page state and take a fresh snapshot.', 'safe');
            }
            await store.bind(snapshotId,bindings.map(f=>({...f,tabId,operationId:String(p.operationId)})));
            return {snapshotId,url:tab.url?.slice(0,2048),title:tab.title?.slice(0,256),tabId,frames:results,frameErrors:errors,
                framesOffset:frameOffset,framesTotal:allFrames.length,framesNextOffset,framesTruncated:framesNextOffset!==null,
                limits:[...(Number(tab.url?.length)>2048?['url-truncated']:[]),...(Number(tab.title?.length)>256?['title-truncated']:[])],
                note:'DOM element list, not the accessibility tree. After navigation, sorting, pagination, or rerender, wait for expected text then snapshot again and identify the target by name/href; never reuse an element index. Use frameOffset, elementOffset, or text offset to continue truncated results.'};
        }
        if (req.method === 'browser.navigate') {
            const action = p.action ?? 'goto';
            if (action === 'goto')
                requireWeb(String(p.url ?? ''));
            const document = (await frames.list(tabId)).find(f=>f.frameId===0);
            const actions: Record<string, () => Promise<unknown>> = { goto: () => api.tabsUpdate(tabId, { url: String(p.url) }), back: () => api.tabsGoBack(tabId, document?.documentId), forward: () => api.tabsGoForward(tabId, document?.documentId), reload: () => api.tabsReload(tabId) };
            const act = actions[String(action)];
            if (!act)
                throw new ProtocolError('INVALID_PARAMS', 'Unknown navigation action.');
            await requireSnapshot(p,tabId,document?.documentId);
            const result = await loadedTab(api, tabId, async () => { await check(req, signal); run.started = true; return act(); }, signal, true);
            return { executed: true, verified: { url: result.url, title: result.title } };
        }
        if (req.method === 'browser.screenshot') {
            if (!tab.active)
                throw new ProtocolError('NEEDS_TAB_ACTIVATION', 'Activate the operation tab before taking a screenshot.');
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
            const ref = typeof p.ref === 'string' ? p.ref : typeof p.refGone === 'string' ? p.refGone : undefined;
            const frameRef=req.method==='browser.wait'&&typeof p.frameRef==='string'?p.frameRef:undefined;
            if(frameRef!==undefined)await frames.resolve(tabId,ref,String(p.operationId),frameRef);
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
            if (req.method === 'browser.wait' && typeof p.urlIncludes === 'string' && !frameRef && !ref)
                return urlWait(tabId, p, run, prepare);
            const frame = await prepare();
            return send(tabId, frame, req.method.slice('browser.'.length), p, run);
        }
        throw new ProtocolError('FORBIDDEN_METHOD', `Unknown browser method ${req.method}.`);
    }
    async function urlWait(tabId: number, p: Record<string, unknown>, run: Running, prepare: () => Promise<FrameInfo>) {
        const signal = run.controller.signal;
        let frame: FrameInfo | undefined;
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
                return send(tabId, frame, 'wait', p, run);
            })().catch(e => {
                if (['STALE_ELEMENT', 'FRAME_UNAVAILABLE'].includes(asError(e).code)) return url;
                throw e;
            });
            return await interruptible(Promise.race([url, content]), signal);
        }
        finally {
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
            const result = await interruptible(dispatch(run), controller.signal);
            if (claimed)
                await store.saveResult(req.id, { ok: true, result });
            return result;
        }
        catch (e) {
            let error = asError(e);
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
    return Object.assign(handle, { disconnect });
}
