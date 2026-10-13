import {test,expect,type Page} from '@playwright/test';
import {startWorld,type World} from './harness';
import {startOpenCodeFixture} from '../fixtures/opencode.mjs';
declare const chrome:any;
let world:World,lease:string|undefined,scope:any,api:Awaited<ReturnType<typeof startOpenCodeFixture>>;
const panel=async(message:any)=>{const response=await world.adminPage.evaluate(m=>chrome.runtime.sendMessage(m),message);expect(response?.ok,JSON.stringify(response)).toBe(true);return response.result;};
const call=(name:string,args:Record<string,unknown>)=>world.mcp.call(name,args);
const ok=(name:string,args:Record<string,unknown>)=>world.ok(name,args);
const tabs=()=>world.adminPage.evaluate(()=>chrome.tabs.query({}));
const url=(path:string)=>world.fixture.base+'/'+path;
const snap=async(operationId:string)=>(await ok('browser_snapshot',{operationId})).data;
const find=(snapshot:any,name:string)=>{
 const matches=snapshot.frames.flatMap((f:any)=>f.elements).filter((e:any)=>e.name===name);
 expect(matches,`exact accessible name: ${name}`).toHaveLength(1);return matches[0].ref;
};
async function begin(page:Page|null){
 lease=crypto.randomUUID();scope={requestId:lease,messageId:'msg_'+lease,profileId:'journeys',directory:api.directory,sessionId:api.session().id};
 await panel({kind:'request-prepare',lease:scope,target:page?{tabId:await world.tabId(page),windowId:1}:null});return lease;
}
async function attach(page:Page){await begin(page);return (await ok('browser_tabs',{action:'attach',requestId:lease})).operationId!;}
async function create(operationId?:string,path='journey-detail.html?id=A'){
 const result=await ok('browser_tabs',{action:'new',...(operationId?{operationId}:{requestId:lease}),url:url(path)});
 return {operationId:result.operationId!,id:result.data.tab.tabId};
}
async function select(operationId:string,tabId:number){await ok('browser_tabs',{action:'switch',operationId,tabId});return snap(operationId);}
async function editAndSave(operationId:string,label:string,text:string){
 const before=await snap(operationId);await ok('browser_fill',{operationId,ref:find(before,label),text});
 await ok('browser_click',{operationId,ref:find(await snap(operationId),'메모 저장')});
 expect(JSON.stringify(await snap(operationId))).toContain('저장됨: '+text);
}
async function close(operationId:string){await snap(operationId);expect((await ok('browser_tabs',{action:'close',operationId})).verified).toMatchObject({closed:true});}
async function finish(){
 if(lease){await panel({kind:'request-discard',requestId:lease});lease=undefined;}
 const status=await world.admin('status.get');if(status.operation)await call('browser_tabs',{action:'release',operationId:status.operation.id});
}
test.beforeAll(async({},info)=>{world=await startWorld();api=await startOpenCodeFixture();await world.admin('profile.save',{profile:{id:'journeys',name:'Synthetic journeys',kind:'external',baseUrl:api.origin,username:api.username,password:api.password,directory:api.directory}});await info.attach('runtime',{body:JSON.stringify(world.runtime),contentType:'application/json'});console.log('JOURNEYS runtime '+JSON.stringify(world.runtime));});
test.afterEach(async()=>{world.relay.clearHolds();await finish();for(const page of world.context.pages())if(page!==world.adminPage)await page.close();});
test.afterAll(async()=>{await world?.stop();await api?.close();});

for(const start of ['web','blank','newtab'] as const)for(const creation of ['url','blank','window','implicit'] as const){
 test(`J01 ${start}/${creation}: begin request, create tab, navigate, edit/save, return or close`,async()=>{
  const source=await world.context.newPage();await source.goto(start==='web'?url('journey.html'):start==='newtab'?'chrome://newtab/':'about:blank');
  await begin(start==='web'?source:null);
  const windowId=(await world.adminPage.evaluate(()=>chrome.windows.getLastFocused())).id;
  const result=await ok('browser_tabs',{action:'new',requestId:lease,...(creation==='url'||creation==='window'?{url:url('journey-detail.html?id=A')}:creation==='blank'?{url:'about:blank'}:{}),...(creation==='window'?{windowId}:{})});
  const operationId=result.operationId!;
  if(creation==='blank'||creation==='implicit')await ok('browser_navigate',{operationId,url:url('journey-detail.html?id=A')});
  expect((await snap(operationId)).tabId).toBe(result.data.tab.tabId);
  await editAndSave(operationId,'상세 메모',`${start}-${creation}`);
  await close(operationId);expect((await tabs()).some((t:any)=>t.id===result.data.tab.tabId)).toBe(false);
  if(start==='web')expect((await select(operationId,await world.tabId(source))).url).toBe(source.url());
  else expect(source.isClosed()).toBe(false);
 });
}

test('J02 existing catalog: search, read detail in same tab, go back, save a comparison note',async()=>{
 const page=await world.open('journey.html'),operationId=await attach(page);
 await ok('browser_fill',{operationId,ref:find(await snap(operationId),'검색어'),text:'문구'});
 const click=await call('browser_click',{operationId,ref:find(await snap(operationId),'검색')});expect(click.ok||click.error?.code==='EXECUTION_UNKNOWN').toBe(true);
 await expect(page).toHaveURL(/q=/);expect(JSON.stringify(await snap(operationId))).toContain('검색 결과: 문구');
 const detail=await call('browser_click',{operationId,ref:find(await snap(operationId),'상품 A · 12000')});expect(detail.ok||detail.error?.code==='EXECUTION_UNKNOWN').toBe(true);
 expect(JSON.stringify(await snap(operationId))).toContain('12000');
 await ok('browser_navigate',{operationId,action:'back'});await editAndSave(operationId,'비교 메모','A는 12000');
});
test('J03 catalog -> new detail tab -> read table -> original note -> detail close -> original',async()=>{
 const page=await world.open('journey.html'),original=await world.tabId(page),operationId=await attach(page);
 const clicked=await ok('browser_click',{operationId,ref:find(await snap(operationId),'상품 A · 12000'),newTab:true});
 const child=clicked.data.openedTabs[0].tabId;await select(operationId,child);expect(JSON.stringify(await snap(operationId))).toContain('12000');
 await select(operationId,original);await editAndSave(operationId,'비교 메모','상품 A 12000');await select(operationId,child);await close(operationId);
 expect((await select(operationId,original)).tabId).toBe(original);
});
test('J04 three pre-existing tabs: A -> B -> catalog -> A, preserve every entered note',async()=>{
 const catalog=await world.open('journey.html'),a=await world.open('journey-detail.html?id=A'),b=await world.open('journey-detail.html?id=B');
 const operationId=await attach(a);await editAndSave(operationId,'상세 메모','A 확인');
 await select(operationId,await world.tabId(b));await editAndSave(operationId,'상세 메모','B 확인');
 await select(operationId,await world.tabId(catalog));await editAndSave(operationId,'비교 메모','A 12000 / B 18000');
 await select(operationId,await world.tabId(a));await expect(a.locator('#note')).toHaveValue('A 확인');await expect(b.locator('#note')).toHaveValue('B 확인');
});
test('J05 existing + two new details: compare -> close background detail -> continue original',async()=>{
 const page=await world.open('journey.html'),original=await world.tabId(page),operationId=await attach(page);
 const a=await create(operationId),b=await create(operationId,'journey-detail.html?id=B');
 await select(operationId,a.id);expect(JSON.stringify(await snap(operationId))).toContain('12000');
 await select(operationId,b.id);expect(JSON.stringify(await snap(operationId))).toContain('18000');
 await select(operationId,original);await editAndSave(operationId,'비교 메모','差額 6000');
 await select(operationId,a.id);await close(operationId);await select(operationId,original);
 expect((await tabs()).some((t:any)=>t.id===b.id)).toBe(true);await expect(page.locator('#note')).toHaveValue('差額 6000');
});
test('J06 close initial existing tab -> switch to existing survivor -> continue editing',async()=>{
 const a=await world.open('journey-detail.html?id=A'),b=await world.open('journey.html');const survivor=await world.tabId(b),operationId=await attach(a);
 await close(operationId);expect(a.isClosed()).toBe(true);await select(operationId,survivor);await editAndSave(operationId,'비교 메모','계속 작업');
});
test('J07 close last operation tab -> create a replacement -> navigate and continue',async()=>{
 await begin(null);const first=await create();await close(first.operationId);const second=await create(first.operationId,'journey-detail.html?id=B');
 expect(second.id).not.toBe(first.id);await editAndSave(first.operationId,'상세 메모','새 작업');
});
test('J08 manual focus changes during A/B comparison do not replace the explicit target',async()=>{
 const a=await world.open('journey-detail.html?id=A'),b=await world.open('journey-detail.html?id=B');const operationId=await attach(a);
 await b.bringToFront();expect((await snap(operationId)).tabId).toBe(await world.tabId(a));
 await select(operationId,await world.tabId(b));await a.bringToFront();await editAndSave(operationId,'상세 메모','B에만 입력');
 await expect(b.locator('#note')).toHaveValue('B에만 입력');await expect(a.locator('#note')).toHaveValue('');
});
test('J09 background tab closes manually -> reject switch -> continue in original',async()=>{
 const page=await world.open('journey.html'),operationId=await attach(page),child=await create(operationId);await select(operationId,await world.tabId(page));
 await world.adminPage.evaluate(id=>chrome.tabs.remove(id),child.id);
 expect((await call('browser_tabs',{action:'switch',operationId,tabId:child.id})).error?.code).toBe('TAB_NOT_FOUND');await editAndSave(operationId,'비교 메모','살아 있는 탭');
});
test('J10 current tab closes manually -> stale reads fail -> switch existing survivor and continue',async()=>{
 const a=await world.open('journey-detail.html?id=A'),b=await world.open('journey.html'),operationId=await attach(a);const removed=world.relay.nextEvent('tab.closed',d=>d.tabId!==undefined);
 await a.close();await removed;expect((await call('browser_snapshot',{operationId})).error?.code).toBe('TAB_CLOSED');
 await select(operationId,await world.tabId(b));await editAndSave(operationId,'비교 메모','복구 후 계속');
});
for(const field of ['input','iframe','contenteditable'] as const)test(`J11 ${field}: refuse unsaved tab close, return to catalog, preserve user edits`,async()=>{
 const page=await world.open('journey.html'),original=await world.tabId(page),operationId=await attach(page),child=await create(operationId);
 const target=world.context.pages().find(p=>p.url()===url('journey-detail.html?id=A'))!;
 if(field==='input')await ok('browser_fill',{operationId,ref:find(await snap(operationId),'상세 메모'),text:'미저장'});
 if(field==='contenteditable')await target.evaluate(()=>{const div=document.createElement('div');div.contentEditable='true';div.textContent='미저장';document.body.append(div);});
 if(field==='iframe'){await target.evaluate(()=>{const f=document.createElement('iframe');f.src='journey.html';document.body.append(f);});await expect(target.frameLocator('iframe').locator('#note')).toBeVisible();await target.frameLocator('iframe').locator('#note').fill('미저장');}
 await snap(operationId);expect((await call('browser_tabs',{action:'close',operationId})).error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
 expect(target.isClosed()).toBe(false);await select(operationId,original);await editAndSave(operationId,'비교 메모','닫기 보류');expect((await tabs()).some((t:any)=>t.id===child.id)).toBe(true);
});
for(const bad of ['omitted','wrong','previous'] as const)test(`J12 ${bad} requestId: no tab created, corrected current request continues normally`,async()=>{
 if(bad==='previous'){await begin(null);await finish();}
 const current=await begin(null),before=(await tabs()).length;
 const rejected=await call('browser_tabs',{action:'new',...(bad==='omitted'?{}:{requestId:bad==='wrong'?'wrong':'expired'}),url:url('journey-detail.html?id=A')});
 expect(rejected.ok).toBe(false);expect(rejected.executed).toBe('no');expect((await tabs()).length).toBe(before);
 const child=await create();expect(lease).toBe(current);await editAndSave(child.operationId,'상세 메모','교정된 요청');
});
for(const badUrl of ['chrome://settings/','file:///C:/fixture.txt','javascript:alert(1)','data:text/html,fixture','https://chromewebstore.google.com/'])test(`J13 unsupported ${badUrl.split(':')[0]}/${badUrl.includes('webstore')}: no navigation, valid new tab still works`,async()=>{
 await begin(null);const before=(await tabs()).length;
 expect((await call('browser_tabs',{action:'new',requestId:lease,url:badUrl})).ok).toBe(false);expect((await tabs()).length).toBe(before);
 const child=await create();await editAndSave(child.operationId,'상세 메모','정상 주소');
});
test('J14 two new tabs in one request use the existing operation; a repeated bootstrap cannot duplicate',async()=>{
 await begin(null);const first=await create(),before=(await tabs()).length;
 const duplicate=await call('browser_tabs',{action:'new',requestId:lease,url:url('journey-detail.html?id=B')});expect(duplicate.error?.code).toBe('BROWSER_BUSY');expect((await tabs()).length).toBe(before);
 const second=await create(first.operationId,'journey-detail.html?id=B');await select(first.operationId,first.id);await editAndSave(first.operationId,'상세 메모','A 유지');await select(first.operationId,second.id);await close(first.operationId);
});
test('J15 blank tab -> snapshot/close rejected -> navigate -> edit/save -> close',async()=>{
 await begin(null);const blank=await ok('browser_tabs',{action:'new',requestId:lease}),operationId=blank.operationId!;
 expect((await call('browser_snapshot',{operationId})).error?.code).toBe('UNSUPPORTED_PAGE');expect((await call('browser_tabs',{action:'close',operationId})).error?.code).toBe('UNSUPPORTED_PAGE');
 await ok('browser_navigate',{operationId,url:url('journey-detail.html?id=A')});await editAndSave(operationId,'상세 메모','이동 후 사용');await close(operationId);
});
test('J16 navigation history: A -> B -> back A -> forward B -> reload -> saved note',async()=>{
 await begin(null);const {operationId}=await create();await snap(operationId);
 await ok('browser_navigate',{operationId,url:url('journey-detail.html?id=B')});expect(JSON.stringify(await snap(operationId))).toContain('18000');
 await ok('browser_navigate',{operationId,action:'back'});expect(JSON.stringify(await snap(operationId))).toContain('12000');
 await ok('browser_navigate',{operationId,action:'forward'});expect(JSON.stringify(await snap(operationId))).toContain('18000');
 await ok('browser_navigate',{operationId,action:'reload'});await editAndSave(operationId,'상세 메모','기록 이동 완료');
});
test('J17 A refs cannot edit B; switching back requires a fresh observation',async()=>{
 const a=await world.open('journey-detail.html?id=A'),operationId=await attach(a),ref=find(await snap(operationId),'상세 메모');const b=await create(operationId,'journey-detail.html?id=B');
 expect((await call('browser_fill',{operationId,ref,text:'잘못된 대상'})).error?.code).toBe('STALE_ELEMENT');await editAndSave(operationId,'상세 메모','B만 변경');
 await select(operationId,await world.tabId(a));await editAndSave(operationId,'상세 메모','A만 변경');expect(b.id).not.toBe(await world.tabId(a));
});
for(const phase of ['before-new','after-new','after-switch'] as const)test(`J18 Stop ${phase}: late actions blocked, next request starts and continues`,async()=>{
 const page=await world.open('journey.html');await begin(page);let operationId:string|undefined;
 if(phase!=='before-new'){operationId=(await create()).operationId;if(phase==='after-switch')await select(operationId,await world.tabId(page));}
 const old=lease;
 await panel({kind:'request-cancel',scope});lease=undefined;const before=(await tabs()).length;
 expect((await call('browser_tabs',{action:'new',requestId:old,url:url('journey-detail.html?id=B')})).ok).toBe(false);
 if(operationId)expect((await call('browser_navigate',{operationId,url:url('journey-detail.html?id=B')})).error?.code).toBe('CANCELLED');
 expect((await tabs()).length).toBe(before);await begin(page);const next=await create();await editAndSave(next.operationId,'상세 메모','새 요청');
});
test('J19 release then resume in same request; completion invalidates all old identifiers',async()=>{
 const page=await world.open('journey.html'),operationId=await attach(page);await ok('browser_tabs',{action:'release',operationId});
 const child=await create();await editAndSave(child.operationId,'상세 메모','같은 요청의 다음 작업');const old=lease;await finish();
 const count=(await tabs()).length;expect((await call('browser_tabs',{action:'new',requestId:old})).ok).toBe(false);expect((await tabs()).length).toBe(count);
});
test('J20 close another tab only after explicit selection, return to original without losing state',async()=>{
 const a=await world.open('journey.html'),b=await world.open('journey-detail.html?id=B');const original=await world.tabId(a),other=await world.tabId(b),operationId=await attach(a);
 await editAndSave(operationId,'비교 메모','원본 유지');
 expect((await call('browser_tabs',{action:'close',operationId,tabId:other})).error?.code).toBe('INVALID_PARAMS');expect(b.isClosed()).toBe(false);
 await select(operationId,other);await close(operationId);await select(operationId,original);await expect(a.locator('#note')).toHaveValue('원본 유지');
});
test('J21 invalid destination window -> no stranded operation -> choose live window and continue',async()=>{
 await begin(null);const before=(await tabs()).length;expect((await call('browser_tabs',{action:'new',requestId:lease,windowId:2147483647,url:url('journey.html')})).ok).toBe(false);
 expect((await tabs()).length).toBe(before);const child=await create();await editAndSave(child.operationId,'상세 메모','복구');
});
test('J22 across two Chrome windows: existing A -> existing B -> new child in B -> return A',async()=>{
 const a=await world.open('journey.html'),operationId=await attach(a);
 const win=await world.adminPage.evaluate(url=>chrome.windows.create({url,focused:false}),url('journey-detail.html?id=B'));
 try{await expect.poll(async()=> (await tabs()).find((t:any)=>t.id===win.tabs[0].id)?.status).toBe('complete');
 await select(operationId,win.tabs[0].id);await editAndSave(operationId,'상세 메모','다른 창');const child=await create(operationId);
 expect((await tabs()).find((t:any)=>t.id===child.id).windowId).toBe(win.id);await close(operationId);await select(operationId,await world.tabId(a));await editAndSave(operationId,'비교 메모','원래 창');
 }finally{await world.adminPage.evaluate(id=>chrome.windows.remove(id),win.id).catch(()=>{});}
});
for(const kind of ['link-tab','popup-window','nested-popup'] as const)test(`J23 ${kind}: user closes adopted child, original resumes, next request remains usable`,async()=>{
 const page=await world.open('journey.html'),original=await world.tabId(page),operationId=await attach(page);
 await page.evaluate(kind=>{const a=document.querySelector('a')!;a.textContent='팝업 상세';a.target='_blank';if(kind!=='link-tab'){a.removeAttribute('target');a.onclick=e=>{e.preventDefault();window.open(a.href,'','popup,width=600,height=500');};}},kind);
 const childEvent=world.context.waitForEvent('page');await ok('browser_click',{operationId,ref:find(await snap(operationId),'팝업 상세')});
 const child=await childEvent;await child.waitForLoadState();const childId=await world.tabId(child);expect((await snap(operationId)).tabId).toBe(childId);
 if(kind==='nested-popup'){
  await child.evaluate(()=>{const a=document.querySelector('a')!;a.textContent='두 번째 팝업';a.href='journey.html?nested=1';a.target='_blank';});
  const grandchildEvent=world.context.waitForEvent('page');await ok('browser_click',{operationId,ref:find(await snap(operationId),'두 번째 팝업')});const grandchild=await grandchildEvent;await grandchild.waitForLoadState();
  const grandchildId=await world.tabId(grandchild),gone=world.relay.nextEvent('tab.closed',d=>d.tabId===grandchildId);await grandchild.close();await gone;
  expect((await snap(operationId)).tabId).toBe(childId);await editAndSave(operationId,'상세 메모','중첩 복귀');
 }
 const closed=world.relay.nextEvent('tab.closed',d=>d.tabId===childId);await child.close();await closed;
 expect((await snap(operationId)).tabId).toBe(original);await editAndSave(operationId,'비교 메모','팝업 닫은 뒤 계속');
 await finish();await begin(page);const next=await create();await editAndSave(next.operationId,'상세 메모','다음 요청도 정상');
});
for(const initial of ['existing','created'] as const)test(`J24 ${initial}: native beforeunload cancellation preserves tab and operation, then continue elsewhere`,async()=>{
 const catalog=await world.open('journey.html');let page:Page,operationId:string;
 if(initial==='existing'){page=await world.open('journey-detail.html?id=A');operationId=await attach(page);}
 else{operationId=await attach(catalog);await create(operationId);page=world.context.pages().find(p=>p.url()===url('journey-detail.html?id=A'))!;}
 await snap(operationId);await page.getByRole('heading').click();await page.evaluate(()=>{window.onbeforeunload=e=>{e.preventDefault();e.returnValue='';};});
 const before=await world.admin('status.get'),dialog=page.waitForEvent('dialog'),closing=call('browser_tabs',{operationId,action:'close'});
 const warning=await dialog;expect(warning.type()).toBe('beforeunload');await warning.dismiss();
 expect((await closing).error?.code).toBe('EXECUTION_UNKNOWN');expect(page.isClosed()).toBe(false);
 expect((await world.admin('status.get')).operation.currentTab).toBe(before.operation.currentTab);
 await page.evaluate(()=>{window.onbeforeunload=null;});await select(operationId,await world.tabId(catalog));await editAndSave(operationId,'비교 메모','닫기 취소 후 계속');
});
test('J25 existing tab with several history entries closes, survivor remains usable',async()=>{
 const catalog=await world.open('journey.html'),page=await world.open('journey-detail.html?id=A');await page.goto(url('journey-detail.html?id=B'));
 const operationId=await attach(page);await close(operationId);expect(page.isClosed()).toBe(true);await select(operationId,await world.tabId(catalog));await editAndSave(operationId,'비교 메모','기존 탭 닫기 완료');
});
test('J26 cannot switch to Chrome settings; current task continues without losing its target',async()=>{
 const page=await world.open('journey.html'),operationId=await attach(page),internal=await world.context.newPage();await internal.goto('chrome://settings/');
 const id=await world.adminPage.evaluate(async()=> (await chrome.tabs.query({})).find((t:any)=>t.url==='chrome://settings/').id);
 expect((await call('browser_tabs',{action:'switch',operationId,tabId:id})).error?.code).toBe('UNSUPPORTED_PAGE');
 expect((await snap(operationId)).tabId).toBe(await world.tabId(page));await editAndSave(operationId,'비교 메모','허용된 페이지에서 계속');
});
test('J27 own blank tab can be revisited after another tab, then navigated and used',async()=>{
 const page=await world.open('journey.html'),operationId=await attach(page);const blank=await ok('browser_tabs',{action:'new',operationId});
 await select(operationId,await world.tabId(page));await ok('browser_tabs',{action:'switch',operationId,tabId:blank.data.tab.tabId});
 await ok('browser_navigate',{operationId,url:url('journey-detail.html?id=A')});await editAndSave(operationId,'상세 메모','빈 탭 복귀');
});
test('J28 automatic popup return requires a fresh observation before another page mutation',async()=>{
 const page=await world.open('journey.html'),operationId=await attach(page);await snap(operationId);const child=await create(operationId);
 const removed=world.relay.nextEvent('tab.closed',d=>d.tabId===child.id);await world.adminPage.evaluate(id=>chrome.tabs.remove(id),child.id);await removed;
 const result=await call('browser_navigate',{operationId,url:url('journey-detail.html?id=B')});expect(result.error?.code).toBe('STALE_ELEMENT');
 expect(page.url()).toBe(url('journey.html'));await snap(operationId);await editAndSave(operationId,'비교 메모','대상 확인 후 계속');
});
