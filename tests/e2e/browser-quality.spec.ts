import { test, expect } from '@playwright/test';
import { startWorld, type World } from './harness';
let world:World;
test.beforeAll(async()=>{world=await startWorld();console.log('QUALITY runtime '+JSON.stringify(world.runtime));});
test.afterEach(async()=>{
  const status=await world.admin('status.get');
  if(status.operation)await world.mcp.call('browser_tabs',{action:'release',operationId:status.operation.id});
  for(const page of world.context.pages())if(page!==world.adminPage)await page.close();
});
test.afterAll(async()=>world?.stop());
const elements=(snapshot:any)=>snapshot.frames.flatMap((f:any)=>f.elements);
async function setup(){
  const page=await world.open('quality.html'),attached=await world.ok('browser_tabs',{action:'attach',tabId:await world.tabId(page)});
  const operationId=attached.operationId!,snapshot=attached.data.snapshot;
  const ref=(name:string)=>elements(snapshot).find((e:any)=>e.name===name)!.ref;
  return {page,operationId,snapshot,ref};
}
test('Q01 recycled rows never dispatch to the replacement record; queries retain context',async()=>{
  const {page,operationId}=await setup();
  const s=(await world.ok('browser_snapshot',{operationId,query:'A-1001'})).data;
  const cancel=elements(s).find((e:any)=>e.name==='Cancel');expect(cancel.context).toContain('A-1001');
  await page.locator('#rows span').first().evaluate(e=>{e.textContent='C-3003';});
  const result=await world.mcp.call('browser_click',{operationId,ref:cancel.ref});
  expect(result.error?.code).toBe('STALE_ELEMENT');expect(result.executed).toBe('no');
  expect(await page.evaluate(()=>(window as any).quality.record)).toBeNull();
});
test('Q02 app rollback, disabled controls and shadow labels are accurately observed',async()=>{
  const {page,operationId,snapshot,ref}=await setup();
  expect(elements(snapshot).some((e:any)=>e.name==='Order A-1001 action')).toBe(true);
  expect(elements(snapshot).some((e:any)=>e.name==='Shadow query')).toBe(true);
  const result=await world.ok('browser_fill',{operationId,ref:ref('Rollback'),text:'after'});
  expect(result.verified?.matches).toBe(false);await expect(page.locator('#rollback')).toHaveValue('before');
  const disabled=await world.mcp.call('browser_click',{operationId,ref:ref('Unavailable')});
  expect(disabled.executed).toBe('no');expect(disabled.error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
  expect(await page.evaluate(()=>(window as any).quality.counts.disabled??0)).toBe(0);
});
test('Q03 explicit completion observes a delayed navigation after intermediate DOM changes',async()=>{
  const {page,operationId,ref}=await setup();
  const result=await world.ok('browser_click',{operationId,ref:ref('Delayed navigation'),waitFor:{urlIncludes:'/detail.html',timeoutMs:4000}});
  expect(result.verified?.expectationMet).toBe(true);
  expect(result.data.snapshot.url).toContain('/detail.html');expect(page.url()).toContain('/detail.html');
});
test('Q04 an unmet completion condition leaves the single submitted action executed',async()=>{
  const {page,operationId,ref}=await setup();
  const result=await world.mcp.call('browser_click',{operationId,ref:ref('Submit once'),waitFor:{text:'Never appears',timeoutMs:100}});
  expect(result.ok).toBe(false);expect(result.error?.code).toBe('TIMEOUT');expect(result.executed).toBe('yes');
  expect(result.error?.retry).toBe('never');expect(await page.evaluate(()=>(window as any).quality.counts.submit)).toBe(1);
});
test('Q05 all conditions wait for both text and URL, and smooth CSS does not outlive a scroll result',async()=>{
  const {page,operationId,ref}=await setup();
  const scrolled=await world.ok('browser_scroll',{operationId,ref:ref('Scroll region'),direction:'down'});
  const actual=await page.locator('.scroll').evaluate(e=>e.scrollTop);
  expect(actual).toBeGreaterThan(0);expect(scrolled.verified?.scrollTop).toBe(actual);
  await page.evaluate(()=>{setTimeout(()=>{history.pushState({},'','?ready');},100);setTimeout(()=>{document.querySelector('#result')!.textContent='Ready result';},250);});
  const result=await world.ok('browser_wait',{operationId,text:'Ready result',urlIncludes:'?ready',match:'all',timeoutMs:2000});
  expect(result.verified?.met).toBe('all');await expect(page.locator('#result')).toHaveText('Ready result');
});
