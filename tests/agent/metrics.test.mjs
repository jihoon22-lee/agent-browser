import test from 'node:test';
import assert from 'node:assert/strict';
import { collectModelMetrics, scoreGoalRun, renderModelHtml } from './metrics.mjs';
import { fetchOfficialPricing } from './pricing.mjs';
const tool=(id,name,input,data)=>({type:'tool_use',part:{callID:id,tool:'browser_'+name,state:{status:'completed',input,time:{start:100,end:140},output:JSON.stringify({ok:true,tool:name,data})}}});
const step={type:'step_finish',part:{id:'step-1',tokens:{input:10,output:5,reasoning:2,cache:{read:20,write:3}}}};
test('model metrics deduplicate tool/step events and sum cache/reasoning once',()=>{
  const call=tool('c1','browser_snapshot',{private:'NEVER_EXPORT'},{});
  const r=collectModelMetrics([call,call,step,step],200);
  assert.equal(r.toolCalls,1);assert.equal(r.modelSteps,1);assert.equal(r.toolDurationMs,40);
  assert.deepEqual(r.tokens,{input:10,output:5,reasoning:2,cacheRead:20,cacheWrite:3,total:null});
  assert.equal(collectModelMetrics([{...step,part:{...step.part,tokens:{...step.part.tokens,total:35}}}],200).tokens.total,35);
  assert.equal(r.elapsedMs,200);assert(!JSON.stringify(r).includes('NEVER_EXPORT'));
});
test('missing usage, missing tool times and partial runs never become zero-cost successes',()=>{
  const call=tool('c1','browser_snapshot',{},{});delete call.part.state.time;
  const r=collectModelMetrics([call,{type:'step_finish',part:{id:'s'}}],null);
  assert.equal(r.tokens,null);assert.equal(r.toolDurationMs,null);assert.equal(r.elapsedMs,null);
  assert.equal(collectModelMetrics([],null).modelSteps,null);
});
const text='에이전트 브라우저 / 12,000원 / a | b, c';
const finalTabs={data:{tabs:[{tabId:1,url:'http://127.0.0.1:8790/search.html'},{tabId:2,url:'http://127.0.0.1:8790/detail.html?id=1'}]}};
const args={fixtureUrl:'http://127.0.0.1:8790',initialTabId:1,finalTabs,fixtureLog:{events:[{type:'search',body:{q:'query',category:'도서'}}]},query:'query',category:'도서',exitCode:0,preflight:{initialized:true,toolsListed:true,browserConnected:true}};
test('goal scoring accepts link-newTab and attached snapshots without imposing a tool recipe',()=>{
  const events=[tool('open','browser_click',{newTab:true},{snapshot:{tabId:2,url:'http://127.0.0.1:8790/detail.html?id=1',text}}),tool('return','browser_tabs',{action:'switch'},{tab:{tabId:1}}),tool('release','browser_tabs',{action:'release'},{released:true}),{type:'text',part:{text}}];
  assert.equal(scoreGoalRun({...args,events}).model.success,true);
  assert.equal(scoreGoalRun({...args,events,finalTabs:{data:{tabs:[finalTabs.data.tabs[0]]}}}).model.success,false);
  assert.equal(scoreGoalRun({...args,events:[{type:'text',part:{text}}]}).model.success,false);
});
test('goal scoring accepts a confirmed detail-tab close and wrapped MCP results',()=>{
  const opened=tool('open','browser_click',{newTab:true},{snapshot:{tabId:2,url:'http://127.0.0.1:8790/detail.html?id=1',text}});
  opened.part.state.output=JSON.stringify({content:[{type:'text',text:opened.part.state.output}]});
  const closed=tool('close','browser_tabs',{action:'close'},{tabId:2,currentTab:1});
  closed.part.state.output=JSON.stringify({...JSON.parse(closed.part.state.output),verified:{closed:true}});
  const events=[opened,closed,tool('release','browser_tabs',{action:'release'},{released:true}),{type:'text',part:{text}}];
  assert.equal(scoreGoalRun({...args,events,finalTabs:{data:{tabs:[finalTabs.data.tabs[0]]}}}).model.success,true);
  assert.equal(collectModelMetrics([opened],100).failedTools,0);
});
test('HTML model report escapes labels and contains only metrics supplied to it',()=>{
  const html=renderModelHtml({model:'<script>x</script>',taskMode:'goal',runs:[{index:1,success:false,metrics:collectModelMetrics([],10)}]});
  assert(!html.includes('<script>'));assert(html.includes('미측정'));assert(html.includes('&lt;script&gt;'));
});
test('official pricing follows only same-origin documentation redirects',async()=>{
  const urls=[];
  const response=await fetchOfficialPricing(async(url)=>{urls.push(url);return urls.length===1?new Response(null,{status:302,headers:{location:'/v2/docs/console/models/'}}):new Response('official prices');});
  assert.equal(await response.text(),'official prices');assert.equal(urls.length,2);
  await assert.rejects(fetchOfficialPricing(async()=>new Response(null,{status:302,headers:{location:'https://example.test/prices'}})),/official/);
});
