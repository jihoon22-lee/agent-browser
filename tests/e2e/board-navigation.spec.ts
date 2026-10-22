import { test, expect, type Page } from '@playwright/test';
import { startWorld, type World } from './harness';
let world: World;
const ref = (snap: any, name: string) => {
  const found = snap.frames.flatMap((f: any) => f.elements).filter((e: any) => e.name === name);
  expect(found).toHaveLength(1); return found[0].ref;
};
const snapshot = async (operationId: string) => (await world.ok('browser_snapshot',{operationId})).data;
async function setup() {
  const page=await world.open('board.html'), operationId=await world.attach(page);
  return {page, operationId, snap:await snapshot(operationId)};
}
async function click(operationId: string, target: string) {
  const result=await world.mcp.call('browser_click',{operationId,ref:target});
  // Hard navigation is reported as executed with navigated:true; never replay a click.
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result;
}
test.beforeAll(async ({}, info) => {
  world=await startWorld(); console.log('BOARD runtime '+JSON.stringify(world.runtime));
  await info.attach('runtime',{body:JSON.stringify(world.runtime),contentType:'application/json'});
});
test.afterEach(async () => {
  const status=await world.admin('status.get');
  if(status.operation) await world.mcp.call('browser_tabs',{action:'release',operationId:status.operation.id});
  for(const page of world.context.pages()) if(page!==world.adminPage) await page.close();
});
test.afterAll(async()=>{await world?.stop();});
test('B09 history boundaries return promptly without changing the page',async()=>{
  const page=await world.context.newPage();
  await page.evaluate(url=>location.replace(url),world.fixture.base+'/board.html');
  await page.waitForURL('**/board.html');
  await page.waitForLoadState('load');
  const operationId=await world.attach(page); await snapshot(operationId);
  console.log('HISTORY boundary '+JSON.stringify(await page.evaluate(()=>({length:history.length,entries:(window as any).navigation.entries().length,back:(window as any).navigation.canGoBack,forward:(window as any).navigation.canGoForward}))));
  for(const action of ['back','forward']) {
    const url=page.url(), start=Date.now();
    const result=await world.mcp.call('browser_navigate',{operationId,action});
    expect(result.error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
    expect(Date.now()-start).toBeLessThan(5000);
    expect(page.url()).toBe(url);
  }
});
test('B01 hard article/back cycles, forward and reload use fresh references',async()=>{
  const {page,operationId}=await setup();
  for(let i=0;i<4;i++) {
    const list=await snapshot(operationId);
    await click(operationId,ref(list,'Post 1'));
    await expect(page.getByRole('heading',{name:'Article 1'})).toBeVisible();
    const article=await snapshot(operationId);
    expect(article.frames[0].text.content).toContain('Body 1');
    await world.ok('browser_navigate',{operationId,action:'back'});
    await world.ok('browser_wait',{operationId,text:'Board ready'});
    const stale=await world.mcp.call('browser_click',{operationId,ref:ref(list,'Post 1')});
    expect(stale.error?.code).toBe('STALE_ELEMENT');
    console.log('BFCache restored='+await page.evaluate(()=>(window as any).restored));
  }
  await snapshot(operationId);
  await world.ok('browser_navigate',{operationId,action:'forward'});
  expect((await snapshot(operationId)).frames[0].text.content).toContain('Body 1');
  await world.ok('browser_navigate',{operationId,action:'reload'});
  expect((await snapshot(operationId)).frames[0].text.content).toContain('Body 1');
});
test('B02 SPA back with delayed list, same-node sorting and pagination',async()=>{
  const {page,operationId,snap}=await setup();
  await click(operationId,ref(snap,'SPA post'));
  await snapshot(operationId);
  await world.ok('browser_navigate',{operationId,action:'back'});
  await world.ok('browser_wait',{operationId,text:'Board ready'});
  const list=await snapshot(operationId), old=ref(list,'Post 1');
  await click(operationId,ref(list,'Sort rows'));
  expect((await world.mcp.call('browser_click',{operationId,ref:old})).error?.code).toBe('STALE_ELEMENT');
  expect(page.url()).not.toContain('post=');
  const sorted=await snapshot(operationId);
  expect(sorted.frames[0].elements.find((e:any)=>e.name==='Post 2').href).toContain('post=2');
  await click(operationId,ref(sorted,'Next page'));
  const stalePage=await world.mcp.call('browser_click',{operationId,ref:ref(sorted,'Post 2')});
  expect(stalePage.error?.code,JSON.stringify(stalePage)).toBe('STALE_ELEMENT');
  await click(operationId,ref(await snapshot(operationId),'Post 2'));
  await expect(page.getByRole('heading',{name:'Article 2'})).toBeVisible();
});
test('B03 replaced iframe rejects old refs, fresh snapshot reads replacement',async()=>{
  const {page,operationId}=await setup();
  await page.locator('iframe').evaluate((el:any)=>{el.src='form.html';});
  await expect(page.frameLocator('iframe').getByRole('button',{name:'저장'})).toBeVisible();
  const before=await snapshot(operationId), old=ref(before,'저장');
  await page.locator('iframe').evaluate((el:any)=>{el.outerHTML='<iframe src="form.html?replacement=1"></iframe>';});
  await expect(page.frameLocator('iframe').getByRole('button',{name:'저장'})).toBeVisible();
  expect((await world.mcp.call('browser_click',{operationId,ref:old})).error?.code).toBe('STALE_ELEMENT');
  expect(ref(await snapshot(operationId),'저장')).not.toBe(old);
});
test('B04 new-tab article closes and operation returns to original list',async()=>{
  const {page,operationId,snap}=await setup(), original=await world.tabId(page);
  await click(operationId,ref(snap,'New tab post'));
  expect((await snapshot(operationId)).frames[0].text.content).toContain('Body 9');
  const closed=await world.ok('browser_tabs',{operationId,action:'close'});
  expect(closed.verified?.closed).toBe(true);
  await world.ok('browser_tabs',{operationId,action:'switch',tabId:original});
  expect((await snapshot(operationId)).frames[0].text.content).toContain('Board ready');
  expect((await world.ok('browser_tabs',{operationId,action:'close'})).verified?.closed).toBe(true);
  // Chrome confirmed the close; Playwright learns of it a moment later.
  await expect.poll(() => page.isClosed()).toBe(true);
});
test('B05 edited form is kept open without a force-close fallback',async()=>{
  const {operationId}=await setup();
  await world.ok('browser_tabs',{operationId,action:'new',url:world.fixture.base+'/form.html'});
  const snap=await snapshot(operationId);
  await world.ok('browser_fill',{operationId,ref:ref(snap,'이름'),text:'Unsaved fixture'});
  expect((await world.mcp.call('browser_tabs',{operationId,action:'close'})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
  expect((await snapshot(operationId)).frames[0].elements.some((e:any)=>e.value==='Unsaved fixture')).toBe(true);
});
test('B06 native beforeunload warning can cancel close and preserves the tab',async()=>{
  const {page,operationId,snap}=await setup();
  const originalUrl=page.url();
  await click(operationId,ref(snap,'New tab post'));
  await snapshot(operationId);
  const detail=world.context.pages().find(p=>p.url().includes('post=9'))!;
  await detail.getByRole('heading').click(); // trusted activation, synthetic fixture only
  await detail.evaluate(()=>addEventListener('beforeunload',e=>{e.preventDefault();e.returnValue='';}));
  const beforeClose=(await world.admin('status.get')).operation;
  const dialog=detail.waitForEvent('dialog');
  const closing=world.mcp.call('browser_tabs',{operationId,action:'close'});
  const warning=await dialog;
  expect(warning.type()).toBe('beforeunload');
  await warning.dismiss();
  expect((await closing).error?.code).toBe('EXECUTION_UNKNOWN');
  expect(detail.isClosed()).toBe(false);
  const afterClose=(await world.admin('status.get')).operation;
  expect(afterClose.tabs).toEqual(beforeClose.tabs);
  expect(afterClose.currentTab).toBe(beforeClose.currentTab);
  expect(afterClose.currentTabClosed).toBe(false);
  expect(page.url()).toBe(originalUrl);
});

test('B07 genuine BFCache restoration never revives old refs',async()=>{
  test.skip(process.env.AB_TEST_BFCACHE !== '1','Opt in to actual BFCache (Playwright disables it by default)');
  const page=await world.open('board-cache.html'), operationId=await world.attach(page);
  const list=await snapshot(operationId);
  await click(operationId,ref(list,'Cache post'));
  await expect(page.getByRole('heading',{name:'Cache article'})).toBeVisible();
  await snapshot(operationId);
  await world.ok('browser_navigate',{operationId,action:'back'});
  await expect(page.getByRole('heading',{name:'Cache list'})).toBeVisible();
  const evidence=await page.evaluate(()=>({restored:(window as any).restored,reasons:(performance.getEntriesByType('navigation')[0] as any)?.notRestoredReasons}));
  console.log('BFCACHE evidence '+JSON.stringify(evidence));
  expect(evidence.restored).toBe(true);
  expect((await world.mcp.call('browser_click',{operationId,ref:ref(list,'Cache post')})).error?.code).toBe('STALE_ELEMENT');
  expect(ref(await snapshot(operationId),'Cache post')).not.toBe(ref(list,'Cache post'));
});

test('B08 pointer handler cannot redirect a snapshot link to another article',async()=>{
  const {page,operationId,snap}=await setup();
  await page.locator('#first').evaluate(el=>el.addEventListener('mousedown',()=>{(el as HTMLAnchorElement).href='?post=2';}));
  const outcome=await world.mcp.call('browser_click',{operationId,ref:ref(snap,'Post 1')});
  expect(outcome.error).toMatchObject({code:'EXECUTION_UNKNOWN',retry:'unsafe'});
  expect(outcome.executed).toBe('unknown');
  expect(page.url()).not.toContain('post=');
  expect((await snapshot(operationId)).frames[0].elements.find((el:any)=>el.name==='Post 1').href).toContain('post=2');
});

test('B10 rechecks an earlier iframe edited during a later close check',async()=>{
  const {operationId}=await setup();
  await world.ok('browser_tabs',{operationId,action:'new',url:world.fixture.base+'/close-race.html'});
  const owned=world.context.pages().find(p=>p.url().endsWith('/close-race.html'))!;
  await expect(owned.frameLocator('iframe').first().locator('input').first()).toBeVisible();
  await expect(owned.frameLocator('iframe').last().locator('input').first()).toBeVisible();
  const before=await snapshot(operationId),tabId=await world.tabId(owned);
  const worker=world.context.serviceWorkers()[0];
  await worker.evaluate(({tabId,early,late})=>{
    const api=(globalThis as any).chrome;
    const original=api.tabs.sendMessage.bind(api.tabs);
    const state={edited:false,methods:[] as string[]};
    (globalThis as any).__closeRace={state,restore:()=>{api.tabs.sendMessage=original;}};
    api.tabs.sendMessage=async(id:number,msg:any,options:any)=>{
      if(id===tabId) state.methods.push(msg.method);
      const response=await original(id,msg,options);
      // Gate the later frame's real reply, then edit the already-checked frame.
      // No navigation, beforeunload handler, or synthetic input event is involved.
      if(id===tabId&&msg.method==='close-check'&&options.documentId===late&&!state.edited) {
        await api.scripting.executeScript({target:{tabId,documentIds:[early]},func:()=>{
          document.querySelector('input')!.value='Unsaved during preflight';
        }});
        state.edited=true;
      }
      return response;
    };
  },{tabId,early:before.frames.find((f:any)=>f.url.includes('earlier=1')).documentId,
    late:before.frames.find((f:any)=>f.url.includes('later=1')).documentId});
  try {
    const result=await world.mcp.call('browser_tabs',{operationId,action:'close'});
    const evidence=await worker.evaluate(()=>(globalThis as any).__closeRace.state);
    console.log('CLOSE same-document edit '+JSON.stringify({result,evidence,closed:owned.isClosed()}));
    expect(evidence.edited).toBe(true);
    expect(result.error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
    expect(result.executed).toBe('no');
    expect(evidence.methods).not.toContain('close');
    expect(owned.isClosed()).toBe(false);
    await expect(owned.frameLocator('iframe').first().locator('input').first()).toHaveValue('Unsaved during preflight');
    const after=await snapshot(operationId);
    expect(after.frames.map((f:any)=>f.documentId)).toEqual(before.frames.map((f:any)=>f.documentId));
    // An unchanged clean multi-frame page still closes in one bounded attempt.
    await owned.frameLocator('iframe').first().locator('input').first().evaluate((el:HTMLInputElement)=>{el.value=el.defaultValue;});
    await world.ok('browser_tabs',{operationId,action:'close'});
    expect(owned.isClosed()).toBe(true);
  } finally {
    await worker.evaluate(()=>(globalThis as any).__closeRace.restore());
  }
});
