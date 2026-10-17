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
        tabsRemove: async () => { }, tabsGoBack: async () => { }, tabsGoForward: async () => { }, tabsReload: async () => { },
        captureVisibleTab: async () => 'data:image/png;base64,AQID',
        listFrames: async (id) => frames.get(id) ?? [],
        inject: async (_id, frame) => frame,
        sendToFrame: async (tabId, frame, msg: any) => { sent.push({ tabId, frame, msg }); return { ok: true, result: msg.method === 'snapshot' ? { frameId: frame.frameId, elements: [{ ref: `s${msg.params.snapshotId.toString(36)}f${frame.frameId}e1`, name: 'Button' }], text: { content: 'fixture' } } : { executed: true, verified: { clicked: true } } }; },
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
    expect(frameRef).toBe(`s${snap.snapshotId.toString(36)}f7`);
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
    expect(await h(request('browser.tabs.get', { tabId: 3 }))).toMatchObject({tabId:3,attachable:false});
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
 const original=w.api.sendToFrame;w.api.sendToFrame=async(t,f,m:any)=>{const r=await original(t,f,m);if(m.method==='snapshot')r.result.text={content:'x'.repeat(20000)};return r;};
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
  w.api.sendToFrame=async()=>({ok:true,result:{}});
  w.api.tabsRemove=async id=>{closes++;removed(id);};
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

it('creates blank tabs without any page snapshot and routes a chosen window',async()=>{
 const w=world(),h=createHandlers(w.api,memorySessionStore()),create=vi.fn(w.api.tabsCreate);w.api.tabsCreate=create;
 expect(await h(request('browser.tabs.create',{windowId:10}))).toMatchObject({tabId:9,url:'about:blank'});
 expect(create).toHaveBeenCalledWith({url:'about:blank',active:false,windowId:10});
 expect(w.sent).toHaveLength(0);
});

it('review: edits to an earlier child during later checks preserve the same document',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());await firstRef(h);
  w.frames.get(1)!.push({frameId:2,documentId:'earlier',url:'https://example.test/form'},
    {frameId:3,documentId:'later',url:'https://example.test/form'});
  let dirty=false, closes=0;
  w.api.tabsRemove=async()=>{closes++;};
  const checks:number[]=[];
  w.api.sendToFrame=async(_id,frame,msg:any)=>{
    if(msg.method==='close') {closes++;throw Error('must preserve the tab');}
    checks.push(frame.frameId);
    if(frame.frameId===3) dirty=true;
    return {ok:frame.frameId!==2||!dirty};
  };
  await expect(h(request('browser.tabs.close'))).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
  expect(closes).toBe(0);
  expect(checks.filter(id=>id===2)).toHaveLength(2);
  expect(w.frames.get(1)![1]!.documentId).toBe('earlier');
});

it.each(['unavailable','replaced'] as const)('review: final close validation preserves a %s frame',async mode=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());await firstRef(h);
  w.frames.get(1)!.push({frameId:2,documentId:'child',url:'https://example.test/form'});
  let childChecks=0,closes=0;
  w.api.tabsRemove=async()=>{closes++;};
  w.api.sendToFrame=async(_id,frame,msg:any)=>{
    if(msg.method==='close') {closes++;throw Error('must preserve the tab');}
    if(frame.frameId===2&&++childChecks===2) {
      if(mode==='unavailable') return {ok:false};
      w.frames.get(1)![1]!.documentId='replacement';
    }
    return {ok:true};
  };
  await expect(h(request('browser.tabs.close'))).rejects.toMatchObject({code:mode==='unavailable'?'ELEMENT_NOT_INTERACTABLE':'FRAME_UNAVAILABLE'});
  expect(childChecks).toBe(2);
  expect(closes).toBe(0);
});

it('F5 reads a stable readable document while the tab is still loading',async()=>{
  vi.useFakeTimers();
  const w=world(),h=createHandlers(w.api,memorySessionStore());w.tabs.get(1)!.status='loading';
  let settled:any;
  const work=h(request('browser.snapshot')).then(r=>settled=r,e=>settled=e);
  try {await vi.advanceTimersByTimeAsync(3000);expect(settled).toMatchObject({loading:true,frames:[{text:{content:'fixture'}}]});}
  finally {h.disconnect();await work;vi.useRealTimers();}
});
it('F6 reports the new tab before its page finishes loading',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore()),ref=await firstRef(h);
  w.api.tabsCreate=async p=>{const t={id:9,windowId:10,url:p.url,status:'loading',active:false} as chrome.tabs.Tab;w.tabs.set(9,t);return t;};
  w.api.sendToFrame=async()=>({ok:true,result:{url:'https://example.test/heavy'}});
  vi.useFakeTimers();let settled:any;
  const work=h(request('browser.click',{ref,newTab:true})).then(r=>settled=r,e=>settled=e);
  try {await vi.advanceTimersByTimeAsync(1000);expect(settled).toMatchObject({executed:true,openedTabs:[{tabId:9,status:'loading'}]});}
  finally {h.disconnect();await work;vi.useRealTimers();}
});
it('F7 refGone plus a tab URL condition survives content unload',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore()),ref=await firstRef(h);
  w.api.sendToFrame=async()=>{throw Error('unloaded');};
  const work=h(request('browser.wait',{refGone:ref,urlIncludes:'/done',timeoutMs:2000})).then(r=>r,e=>e);
  await new Promise(r=>setTimeout(r,25));
  Object.assign(w.tabs.get(1)!,{url:'https://example.test/done'});
  for(const f of w.updates)f(1,{url:'https://example.test/done'},w.tabs.get(1)!);
  expect(await work).toMatchObject({verified:{met:'urlIncludes'}});
  expect(w.updates.size).toBe(0);
});
it('F13 unobserved history traversal returns a prompt unexecuted boundary',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());await firstRef(h);
  vi.useFakeTimers();let settled:any;
  const work=h(request('browser.navigate',{action:'forward'})).then(r=>settled=r,e=>settled=e);
  try {await vi.advanceTimersByTimeAsync(2100);expect(settled).toMatchObject({code:'ELEMENT_NOT_INTERACTABLE',details:{executed:false}});}
  finally {h.disconnect();await work;vi.useRealTimers();}
});
it('F10 waits for observed navigation when starting from about:blank',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());
  Object.assign(w.tabs.get(1)!,{url:'about:blank'});w.frames.set(1,[{frameId:0,documentId:'blank',url:'about:blank'}]);
  w.api.tabsUpdate=async()=>({...w.tabs.get(1)!});
  vi.useFakeTimers();let settled=false;
  const work=h(request('browser.navigate',{url:'https://example.test/done'})).then(()=>settled=true,()=>{});
  try {await vi.advanceTimersByTimeAsync(100);expect(settled).toBe(false);
    Object.assign(w.tabs.get(1)!,{url:'https://example.test/done'});
    for(const f of w.updates)f(1,{url:'https://example.test/done',status:'complete'},w.tabs.get(1)!);
    await work;expect(settled).toBe(true);
  }finally{h.disconnect();await work;vi.useRealTimers();}
});
it('F13 keeps waiting after a real navigation starts but loading takes longer',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());await firstRef(h);
  let started:((id:number)=>void)|undefined;
  const off=vi.fn();w.api.onNavigationStarted=fn=>{started=fn;return off;};
  w.api.tabsGoBack=async()=>{started?.(1);};
  vi.useFakeTimers();let settled=false;
  const work=h(request('browser.navigate',{action:'back'})).then(r=>{settled=true;return r;});
  try{
    await vi.advanceTimersByTimeAsync(2000);expect(settled).toBe(false);
    Object.assign(w.tabs.get(1)!,{url:'https://example.test/previous'});
    for(const f of w.updates)f(1,{status:'complete',url:'https://example.test/previous'},w.tabs.get(1)!);
    await expect(work).resolves.toMatchObject({executed:true});expect(off).toHaveBeenCalledOnce();
  }finally{h.disconnect();await work.catch(()=>{});vi.useRealTimers();}
});
it('F6 snapshot waits briefly for a newly created blank loading tab to commit',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());
  Object.assign(w.tabs.get(1)!,{url:'about:blank',pendingUrl:'https://example.test/1',status:'loading'});
  vi.useFakeTimers();let settled:any;
  const work=h(request('browser.snapshot')).then(r=>settled=r,e=>settled=e);
  try{
    await vi.advanceTimersByTimeAsync(100);expect(settled).toBeUndefined();
    Object.assign(w.tabs.get(1)!,{url:'https://example.test/1',pendingUrl:undefined});
    await vi.advanceTimersByTimeAsync(300);await work;
    expect(settled).toMatchObject({loading:true,frames:[{text:{content:'fixture'}}]});
  }finally{h.disconnect();await work;vi.useRealTimers();}
});
it('F9 explains why an operation-created blank tab is preserved',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());w.tabs.get(1)!.url='about:blank';
  await expect(h(request('browser.tabs.close'))).rejects.toMatchObject({code:'UNSUPPORTED_PAGE',message:expect.stringContaining('Blank tabs cannot be safely checked')});
  expect(w.sent).toHaveLength(0);
});
it('review R1 never reads the outgoing HTTP document while navigation is pending',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());
  Object.assign(w.tabs.get(1)!,{pendingUrl:'https://example.test/destination',status:'loading'});
  vi.useFakeTimers();let settled:any;
  const work=h(request('browser.snapshot')).then(r=>settled=r,e=>settled=e);
  try{await vi.advanceTimersByTimeAsync(2100);
    expect(w.sent).toHaveLength(0);
    expect(settled).toMatchObject({code:'FRAME_UNAVAILABLE',retry:'safe'});
  }finally{h.disconnect();await work;vi.useRealTimers();}
});
it('review R1 rejects a snapshot if a pending navigation begins during the read',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore()),send=w.api.sendToFrame;
  w.api.sendToFrame=async(...args)=>{const result=await send(...args);w.tabs.get(1)!.pendingUrl='https://example.test/next';return result;};
  vi.useFakeTimers();let settled:any;
  const work=h(request('browser.snapshot')).then(r=>settled=r,e=>settled=e);
  try{await vi.advanceTimersByTimeAsync(2100);expect(settled).toMatchObject({code:'FRAME_UNAVAILABLE'});}
  finally{h.disconnect();await work;vi.useRealTimers();}
});
it('review R2 recognizes same-URL history entry changes',async()=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());await firstRef(h);
  let key='entry-before';w.api.historyEntry=async()=>key;w.api.tabsGoBack=async()=>{key='entry-after';};
  vi.useFakeTimers();let settled:any;
  const work=h(request('browser.navigate',{action:'back'})).then(r=>settled=r,e=>settled=e);
  try{await vi.advanceTimersByTimeAsync(1600);expect(settled).toMatchObject({executed:true,verified:{url:'https://example.test/1'}});}
  finally{h.disconnect();await work;vi.useRealTimers();}
});
it.each(['back','forward'])('review R9 reports safe document loss before %s dispatch',async action=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore());await firstRef(h);
  w.api.historyEntry=async()=>{throw Error('No document with id doc1');};
  w.api.tabsGoBack=vi.fn();w.api.tabsGoForward=vi.fn();
  try{
    await expect(h(request('browser.navigate',{action}))).rejects.toMatchObject({code:'FRAME_UNAVAILABLE',retry:'safe',details:{executed:false}});
    expect(w.api.tabsGoBack).not.toHaveBeenCalled();expect(w.api.tabsGoForward).not.toHaveBeenCalled();
  }finally{h.disconnect();}
});
it.each(['refGone','frameRef'])('review R5 injection loss still observes the top URL with %s',async scope=>{
  const w=world(),h=createHandlers(w.api,memorySessionStore()),snap:any=await h(request('browser.snapshot'));
  w.api.inject=async()=>{throw Error('Document changed while injecting');};
  const condition=scope==='refGone'?{refGone:snap.frames[0].elements[0].ref}:{frameRef:snap.frames[0].frameRef,text:'destination'};
  const work=h(request('browser.wait',{...condition,urlIncludes:'/arrived',timeoutMs:1000})).then(r=>r,e=>e);
  await new Promise(r=>setTimeout(r,25));
  Object.assign(w.tabs.get(1)!,{url:'https://example.test/arrived'});
  for(const listener of w.updates)listener(1,{url:'https://example.test/arrived'},w.tabs.get(1)!);
  expect(await work).toMatchObject({verified:{met:'urlIncludes'}});expect(w.updates.size).toBe(0);
});
it('bounds a multi-frame Korean snapshot by UTF-8 bytes', async () => {
    const w = world();
    w.frames.set(1, [0, 1, 2, 3].map(frameId => ({ frameId, documentId: `doc-${frameId}`, url: 'https://example.test/1' })));
    w.api.sendToFrame = async (_tabId, frame, msg: any) => msg.method === 'snapshot'
        ? { ok: true, result: { frameId: frame.frameId, elements: [], text: { content: '가'.repeat(5000) } } }
        : { ok: true, result: {} };
    const h = createHandlers(w.api, memorySessionStore());
    const result: any = await h(request('browser.snapshot'));
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(30_000);
    expect(result.framesNextOffset).toBe(1);
});

it('navigates a web page without requiring a snapshot first', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    await expect(h(request('browser.navigate', { action: 'goto', url: 'https://example.test/next' }))).resolves.toMatchObject({ executed: true, verified: { url: 'https://example.test/next' } });
});

it('reports a click that navigated the document as executed, not unknown', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (tabId, frame, msg: any) => {
        if (msg.kind === 'cmd' && msg.method === 'click') {
            w.frames.set(1, [{ frameId: 0, documentId: 'doc-after', url: 'https://example.test/next' }]);
            throw Error('The message port closed before a response was received.');
        }
        return original(tabId, frame, msg);
    };
    await expect(h(request('browser.click', { ref }))).resolves.toMatchObject({ executed: true, verified: { navigated: true, urlChanged: true } });
});

it('keeps an unknown outcome when the document did not change', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (tabId, frame, msg: any) => {
        if (msg.kind === 'cmd' && msg.method === 'click') throw Error('The message port closed before a response was received.');
        return original(tabId, frame, msg);
    };
    await expect(h(request('browser.click', { ref }))).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
});

it('settles a loading tab before a follow-up snapshot reads it', async () => {
    const w = world(), tab = w.tabs.get(1)!;
    tab.status = 'loading';
    setTimeout(() => { tab.status = 'complete'; tab.url = 'https://example.test/next'; w.frames.set(1, [{ frameId: 0, documentId: 'doc-next', url: 'https://example.test/next' }]); }, 300);
    const h = createHandlers(w.api, memorySessionStore());
    const result: any = await h(request('browser.snapshot', { settleMs: 3000 }));
    expect(result.url).toBe('https://example.test/next');
});

it('keeps an unknown outcome when only a subframe disappeared after a click', async () => {
    const w = world(); w.frames.get(1)!.push({ frameId: 7, documentId: 'child', url: 'https://ads.test/slot' });
    const h = createHandlers(w.api, memorySessionStore());
    const snap: any = await h(request('browser.snapshot'));
    const ref = snap.frames.find((f: any) => f.frameId === 7).elements[0].ref;
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (tabId, frame, msg: any) => {
        if (msg.kind === 'cmd' && msg.method === 'click') { w.frames.set(1, [w.frames.get(1)![0]!]); throw Error('The message port closed before a response was received.'); }
        return original(tabId, frame, msg);
    };
    await expect(h(request('browser.click', { ref }))).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
});

it('reads a committed page without waiting for slow subresources to finish loading', async () => {
    const w = world(), tab = w.tabs.get(1)!;
    tab.status = 'loading';
    const h = createHandlers(w.api, memorySessionStore());
    const started = Date.now();
    const result: any = await h(request('browser.snapshot', { settleMs: 6000 }));
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.loading).toBe(true);
});

it('reports a JS navigation that starts after the observation window', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (tabId, frame, msg: any) => {
        if (msg.kind === 'cmd' && msg.method === 'click') {
            setTimeout(() => { (w.tabs.get(1) as any).pendingUrl = 'https://example.test/late'; }, 300);
            return { ok: true, result: { executed: true, verified: { urlChanged: false, domChanged: false } } };
        }
        return original(tabId, frame, msg);
    };
    await expect(h(request('browser.click', { ref }))).resolves.toMatchObject({ verified: { urlChanged: true, navigated: true, lateNavigation: true } });
});

it('does not hold a click that changed nothing for long', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (tabId, frame, msg: any) => msg.kind === 'cmd' && msg.method === 'click'
        ? { ok: true, result: { executed: true, verified: { urlChanged: false, domChanged: false } } } : original(tabId, frame, msg);
    const started = Date.now();
    const result: any = await h(request('browser.click', { ref }));
    expect(result.verified).toEqual({ urlChanged: false, domChanged: false });
    expect(Date.now() - started).toBeLessThan(2500);
});

it('watches for a late navigation after a key press that submitted a form', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (tabId, frame, msg: any) => {
        if (msg.kind === 'cmd' && msg.method === 'press') {
            setTimeout(() => { (w.tabs.get(1) as any).pendingUrl = 'https://example.test/results'; }, 300);
            return { ok: true, result: { executed: true, verified: { key: 'Enter', defaultApplied: true, defaultAction: 'submit', submitted: true } } };
        }
        return original(tabId, frame, msg);
    };
    await expect(h(request('browser.press', { ref, key: 'Enter' }))).resolves.toMatchObject({ verified: { submitted: true, navigated: true, lateNavigation: true } });
});

it('reports a query match across frames so frame 0 alone never reads as no match', async () => {
    const w = world(); w.frames.get(1)!.push({ frameId: 7, documentId: 'child', url: 'https://example.test/frame' });
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (tabId, frame, msg: any) => {
        if (msg.kind === 'cmd' && msg.method === 'snapshot') return { ok: true, result: frame.frameId === 0
            ? { frameId: 0, elements: [], text: { content: '' }, limits: ['query-no-match'], query: 'a-1' }
            : { frameId: 7, elements: [{ ref: `s${msg.params.snapshotId.toString(36)}f7e1`, name: 'A-1 취소' }], text: { content: 'A-1' }, limits: [], query: 'a-1' } };
        return original(tabId, frame, msg);
    };
    const h = createHandlers(w.api, memorySessionStore());
    const result: any = await h(request('browser.snapshot', { query: 'A-1' }));
    expect(result.queryMatched).toBe(true);
    expect(result.frames.find((f: any) => f.frameId === 0).limits).not.toContain('query-no-match');
});

it('keeps an executed click when it is cancelled during the late-navigation watch', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (tabId, frame, msg: any) => msg.kind === 'cmd' && msg.method === 'click'
        ? { ok: true, result: { executed: true, verified: { urlChanged: false, domChanged: false } } } : original(tabId, frame, msg);
    const work = h(request('browser.click', { ref }, 'late-click'));
    await new Promise(r => setTimeout(r, 200));
    await h(request('browser.cancel', { requestId: 'late-click', operationId: undefined, generation: undefined }));
    await expect(work).resolves.toMatchObject({ executed: true });
});

it('captures an inactive operation tab through trusted input when available', async () => {
    const w = world(); w.tabs.get(1)!.active = false;
    const capture = vi.spyOn(w.api, 'captureVisibleTab');
    const h = createHandlers(w.api, memorySessionStore(), { ensure: async () => true, screenshot: async () => 'data:image/png;base64,AAAA' });
    await firstRef(h);
    expect(await h(request('browser.screenshot'))).toEqual({ mimeType: 'image/png', base64: 'AAAA' });
    expect(capture).not.toHaveBeenCalled();
});

it('still asks for activation when trusted input is unavailable', async () => {
    const w = world(); w.tabs.get(1)!.active = false;
    const h = createHandlers(w.api, memorySessionStore(), { ensure: async () => false, screenshot: async () => 'data:image/png;base64,AAAA' });
    await firstRef(h);
    await expect(h(request('browser.screenshot'))).rejects.toMatchObject({ code: 'NEEDS_TAB_ACTIVATION' });
});
