import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {test,expect,type Page} from '@playwright/test';
import {startWorld,type World} from './harness';
import {startOpenCodeFixture} from '../fixtures/opencode.mjs';
let world:World,api:Awaited<ReturnType<typeof startOpenCodeFixture>>;
const set=(data:any)=>world.adminPage.evaluate(d=>(globalThis as any).chrome.storage.local.set(d),data);
const refs=(s:any)=>s.frames.flatMap((f:any)=>f.elements);
const ref=(s:any,name:string)=>refs(s).find((e:any)=>e.name===name)!.ref;
test.beforeEach(async()=>{world=await startWorld();api=await startOpenCodeFixture();});
test.afterEach(async()=>{await world?.stop();await api?.close();});
async function start(vision='supported'){
 await set({advancedBrowser:true,trustedInput:true});
 await world.admin('profile.save',{profile:{id:'fixture',name:'Fixture',kind:'external',baseUrl:api.origin,username:api.username,password:api.password,directory:api.directory}});
 const page=await world.open('advanced.html'),session=api.session();page.on('dialog',()=>{});
 const lease={requestId:'advanced-request',messageId:'advanced-message',sessionId:session.id,profileId:'fixture',directory:api.directory,vision:{model:'fixture/fixture',image:vision,toolcall:true}};
 const prepared=await world.adminPage.evaluate(async ({lease,tabId})=>(globalThis as any).chrome.runtime.sendMessage({kind:'request-prepare',lease,target:{tabId,windowId:1}}),{lease,tabId:await world.tabId(page)});expect(prepared.ok).toBe(true);
 const attached=await world.ok('browser_tabs',{action:'attach',requestId:lease.requestId});return {page,operationId:attached.operationId!,snapshot:attached.data.snapshot};
}
async function shot(operationId:string,scope='viewport',region?:any){const raw=await world.mcp.callRaw('browser_screenshot',{operationId,scope,...(region?{region}:{})});expect(raw.isError,raw.isError?JSON.stringify(raw):undefined).not.toBe(true);return JSON.parse(raw.content.find((p:any)=>p.type==='text')!.text!).data;}
async function visual(args:Record<string,unknown>,driver=world.mcp,modelID='fixture') {
 const lease=await world.adminPage.evaluate(async()=>(await (globalThis as any).chrome.storage.local.get('panelBrowserRequest')).panelBrowserRequest);
 if(lease){api.state.statuses[lease.sessionId]={type:'busy'};api.saveMessage({info:{id:'visual-assistant',role:'assistant',time:{created:Date.now()},sessionID:lease.sessionId,parentID:lease.messageId,providerID:'fixture',modelID},parts:[{id:'visual-part',type:'tool',tool:'browser_browser_pointer',state:{status:'running',input:args}}]});}
 return driver.call('browser_pointer',args);
}
async function visualOk(args:Record<string,unknown>){const result=await visual(args);expect(result.ok,JSON.stringify(result)).toBe(true);return result;}
test('A01 advanced features remain opt-in and native text is retained',async()=>{
 const {page,operationId,snapshot}=await start();
 const filled=await world.ok('browser_fill',{operationId,ref:ref(snapshot,'Native text'),text:'한글🙂'});
 expect(filled.verified).toMatchObject({trusted:true,matches:true});await expect(page.locator('#text-state')).toHaveText('true');await expect(page.locator('#text')).toHaveValue('한글🙂');
 await set({advancedBrowser:false});expect((await world.mcp.call('browser_screenshot',{operationId,scope:'fullPage'})).error?.code).toBe('FORBIDDEN_METHOD');
});
test('A02 full and region capture carry accurate image geometry without moving the viewport',async()=>{
 const {page,operationId}=await start();const before=await page.evaluate(()=>scrollY);
 const full=await shot(operationId,'fullPage');expect(full.captureId).toBeUndefined();expect(full.geometry.imageHeight).toBeGreaterThan(1600);
 const crop=await shot(operationId,'region',{x:10,y:20,width:200,height:100});expect(crop.geometry.imageWidth/crop.geometry.imageHeight).toBe(2);expect(crop.captureId).toBeTruthy();expect(await page.evaluate(()=>scrollY)).toBe(before);
});
test('A03 canvas input requires a current image-capable request and consumes the capture',async()=>{
 const {page,operationId}=await start();const box=await page.locator('canvas').boundingBox();const s=await shot(operationId);
 const args={operationId,captureId:s.captureId,x:(box!.x+30)*s.geometry.imageWidth/s.geometry.width,y:(box!.y+30)*s.geometry.imageHeight/s.geometry.height};
 await visualOk(args);await expect(page.locator('#count')).toHaveText('1');
 expect((await visual(args)).error?.code).toBe('STALE_ELEMENT');await expect(page.locator('#count')).toHaveText('1');
});
test('A04 a changed image or non-image model cannot authorize pointer input',async()=>{
 const {page,operationId}=await start('unsupported');let s=await shot(operationId);
 expect((await visual({operationId,captureId:s.captureId,x:40,y:40})).error?.code).toBe('FORBIDDEN_METHOD');
 await world.adminPage.evaluate(async()=>{const c=(globalThis as any).chrome;const {panelBrowserRequest:r}=await c.storage.local.get('panelBrowserRequest');r.vision.image='supported';await c.storage.local.set({panelBrowserRequest:r});});
 s=await shot(operationId);await page.evaluate(()=>scrollTo(0,100));
 expect((await visual({operationId,captureId:s.captureId,x:40,y:40})).error?.code).toBe('STALE_ELEMENT');await expect(page.locator('#count')).toHaveText('0');
});
test('A05 confirm and prompt return pending state and are answered exactly once',async()=>{
 const {page,operationId,snapshot}=await start();
 const pending=await world.ok('browser_click',{operationId,ref:ref(snapshot,'Confirm task')});expect(pending.verified?.dialogPending).toBe(true);
 const d=pending.data.dialog;expect(d.dialogId).toBeTruthy();
 await world.ok('browser_dialog',{operationId,action:'respond',dialogId:d.dialogId,accept:true});await expect(page.locator('#dialog-result')).toHaveText('accepted');
 expect((await world.mcp.call('browser_dialog',{operationId,action:'respond',dialogId:d.dialogId,accept:true})).error?.code).toBe('STALE_ELEMENT');
 const fresh=await world.ok('browser_snapshot',{operationId});const prompt=await world.ok('browser_click',{operationId,ref:ref(fresh.data,'Prompt task')});
 await world.ok('browser_dialog',{operationId,action:'respond',dialogId:prompt.data.dialog.dialogId,accept:true,text:'응답🙂'});await expect(page.locator('#dialog-result')).toHaveText('응답🙂');
});
test('A06 trusted fill and click route into a cross-origin frame',async()=>{
 const {page,operationId}=await start();
 await page.evaluate(base=>{const frame=document.createElement('iframe');frame.src=base+'/advanced.html';document.body.prepend(frame);},world.fixture.base.replace('127.0.0.1','localhost'));
 const child=page.frameLocator('iframe');await expect(child.locator('#text')).toBeVisible();
 const s=await world.ok('browser_snapshot',{operationId});const sub=s.data.frames.find((f:any)=>f.frameId!==0);
 const field=sub.elements.find((e:any)=>e.name==='Native text').ref;
 const filled=await world.ok('browser_fill',{operationId,ref:field,text:'frame 입력'});expect(filled.verified?.trusted).toBe(true);await expect(child.locator('#text')).toHaveValue('frame 입력');
 const s2=await world.ok('browser_snapshot',{operationId});const button=s2.data.frames.find((f:any)=>f.frameId!==0).elements.find((e:any)=>e.name==='Confirm task').ref;
 const clicked=await world.ok('browser_click',{operationId,ref:button});expect(clicked.verified?.dialogPending).toBe(true);
 await world.ok('browser_dialog',{operationId,action:'respond',dialogId:clicked.data.dialog.dialogId,accept:false});await expect(child.locator('#dialog-result')).toHaveText('declined');
});

test('A07 download candidates require user binding, survive worker restart, and report completion',async()=>{
 test.skip(process.env.AB_TEST_DOWNLOADS!=='1','optional permission is tested in a separate isolated extension copy');
 const {page,operationId,snapshot}=await start();
 const downloaded=page.waitForEvent('download');
 await world.ok('browser_click',{operationId,ref:ref(snapshot,'Download report')});
 const download=await downloaded, savedPath=await download.path();expect(download.suggestedFilename()).toBe('synthetic-report.txt');expect(await readFile(savedPath!,'utf8')).toBe('synthetic test only');
 let result:any;
 await expect.poll(async()=>{result=await world.ok('browser_downloads',{operationId,action:'list'});return result.data.downloads.length;}).toBe(1);
 const item=result.data.downloads[0];expect(item.bound).toBe(false);
 expect((await world.mcp.call('browser_downloads',{operationId,action:'status',downloadId:item.id})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
 const bound=await world.adminPage.evaluate(async({operationId,id})=>(globalThis as any).chrome.runtime.sendMessage({kind:'download-bind',operationId,downloadId:id}),{operationId,id:item.id});expect(bound.ok).toBe(true);
 const done=await world.ok('browser_downloads',{operationId,action:'wait',downloadId:item.id,timeoutMs:5000});expect(done.data).toMatchObject({filename:basename(savedPath!),complete:true,bound:true});
 expect(done.data.filename).not.toContain('\\');
 await world.restartWorker();
 const restored=await world.ok('browser_downloads',{operationId,action:'status',downloadId:item.id});expect(restored.data.complete).toBe(true);
});
test('A08 download access is denied when the optional permission was not granted',async()=>{
 test.skip(process.env.AB_TEST_DOWNLOADS==='1');const {operationId}=await start();
 expect((await world.mcp.call('browser_downloads',{operationId,action:'list'})).error?.code).toBe('FORBIDDEN_METHOD');
});

test('A09 canvas pixel changes invalidate coordinates even when the DOM and layout are unchanged',async()=>{
 const {page,operationId}=await start();const s=await shot(operationId);
 await page.locator('canvas').evaluate((el:HTMLCanvasElement)=>{const ctx=el.getContext('2d')!;ctx.fillStyle='red';ctx.fillRect(0,0,240,100);});
 const r=await visual({operationId,captureId:s.captureId,x:40,y:40});expect(r.ok).toBe(false);expect(r.executed).toBe('no');await expect(page.locator('#count')).toHaveText('0');
});
test('A10 concurrent requests cannot spend the same capture twice',async()=>{
 const {page,operationId}=await start();const s=await shot(operationId),box=await page.locator('canvas').boundingBox();
 const args={operationId,captureId:s.captureId,x:(box!.x+40)*s.geometry.imageWidth/s.geometry.width,y:(box!.y+30)*s.geometry.imageHeight/s.geometry.height};
 const r=await Promise.all([visual(args),visual(args)]);
 expect(r.filter(x=>x.ok)).toHaveLength(1);await expect(page.locator('#count')).toHaveText('1');
});
test('A11 region coordinates remain accurate at browser zoom and old tokens cannot cross a zoom change',async()=>{
 const {page,operationId}=await start();const tabId=await world.tabId(page);
 await world.adminPage.evaluate(async tabId=>(globalThis as any).chrome.tabs.setZoom(tabId,1.25),tabId);
 const box=await page.locator('canvas').boundingBox(),s=await shot(operationId,'region',{x:box!.x,y:box!.y,width:200,height:80});
 await visualOk({operationId,captureId:s.captureId,x:s.geometry.imageWidth/2,y:s.geometry.imageHeight/2});await expect(page.locator('#count')).toHaveText('1');
 const old=await shot(operationId);await world.adminPage.evaluate(async tabId=>(globalThis as any).chrome.tabs.setZoom(tabId,1),tabId);
 expect((await visual({operationId,captureId:old.captureId,x:50,y:50})).ok).toBe(false);await expect(page.locator('#count')).toHaveText('1');
});
test('A12 a user-closed dialog cannot be answered again',async()=>{
 const {page,operationId,snapshot}=await start();const appeared=page.waitForEvent('dialog');
 const result=await world.ok('browser_click',{operationId,ref:ref(snapshot,'Confirm task')});const dialog=await appeared;await dialog.dismiss();
 await expect(page.locator('#dialog-result')).toHaveText('declined');
 expect((await world.mcp.call('browser_dialog',{operationId,action:'respond',dialogId:result.data.dialog.dialogId,accept:true})).error?.code).toBe('STALE_ELEMENT');
});
test('A13 stopping a request prevents a captured coordinate action',async()=>{
 const {page,operationId}=await start();const s=await shot(operationId);await world.admin('operation.abort',{operationId});
 const result=await visual({operationId,captureId:s.captureId,x:40,y:40});expect(result.ok).toBe(false);await expect(page.locator('#count')).toHaveText('0');
});

test('A14 normal Tab focus movement remains successful in advanced mode',async()=>{
 const {page,operationId,snapshot}=await start();
 const result=await world.ok('browser_press',{operationId,ref:ref(snapshot,'Native text'),key:'Tab'});expect(result.executed).toBe('yes');await expect(page.locator('#confirm')).toBeFocused();
});
test('A15 dialogs raised by native fill are visible and answerable',async()=>{
 const {page,operationId,snapshot}=await start();
 await page.locator('#text').evaluate(el=>el.addEventListener('input',()=>{document.querySelector('#dialog-result')!.textContent=confirm('input dialog')?'accepted':'declined';},{once:true}));
 const result=await world.ok('browser_fill',{operationId,ref:ref(snapshot,'Native text'),text:'one input'});expect(result.verified?.dialogPending).toBe(true);
 await world.ok('browser_dialog',{operationId,action:'respond',dialogId:result.data.dialog.dialogId,accept:true});await expect(page.locator('#dialog-result')).toHaveText('accepted');
});
test('A16 legacy viewport capture remains available with advanced on and trusted input off',async()=>{
 const {operationId}=await start();await set({trustedInput:false});await shot(operationId,'viewport');
 await set({advancedBrowser:false});await shot(operationId,'viewport');
});
test('A17 hover-driven canvas replacement never receives a press from the old capture',async()=>{
 const {page,operationId}=await start();
 await page.locator('canvas').evaluate(el=>el.addEventListener('pointermove',()=>{const ctx=(el as HTMLCanvasElement).getContext('2d')!;ctx.fillStyle='red';ctx.fillRect(0,0,240,100);},{once:true}));
 const s=await shot(operationId),box=await page.locator('canvas').boundingBox();
 const result=await visual({operationId,captureId:s.captureId,x:(box!.x+40)*s.geometry.imageWidth/s.geometry.width,y:(box!.y+30)*s.geometry.imageHeight/s.geometry.height});
 expect(result.ok).toBe(false);await expect(page.locator('#count')).toHaveText('0');
});

test('A18 another MCP connection cannot borrow image authority using an explicit operation ID',async()=>{
 const {operationId}=await start(),s=await shot(operationId),other=await world.newMcp();
 expect((await visual({operationId,captureId:s.captureId,x:40,y:40},other)).error?.code).toBe('FORBIDDEN_METHOD');
});
test('A19 an actual model without verified image support cannot inherit the selected model capability',async()=>{
 const {operationId}=await start(),s=await shot(operationId);
 expect((await visual({operationId,captureId:s.captureId,x:40,y:40},world.mcp,'unknown')).error?.code).toBe('FORBIDDEN_METHOD');
});
test('A20 capture fails promptly while a modal dialog is pending',async()=>{
 const {page,operationId,snapshot}=await start();const event=page.waitForEvent('dialog');
 await world.ok('browser_click',{operationId,ref:ref(snapshot,'Confirm task')});const dialog=await event;
 const startTime=Date.now(),raw=await world.mcp.callRaw('browser_screenshot',{operationId});expect(raw.isError).toBe(true);expect(Date.now()-startTime).toBeLessThan(3000);await dialog.dismiss();
});
test('A21 a confirm followed by an alert and prompt retains all dialog identities',async()=>{
 const {page,operationId,snapshot}=await start();
 await page.locator('#confirm').evaluate((el:HTMLButtonElement)=>el.onclick=()=>{if(confirm('first')){alert('notice');document.querySelector('#dialog-result')!.textContent=prompt('second')??'cancelled';}});
 const first=await world.ok('browser_click',{operationId,ref:ref(snapshot,'Confirm task')});
 const reply=await world.ok('browser_dialog',{operationId,action:'respond',dialogId:first.data.dialog.dialogId,accept:true});
 let second=reply.data.dialog;
 if(!second){await expect.poll(async()=>{second=(await world.ok('browser_dialog',{operationId,action:'list'})).data.dialogs.find((d:any)=>d.type==='prompt');return !!second;}).toBe(true);}
 expect(second.dialogId).not.toBe(first.data.dialog.dialogId);
 await world.ok('browser_dialog',{operationId,action:'respond',dialogId:second.dialogId,accept:true,text:'chain done'});await expect(page.locator('#dialog-result')).toHaveText('chain done');
});
test('A22 a delayed unowned dialog is visible but cannot be silently accepted',async()=>{
 const {page,operationId,snapshot}=await start();await world.ok('browser_fill',{operationId,ref:ref(snapshot,'Native text'),text:'ready'});
 const event=page.waitForEvent('dialog');await page.evaluate(()=>setTimeout(()=>confirm('unowned'),1800));const dialog=await event;
 const list=await world.ok('browser_dialog',{operationId,action:'list'});expect(list.data.dialogs[0].owned).toBe(false);
 expect((await world.mcp.call('browser_dialog',{operationId,action:'respond',dialogId:list.data.dialogs[0].dialogId,accept:true})).error?.code).toBe('FORBIDDEN_METHOD');await dialog.dismiss();
});
test('A23 one input invalidates every earlier capture even if pixels are unchanged',async()=>{
 const {operationId}=await start(),a=await shot(operationId),b=await shot(operationId);
 await visualOk({operationId,captureId:a.captureId,mode:'hover',x:800,y:400});
 expect((await visual({operationId,captureId:b.captureId,mode:'hover',x:800,y:400})).error?.code).toBe('STALE_ELEMENT');
});

test('A24 same-name GET, redirect and POST downloads stay unbound until the user selects each ID',async()=>{
 test.skip(process.env.AB_TEST_DOWNLOADS!=='1','isolated downloads permission fixture');
 const {createServer}=await import('node:http');
 const server=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'/file'});res.end();}else{res.writeHead(200,{'content-type':'text/plain','content-disposition':'attachment; filename="same.txt"'});res.end('synthetic '+req.method);}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
 const base=`http://127.0.0.1:${(server.address() as any).port}`,{page,operationId}=await start();
 await page.evaluate(base=>{for(const [name,path] of [['Direct file','/file'],['Redirect file','/redirect']]){const link=document.createElement('a');link.href=base+path;link.textContent=name;document.body.prepend(link);}const form=document.createElement('form');form.action=base+'/file';form.method='POST';form.innerHTML='<button>Post file</button>';document.body.prepend(form);},base);
 for(const name of ['Direct file','Redirect file','Post file']){const s=await world.ok('browser_snapshot',{operationId}),event=page.waitForEvent('download');await world.ok('browser_click',{operationId,ref:ref(s.data,name)});expect(await (await event).path()).toBeTruthy();}
 // A simultaneous user download is deliberately indistinguishable in Chrome's API.
 const event=page.waitForEvent('download');await page.getByRole('link',{name:'Direct file',exact:true}).click();await (await event).path();
 let items:any[]=[];await expect.poll(async()=>{items=(await world.ok('browser_downloads',{operationId,action:'list'})).data.downloads;return items.length;}).toBe(4);
 expect(items.every(d=>!d.bound&&d.complete)).toBe(true);
 for(const item of items)expect((await world.mcp.call('browser_downloads',{operationId,action:'status',downloadId:item.id})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
 await world.adminPage.evaluate(async({operationId,id})=>(globalThis as any).chrome.runtime.sendMessage({kind:'download-bind',operationId,downloadId:id}),{operationId,id:items[0].id});
 expect((await world.ok('browser_downloads',{operationId,action:'wait',downloadId:items[0].id})).data.complete).toBe(true);
 expect((await world.ok('browser_downloads',{operationId,action:'list'})).data.downloads.filter((d:any)=>d.bound)).toHaveLength(1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('A25 hover cannot change the destination of a link around the visual hit',async()=>{
 const {page,operationId}=await start();await page.evaluate(()=>{const a=document.createElement('a');a.href='#safe';a.innerHTML='<span>Open synthetic link</span>';a.style.cssText='display:block;width:220px;height:40px';a.onmouseenter=()=>a.href='#changed';a.onpointerdown=()=>document.querySelector('#count')!.textContent='1';document.body.prepend(a);});
 const box=await page.locator('a span').boundingBox(),s=await shot(operationId);
 expect((await visual({operationId,captureId:s.captureId,x:(box!.x+10)*s.geometry.imageWidth/s.geometry.width,y:(box!.y+5)*s.geometry.imageHeight/s.geometry.height})).ok).toBe(false);
 await expect(page.locator('#count')).toHaveText('0');
});
test('A26 double clicks work on a stable target and stop when the first click replaces it',async()=>{
 const {page,operationId}=await start();await page.evaluate(()=>{const b=document.createElement('button');b.textContent='Stable double';b.ondblclick=()=>document.querySelector('#count')!.textContent='1';document.body.prepend(b);});
 let snap=await world.ok('browser_snapshot',{operationId});await world.ok('browser_click',{operationId,ref:ref(snap.data,'Stable double'),mode:'double'});await expect(page.locator('#count')).toHaveText('1');
 await page.evaluate(()=>{document.querySelector('#count')!.textContent='0';const b=document.querySelector('button')!;b.onclick=()=>{const replacement=document.createElement('button');replacement.textContent='Replacement';replacement.onpointerdown=()=>document.querySelector('#count')!.textContent='wrong';b.replaceWith(replacement);};});
 snap=await world.ok('browser_snapshot',{operationId});const result=await world.mcp.call('browser_click',{operationId,ref:ref(snap.data,'Stable double'),mode:'double'});
 expect(result.ok).toBe(false);await expect(page.locator('#count')).toHaveText('0');
});
