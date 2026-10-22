import { EXPECTED_VALUES, stopReason, parseOutcome } from './runner-lib.mjs';

function callsFrom(events) {
  const calls=new Map();
  for(const e of events)if(e.type==='tool_use' && (e.part?.callID||e.part?.id))calls.set(e.part.callID??e.part.id,e.part);
  return [...calls.values()].map(part=>{
    const outcome=parseOutcome(part.state?.output);
    const name=part.tool?.replace(/^browser_(?=browser_)/,'');
    return {part,name,outcome,success:part.state?.status==='completed'&&outcome?.ok===true&&outcome.tool===name};
  });
}
const finite=n=>Number.isFinite(n)&&n>=0;
export function collectModelMetrics(events,elapsedMs) {
  const calls=callsFrom(events),steps=new Map();
  events.forEach((event,index)=>{if(event.type==='step_finish')steps.set(event.part?.id??`event-${index}`,event.part);});
  const usage=[...steps.values()].map(part=>{
    const t=part?.tokens;
    return t&&[t.input,t.output,t.reasoning,t.cache?.read,t.cache?.write].every(finite)
      ? {input:t.input,output:t.output,reasoning:t.reasoning,cacheRead:t.cache.read,cacheWrite:t.cache.write}:null;
  });
  const tokens=usage.length&&usage.every(Boolean)?Object.fromEntries(['input','output','reasoning','cacheRead','cacheWrite'].map(k=>[k,usage.reduce((n,t)=>n+t[k],0)])):null;
  // Provider accounting may overlap output/reasoning/cache categories. Preserve
  // its reported total when present; do not invent a total by adding categories.
  const totals=[...steps.values()].map(part=>part?.tokens?.total);
  if(tokens)tokens.total=totals.every(finite)?totals.reduce((a,b)=>a+b,0):null;
  const durations=calls.map(c=>{const t=c.part.state?.time;return finite(t?.start)&&finite(t?.end)&&t.end>=t.start?t.end-t.start:null;});
  const outputs=calls.map(c=>typeof c.part.state?.output==='string'?Buffer.byteLength(c.part.state.output):null);
  return {elapsedMs:finite(elapsedMs)?elapsedMs:null,modelSteps:steps.size||null,usageSteps:usage.filter(Boolean).length,tokens,
    toolCalls:calls.length,failedTools:calls.filter(c=>!c.success).length,
    explicitSnapshots:calls.filter(c=>c.name==='browser_snapshot').length,
    consecutiveSnapshots:calls.filter((c,i)=>i>0&&c.name==='browser_snapshot'&&calls[i-1].name==='browser_snapshot').length,
    recoveryErrors:calls.filter(c=>['STALE_ELEMENT','EXECUTION_UNKNOWN','BROWSER_DISCONNECTED'].includes(c.outcome?.error?.code)).length,
    toolDurationMs:durations.length&&durations.every(finite)?durations.reduce((a,b)=>a+b,0):null,
    outputBytes:outputs.length&&outputs.every(finite)?outputs.reduce((a,b)=>a+b,0):null};
}

/** Goal evaluation admits different tool recipes. Fixture writes and independent tab listing
 * are the oracle; reads/return/release also require actual successful tool evidence, never prose. */
export function scoreGoalRun({events,fixtureLog,preflight,exitCode,query,category,fixtureUrl,initialTabId,finalTabs}) {
  const calls=callsFrom(events),successful=calls.filter(c=>c.success);
  const searches=(fixtureLog?.events??[]).filter(e=>e.type==='search');
  const initialIds=new Set((preflight?.tabs?.data?.tabs??[{tabId:initialTabId}]).map(t=>t.tabId));
  const tabs=finalTabs?.data?.tabs??[];
  const closedIds=new Set(successful.filter(c=>c.name==='browser_tabs'&&c.outcome.verified?.closed===true).map(c=>c.outcome.data?.tabId));
  const finalIds=new Set(tabs.map(tab=>tab.tabId));
  const observedTabs=[...tabs,...successful.flatMap(c=>[c.outcome.data?.tab,c.outcome.data?.snapshot,c.outcome.data].filter(Boolean))];
  const detailIds=new Set(observedTabs.filter(tab=>{
    if(!finalIds.has(tab.tabId)&&!closedIds.has(tab.tabId))return false;
    try{const u=new URL(tab.url);return !initialIds.has(tab.tabId)&&u.origin===fixtureUrl&&u.pathname==='/detail.html'&&u.searchParams.get('id')==='1';}catch{return false;}
  }).map(t=>t.tabId));
  let currentTab=initialTabId,readDetail=false,released=false;
  for(const call of successful) {
    const data=call.outcome.data??{};
    const target=data.currentTab??data.snapshot?.tabId??data.tab?.tabId??data.tabId;
    if(Number.isInteger(target))currentTab=target;
    if(detailIds.has(currentTab) && (['browser_snapshot','browser_extract'].includes(call.name)||data.snapshot) && EXPECTED_VALUES.every(v=>JSON.stringify(data).includes(v)))readDetail=true;
    if(call.outcome.operationId&&!data.released)released=false;
    if(call.name==='browser_tabs'&&data.released===true)released=true;
  }
  const finalText=events.filter(e=>e.type==='text').map(e=>e.part?.text??'').join('\n');
  const checks={searchCorrect:searches.length===1&&searches[0].body?.q===query&&searches[0].body?.category===category,
    newTab:detailIds.size>0,tableRead:readDetail,returned:currentTab===initialTabId&&tabs.some(t=>t.tabId===initialTabId&&t.url?.startsWith(fixtureUrl+'/search.html')),
    released,summaryCorrect:EXPECTED_VALUES.every(v=>finalText.includes(v)),cleanExit:exitCode===0&&!events.some(e=>e.type==='error')&&!stopReason(events)};
  return {communication:{success:preflight?.initialized===true&&preflight?.toolsListed===true&&preflight?.browserConnected===true},
    tools:{success:calls.length>0&&successful.length===calls.length,passed:successful.length,total:calls.length},model:{success:Object.values(checks).every(Boolean),checks}};
}
const escape=value=>String(value??'미측정').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderModelHtml(report) {
  const keys=['elapsedMs','modelSteps','toolCalls','failedTools','explicitSnapshots','consecutiveSnapshots','recoveryErrors','toolDurationMs','outputBytes'];
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>모델 업무 평가</title><style>body{font:16px/1.6 system-ui;max-width:1200px;margin:32px auto;padding:0 20px;color:#172033}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:10px;border:1px solid #dde3ee;text-align:left}.scroll{overflow:auto}</style><h1>모델 업무 평가</h1><p>${escape(report.model)} · ${escape(report.taskMode)}</p><p>시간은 CLI 시작부터 종료까지입니다. toolDurationMs는 개별 도구 시간 합계이며 모델 추론 시간 추정치가 아닙니다. 누락된 토큰은 미측정으로 표시합니다.</p><div class="scroll"><table><tr><th>실행</th><th>업무 결과</th>${keys.map(k=>`<th>${k}</th>`).join('')}<th>토큰(input/output/reasoning/cache)</th></tr>${report.runs.map(r=>`<tr><td>${escape(r.index)}</td><td>${r.success?'PASS':'FAIL / 중단'}</td>${keys.map(k=>`<td>${escape(r.metrics?.[k])}</td>`).join('')}<td>${r.metrics?.tokens?escape(JSON.stringify(r.metrics.tokens)):'미측정'}</td></tr>`).join('')}</table></div></html>`;
}
