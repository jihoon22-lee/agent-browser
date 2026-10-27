import {test,expect,type Page} from '@playwright/test';
import {startWorld,type World} from './harness';
declare const chrome:any;
let world:World;
const ref=(s:any,name:string)=>s.frames.flatMap((f:any)=>f.elements).find((e:any)=>e.name===name)!.ref;
async function fixture(advanced=true,trusted=true,kind='key',modal='alert',edge='keydown',key='Enter'){
 world=await startWorld();
 await world.adminPage.evaluate(({advanced,trusted})=>chrome.storage.local.set({advancedBrowser:advanced,trustedInput:trusted}),{advanced,trusted});
 const page=await world.open('advanced.html');page.on('dialog',dialog=>{if(!trusted)void dialog.dismiss();});
 await page.evaluate(({kind,modal,edge,key})=>{
  document.body.innerHTML='<label>Editor<input id="editor" value="seed"></label><button id="action">Action</button><div id="drop">Drop target</div>';
  (window as any).releaseState={keys:[],dragging:false,moves:0,clicks:0,drops:0,triggered:false,events:[]};
  const s=(window as any).releaseState;
  for(const type of ['keydown','keyup','mousedown','mouseup','mousemove','click','drop'])document.addEventListener(type,(e:any)=>{
   s.events.push({type,key:e.key??null,ctrl:e.ctrlKey,buttons:e.buttons??null,trusted:e.isTrusted});
   if(type==='keydown'&&!s.keys.includes(e.key))s.keys.push(e.key);
   if(type==='keyup')s.keys=s.keys.filter((k:string)=>k!==e.key);
   if(type==='mousedown')s.dragging=true;if(type==='mouseup')s.dragging=false;
   if(type==='mousemove'&&s.dragging)s.moves++;if(type==='click')s.clicks++;if(type==='drop')s.drops++;
  },true);
  const target=document.querySelector(kind==='mouse'||kind==='space'?'#action':'#editor')!;
  target.addEventListener(kind==='mouse'?edge==='keydown'?'mousedown':edge:edge,(e:any)=>{
   if(s.triggered||(kind!=='mouse'&&e.key!==key))return;s.triggered=true;
   if(modal==='alert')alert('Synthetic interrupted input');else if(modal==='confirm')confirm('Synthetic interrupted input');
  });
 },{kind,modal,edge,key});
 const operationId=await world.attach(page),snapshot=(await world.ok('browser_snapshot',{operationId})).data;
 return {page,operationId,reference:ref(snapshot,kind==='mouse'||kind==='space'?'Action':'Editor')};
}
const state=(page:Page)=>page.evaluate(()=>(window as any).releaseState);
test.afterEach(async()=>{await world?.stop();});
for(const advanced of [false,true])test(`D01 Ctrl+Enter alert releases both keys with advanced=${advanced}`,async()=>{
 const {page,operationId,reference}=await fixture(advanced);
 const result=await world.ok('browser_press',{operationId,ref:reference,key:'Enter',modifiers:['Control']});
 expect(result.verified).toMatchObject({incomplete:true,keysReleased:true});
 expect((await state(page)).keys).toEqual([]);
 await world.ok('browser_press',{operationId,ref:reference,key:'ArrowRight'});expect((await state(page)).keys).toEqual([]);
});
for(const advanced of [false,true])test(`D02 interrupted mouse never releases or continues dragging, advanced=${advanced}`,async({},info)=>{
 const {page,operationId,reference}=await fixture(advanced,true,'mouse');
 const result=await world.ok('browser_click',{operationId,ref:reference});expect(result.verified).toMatchObject({incomplete:true,inputRecoveryRequired:true});
 const before=await state(page);expect(before.dragging).toBe(true);expect(before.clicks).toBe(0);expect(before.events.filter((e:any)=>e.type==='mouseup')).toHaveLength(0);
 const blocked=await world.mcp.call('browser_click',{operationId,ref:reference,mode:'hover'});expect(blocked.error?.code).toBe('ELEMENT_NOT_INTERACTABLE');expect(blocked.executed).toBe('no');expect((await state(page)).moves).toBe(before.moves);
 const panel=await world.context.newPage();await panel.setViewportSize({width:400,height:900});await panel.goto(`chrome-extension://${world.extensionId}/${world.manifest.side_panel.default_path}`);await panel.getByRole('tab',{name:'브라우저',exact:true}).click();await expect(panel.getByRole('alert').filter({hasText:'페이지를 직접 확인'})).toBeVisible();await panel.screenshot({path:info.outputPath('input-recovery.png'),fullPage:true});await panel.close();
 await world.adminPage.evaluate(()=>chrome.storage.local.set({trustedInput:false,advancedBrowser:false}));
 await page.evaluate(()=>history.pushState({},'','#same-document'));await world.ok('browser_snapshot',{operationId});
 expect((await world.mcp.call('browser_fill',{operationId,ref:ref((await world.ok('browser_snapshot',{operationId})).data,'Editor'),text:'no'})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
 expect((await world.mcp.call('browser_navigate',{operationId,url:world.fixture.base+'/advanced.html'})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
 await world.restartWorker();await world.ok('browser_snapshot',{operationId});expect((await world.mcp.call('browser_click',{operationId,ref:reference,mode:'hover'})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
 await world.mcp.call('browser_tabs',{operationId,action:'release'});const next=await world.attach(page);await world.ok('browser_snapshot',{operationId:next});expect((await world.mcp.call('browser_click',{operationId:next,ref:reference,mode:'hover'})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
 await page.reload();const fresh=(await world.ok('browser_snapshot',{operationId:next})).data;await world.ok('browser_click',{operationId:next,ref:ref(fresh,'Native text'),mode:'hover'});
});
for(const trusted of [false,true])for(const kind of ['key','mouse'])test(`D03 control input pairs releases, trusted=${trusted}, kind=${kind}`,async()=>{
 const {page,operationId,reference}=await fixture(true,trusted,kind,trusted?'none':'alert');
 await world.ok(kind==='key'?'browser_press':'browser_click',{operationId,ref:reference,...(kind==='key'?{key:'Enter',modifiers:['Control']}:{})});const actual=await state(page);expect(actual.keys).toEqual([]);expect(actual.dragging).toBe(false);
});
test('D04 keyup dialog still releases the remaining modifier',async()=>{
 const {page,operationId,reference}=await fixture(true,true,'key','alert','keyup');
 const r=await world.ok('browser_press',{operationId,ref:reference,key:'Enter',modifiers:['Control']});expect(r.verified?.incomplete).toBe(true);expect((await state(page)).keys).toEqual([]);
});
test('D05 modifier dialog does not send the principal key',async()=>{
 const {page,operationId,reference}=await fixture(true,true,'key','alert','keydown','Control');
 await world.ok('browser_press',{operationId,ref:reference,key:'Enter',modifiers:['Control']});const actual=await state(page);expect(actual.keys).toEqual([]);expect(actual.events.some((e:any)=>e.key==='Enter')).toBe(false);
});
for(const modifiers of [[],['Shift']])test(`D06 interrupted Space never adds a button activation (${modifiers.join('+')})`,async()=>{
 const {page,operationId,reference}=await fixture(true,true,'space','alert','keydown',' ');
 const r=await world.ok('browser_press',{operationId,ref:reference,key:'Space',modifiers});expect(r.verified).toMatchObject({incomplete:true,inputRecoveryRequired:true});const actual=await state(page);expect(actual.clicks).toBe(0);expect(actual.keys).toContain(' ');expect((await world.mcp.call('browser_press',{operationId,ref:reference,key:'Space'})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
});
test('D07 uninterrupted Space activates the button exactly once',async()=>{
 const {page,operationId,reference}=await fixture(true,true,'space','none','keydown',' ');await world.ok('browser_press',{operationId,ref:reference,key:'Space'});const actual=await state(page);expect(actual.keys).toEqual([]);expect(actual.clicks).toBe(1);
});
test('D08 empty native fill releases Backspace and preserves interruption metadata',async()=>{
 const {page,operationId,reference}=await fixture(true,true,'key','alert','keydown','Backspace');const r=await world.ok('browser_fill',{operationId,ref:reference,text:''});expect(r.verified).toMatchObject({incomplete:true,keysReleased:true});expect((await state(page)).keys).toEqual([]);
});
test('D09 confirm remains answerable while the key lease is pending',async()=>{
 const {page,operationId,reference}=await fixture(true,true,'key','confirm');
 const pending=await world.ok('browser_press',{operationId,ref:reference,key:'Enter',modifiers:['Control']});expect(pending.verified?.dialogPending).toBe(true);
 const reply=await world.ok('browser_dialog',{operationId,action:'respond',dialogId:pending.data.dialog.dialogId,accept:false});expect(reply.verified?.dialogAnswered).toBe(true);expect(reply.verified?.inputRecoveryRequired).not.toBe(true);await expect.poll(async()=>(await state(page)).keys.length).toBe(0);
});
test('D10 a dialog after acknowledged mouseup does not require manual recovery',async()=>{
 const {page,operationId,reference}=await fixture(true,true,'mouse','alert','mouseup');const r=await world.ok('browser_click',{operationId,ref:reference});expect(r.verified?.inputRecoveryRequired).not.toBe(true);expect(r.verified?.incomplete).not.toBe(true);expect((await state(page)).dragging).toBe(false);await world.ok('browser_click',{operationId,ref:reference,mode:'hover'});
});

test('D11 native cancelDragging and detach do not invent mouseup or reset page-held state',async()=>{
 const {page}=await fixture(false,false,'mouse','none');const tabId=await world.tabId(page),box=await page.locator('#action').boundingBox();
 await world.adminPage.evaluate(async({tabId,x,y})=>{await chrome.debugger.attach({tabId},'1.3');await chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',{type:'keyDown',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,modifiers:2});await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await chrome.debugger.sendCommand({tabId},'Input.cancelDragging');await chrome.debugger.detach({tabId});},{tabId,x:box!.x+10,y:box!.y+10});
 const actual=await state(page);expect(actual.dragging).toBe(true);expect(actual.keys).toEqual(['Control']);expect(actual.clicks).toBe(0);expect(actual.events.filter((e:any)=>['keyup','mouseup'].includes(e.type))).toHaveLength(0);
});
test('D12 raw native Space-up after a dialog activates the button, so cleanup must withhold it',async()=>{
 const {page}=await fixture(false,false,'space','alert','keydown',' ');const tabId=await world.tabId(page);await page.locator('#action').focus();
 await world.adminPage.evaluate(async tabId=>{await chrome.debugger.attach({tabId},'1.3');await chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '});await chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});await chrome.debugger.detach({tabId});},tabId);
 expect((await state(page)).clicks).toBe(1);
});
test('D13 stopping a pending confirm blocks a new operation without an extra release',async()=>{
 const {page,operationId,reference}=await fixture(true,true,'mouse','confirm');const event=page.waitForEvent('dialog');
 const pending=await world.ok('browser_click',{operationId,ref:reference});expect(pending.verified?.dialogPending).toBe(true);const dialog=await event;
 const started=Date.now();await world.admin('operation.abort',{operationId});await dialog.dismiss();
 const next=await world.attach(page);await world.ok('browser_snapshot',{operationId:next});
 await expect.poll(async()=> (await world.mcp.call('browser_click',{operationId:next,ref:reference,mode:'hover'})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
 expect(Date.now()-started).toBeLessThan(4000);const actual=await state(page);expect(actual.clicks).toBe(0);expect(actual.drops).toBe(0);expect(actual.moves).toBe(0);expect(actual.events.filter((e:any)=>e.type==='mouseup')).toHaveLength(0);
});

for(const initial of ['newtab','crashed'])test(`D14 goto bootstraps an untainted ${initial} tab`,async()=>{
 const {page,operationId}=await fixture(false,true,'key','none');
 if(initial==='newtab')await page.goto('chrome://newtab/');
 if(initial==='crashed'){const cdp=await world.context.newCDPSession(page);const crash=page.waitForEvent('crash');void cdp.send('Page.crash').catch(()=>{});await crash;}
 const r=await world.ok('browser_navigate',{operationId,url:world.fixture.base+'/advanced.html'});expect(r.data.snapshot.url).toContain('/advanced.html');
});
test('D15 an onclick alert preserves completed-click navigation observation',async()=>{
 const {page,operationId,reference}=await fixture(false,true,'mouse','none');
 await page.locator('#action').evaluate(el=>(el as HTMLButtonElement).onclick=()=>{alert('Saved');setTimeout(()=>location.href='/detail.html',100);});
 const r=await world.ok('browser_click',{operationId,ref:reference});expect(r.verified?.incomplete).not.toBe(true);expect(r.data.snapshot.url).toContain('/detail.html');
});
test('D16 a final modifier-up dialog keeps an acknowledged key gesture complete',async()=>{
 const {page,operationId,reference}=await fixture(false,true,'key','alert','keyup','Control');const r=await world.ok('browser_press',{operationId,ref:reference,key:'Enter',modifiers:['Control']});expect(r.verified?.incomplete).not.toBe(true);expect((await state(page)).keys).toEqual([]);
});

test('D17 discard replacement rejects the old operation tab without navigating another tab',async()=>{
 // Native Windows Chrome 155 closes the Playwright context after raw tabs.discard,
 // including with the unmodified v0.3.0 ZIP and no operation/input (status.md).
 test.skip(process.platform==='win32','Windows raw-discard transport limitation; Linux verifies old-tab refusal');
 const {page,operationId}=await fixture(false,true,'key','none');const original=await world.tabId(page);
 await world.adminPage.bringToFront();const discarded=await world.adminPage.evaluate(tabId=>chrome.tabs.discard(tabId),original);
 expect(discarded.id).not.toBe(original);
 const r=await world.mcp.call('browser_navigate',{operationId,url:world.fixture.base+'/detail.html'});expect(r.error?.code).toBe('TAB_NOT_FOUND');expect(r.executed).toBe('no');
 expect((await world.adminPage.evaluate(tabId=>chrome.tabs.get(tabId),discarded.id)).url).toContain('/advanced.html');
});
