import { createHandlers } from '../src/background/handlers';
import { memorySessionStore } from '../src/background/dedupe';
import type { ChromeApi, FrameInfo } from '../src/background/chrome-api';
import { ProtocolError, type Req } from '../src/protocol/envelope';
const request = (method: string, params: Record<string, unknown> = {}, id: string = crypto.randomUUID()): Req => ({ v: 1, type: 'req', id, method, params: { operationId: 'op-1', generation: 1, tabId: 1, ...params } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function world() {
    const tabs = new Map<number, chrome.tabs.Tab>([1, 2, 3].map(id => [id, { id, windowId: 10, active: id === 1, url: id === 3 ? 'chrome://settings' : `https://example.test/${id}`, title: `Tab ${id}`, status: 'complete' } as chrome.tabs.Tab]));
    const frames = new Map<number, FrameInfo[]>([[1, [{ frameId: 0, documentId: 'doc1', url: 'https://example.test/1' }]], [2, [{ frameId: 0, documentId: 'doc2', url: 'https://example.test/2' }]]]);
    const sent: {
        tabId: number;
        frame: FrameInfo;
        msg: any;
    }[] = [];
    const updates = new Set<(id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void>();
    const activations = new Set<(info: chrome.tabs.OnActivatedInfo) => void>();
    const api: ChromeApi = {
        tabsQuery: async (q) => [...tabs.values()].filter(t => (!q.active || t.active) && (!q.windowId || t.windowId === q.windowId)),
        tabsGet: async (id) => { const t = tabs.get(id); if (!t)
            throw Error('No tab'); return { ...t }; },
        tabsCreate: async (p) => { const t = { id: 9, windowId: 10, active: p.active, url: p.url, title: 'New', status: 'complete' } as chrome.tabs.Tab; tabs.set(9, t); return t; },
        tabsUpdate: async (id, p) => { const t = tabs.get(id)!; Object.assign(t, p); return { ...t }; },
        tabsGoBack: async () => { }, tabsGoForward: async () => { }, tabsReload: async () => { },
        captureVisibleTab: async () => 'data:image/png;base64,AQID',
        listFrames: async (id) => frames.get(id) ?? [],
        inject: async (_id, frame) => frame,
        sendToFrame: async (tabId, frame, msg: any) => { sent.push({ tabId, frame, msg }); return { ok: true, result: msg.method === 'snapshot' ? { frameId: frame.frameId, elements: [{ ref: `s${msg.params.snapshotId}f${frame.frameId}e1`, name: 'Button' }], text: { content: 'fixture' } } : { executed: true, verified: { clicked: true } } }; },
        onTabUpdated: fn => { updates.add(fn); return () => { updates.delete(fn); }; },
        onTabActivated: fn => { activations.add(fn); return () => { activations.delete(fn); }; },
        onTabRemoved: () => () => {}, onCreatedNavigationTarget: () => () => {},
    };
    return { api, tabs, frames, sent, updates, activations };
}
async function firstRef(h: ReturnType<typeof createHandlers>, tabId = 1) {
    const result: any = await h(request('browser.snapshot', { tabId }));
    return result.frames[0].elements[0].ref as string;
}
it('waits in the snapshot-bound child document, rejects navigation and conflicting refs',async()=>{
    const w=world();w.frames.get(1)!.push({frameId:7,documentId:'child',url:'https://other.test/mail'});
    const h=createHandlers(w.api,memorySessionStore()),snap:any=await h(request('browser.snapshot'));
    const frameRef=snap.frames[1].frameRef;
    expect(frameRef).toBe(`s${snap.snapshotId}f7`);
    await expect(h(request('browser.wait',{frameRef:'',text:'body'}))).rejects.toMatchObject({code:'INVALID_PARAMS'});
    await h(request('browser.wait',{frameRef,text:'body',urlIncludes:'/mail'}));
    expect(w.sent.at(-1)?.frame.documentId).toBe('child');
    await expect(h(request('browser.wait',{frameRef,refGone:snap.frames[0].elements[0].ref}))).rejects.toMatchObject({code:'INVALID_PARAMS'});
    w.frames.get(1)![1]!.documentId='replacement';
    await expect(h(request('browser.wait',{frameRef,text:'body'}))).rejects.toMatchObject({code:'STALE_ELEMENT'});
});
it('lists tabs with attachability and returns flat tab metadata', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    expect(await h(request('browser.tabs.list'))).toMatchObject({ tabs: [{ tabId: 1, attachable: true }, { tabId: 2, attachable: true }, { tabId: 3, attachable: false }] });
    expect(await h(request('browser.tabs.get', { tabId: undefined }))).toMatchObject({ tabId: 1 });
    await firstRef(h);
    expect(await h(request('browser.tabs.create', { url: 'https://example.test/new' }))).toMatchObject({ tabId: 9, active: false });
});
it('rejects missing tabs and unsupported pages before injecting', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    await expect(h(request('browser.tabs.get', { tabId: 99 }))).rejects.toMatchObject({ code: 'TAB_NOT_FOUND' });
    await expect(h(request('browser.tabs.get', { tabId: 3 }))).rejects.toMatchObject({ code: 'UNSUPPORTED_PAGE' });
    w.tabs.get(1)!.url = 'https://chromewebstore.google.com/detail/x';
    await expect(h(request('browser.snapshot'))).rejects.toMatchObject({ code: 'UNSUPPORTED_PAGE' });
    expect(w.sent).toHaveLength(0);
});
it('refuses non-http navigation and new tabs before any side effect', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    await expect(h(request('browser.navigate', { url: 'file:///C:/x' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_PAGE' });
    await expect(h(request('browser.tabs.create', { url: 'javascript:alert(1)' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_PAGE' });
    expect(w.tabs.size).toBe(3);
});
it('returns partial snapshot errors and routes refs to their document', async () => {
    const w = world();
    w.frames.get(1)!.push({ frameId: 7, documentId: 'doc7', url: 'https://other.test/' }, { frameId: 8, documentId: 'doc8', url: 'about:blank' });
    w.api.inject = async (_, f) => { if (f.frameId === 8)
        throw Error('denied'); return f; };
    const h = createHandlers(w.api, memorySessionStore());
    const snap: any = await h(request('browser.snapshot'));
    expect(snap.frames.map((f: any) => f.frameId)).toEqual([0, 7]);
    expect(snap.frameErrors).toMatchObject([{ frameId: 8, code: 'FRAME_UNAVAILABLE' }]);
    await h(request('browser.click', { ref: snap.frames[1].elements[0].ref }));
    expect(w.sent.at(-1)).toMatchObject({ frame: { frameId: 7, documentId: 'doc7' }, msg: { params: { operationId: 'op-1', generation: 1 } } });
});
it('never resolves an old ref in another tab or replacement document', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const ref2 = await firstRef(h, 2);
    expect(ref).not.toBe(ref2);
    await expect(h(request('browser.click', { tabId: 2, ref }))).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
    w.frames.get(1)![0]!.documentId = 'replacement';
    await expect(h(request('browser.click', { ref }))).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
    expect(w.sent.filter(x => x.msg.method === 'click')).toHaveLength(0);
});
it('deduplicates concurrent writes as well as later replay', async () => {
    const w = world(), store = memorySessionStore(), h = createHandlers(w.api, store);
    const ref = await firstRef(h);
    const gate = deferred<any>();
    w.api.sendToFrame = async (tabId, frame, msg: any) => { w.sent.push({ tabId, frame, msg }); return msg.kind === 'input-state' ? {document:'doc1',epoch:0} : gate.promise; };
    const r = request('browser.click', { ref }, 'same-id');
    const a = h(r), b = h(r);
    await vi.waitFor(() => expect(w.sent.filter(x => x.msg.method === 'click')).toHaveLength(1));
    gate.resolve({ ok: true, result: { executed: true, verified: { count: 1 } } });
    expect(await a).toEqual(await b);
    expect(await h(r)).toEqual(await a);
    expect(w.sent.filter(x => x.msg.method === 'click')).toHaveLength(1);
});
it('worker restart never replays a write marked in flight', async () => {
    const w = world(), store = memorySessionStore();
    await store.markInFlight('lost');
    const h = createHandlers(w.api, store);
    await expect(h(request('browser.click', { ref: 's1f0e1' }, 'lost'))).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(w.sent).toHaveLength(0);
});
it('cached pre-execution errors stay errors on duplicate requests', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    w.api.sendToFrame = async () => ({ ok: false, error: { code: 'ELEMENT_NOT_INTERACTABLE', message: 'disabled', retry: 'never' } });
    const r = request('browser.click', { ref }, 'bad-click');
    await expect(h(r)).rejects.toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
    await expect(h(r)).rejects.toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
});
it('cancels pending wait immediately and permits a new operation after bridge restart', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    await firstRef(h);
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (t, f, m: any) => m.method === 'wait' ? new Promise(() => { }) : original(t, f, m);
    const waiting = h(request('browser.wait', { text: 'absent' }, 'waiting'));
    const failure = expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
    await h(request('browser.cancel', { operationId: 'op-1', generation: 2 }));
    await failure;
    await expect(h(request('browser.scroll', { direction: 'down' }))).rejects.toMatchObject({ code: 'CANCELLED' });
    await h(request('browser.snapshot',{operationId:'op-new-server',generation:1}));
    await expect(h(request('browser.scroll', { operationId: 'op-new-server', generation: 1, direction: 'down' }))).resolves.toMatchObject({ executed: true });
    expect(w.sent.some(x => x.msg.kind === 'cancel')).toBe(true);
});
it('a cancelled request cannot execute after an asynchronous injection finishes', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const gate = deferred<FrameInfo>();
    w.api.inject = async () => gate.promise;
    const work = h(request('browser.click', { ref }, 'queued'));
    const failure = expect(work).rejects.toMatchObject({ code: 'CANCELLED' });
    await h(request('browser.cancel', { requestId: 'queued', operationId: undefined, generation: undefined }));
    gate.resolve(w.frames.get(1)![0]!);
    await failure;
    expect(w.sent.filter(x => x.msg.method === 'click')).toHaveLength(0);
});
it('screenshot never captures an inactive tab and discards a switch-away-and-back', async () => {
    const w = world();
    let captures = 0;
    w.api.captureVisibleTab = async () => { captures++; for (const f of w.activations) {
        f({ tabId: 2, windowId: 10 });
        f({ tabId: 1, windowId: 10 });
    } return 'data:image/png;base64,AQID'; };
    const h = createHandlers(w.api, memorySessionStore());
    await expect(h(request('browser.screenshot', { tabId: 2 }))).rejects.toMatchObject({ code: 'NEEDS_TAB_ACTIVATION' });
    expect(captures).toBe(0);
    await expect(h(request('browser.screenshot'))).rejects.toMatchObject({ code: 'NEEDS_TAB_ACTIVATION' });
    expect(captures).toBe(1);
});
it('returns only PNG payload for a stable active tab', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    expect(await h(request('browser.screenshot'))).toEqual({ mimeType: 'image/png', base64: 'AQID' });
});
it('navigation waits for completion and records the resulting page', async () => {
    const w = world();
    w.api.tabsUpdate = async (id, p) => { Object.assign(w.tabs.get(id)!, p, { status: 'loading' }); return { ...w.tabs.get(id)! }; };
    const h = createHandlers(w.api, memorySessionStore());
    await firstRef(h);
    const work = h(request('browser.navigate', { url: 'https://example.test/new' }));
    await vi.waitFor(() => expect(w.tabs.get(1)!.status).toBe('loading'));
    Object.assign(w.tabs.get(1)!, { status: 'complete', title: 'Arrived' });
    for (const f of w.updates)
        f(1, { status: 'complete' }, w.tabs.get(1)!);
    expect(await work).toMatchObject({ executed: true, verified: { url: 'https://example.test/new', title: 'Arrived' } });
    expect(w.updates.size).toBe(0);
});
it('URL wait survives the old content document disappearing', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    w.api.sendToFrame = async () => { throw Error('document unloaded'); };
    const work = h(request('browser.wait', { urlIncludes: '/arrived', timeoutMs: 2000 }));
    await vi.waitFor(() => expect(w.updates.size).toBeGreaterThan(0));
    Object.assign(w.tabs.get(1)!, { url: 'https://example.test/arrived' });
    for (const f of w.updates)
        f(1, { url: 'https://example.test/arrived' }, w.tabs.get(1)!);
    expect(await work).toMatchObject({ verified: { met: 'urlIncludes' } });
    expect(w.updates.size).toBe(0);
});
it('disconnect cancels outstanding writes and does not execute queued effects', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const gate = deferred<any>();
    w.api.sendToFrame = async (_t, _f, m: any) => m.kind === 'cancel' ? { ok: true } : m.kind === 'input-state' ? {document:'doc1',epoch:0} : gate.promise;
    const work = h(request('browser.click', { ref }, 'disconnected'));
    const failed = expect(work).rejects.toBeInstanceOf(ProtocolError);
    await new Promise(r => setTimeout(r, 10));
    h.disconnect();
    await failed;
    gate.resolve({ ok: true, result: { executed: true } });
    await expect(h(request('browser.click', { ref }, 'disconnected'))).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
});
it('refGone succeeds after same-tab document replacement but rejects refs from another tab', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    w.frames.get(1)![0]!.documentId = 'replacement';
    await expect(h(request('browser.wait', { refGone: ref }))).resolves.toMatchObject({ verified: { met: 'refGone' } });
    await expect(h(request('browser.wait', { tabId: 2, refGone: ref }))).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
});
it('navigation API uncertainty is never reported as definitely unexecuted', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    await firstRef(h);
    w.api.tabsUpdate = async () => { throw Error('transport lost'); };
    await expect(h(request('browser.navigate', { url: 'https://example.test/new' }))).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN', retry: 'unsafe' });
});
it('URL-only wait works while the old document cannot be injected',async()=>{
 const w=world(),h=createHandlers(w.api,memorySessionStore());w.api.inject=async()=>{throw Error('document gone');};
 const work=h(request('browser.wait',{urlIncludes:'/ready',timeoutMs:1000}));
 const outcome=expect(work).resolves.toMatchObject({verified:{met:'urlIncludes'}});
 await new Promise(r=>setTimeout(r,10));
 for(const f of w.updates)f(1,{url:'https://example.test/ready'},{...w.tabs.get(1)!,url:'https://example.test/ready'});
 await outcome;
});
it('cancelling a navigation with an unresolved Chrome API call removes its listeners',async()=>{
 const w=world(),h=createHandlers(w.api,memorySessionStore());await firstRef(h);let called=false;
 w.api.tabsUpdate=async()=>{called=true;return new Promise(()=>{});};
 const work=h(request('browser.navigate',{url:'https://example.test/new'},'hanging-nav'));
 const failure=expect(work).rejects.toMatchObject({code:'EXECUTION_UNKNOWN'});
 await vi.waitFor(()=>expect(called).toBe(true));
 await h(request('browser.cancel',{requestId:'hanging-nav',operationId:undefined,generation:undefined}));await failure;
 expect(w.updates.size).toBe(0);
});
it('a new operation requires its own snapshot for old refs and ref-less writes',async()=>{
 const w=world(),h=createHandlers(w.api,memorySessionStore());const old=await firstRef(h);
 await h(request('browser.cancel',{operationId:'op-1',generation:2}));
 await expect(h(request('browser.click',{operationId:'op-2',ref:old}))).rejects.toMatchObject({code:'STALE_ELEMENT'});
 await expect(h(request('browser.scroll',{operationId:'op-2',direction:'down'}))).rejects.toMatchObject({code:'STALE_ELEMENT'});
 await h(request('browser.snapshot',{operationId:'op-2'}));
 await expect(h(request('browser.scroll',{operationId:'op-2',direction:'down'}))).resolves.toMatchObject({executed:true});
});
it('snapshot frame pagination bounds aggregate output and exposes all remaining frames',async()=>{
 const w=world();w.frames.set(1,Array.from({length:6},(_,frameId)=>({frameId,documentId:`d${frameId}`,url:`https://example.test/${frameId}`})));
 const original=w.api.sendToFrame;w.api.sendToFrame=async(t,f,m:any)=>{const r=await original(t,f,m);if(m.method==='snapshot')r.result.text={content:'x'.repeat(30000)};return r;};
 const h=createHandlers(w.api,memorySessionStore());const one:any=await h(request('browser.snapshot',{elementOffset:150}));
 expect(JSON.stringify(one).length).toBeLessThan(65536);
 expect(one.framesNextOffset).toBeGreaterThan(0);
 expect(w.sent[0]!.msg.params.elementOffset).toBe(150);
 const two:any=await h(request('browser.snapshot',{frameOffset:one.framesNextOffset}));
 expect(two.frames[0].frameId).toBe(one.framesNextOffset);
});

it('does not trust content-provided opened-tab metadata without a Chrome target event',async()=>{
 const w=world(),h=createHandlers(w.api,memorySessionStore());const ref=await firstRef(h);
 w.api.sendToFrame=async()=>({ok:true,result:{executed:true,openedTabs:[{tabId:99,sourceTabId:1,sourceFrameId:0,url:'https://other.test/'}]}});
 expect(await h(request('browser.click',{ref}))).toEqual({executed:true});
});

it.each(['unchanged','user-intervention','source-unavailable'] as const)('checks source input after a delayed child finishes loading: %s',async(mode)=>{
 const w=world(),h=createHandlers(w.api,memorySessionStore()),ref=await firstRef(h);
 let target!: Parameters<ChromeApi['onCreatedNavigationTarget']>[0];
 w.api.onCreatedNavigationTarget=fn=>{target=fn;return()=>{};};
 let epoch=0,unavailable=false;
 w.api.sendToFrame=async(_t,_f,msg:any)=>{
   if(msg.kind==='input-state'){if(unavailable)throw Error('source gone');return {document:'doc1',epoch};}
   target({tabId:9,sourceTabId:1,sourceFrameId:0,sourceProcessId:1,timeStamp:Date.now(),url:'about:blank'});
   return {ok:true,result:{executed:true}};
 };
 w.tabs.set(9,{id:9,windowId:10,active:false,status:'loading',url:'about:blank'} as chrome.tabs.Tab);
 const work=h(request('browser.click',{ref}));
 // The action has replied and the 100 ms target-event window has closed;
 // intervention during child loading must still prevent automatic adoption.
 await vi.waitFor(()=>expect(w.updates.size).toBe(1));
 if(mode==='user-intervention')epoch++;
 if(mode==='source-unavailable')unavailable=true;
 const child={...w.tabs.get(9)!,status:'complete',url:'https://example.test/child'} as chrome.tabs.Tab;
 for(const update of w.updates)update(9,{status:'complete'},child);
 const result:any=await work;
 if(mode==='unchanged')expect(result.openedTabs).toMatchObject([{tabId:9}]);
 else {expect(result.openedTabs).toBeUndefined();expect(result.openedTabWarnings).toEqual([{tabId:9,reason:mode}]);}
});

it('R05 advances iframe text pages using the returned cursor and requested budget', async () => {
    const w = world(); w.frames.get(1)!.push({ frameId: 7, documentId: 'doc7', url: 'https://other.test/' });
    const text = '0123456789'.repeat(300);
    w.api.sendToFrame = async (_, frame, msg: any) => {
        const {offset, maxChars} = msg.params;
        return {ok: true, result: {frameId: frame.frameId, text: {content: text.slice(offset, offset + maxChars), nextOffset: Math.min(text.length, offset + maxChars)}}};
    };
    const h = createHandlers(w.api, memorySessionStore());
    const first: any = await h(request('browser.snapshot', {maxChars: 1200}));
    const next: any = await h(request('browser.snapshot', {maxChars: 1200, offset: first.frames[1].text.nextOffset}));
    expect(first.frames[1].text.content).toHaveLength(1200);
    expect(next.frames[1].text.nextOffset).toBe(2400);
    expect(next.frames[1].text.content).toBe(text.slice(1200,2400));
});

it('retries only the snapshot when the top document changes during the read', async () => {
  const w = world(), original = w.api.sendToFrame;
  let reads = 0;
  w.api.sendToFrame = async (tab, frame, msg: any) => {
    const result = await original(tab, frame, msg);
    if (msg.method === 'snapshot' && ++reads === 1) {
      w.frames.get(1)![0]!.documentId = 'doc-new';
      w.tabs.get(1)!.url = 'https://example.test/new';
    }
    return result;
  };
  const h = createHandlers(w.api, memorySessionStore());
  const snap: any = await h(request('browser.snapshot'));
  expect(reads).toBe(2);
  expect(snap.frames[0].documentId).toBe('doc-new');
  expect(snap.url).toBe('https://example.test/new');
});
it('bounds snapshot retries when navigation never settles', async () => {
  const w = world(), original = w.api.sendToFrame;
  let reads = 0;
  w.api.sendToFrame = async (tab, frame, msg: any) => {
    const result = await original(tab, frame, msg);
    if (msg.method === 'snapshot') w.frames.get(1)![0]!.documentId = 'doc-' + ++reads;
    return result;
  };
  const h = createHandlers(w.api, memorySessionStore());
  await expect(h(request('browser.snapshot'))).rejects.toMatchObject({ code: 'FRAME_UNAVAILABLE', retry: 'safe' });
  expect(reads).toBe(3);
});

it('does not return old complete state after Chrome acknowledges navigation', async () => {
  const w = world(), h = createHandlers(w.api, memorySessionStore());
  await firstRef(h);
  w.api.tabsGoBack = async () => {
    setTimeout(() => {
      w.tabs.get(1)!.url = 'https://example.test/list';
      w.frames.get(1)![0]!.documentId = 'returned-list';
      for (const fn of w.updates) fn(1, {url:'https://example.test/list',status:'complete'}, w.tabs.get(1)!);
    }, 80);
  };
  expect(await h(request('browser.navigate', {action:'back'}))).toMatchObject({verified:{url:'https://example.test/list'}});
});

it('deduplicates confirmed tab close and requires a fresh operation snapshot', async () => {
  const w=world(), h=createHandlers(w.api,memorySessionStore());
  await expect(h(request('browser.tabs.close'))).rejects.toMatchObject({code:'STALE_ELEMENT'});
  await firstRef(h);
  let removed: (id:number)=>void = ()=>{}, closes=0;
  w.api.onTabRemoved=fn=>{removed=fn;return ()=>{};};
  w.api.sendToFrame=async (_tab,_frame,msg:any)=>{
    if(msg.method==='close') {closes++;removed(1);throw Error('document closed');}
    return {ok:true,result:{}};
  };
  const req=request('browser.tabs.close',{},'close-once');
  expect(await h(req)).toEqual({closed:true});
  expect(await h(req)).toEqual({closed:true});
  expect(closes).toBe(1);
});
it('edited child frame prevents close dispatch', async () => {
  const w=world(),h=createHandlers(w.api,memorySessionStore());await firstRef(h);
  w.frames.get(1)!.push({frameId:2,documentId:'child',url:'https://example.test/form'});
  const calls:string[]=[];
  w.api.sendToFrame=async (_tab,frame,msg:any)=>{calls.push(msg.method);return {ok:frame.frameId!==2};};
  await expect(h(request('browser.tabs.close'))).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
  expect(calls).toEqual(['close-check','close-check']);
});

it('review: missing top document never permits history to retarget the next document', async () => {
  const w=world(),h=createHandlers(w.api,memorySessionStore());await firstRef(h);
  w.frames.set(1,[]);
  const back=vi.fn(async()=>{throw Error('must not dispatch');});w.api.tabsGoBack=back;
  await expect(h(request('browser.navigate',{action:'back'}))).rejects.toMatchObject({code:'FRAME_UNAVAILABLE'});
  expect(back).not.toHaveBeenCalled();
});
it('review: replacing a checked child document prevents close dispatch',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());await firstRef(h);
  w.frames.get(1)!.push({frameId:2,documentId:'checked-child',url:'https://example.test/form'});
  const methods:string[]=[];
  w.api.sendToFrame=async(_id,frame,msg:any)=>{
    methods.push(msg.method);
    if(msg.method==='close-check'&&frame.frameId===2) w.frames.get(1)![1]!.documentId='unchecked-child';
    return {ok:true};
  };
  await expect(h(request('browser.tabs.close'))).rejects.toMatchObject({code:'FRAME_UNAVAILABLE'});
  expect(methods).not.toContain('close');
});
