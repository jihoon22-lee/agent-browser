import {test,expect} from '@playwright/test';
import {startWorld,type World} from './harness';
let world:World;
test.beforeAll(async()=>{world=await startWorld();console.log('WP2 runtime '+JSON.stringify(world.runtime));});
test.afterAll(async()=>{await world?.stop();});
test.afterEach(async()=>{
  const status=await world.admin('status.get');
  if(status.operation)await world.mcp.call('browser_tabs',{action:'release',operationId:status.operation.id});
  for(const page of world.context.pages())if(page!==world.adminPage)await page.close();
});
for(const type of ['checkbox','radio','range','color','range-constrained'])test(`F4 closes untouched ${type} and preserves edits`,async()=>{
  const created=await world.ok('browser_tabs',{action:'new',url:world.fixture.base+'/board.html'}),operationId=created.operationId!;
  const page=world.context.pages().find(p=>p.url().includes('/board.html'))!;
  await page.evaluate(type=>{document.body.innerHTML=type==='range-constrained'?'<input type="range" min="20" max="40">':`<input type="${type}">`;},type);
  await world.ok('browser_snapshot',{operationId});
  await page.evaluate(type=>{const el=document.querySelector('input')!;if(type==='checkbox'||type==='radio')el.checked=true;else el.value=type==='color'?'#abcdef':'75';},type);
  expect((await world.mcp.call('browser_tabs',{action:'close',operationId})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
  expect(page.isClosed()).toBe(false);
  await page.evaluate(type=>{document.body.innerHTML=type==='range-constrained'?'<input type="range" min="20" max="40">':`<input type="${type}">`;},type);
  await world.ok('browser_snapshot',{operationId});
  expect((await world.ok('browser_tabs',{action:'close',operationId})).verified?.closed).toBe(true);
});
test('F8 repeated fill and click keep unlabeled editable refs',async()=>{
  const page=await world.open('board.html');
  await page.evaluate(()=>{document.body.innerHTML='<div contenteditable="true" role="textbox">old</div>';});
  const operationId=await world.attach(page),snap=await world.ok('browser_snapshot',{operationId});
  const ref=snap.data.frames[0].elements.find((el:any)=>el.name==='old').ref;
  await world.ok('browser_fill',{operationId,ref,text:'hello'});
  await world.ok('browser_fill',{operationId,ref,text:'hello again'});
  await world.ok('browser_click',{operationId,ref});
  expect(await page.locator('[contenteditable]').textContent()).toBe('hello again');
});
test('F11 pointer side effects are never reported as unexecuted',async()=>{
  const page=await world.open('board.html');
  await page.evaluate(()=>{
    document.body.innerHTML='<button>Menu</button><div id="overlay" hidden>Open</div>';
    document.querySelector('button')!.addEventListener('mousedown',()=>{document.getElementById('overlay')!.hidden=false;document.querySelector('button')!.hidden=true;});
  });
  const operationId=await world.attach(page),snap=await world.ok('browser_snapshot',{operationId});
  const ref=snap.data.frames[0].elements.find((el:any)=>el.name==='Menu').ref;
  const outcome=await world.mcp.call('browser_click',{operationId,ref});
  expect(outcome.error).toMatchObject({code:'EXECUTION_UNKNOWN',retry:'unsafe'});
  expect(outcome.executed).toBe('unknown');
  await expect(page.locator('#overlay')).toBeVisible();
});
test('R6 textarea fills keep refs but authored default replacement invalidates them',async()=>{
  const page=await world.open('board.html');
  await page.evaluate(()=>{document.body.innerHTML='<textarea>First record</textarea>';});
  const operationId=await world.attach(page),snap=await world.ok('browser_snapshot',{operationId}),ref=snap.data.frames[0].elements[0].ref;
  await world.ok('browser_fill',{operationId,ref,text:'edited once'});
  await world.ok('browser_fill',{operationId,ref,text:'edited twice'});
  await page.locator('textarea').evaluate(el=>{const textarea=el as HTMLTextAreaElement;textarea.defaultValue='Second record';textarea.value='Second record';});
  expect((await world.mcp.call('browser_fill',{operationId,ref,text:'wrong record'})).error?.code).toBe('STALE_ELEMENT');
  await expect(page.locator('textarea')).toHaveValue('Second record');
});
