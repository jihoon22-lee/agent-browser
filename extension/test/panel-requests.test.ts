import {panelRequests} from '../src/background/panel-requests';
import {OpenCodeApiError} from '../src/agents/opencode-v1/client';
const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('../src/agents/opencode-v1/client',async original=>({...await original<typeof import('../src/agents/opencode-v1/client')>(),OpenCodeV1Client:class {get=api.get;post=api.post;}}));
const lease=(id:string)=>({requestId:id,messageId:'msg-'+id,sessionId:'session-'+id,profileId:'native',directory:'/fixture'});
let storage:Record<string,any>,call:ReturnType<typeof vi.fn<(method:string,params:Record<string,unknown>)=>Promise<any>>>;
beforeEach(()=>{
  storage={};api.get.mockReset().mockResolvedValue([]);api.post.mockReset().mockResolvedValue({});
  call=vi.fn(async(method:string,_params:Record<string,unknown>)=>method==='runtime.ensure'?{state:'ready',baseUrl:'http://127.0.0.1:4444'}:{});
  vi.stubGlobal('chrome',{storage:{local:{get:async()=>({clientId:'browser',...structuredClone(storage)}),set:async(v:any)=>Object.assign(storage,v),remove:async(k:string)=>{delete storage[k]}}}});
});
afterEach(()=>vi.unstubAllGlobals());
it('can stop a reservation after Chrome session storage is cleared on restart',async()=>{
  const durable:Record<string,any>={clientId:'browser'};let transient:Record<string,any>={};
  (chrome.storage as any).local={get:async()=>structuredClone(durable),set:async(v:any)=>Object.assign(durable,v),remove:async(k:string)=>{delete durable[k];}};
  (chrome.storage as any).session={get:async()=>structuredClone(transient),set:async(v:any)=>Object.assign(transient,v),remove:async(k:string)=>{delete transient[k];}};
  await panelRequests(call).prepare(lease('one'),null);transient={};
  await panelRequests(call).cancel(lease('one'));
  expect(call).toHaveBeenCalledWith('request.end',{requestId:'one',clientId:'browser'});
});
it('releases a deleted session after closing its gate even when abort returns 404',async()=>{
  storage.panelBrowserRequest=lease('one');api.post.mockRejectedValueOnce(new OpenCodeApiError(404,'deleted'));
  await expect(panelRequests(call).cancel(lease('one'))).resolves.toBe(true);
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
  call.mockImplementation(async method=>{if(method==='runtime.ensure')throw Error('offline');return {};});
  await expect(panelRequests(call).cancel(lease('one'))).rejects.toThrow('offline');
  expect(call).toHaveBeenCalledWith('request.end',{requestId:'one',clientId:'browser'});
  expect(storage.panelBrowserRequest).toEqual(lease('one'));
});
it('pins submission target and serializes concurrent session requests',async()=>{
  const manager=panelRequests(call);
  const results=await Promise.allSettled([manager.prepare(lease('one'),{tabId:11,windowId:1}),manager.prepare(lease('two'),{tabId:22,windowId:2})]);
  expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);
  expect(call.mock.calls.filter(c=>c[0]==='request.begin')).toEqual([['request.begin',{requestId:'one',clientId:'browser',tabId:11}]]);
  expect(storage.panelBrowserRequest.requestId).toBe('one');
});
it('after a worker restart, releases only a completed matching response and captures the new tab',async()=>{
  await panelRequests(call).prepare(lease('one'),{tabId:11,windowId:1});
  api.get.mockImplementation(async(path:string)=>path==='/session/status'?{}:[{info:{role:'assistant',sessionID:'session-one',parentID:'msg-one',time:{completed:1},finish:'stop'}}]);
  await panelRequests(call).prepare(lease('two'),{tabId:22,windowId:2});
  expect(call.mock.calls.filter(c=>c[0].startsWith('request.'))).toEqual([
    ['request.begin',{requestId:'one',clientId:'browser',tabId:11}],
    ['request.end',{requestId:'one',clientId:'browser'}],
    ['request.begin',{requestId:'two',clientId:'browser',tabId:22}],
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
  expect(call).toHaveBeenCalledWith('request.end',{requestId:'one',clientId:'browser'});
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
  expect(call).toHaveBeenCalledWith('request.begin',{requestId:'one',clientId:'browser',tabId:null});
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
