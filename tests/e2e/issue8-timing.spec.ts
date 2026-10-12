import {test,expect} from '@playwright/test';
import {startWorld,type World} from './harness';
let world:World;
test.beforeAll(async()=>{world=await startWorld();console.log('WP3 runtime '+JSON.stringify(world.runtime));});
test.afterAll(async()=>{await world?.stop();});
test.afterEach(async()=>{
  const status=await world.admin('status.get');
  if(status.operation)await world.mcp.call('browser_tabs',{action:'release',operationId:status.operation.id});
  for(const page of world.context.pages())if(page!==world.adminPage)await page.close();
});
test('F5 returns a readable snapshot before a hanging subresource finishes',async()=>{
  const page=await world.context.newPage();
  await page.goto(world.fixture.base+'/issue8-loading.html',{waitUntil:'domcontentloaded'});
  const operationId=await world.attach(page),start=Date.now();
  const snap=await world.ok('browser_snapshot',{operationId});
  expect(Date.now()-start).toBeLessThan(15_000);
  expect(snap.data.loading).toBe(true);
  expect(snap.data.frames[0].text.content).toContain('Readable while loading');
  expect(snap.data.frames[0].elements.some((el:any)=>el.name==='Ready control')).toBe(true);
});
test('F6 registers a newTab click immediately and permits switching to its loading tab',async()=>{
  const page=await world.open('board.html');
  await page.evaluate(()=>{document.body.innerHTML='<a href="/issue8-loading.html">Heavy link</a>';});
  const operationId=await world.attach(page),snap=await world.ok('browser_snapshot',{operationId});
  const ref=snap.data.frames[0].elements.find((el:any)=>el.name==='Heavy link').ref;
  const start=Date.now(),clicked=await world.ok('browser_click',{operationId,ref,newTab:true});
  expect(Date.now()-start).toBeLessThan(15_000);
  const tabId=clicked.data.openedTabs[0].tabId;
  expect((await world.admin('status.get')).operation.tabs).toContain(tabId);
  await world.ok('browser_tabs',{action:'switch',operationId,tabId});
  // DOM readiness can follow tab creation; retry only the read.
  await expect.poll(async()=>{
    const read=await world.mcp.call('browser_snapshot',{operationId});
    return read.ok&&read.data.frames[0]?.text.content.includes('Readable while loading');
  }).toBe(true);
});
test('F7 waits on refGone OR the tab URL during form navigation',async()=>{
  const page=await world.open('board.html');
  await page.evaluate(()=>{
    document.body.innerHTML='<form action="/board.html"><input type="hidden" name="arrived" value="1"><button>Submit later</button></form>';
    document.querySelector('button')!.addEventListener('click',event=>{event.preventDefault();setTimeout(()=>document.querySelector('form')!.submit(),800);});
  });
  const operationId=await world.attach(page),snap=await world.ok('browser_snapshot',{operationId});
  const ref=snap.data.frames[0].elements.find((el:any)=>el.name==='Submit later').ref;
  // Different destination makes the tab URL condition observable.
  await page.locator('form').evaluate(el=>(el as HTMLFormElement).action='/board.html?arrived=1');
  await world.mcp.call('browser_click',{operationId,ref});
  const waited=await world.ok('browser_wait',{operationId,refGone:ref,urlIncludes:'arrived=1',timeoutMs:5000});
  expect(['refGone','urlIncludes']).toContain(waited.verified?.met);
});
for(const cross of [false,true])test(`F13 history end with hidden ${cross?'cross-origin':'about:blank'} entries returns promptly`,async()=>{
  const page=await world.open('board.html');
  if(cross)await page.goto(`http://127.0.0.1:${world.fixture.alt}/board.html`);
  const operationId=await world.attach(page);await world.ok('browser_snapshot',{operationId});
  const url=page.url(),start=Date.now(),result=await world.mcp.call('browser_navigate',{operationId,action:'forward'});
  expect(result.error).toMatchObject({code:'ELEMENT_NOT_INTERACTABLE',details:{executed:false}});
  expect(result.executed).toBe('no');expect(Date.now()-start).toBeLessThan(5000);expect(page.url()).toBe(url);
});
test('F13 back at the first entry with a hidden cross-origin forward entry is unexecuted',async()=>{
  const page=await world.context.newPage();
  await page.evaluate(url=>location.replace(url),world.fixture.base+'/board.html');
  await page.waitForURL('**/board.html');await page.waitForLoadState('load');
  await page.goto(`http://127.0.0.1:${world.fixture.alt}/board.html`);
  const operationId=await world.attach(page);await world.ok('browser_snapshot',{operationId});
  await world.ok('browser_navigate',{operationId,action:'back'});await world.ok('browser_snapshot',{operationId});
  const start=Date.now(),result=await world.mcp.call('browser_navigate',{operationId,action:'back'});
  expect(result.error).toMatchObject({code:'ELEMENT_NOT_INTERACTABLE',details:{executed:false}});
  expect(result.executed).toBe('no');expect(Date.now()-start).toBeLessThan(5000);
});
test('R1 pending HTTP navigation never snapshots the outgoing page',async()=>{
  const page=await world.open('board.html'),operationId=await world.attach(page);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/issue8-pending',async route=>{await gate;await route.fulfill({contentType:'text/html',body:'<h1>Destination committed</h1><button>Destination action</button>'});});
  const navigation=page.goto(world.fixture.base+'/issue8-pending');
  try{
    await expect.poll(()=>world.adminPage.evaluate(async url=>{
      const tabs=await (globalThis as any).chrome.tabs.query({});return tabs.some((tab:any)=>tab.pendingUrl===url);
    },world.fixture.base+'/issue8-pending')).toBe(true);
    const result=await world.mcp.call('browser_snapshot',{operationId});
    expect(result.error).toMatchObject({code:'FRAME_UNAVAILABLE',retry:'safe'});expect(result.data).toBeNull();
  }finally{release();await navigation;}
  expect((await world.ok('browser_snapshot',{operationId})).data.frames[0].text.content).toContain('Destination committed');
});
test('R2 same-URL SPA history changes are executed and true boundaries are not',async()=>{
  const page=await world.open('board.html'),url=page.url();
  await page.evaluate(()=>{
    history.replaceState({step:0},'');history.pushState({step:1},'');history.pushState({step:2},'');
    document.body.innerHTML='<h1>Step 2</h1>';
    addEventListener('popstate',()=>{document.querySelector('h1')!.textContent='Step '+history.state.step;});
  });
  const operationId=await world.attach(page);await world.ok('browser_snapshot',{operationId});
  expect((await world.ok('browser_navigate',{operationId,action:'back'})).executed).toBe('yes');
  await expect(page.getByRole('heading',{name:'Step 1'})).toBeVisible();expect(page.url()).toBe(url);
  await world.ok('browser_snapshot',{operationId});
  expect((await world.ok('browser_navigate',{operationId,action:'forward'})).executed).toBe('yes');
  await expect(page.getByRole('heading',{name:'Step 2'})).toBeVisible();
  await world.ok('browser_snapshot',{operationId});
  const boundary=await world.mcp.call('browser_navigate',{operationId,action:'forward'});
  expect(boundary.error?.code).toBe('ELEMENT_NOT_INTERACTABLE');expect(boundary.executed).toBe('no');
});
