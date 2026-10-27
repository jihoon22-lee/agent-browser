import {test,expect} from '@playwright/test';
import {startWorld,type World} from './harness';
let world:World;
test.beforeAll(async()=>{world=await startWorld();});
test.afterAll(async()=>{await world?.stop();});
test('P0 Chrome debugger inserts Unicode into a focused cross-origin iframe and captures an explicit region',async()=>{
 const page=await world.open('index.html');
 await page.evaluate(base=>{const frame=document.createElement('iframe');frame.src=base+'/index.html';document.body.prepend(frame);},world.fixture.base.replace('127.0.0.1','localhost'));
 const child=page.frameLocator('iframe').first();
 await expect(child.locator('body')).toBeVisible();
 await child.locator('body').evaluate(body=>{body.innerHTML='<input id="probe">';const input=body.querySelector('input')!;input.focus();(window as any).probeTrusted=false;input.addEventListener('input',e=>(window as any).probeTrusted=e.isTrusted);});
 const tabId=await world.tabId(page);
 const result=await world.adminPage.evaluate(async tabId=>{
   const c=(globalThis as any).chrome;await c.debugger.attach({tabId},'1.3');
   try {await c.debugger.sendCommand({tabId},'Input.insertText',{text:'한글🙂'});const shot=await c.debugger.sendCommand({tabId},'Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:320,height:180,scale:1},captureBeyondViewport:true});return {png:shot.data.slice(0,12),bytes:shot.data.length};}
   finally {await c.debugger.detach({tabId});}
 },tabId);
 await expect(child.locator('#probe')).toHaveValue('한글🙂');
 expect(await child.locator('body').evaluate(()=>(window as any).probeTrusted)).toBe(true);
 expect(result.png).toBe('iVBORw0KGgoA');expect(result.bytes).toBeGreaterThan(100);
});
