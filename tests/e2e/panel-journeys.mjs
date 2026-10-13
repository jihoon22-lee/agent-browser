// Real side panel/OpenCode/MCP transport; tool choices are deterministic fixture output.
import assert from 'node:assert/strict';
export async function runPanelJourneys({context,admin,panel,api,sessionId,providerUrl,siteUrl,until,wait,report}) {
 const tab=(action,args={})=>({tool:'browser_tabs',args:{action,...args}});
 const attach=()=>tab('attach',{requestId:'$requestId'}),fresh=(url,extra={})=>tab('new',{requestId:'$requestId',...(url?{url}:{}),...extra});
 const select=id=>tab('switch',{operationId:'$operationId',tabId:id});
 const next=url=>tab('new',{operationId:'$operationId',...(url?{url}:{})});
 const snapshot=(extra={})=>({tool:'browser_snapshot',args:{operationId:'$operationId'},...extra});
 const close=()=>tab('close',{operationId:'$operationId'});
 const navigate=url=>({tool:'browser_navigate',args:{operationId:'$operationId',url}});
 const catalog=siteUrl+'/journey.html',detail=siteUrl+'/journey-detail.html?id=A';
 const save=label=>[snapshot(),{tool:'browser_fill',args:{operationId:'$operationId',ref:'$ref:'+label,text:'패널 연속 작업'}},snapshot(),{tool:'browser_click',args:{operationId:'$operationId',ref:'$ref:메모 저장'}},snapshot()];
 const cases=[
  {name:'new URL from existing page',steps:()=>[fresh(detail),...save('상세 메모'),close()]},
  {name:'new blank then navigate',steps:()=>[fresh(),navigate(detail),...save('상세 메모'),close()]},
  {name:'attach then new then original',steps:(_,original)=>[attach(),next(detail),snapshot(),select(original),...save('비교 메모')]},
  {name:'close child and resume original',steps:()=>[attach(),next(detail),snapshot(),close(),...save('비교 메모')]},
  {name:'switch between pre-existing tabs',steps:(other,original)=>[attach(),select(other),...save('상세 메모'),select(original),...save('비교 메모')]},
  {name:'close original and continue another existing tab',steps:other=>[attach(),snapshot(),close(),select(other),...save('상세 메모')]},
  {name:'two new tabs switch close and continue',steps:()=>[attach(),next(detail),next(siteUrl+'/journey-detail.html?id=B'),select('$tab:1'),snapshot(),close(),...save('상세 메모')]},
  {name:'new URL from blank active tab',source:'about:blank',steps:()=>[fresh(detail),...save('상세 메모')]},
  {name:'new blank from Chrome new-tab',source:'chrome://newtab/',steps:()=>[fresh(),navigate(detail),...save('상세 메모')]},
  {name:'missing requestId rejected then new succeeds',steps:()=>[{...tab('new',{url:detail}),error:true},fresh(detail),...save('상세 메모')]},
  {name:'wrong requestId rejected then new succeeds',steps:()=>[{...fresh(detail,{requestId:'invalid-fixture-request'}),error:true},fresh(detail),...save('상세 메모')]},
  {name:'user closes link-opened child and original resumes',steps:()=>[attach(),snapshot(),{tool:'browser_click',args:{operationId:'$operationId',ref:'$ref:상품 A · 12000',newTab:true}},select('$opened:2'),snapshot(),snapshot({pause:true}),...save('비교 메모')]},
 ];
 for(const item of cases) {
  const original=await context.newPage(),other=await context.newPage();
  await original.goto(item.source??catalog);await other.goto(detail);await original.bringToFront();
  const all=await admin.evaluate(()=>chrome.tabs.query({}));
  const originalId=all.find(t=>t.url===original.url())?.id,otherId=all.find(t=>t.url===other.url())?.id;
  const steps=item.steps(otherId,originalId);
  assert((await fetch(providerUrl+'/test/plan',{method:'POST',body:JSON.stringify({steps})})).ok);
  await panel(`(()=>{const t=document.querySelector('textarea[aria-label="메시지"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify('합성 연속 작업: '+item.name)});t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(100);await panel(`document.querySelector('textarea[aria-label="메시지"]').closest('form').requestSubmit()`);
  let lease,messages,answer,manuallyClosed=false;
  await until(async()=>{lease=await admin.evaluate(async()=> (await chrome.storage.local.get('panelBrowserRequest')).panelBrowserRequest);return !!lease;},'journey request reservation');
  await until(async()=>{
   const state=await fetch(providerUrl+'/test/state').then(r=>r.json());
   if(state.pauseAt!==undefined&&!manuallyClosed){
    const status=await admin.evaluate(()=>chrome.runtime.sendMessage({kind:'bridge',method:'status.get',params:{}}));
    assert(status.ok);const id=status.result.operation.currentTab;assert.notEqual(id,originalId);
    await admin.evaluate(id=>chrome.tabs.remove(id),id);manuallyClosed=true;
    await until(async()=>{const r=await admin.evaluate(()=>chrome.runtime.sendMessage({kind:'bridge',method:'status.get',params:{}}));return r.result.operation.currentTab===originalId;},'popup target restored');
    await fetch(providerUrl+'/test/continue');
   }
   messages=await api('/session/'+sessionId+'/message');
   answer=messages.filter(m=>m.info.role==='assistant'&&m.info.parentID===lease.messageId).at(-1);
   if(answer?.info.error)throw Error(item.name+': '+JSON.stringify(answer.info.error));
   return !!answer?.info.time?.completed&&!['tool-calls','unknown'].includes(answer.info.finish);
  },item.name+' completion',90000);
  const calls=messages.filter(m=>m.info.parentID===lease.messageId).flatMap(m=>m.parts.filter(p=>p.type==='tool'));
  assert.equal(calls.length,steps.length,item.name+': every planned action reached OpenCode');
  for(const [i,step] of steps.entries()){
   const call=calls[i];assert(call.tool.endsWith(step.tool));
   assert.equal(call.state.status,step.error?'error':'completed',item.name+' step '+i+': '+JSON.stringify(call.state));
   if(!step.error){const result=JSON.parse(call.state.output);assert.equal(result.ok,true,item.name+' step '+i);}
   if(step.args.requestId==='$requestId')assert.equal(call.state.input.requestId,lease.requestId);
  }
  await until(async()=>!(await admin.evaluate(async()=> (await chrome.storage.local.get('panelBrowserRequest')).panelBrowserRequest)),'journey request released');
  await until(()=>panel(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='응답 중단')?.disabled===true`),'journey Stop disabled');
  report.turns.push({scenario:item.name,toolCount:calls.length,requestId:lease.requestId,manuallyClosed,pass:true});
  console.log('PASS actual OpenCode panel journey: '+item.name);
  for(const page of context.pages())if(page!==admin)await page.close();
 }
}
