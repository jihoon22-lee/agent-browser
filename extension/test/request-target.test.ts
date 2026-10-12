import { captureRequestTarget, requestInstructions, completedRequest } from '../src/sidepanel/request-target';

afterEach(() => vi.unstubAllGlobals());
it('captures the focused window once, including a focused popup, without following later tab changes', async () => {
  const win={id:7,focused:true,type:'popup',tabs:[{id:31,active:true,url:'https://mail.test'}]};
  const getLastFocused=vi.fn(async()=>structuredClone(win));
  vi.stubGlobal('chrome',{windows:{getLastFocused}});
  const target=await captureRequestTarget();
  win.tabs[0]!.id=99;
  expect(target).toEqual({tabId:31,windowId:7});
  expect(getLastFocused).toHaveBeenCalledTimes(1);
});
it.each([
  {focused:false,tabs:[{id:1,active:true,url:'https://a.test'}]},
  {focused:true,tabs:[]},
  {focused:true,tabs:[{id:1,active:true,url:'chrome://settings'}]},
  {focused:true,tabs:[{id:1,active:true,url:'https://a.test',pendingUrl:'https://b.test'}]},
  {focused:true,tabs:[{id:1,active:true,url:'https://a.test'},{id:2,active:true,url:'https://b.test'}]},
])('does not invent a default for an ambiguous or unavailable window %#', async win=>{
  vi.stubGlobal('chrome',{windows:{getLastFocused:vi.fn(async()=>win)}});
  expect(await captureRequestTarget()).toBeNull();
});
it('keeps explicit user targets ahead of the captured default in request instructions',()=>{
  const text=requestInstructions('request-a',{tabId:31,windowId:7});
  expect(text).toContain('request-a');expect(text).toContain('explicit');expect(text).toContain('31');
});
it('only finishes on the submitted message response, not an old idle state or unrelated session',()=>{
  const lease={requestId:'r',messageId:'m',sessionId:'s'};
  expect(completedRequest(lease,[{info:{role:'assistant',sessionID:'s',parentID:'old',time:{completed:1}},parts:[]}])).toBe(false);
  expect(completedRequest(lease,[{info:{role:'assistant',sessionID:'other',parentID:'m',time:{completed:1}},parts:[]}])).toBe(false);
  expect(completedRequest(lease,[{info:{role:'assistant',sessionID:'s',parentID:'m',time:{completed:1}},parts:[]}])).toBe(true);
});
