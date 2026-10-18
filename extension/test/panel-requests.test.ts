import {panelRequests} from '../src/background/panel-requests';
import {OpenCodeApiError} from '../src/agents/opencode-v1/client';
const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('../src/agents/opencode-v1/client',async original=>({...await original<typeof import('../src/agents/opencode-v1/client')>(),OpenCodeV1Client:class {get=api.get;post=api.post;}}));
const lease=(id:string)=>({requestId:id,messageId:'msg-'+id,sessionId:'session-'+id,profileId:'native',directory:'/fixture'});
let storage:Record<string,any>,call:ReturnType<typeof vi.fn<(method:string,params:Record<string,unknown>)=>Promise<any>>>;
beforeEach(()=>{
  storage={};api.get.mockReset().mockResolvedValue([]);api.post.mockReset().mockResolvedValue({});
  call=vi.fn(async(method:string,_params:Record<string,unknown>)=>method==='runtime.status'?{state:'ready',baseUrl:'http://127.0.0.1:4444'}:{});
  vi.stubGlobal('chrome',{storage:{local:{get:async()=>({clientId:'browser',...structuredClone(storage)}),set:async(v:any)=>Object.assign(storage,v),remove:async(k:string)=>{delete storage[k]}}}});
});
afterEach(()=>vi.unstubAllGlobals());
it('can stop a reservation after Chrome session storage is cleared on restart',async()=>{
  const durable:Record<string,any>={clientId:'browser'};let transient:Record<string,any>={};
  (chrome.storage as any).local={get:async()=>structuredClone(durable),set:async(v:any)=>Object.assign(durable,v),remove:async(k:string)=>{delete durable[k];}};
  (chrome.storage as any).session={get:async()=>structuredClone(transient),set:async(v:any)=>Object.assign(transient,v),remove:async(k:string)=>{delete transient[k];}};
  await panelRequests(call).prepare(lease('one'),null);transient={};
  await panelRequests(call).cancel(lease('one'));
  expect(call).toHaveBeenCalledWith('request.end',{requestId:'one',clientId:'browser',abort:true});
});
it('releases a deleted session after closing its gate even when abort returns 404',async()=>{
  storage.panelBrowserRequest=lease('one');api.post.mockRejectedValueOnce(new OpenCodeApiError(404,'deleted'));
  await expect(panelRequests(call).cancel(lease('one'))).resolves.toEqual({handled:true,abortSent:true});
  expect(storage.panelBrowserRequest).toBeUndefined();
});
it.each([404,500])('handles a disappeared owning session without clearing uncertain HTTP %i failures',async status=>{
  storage.panelBrowserRequest=lease('one');
  api.get.mockImplementation(async(path:string)=>{if(path==='/session/status')return {};throw new OpenCodeApiError(status,'fixture');});
  const preparing=panelRequests(call).prepare(lease('two'),null);
  if(status===404){await preparing;expect(call).toHaveBeenCalledWith('request.end',{requestId:'one',clientId:'browser'});expect(storage.panelBrowserRequest).toEqual(lease('two'));}
  else {await expect(preparing).rejects.toThrow();expect(storage.panelBrowserRequest).toEqual(lease('one'));expect(call.mock.calls.some(([method])=>method==='request.end')).toBe(false);}
});
it('ignores a delayed cancellation for an older request in the same session',async()=>{
  storage.panelBrowserRequest=lease('one');
  await panelRequests(call).cancel({...lease('one'),requestId:'older'});
  expect(call).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled();
});
it('closes the browser gate even when runtime discovery fails during cancellation',async()=>{
  storage.panelBrowserRequest=lease('one');
  call.mockImplementation(async method=>{if(method==='runtime.status')throw Error('offline');return {};});
  await expect(panelRequests(call).cancel(lease('one'))).resolves.toEqual({handled:true,abortSent:false});
  expect(call).toHaveBeenCalledWith('request.end',{requestId:'one',clientId:'browser',abort:true});
  expect(storage.panelBrowserRequest).toBeUndefined();
});
it('pins submission target and serializes concurrent session requests',async()=>{
  const manager=panelRequests(call);
  const results=await Promise.allSettled([manager.prepare(lease('one'),{tabId:11,windowId:1}),manager.prepare(lease('two'),{tabId:22,windowId:2})]);
  expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);
  expect(call.mock.calls.filter(c=>c[0]==='request.begin')).toEqual([['request.begin',{requestId:'one',clientId:'browser',tabId:11,profileId:'native',sessionId:'session-one',directory:'/fixture'}]]);
  expect(storage.panelBrowserRequest.requestId).toBe('one');
});
it('after a worker restart, releases only a completed matching response and captures the new tab',async()=>{
  await panelRequests(call).prepare(lease('one'),{tabId:11,windowId:1});
  api.get.mockImplementation(async(path:string)=>path==='/session/status'?{}:[{info:{role:'assistant',sessionID:'session-one',parentID:'msg-one',time:{completed:1},finish:'stop'}}]);
  await panelRequests(call).prepare(lease('two'),{tabId:22,windowId:2});
  expect(call.mock.calls.filter(c=>c[0].startsWith('request.'))).toEqual([
    ['request.begin',{requestId:'one',clientId:'browser',tabId:11,profileId:'native',sessionId:'session-one',directory:'/fixture'}],
    ['request.end',{requestId:'one',clientId:'browser'}],
    ['request.begin',{requestId:'two',clientId:'browser',tabId:22,profileId:'native',sessionId:'session-two',directory:'/fixture'}],
  ]);
});
it.each(['busy','retry'])('does not end a %s session even if an earlier assistant step completed',async type=>{
  storage.panelBrowserRequest=lease('one');
  api.get.mockImplementation(async(path:string)=>path==='/session/status'?{'session-one':{type}}:[{info:{role:'assistant',sessionID:'session-one',parentID:'msg-one',time:{completed:1}}}]);
  await expect(panelRequests(call).prepare(lease('two'),null)).rejects.toThrow();
  expect(call.mock.calls.some(c=>c[0]==='request.end')).toBe(false);
});
it('does not cancel another selected session and closes the owner gate before aborting',async()=>{
  storage.panelBrowserRequest=lease('one');const manager=panelRequests(call);
  await manager.cancel(lease('two'));expect(api.post).not.toHaveBeenCalled();
  await manager.cancel(lease('one'));expect(api.post).toHaveBeenCalledWith('/session/session-one/abort');
  expect(call).toHaveBeenCalledWith('request.end',{requestId:'one',clientId:'browser',abort:true});
  expect(storage.panelBrowserRequest).toBeUndefined();
  expect(call.mock.invocationCallOrder.at(-1)).toBeLessThan(api.post.mock.invocationCallOrder[0]!);
});
it('discards only an unsent request with the exact token without aborting a session',async()=>{
  storage.panelBrowserRequest=lease('one');const manager=panelRequests(call);
  await manager.discard('other');expect(storage.panelBrowserRequest).toBeDefined();
  await manager.discard('one');expect(storage.panelBrowserRequest).toBeUndefined();
  expect(api.post).not.toHaveBeenCalled();
});
it('keeps no ambiguous active default and never substitutes another tab',async()=>{
  await panelRequests(call).prepare(lease('one'),null);
  expect(call).toHaveBeenCalledWith('request.begin',{requestId:'one',clientId:'browser',tabId:null,profileId:'native',sessionId:'session-one',directory:'/fixture'});
});
it('keeps the lease when begin acknowledgement is lost, so Stop can recover it',async()=>{
  call.mockRejectedValueOnce(new Error('connection lost'));
  await expect(panelRequests(call).prepare(lease('one'),null)).rejects.toThrow();
  expect(storage.panelBrowserRequest).toEqual(lease('one'));
});
it('finishes only after an authoritative completed response in the owning session',async()=>{
  storage.panelBrowserRequest=lease('one');const manager=panelRequests(call);
  expect(await manager.finish(lease('two'))).toBe(false);
  expect(await manager.finish(lease('one'))).toBe(false);
  api.get.mockImplementation(async(path:string)=>path==='/session/status'?{}:[{info:{role:'assistant',sessionID:'session-one',parentID:'msg-one',time:{completed:1},finish:'stop'}}]);
  expect(await manager.finish(lease('one'))).toBe(true);
  expect(storage.panelBrowserRequest).toBeUndefined();
});

it.each(['deleted','stopped','error'])('F1 clears an unavailable %s lease without starting its runtime',async state=>{
  storage.panelBrowserRequest={...lease('one'),profileId:'old'};
  call.mockImplementation(async method=>{if(method==='runtime.status'){if(state==='deleted')throw Object.assign(Error('Unknown runtime profile'),{code:'INVALID_PARAMS'});return {state};}return {};});
  await panelRequests(call).prepare(lease('two'),null);
  expect(storage.panelBrowserRequest).toEqual(lease('two'));
  expect(call.mock.calls.some(([m])=>m==='runtime.ensure')).toBe(false);
});
it('F16 reconciles completed work without a panel and retains an incomplete request',async()=>{
  storage.panelBrowserRequest=lease('one');const manager=panelRequests(call);
  expect(await manager.reconcile()).toBe(false);
  api.get.mockImplementation(async path=>path==='/session/status'?{}:[{info:{role:'assistant',sessionID:'session-one',parentID:'msg-one',time:{completed:1},finish:'stop'}}]);
  expect(await manager.reconcile()).toBe(true);
  expect(storage.panelBrowserRequest).toBeUndefined();
});
it('F1 removes only the deleted profile lease',async()=>{
  storage.panelBrowserRequest=lease('one');const manager=panelRequests(call);
  await manager.removeProfile('other');expect(storage.panelBrowserRequest).toBeDefined();
  await manager.removeProfile('native');expect(storage.panelBrowserRequest).toBeUndefined();
});
it.each(['TIMEOUT','BROWSER_DISCONNECTED','INTERNAL'])('review R4 retains leases after transient discovery %s',async code=>{
  storage.panelBrowserRequest=lease('one');
  call.mockImplementation(async method=>{if(method==='runtime.status')throw Object.assign(Error('temporary'),{code});return {};});
  await expect(panelRequests(call).reconcile()).rejects.toThrow('temporary');
  expect(storage.panelBrowserRequest).toEqual(lease('one'));
  expect(call.mock.calls.some(([m])=>m==='request.end')).toBe(false);
});
it('review R4 preserves a starting runtime lease without launching it',async()=>{
  storage.panelBrowserRequest=lease('one');call.mockResolvedValue({state:'starting'});
  await expect(panelRequests(call).prepare(lease('two'),null)).rejects.toThrow();
  expect(storage.panelBrowserRequest).toEqual(lease('one'));
  expect(call.mock.calls.some(([m])=>m==='runtime.ensure'||m==='request.end')).toBe(false);
});
it('review R7 distinguishes a confirmed abort from unavailable connection discovery',async()=>{
  storage.panelBrowserRequest=lease('one');
  await expect(panelRequests(call).cancel(lease('one'))).resolves.toEqual({handled:true,abortSent:true});
  expect(api.post).toHaveBeenCalledOnce();
  storage.panelBrowserRequest=lease('two');call.mockImplementation(async method=>method==='runtime.status'?{state:'stopped'}:{});
  await expect(panelRequests(call).cancel(lease('two'))).resolves.toEqual({handled:true,abortSent:false});
  expect(api.post).toHaveBeenCalledOnce();
});
it.each(['reconcile','finish'] as const)('review R10 Stop bypasses a stalled %s probe and its stale result preserves a new lease',async method=>{
  storage.panelBrowserRequest=lease('one');const manager=panelRequests(call);
  let release!:(value:any)=>void,started!:()=>void;
  const probing=new Promise<void>(resolve=>{started=resolve;});
  call.mockImplementationOnce(async()=>{started();return new Promise(resolve=>{release=resolve;});});
  const poll=method==='reconcile'?manager.reconcile():manager.finish(lease('one'));
  await probing;
  const cancel=manager.cancel(lease('one'));
  try{
    for(let i=0;i<20;i++)await Promise.resolve();
    expect(call).toHaveBeenCalledWith('request.end',{requestId:'one',clientId:'browser',abort:true});
    await cancel;
    await manager.prepare(lease('two'),null);
    api.get.mockImplementation(async path=>path==='/session/status'?{}:[{info:{role:'assistant',sessionID:'session-one',parentID:'msg-one',time:{completed:1},finish:'stop'}}]);
    release({state:'ready',baseUrl:'http://127.0.0.1:4444'});
    expect(await poll).toBe(false);
    expect(storage.panelBrowserRequest).toEqual(lease('two'));
    expect(call.mock.calls.filter(([m])=>m==='request.end')).toHaveLength(1);
  }finally{release({state:'stopped'});await poll;await cancel;}
});
it('shares overlapping runtime probes so completion and the next request do not race the runtime lock',async()=>{
  storage.panelBrowserRequest=lease('one');const manager=panelRequests(call);
  let release!:(value:any)=>void,started!:()=>void;
  const probing=new Promise<void>(resolve=>{started=resolve;});
  let busy=false;
  call.mockImplementation(async method=>{
    if(method!=='runtime.status')return {};
    if(busy)return {state:'starting'};
    busy=true;started();return new Promise(resolve=>{release=value=>{busy=false;resolve(value);};});
  });
  api.get.mockImplementation(async path=>path==='/session/status'?{}:[{info:{role:'assistant',sessionID:'session-one',parentID:'msg-one',time:{completed:1},finish:'stop'}}]);
  const poll=manager.finish(lease('one'));
  await probing;
  const prepare=manager.prepare(lease('two'),null).then(value=>({value}),error=>({error}));
  for(let i=0;i<20;i++)await Promise.resolve();
  const probes=call.mock.calls.filter(([m])=>m==='runtime.status').length;
  release({state:'ready',baseUrl:'http://127.0.0.1:4444'});
  const [prepared,finished]=await Promise.all([prepare,poll]);
  expect(probes).toBe(1);
  expect(prepared).toMatchObject({value:{requestId:'two'}});
  expect(finished).toBe(false);
  expect(storage.panelBrowserRequest).toEqual(lease('two'));
});
it('does not cache a failed shared runtime probe across a later completion check',async()=>{
  storage.panelBrowserRequest=lease('one');const manager=panelRequests(call);
  call.mockRejectedValueOnce(Error('temporary disconnect'));
  await expect(manager.reconcile()).rejects.toThrow('temporary disconnect');
  expect(await manager.reconcile()).toBe(false);
  expect(call.mock.calls.filter(([m])=>m==='runtime.status')).toHaveLength(2);
  expect(storage.panelBrowserRequest).toEqual(lease('one'));
});
it('invalidates pending shared probes and blocks prepares while a profile mutation is active',async()=>{
  storage.panelBrowserRequest=lease('one');const manager=panelRequests(call);
  expect(typeof manager.manageProfile).toBe('function');
  let release!:(value:any)=>void,mutated!:()=>void,started!:()=>void;
  const probing=new Promise<void>(resolve=>{started=resolve;});
  call.mockImplementationOnce(async()=>{started();return new Promise(resolve=>{release=resolve;});});
  const poll=manager.finish(lease('one')).catch(error=>error);
  await probing;
  const prepare=manager.prepare(lease('two'),null).catch(error=>error);
  for(let i=0;i<20;i++)await Promise.resolve();
  const mutation=manager.manageProfile('native',()=>new Promise<void>(resolve=>{mutated=resolve;}));
  release({state:'ready',baseUrl:'http://127.0.0.1:4444'});
  expect(await prepare).toBeInstanceOf(Error);expect(await poll).toBeInstanceOf(Error);
  await expect(manager.prepare(lease('two'),null)).rejects.toThrow();
  expect(call.mock.calls.some(([m])=>m==='request.begin')).toBe(false);
  mutated();await mutation;
  api.get.mockImplementation(async path=>path==='/session/status'?{}:[{info:{role:'assistant',sessionID:'session-one',parentID:'msg-one',time:{completed:1},finish:'stop'}}]);
  await expect(manager.prepare(lease('two'),null)).resolves.toMatchObject({requestId:'two'});
  expect(call.mock.calls.filter(([m])=>m==='runtime.status')).toHaveLength(2);
});
it('closes a reservation if profile management starts while request.begin is in flight',async()=>{
  const manager=panelRequests(call);expect(typeof manager.manageProfile).toBe('function');
  let begun!:()=>void,release!:()=>void;
  const beginning=new Promise<void>(resolve=>{begun=resolve;});
  call.mockImplementation(async method=>{if(method==='request.begin'){begun();await new Promise<void>(resolve=>{release=resolve;});}return {};});
  const prepare=manager.prepare(lease('one'),null).catch(error=>error);await beginning;
  await manager.manageProfile('native',async()=>{});release();
  expect(await prepare).toBeInstanceOf(Error);
  expect(call).toHaveBeenCalledWith('request.end',{requestId:'one',clientId:'browser',abort:true});
  expect(storage.panelBrowserRequest).toBeUndefined();
});
it('background reconcile retains a busy request when one status probe reports error', async () => {
  storage.panelBrowserRequest = lease('one');
  api.get.mockImplementation(async (path: string) => path === '/session/status' ? { 'session-one': { type: 'busy' } } : []);
  call.mockImplementation(async (method: string) => method === 'runtime.status' ? { state: 'error', error: 'readiness probe failed' } : {});
  expect(await panelRequests(call).reconcile()).toBe(false);
  expect(call.mock.calls.some(([method]) => method === 'request.end')).toBe(false);
  expect(storage.panelBrowserRequest).toEqual(lease('one'));
});

it('reports a pending question or permission of the saved request session only', async () => {
  await panelRequests(call).prepare(lease('one'), { tabId: 11, windowId: 1 });
  api.get.mockImplementation(async (path: string) => path === '/question' ? [{ id: 'q1', sessionID: 'session-other' }]
    : path === '/permission' ? [{ id: 'p1', sessionID: 'session-one' }] : {});
  await expect(panelRequests(call).attention()).resolves.toEqual({ waiting: true, kind: 'permission' });
  api.get.mockImplementation(async () => []);
  await expect(panelRequests(call).attention()).resolves.toEqual({ waiting: false });
});

it('treats an unreachable runtime as nothing to report', async () => {
  await panelRequests(call).prepare(lease('one'), { tabId: 11, windowId: 1 });
  call.mockImplementation(async (method: string) => { if (method === 'runtime.status') throw Error('offline'); return {}; });
  await expect(panelRequests(call).attention()).resolves.toEqual({ waiting: false });
});
it('registers the attached files for the request and forgets them when it ends', async () => {
  const {uploads}=await import('../src/background/uploads');
  const png={name:'a.png',mime:'image/png',dataUrl:'data:image/png;base64,AAAA'};
  const requests=panelRequests(call);
  const prepared=await requests.prepare(lease('one'),null,undefined,[png]);
  expect(prepared.system).toContain('a.png');
  expect(uploads.take('one','a.png')).toMatchObject({name:'a.png'});
  await requests.cancel(lease('one'));
  expect(uploads.take('one','a.png')).toBeUndefined();
});
it('names files the panel left out in the request instructions', async () => {
  const prepared=await panelRequests(call).prepare(lease('two'),null,undefined,[],['huge.zip']);
  expect(prepared.system).toContain('huge.zip');
});
