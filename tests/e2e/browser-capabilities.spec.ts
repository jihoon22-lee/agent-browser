import {test,expect} from '@playwright/test';
import {startWorld,type World} from './harness';
declare const chrome:any;
let world:World;
test.beforeAll(async()=>{world=await startWorld();console.log('CAPABILITIES runtime '+JSON.stringify(world.runtime));});
test.afterEach(async()=>{
 const status=await world.admin('status.get');
 if(status.operation) await world.mcp.call('browser_tabs',{action:'release',operationId:status.operation.id});
 for(const page of world.context.pages()) if(page!==world.adminPage) await page.close();
});
test.afterAll(async()=>{await world?.stop();});
test('C01 new tab starts an operation without attaching or reading another page',async()=>{
 const opened=await world.ok('browser_tabs',{action:'new',url:world.fixture.base+'/board.html'});
 expect(opened.operationId).toMatch(/^op-/);
 const snap=await world.ok('browser_snapshot',{operationId:opened.operationId});
 expect(snap.data.frames[0].text.content).toContain('Board ready');
});
test('C02 attached operation opens a new tab without a prerequisite snapshot',async()=>{
 const page=await world.open('board.html'),operationId=await world.attach(page);
 const opened=await world.ok('browser_tabs',{action:'new',operationId,url:world.fixture.base+'/board.html?post=1'});
 expect(opened.data.tab.tabId).not.toBe(await world.tabId(page));
});

test('C03 empty new tab can navigate to a web page without injecting a Chrome internal page',async()=>{
 const created=await world.ok('browser_tabs',{action:'new'}),operationId=created.operationId!;
 expect(created.data.tab.url).toBe('about:blank');
 await world.ok('browser_navigate',{operationId,url:world.fixture.base+'/board.html'});
 expect((await world.ok('browser_snapshot',{operationId})).data.frames[0].text.content).toContain('Board ready');
});
test('C04 windows list, filtered tabs and explicit destination window work',async()=>{
 const createdWindow=await world.adminPage.evaluate(()=>chrome.windows.create({url:'about:blank',focused:false}));
 const windows=await world.ok('browser_tabs',{action:'windows'});
 expect(windows.data.windows.some((w:any)=>w.windowId===createdWindow.id)).toBe(true);
 const created=await world.ok('browser_tabs',{action:'new',windowId:createdWindow.id,url:world.fixture.base+'/board.html'});
 expect(created.data.tab.windowId).toBe(createdWindow.id);
 const list=await world.ok('browser_tabs',{action:'list',windowId:createdWindow.id});
 expect(list.data.tabs.length).toBeGreaterThan(0);expect(list.data.tabs.every((tab:any)=>tab.windowId===createdWindow.id)).toBe(true);
});
test('C04b windows list includes popup-type windows and their tabs',async()=>{
 const popup=await world.adminPage.evaluate(url=>chrome.windows.create({url,type:'popup',focused:false}),world.fixture.base+'/board.html');
 try{
  const windows=await world.ok('browser_tabs',{action:'windows'});
  expect(windows.data.windows.find((w:any)=>w.windowId===popup.id)?.type).toBe('popup');
  expect(windows.data.windows.some((w:any)=>w.type==='normal')).toBe(true);
  const list=await world.ok('browser_tabs',{action:'list',windowId:popup.id});
  expect(list.data.tabs.length).toBe(1);
 }finally{await world.adminPage.evaluate(id=>chrome.windows.remove(id),popup.id).catch(()=>{});}
});
test('C05 ordinary anchor opens in a new operation tab without navigating the source',async()=>{
 const page=await world.open('board.html'),operationId=await world.attach(page),original=page.url();
 const snap=(await world.ok('browser_snapshot',{operationId})).data;
 const link=snap.frames[0].elements.find((el:any)=>el.name==='Post 1');
 const clicked=await world.ok('browser_click',{operationId,ref:link.ref,newTab:true});
 expect(clicked.data.openedTabs[0].adopted).toBe(true);expect(page.url()).toBe(original);
 expect((await world.ok('browser_snapshot',{operationId})).data.frames[0].text.content).toContain('Body 1');
});
test('C06 bookmarks permission is optional and a denied read does not prompt or navigate',async()=>{
 const pages=world.context.pages().length;
 expect(await world.adminPage.evaluate(()=>chrome.permissions.contains({permissions:['bookmarks']}))).toBe(false);
 const response=await world.mcp.call('browser_bookmarks',{action:'list'});
 expect(response.error?.code).toBe('FORBIDDEN_METHOD');expect(response.error?.details).toMatchObject({permission:'bookmarks'});
 expect(world.context.pages()).toHaveLength(pages);
});

test('C07 empty tab permission boundary is explicit and never bypassed',async()=>{
 const created=await world.ok('browser_tabs',{action:'new'});
 const probe=await world.adminPage.evaluate(async(id)=>{
  try{return await chrome.scripting.executeScript({target:{tabId:id},func:()=>({url:location.href,empty:document.body?.textContent===''})});}
  catch(error){return {error:String(error)};}
 },created.data.tab.tabId);
 console.log('EMPTY TAB probe '+JSON.stringify(probe));expect(probe.error).toContain('about:blank');
 expect((await world.mcp.call('browser_snapshot',{operationId:created.operationId})).error?.code).toBe('UNSUPPORTED_PAGE');
 expect((await world.mcp.call('browser_tabs',{action:'close',operationId:created.operationId})).error).toMatchObject({code:'UNSUPPORTED_PAGE',message:expect.stringContaining('Blank tabs cannot be safely checked')});
 const listed=await world.ok('browser_tabs',{action:'list'});expect(listed.data.tabs.some((tab:any)=>tab.tabId===created.data.tab.tabId)).toBe(true);
});
test('C41 scroll moves the page when the body is its scroller, not a carousel with a sliver of overflow',async()=>{
 const page=await world.open('scroll-body.html'),operationId=await world.attach(page);
 const bodyTop=()=>page.evaluate(()=>document.body.scrollTop);
 expect(await page.evaluate(()=>{const c=document.querySelector('#carousel')!;return c.scrollHeight>c.clientHeight&&c.scrollWidth>c.clientWidth;})).toBe(true);
 const down=await world.ok('browser_scroll',{operationId,direction:'down'});
 expect(down.verified).toMatchObject({moved:true,target:'document'});
 expect(await bodyTop()).toBeGreaterThan(0);
 await world.ok('browser_scroll',{operationId,direction:'top'});
 expect(await bodyTop()).toBe(0);
 const snap=await world.ok('browser_snapshot',{operationId});
 const ref=snap.data.frames[0].elements.find((e:any)=>e.name==='Slide 1').ref;
 const fromSlide=await world.ok('browser_scroll',{operationId,ref,direction:'down'});
 expect(fromSlide.verified).toMatchObject({moved:true,target:'document'});
 expect(await bodyTop()).toBeGreaterThan(0);
 expect(await page.evaluate(()=>document.querySelector('#carousel')!.scrollTop)).toBe(0);
});
test('C40 scroll moves the area that can scroll and says when nothing moved',async()=>{
 const page=await world.open('scroll-shell.html'),operationId=await world.attach(page);
 const top=()=>page.evaluate(()=>document.querySelector('#scroller')!.scrollTop);
 // The document itself cannot scroll: an app shell keeps its rows in an inner area.
 const down=await world.ok('browser_scroll',{operationId,direction:'down'});
 expect(down.verified).toMatchObject({moved:true,target:'region',atEnd:false});
 expect(await top()).toBeGreaterThan(0);
 await world.ok('browser_scroll',{operationId,direction:'top'});
 const snap=await world.ok('browser_snapshot',{operationId});
 const ref=snap.data.frames[0].elements.find((e:any)=>e.name==='Open order 1').ref;
 const inner=await world.ok('browser_scroll',{operationId,ref,direction:'down'});
 expect(inner.verified).toMatchObject({moved:true,target:'ancestor'});
 expect(await top()).toBeGreaterThan(0);
 await world.ok('browser_scroll',{operationId,direction:'bottom'});
 const end=await world.ok('browser_scroll',{operationId,direction:'down'});
 expect(end.verified).toMatchObject({moved:false,atEnd:true,target:'region'});
 // A page whose document scrolls keeps scrolling the document.
 await world.ok('browser_tabs',{action:'release',operationId});
 const long=await world.open('board.html'),second=await world.attach(long);
 expect((await world.ok('browser_scroll',{operationId:second,direction:'down'})).verified).toMatchObject({target:'document'});
});
