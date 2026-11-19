import { captureRequestTarget, requestInstructions, completedRequest, resolveRequestTarget, listRequestTargets, TARGET_UNAVAILABLE } from '../src/sidepanel/request-target';

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
  expect(text.length).toBeLessThan(800);
});
it("tells the model ids are optional in a panel request but still names them", () => {
  const text = requestInstructions("req-1", { tabId: 7, windowId: 1 });
  expect(text.length).toBeLessThan(600);
  expect(text).toContain("requestId=req-1");
  expect(text).toMatch(/omit/i);
  expect(text).toContain("7");
});
it('only finishes on the submitted message response, not an old idle state or unrelated session',()=>{
  const lease={requestId:'r',messageId:'m',sessionId:'s'};
  expect(completedRequest(lease,[{info:{role:'assistant',sessionID:'s',parentID:'old',time:{completed:1}},parts:[]}])).toBe(false);
  expect(completedRequest(lease,[{info:{role:'assistant',sessionID:'other',parentID:'m',time:{completed:1}},parts:[]}])).toBe(false);
  expect(completedRequest(lease,[{info:{role:'assistant',sessionID:'s',parentID:'m',time:{completed:1},finish:'stop'},parts:[]}])).toBe(true);
});
it('does not release on an earlier final step when a newer step is incomplete',()=>{
  const info={role:'assistant',sessionID:'s',parentID:'m'};
  expect(completedRequest({sessionId:'s',messageId:'m'},[{info:{...info,time:{completed:1},finish:'stop'}},{info:{...info,time:{created:2}}}])).toBe(false);
});
it('accepts optional finish in completed v1 responses and rejects explicit nonterminal steps',()=>{
  const lease={sessionId:'s',messageId:'m'},info={role:'assistant',sessionID:'s',parentID:'m',time:{completed:1}};
  expect(completedRequest(lease,[{info}])).toBe(true);
  expect(completedRequest(lease,[{info:{...info,error:{name:'APIError'}}}])).toBe(true);
  expect(completedRequest(lease,[{info:{...info,finish:'tool-calls'}}])).toBe(false);
});
it("names the attached files the model may upload, and the ones it may not", () => {
  const text = requestInstructions("req-1", { tabId: 7, windowId: 1 }, ["a.pdf", "b.png"], ["huge.zip"]);
  expect(text).toContain("browser_upload");
  expect(text).toContain("a.pdf, b.png");
  expect(text).toContain("huge.zip");
  expect(requestInstructions("req-1", null)).not.toContain("browser_upload");
});

it('uses the automatic capture unchanged when nothing is chosen', async () => {
  const getLastFocused=vi.fn(async()=>({id:7,focused:true,type:'normal',tabs:[{id:31,active:true,url:'https://a.test'}]}));
  const get=vi.fn();
  vi.stubGlobal('chrome',{windows:{getLastFocused},tabs:{get}});
  expect(await resolveRequestTarget(null)).toEqual({tabId:31,windowId:7});
  expect(get).not.toHaveBeenCalled();
});
it('returns the chosen tab even when another window has focus', async () => {
  const getLastFocused=vi.fn();
  vi.stubGlobal('chrome',{windows:{getLastFocused},tabs:{get:vi.fn(async()=>({id:44,windowId:9,url:'https://popup.test/x'}))}});
  expect(await resolveRequestTarget(44)).toEqual({tabId:44,windowId:9});
  expect(getLastFocused).not.toHaveBeenCalled();
});
it.each([
  ['closed', async()=>{throw new Error('No tab with id: 44');}],
  ['a Chrome page', async()=>({id:44,windowId:9,url:'chrome://settings'})],
  ['still loading another page', async()=>({id:44,windowId:9,url:'https://a.test',pendingUrl:'https://b.test'})],
  ['an extension page', async()=>({id:44,windowId:9,url:'chrome-extension://abc/src/sidepanel/index.html'})],
])('refuses a chosen tab that is %s instead of falling back to another tab', async (_,get) => {
  const getLastFocused=vi.fn();
  vi.stubGlobal('chrome',{windows:{getLastFocused},tabs:{get:vi.fn(get)}});
  await expect(resolveRequestTarget(44)).rejects.toThrow(TARGET_UNAVAILABLE);
  expect(getLastFocused).not.toHaveBeenCalled();
});
it('lists web tabs of normal and popup-type windows and leaves out other pages', async () => {
  const getAll=vi.fn(async()=>[
    {id:1,type:'normal',focused:true,tabs:[{id:11,title:'Mail',url:'https://mail.test',active:true},{id:12,title:'Settings',url:'chrome://settings',active:false}]},
    {id:2,type:'popup',focused:false,tabs:[{id:21,title:'결재',url:'https://erp.test/approve',active:true}]},
    {id:3,type:'popup',focused:false,tabs:[{id:31,title:'AgentBrowser',url:'chrome-extension://abc/src/sidepanel/index.html',active:true}]},
  ]);
  vi.stubGlobal('chrome',{windows:{getAll}});
  expect(await listRequestTargets()).toEqual([
    {windowId:1,type:'normal',focused:true,tabs:[{tabId:11,title:'Mail',url:'https://mail.test',active:true}]},
    {windowId:2,type:'popup',focused:false,tabs:[{tabId:21,title:'결재',url:'https://erp.test/approve',active:true}]},
  ]);
  expect(getAll).toHaveBeenCalledWith({populate:true,windowTypes:['normal','popup']});
});
it('lists nothing when the windows API is unavailable', async () => {
  vi.stubGlobal('chrome',{});
  expect(await listRequestTargets()).toEqual([]);
});
it('starts the automatic capture synchronously, before any wait, so it sees the tab in focus at the click', () => {
  const getLastFocused=vi.fn(async()=>({id:4,focused:true,tabs:[{id:31,active:true,url:'https://a.test'}]}));
  vi.stubGlobal('chrome',{windows:{getLastFocused}});
  void resolveRequestTarget(null);
  expect(getLastFocused).toHaveBeenCalledTimes(1);
});
