import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startWorld, ROOT, type World } from './harness';
import { summarize, writeReports, benchmarkSuiteHash } from './metrics-report.mjs';
import type { ToolOutcome } from './mcp-driver';

const digest=(text:Uint8Array|string)=>createHash('sha256').update(text).digest('hex');
const samples=Number(process.env.AB_METRICS_SAMPLES??50);
if(!Number.isInteger(samples)||samples<1||samples>200)throw new Error('AB_METRICS_SAMPLES must be 1..200');
const label=process.env.AB_METRICS_RUN??new Date().toISOString().replace(/[^0-9TZ]/g,'');
if(!/^[a-zA-Z0-9_-]{1,80}$/.test(label))throw new Error('AB_METRICS_RUN must be a short file-safe label');
const directory=join(ROOT,'tests/agent/results/browser-metrics',label);
const run:any={schemaVersion:1,label,createdAt:new Date().toISOString(),environment:{},calls:[],oracles:[],connection:{},model:null,complete:false};
let world:World;
test.afterAll(async()=>{ await world?.stop(); });

test('collect browser timing and actual-state quality metrics',async()=>{
  await mkdir(directory,{recursive:true});
  // Refuse to silently replace a baseline or a previously interrupted run.
  const marker=await import('node:fs/promises').then(fs=>fs.open(join(directory,'run.json'),'wx'));
  await marker.close();
  try {
    world=await startWorld();
    if(process.env.AB_METRICS_TRUSTED==='1')await world.adminPage.evaluate(()=> (globalThis as any).chrome.storage.local.set({trustedInput:true}));
    let revision=process.env.AB_SOURCE_REVISION??'unknown';
    try{revision=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
    run.environment={platform:process.platform,arch:process.arch,nodeVersion:process.version,browserVersion:world.runtime.browserVersion,headless:world.runtime.headless,inputMode:process.env.AB_METRICS_TRUSTED==='1'?'trusted':'dom',bridgeBuild:process.env.AB_BRIDGE_BUILD??(process.platform==='win32'?'release':'debug'),sourceRevision:revision,
      suiteHash:await benchmarkSuiteHash(ROOT),extensionSha256:digest(await readFile(join(world.config.extensionDir,'content.js'))),bridgeSha256:digest(await readFile(world.config.bridgeExe))};
    const page=await world.open('quality.html');
    let operationId=await world.attach(page);
    const monitor=async()=>page.evaluate(()=>{
      const w=window as any,supported=PerformanceObserver.supportedEntryTypes.includes('longtask');w.qualityLongTasks=supported?[]:null;
      if(supported)new PerformanceObserver(list=>{for(const e of list.getEntries())w.qualityLongTasks.push({start:e.startTime,duration:e.duration});}).observe({type:'longtask',buffered:true});
    });
    await monitor();
    const ref=(s:any,name:string)=>s.frames.flatMap((f:any)=>f.elements).find((e:any)=>e.name===name)?.ref;
    const snap=async()=> (await world.ok('browser_snapshot',{operationId})).data;
    async function call(scenario:string,name:string,args:Record<string,unknown>,record=true):Promise<ToolOutcome> {
      const browserStart=await page.evaluate(()=>performance.now()).catch(()=>null);
      const first=world.relay.commandTimings.length,start=performance.now();
      let r:ToolOutcome;
      try{r=await world.mcp.call(name,args);}catch{
        if(record)run.calls.push({scenario,tool:name,durationMs:performance.now()-start,ok:false,errorCode:'TRANSPORT_ERROR',outcomeBytes:null,executed:'unknown'});
        throw new Error('Metrics tool transport failed; partial run was saved without raw output');
      }
      const durationMs=performance.now()-start;
      const long=await page.evaluate(s=>{const entries=(window as any).qualityLongTasks;if(!Array.isArray(entries)||s===null)return null;const found=entries.filter((e:any)=>e.start>=s);return {count:found.length,max:Math.max(0,...found.map((e:any)=>e.duration))};},browserStart).catch(()=>null);
      const routed=world.relay.commandTimings.slice(first);
      if(record)run.calls.push({scenario,tool:name,durationMs,ok:r.ok,errorCode:r.error?.code??null,executed:r.executed,outcomeBytes:Buffer.byteLength(JSON.stringify(r)),browserMs:routed.reduce((n,r)=>n+r.durationMs,0),snapshotMs:routed.filter(r=>r.method==='browser.snapshot').reduce((n,r)=>n+r.durationMs,0),longTaskCount:long?.count??null,longTaskMaxMs:long?.max??null});
      return r;
    }
    async function measure(scenario:string,name:string,args:()=>Promise<Record<string,unknown>>|Record<string,unknown>) {
      for(let i=0;i<=samples;i++) {const r=await call(scenario,name,await args(),i>0);if(!r.ok)throw new Error(`Timing workload ${scenario} failed: ${r.error?.code}`);}
      const timing=summarize(run).timings.find((t:any)=>t.scenario===scenario);console.log('METRIC '+JSON.stringify({scenario,...timing.duration}));
      await writeFile(join(directory,'run.json'),JSON.stringify(run,null,2));
    }
    const oracle=(scenario:string,passed:boolean,extra:Record<string,number>={})=>run.oracles.push({scenario,passed,wrongTarget:0,falseSuccess:0,duplicateWrites:0,postCancelWrites:0,...extra});
    await measure('tabs','browser_tabs',()=>({action:'list'}));
    const input=ref(await snap(),'Name');
    await measure('fill','browser_fill',()=>({operationId,ref:input,text:'sample'}));
    oracle('fill-retained',await page.locator('#name').inputValue()==='sample');
    const noop=ref(await snap(),'No change');
    await measure('click-no-change','browser_click',()=>({operationId,ref:noop}));
    await measure('click-dom-change','browser_click',async()=>({operationId,ref:ref(await snap(),'Change')}));
    for(const rows of [100,1000,5000]) {
      await page.evaluate(n=>{document.getElementById('main')!.innerHTML=Array.from({length:n},(_,i)=>`<div><span>Record ${i}</span><button>Action ${i}</button></div>`).join('');},rows);
      await measure('snapshot-'+rows,'browser_snapshot',()=>({operationId}));
      await measure('query-miss-'+rows,'browser_snapshot',()=>({operationId,query:'missing-record'}));
    }
    async function reset(){await page.goto(world.fixture.base+'/quality.html');await monitor();return snap();}
    let s=await reset();
    const row=s.frames[0].elements.find((e:any)=>e.name==='Cancel');
    await page.evaluate(()=>{document.querySelector('#rows span')!.textContent='C-3003';});
    const reused=await call('recycled-row','browser_click',{operationId,ref:row.ref});
    const wrong=await page.evaluate(()=>Number((window as any).quality.record==='C-3003'));
    oracle('recycled-row',!wrong&&!reused.ok,{wrongTarget:wrong,falseSuccess:wrong&&reused.ok?1:0});
    s=await reset();
    const rolled=await call('fill-rollback','browser_fill',{operationId,ref:ref(s,'Rollback'),text:'after'});
    const actual=await page.locator('#rollback').inputValue();
    const falseFill=actual!=='after'&&rolled.verified?.matches===true;
    oracle('fill-rollback',actual==='before'&&!falseFill,{falseSuccess:falseFill?1:0});
    oracle('label-priority',!!ref(s,'Order A-1001 action'));
    oracle('shadow-label',!!ref(s,'Shadow query'));
    const disabled=await call('aria-disabled','browser_click',{operationId,ref:ref(s,'Unavailable')});
    const disabledClicks=await page.evaluate(()=>(window as any).quality.counts.disabled??0);
    oracle('aria-disabled',disabledClicks===0&&!disabled.ok,{wrongTarget:disabledClicks,falseSuccess:disabledClicks&&disabled.ok?1:0});
    const query=await call('query-context','browser_snapshot',{operationId,query:'A-1001'});
    oracle('query-context',query.data.frames.flatMap((f:any)=>f.elements).some((e:any)=>e.name==='Cancel'&&e.context?.includes('A-1001')));
    s=await reset();
    const scrolled=await call('scroll-completion','browser_scroll',{operationId,ref:ref(s,'Scroll region'),direction:'down'});
    const scrollNow=await page.locator('.scroll').evaluate(e=>e.scrollTop);
    oracle('scroll-completion',Number(scrolled.verified?.scrollTop)>0&&Math.abs(Number(scrolled.verified?.scrollTop)-scrollNow)<2,{falseSuccess:scrolled.ok&&Number(scrolled.verified?.scrollTop)===0?1:0});
    // Replay precisely the same internal request; a fresh tool call is intentionally not a retry.
    s=await reset();
    const commandIndex=world.relay.commands.length;
    const submitted=await call('submit-once','browser_click',{operationId,ref:ref(s,'Submit once')});
    const command=world.relay.commands.slice(commandIndex).find(c=>c.method==='browser.click')!;
    await world.relay.replay(command);world.relay.clearHolds();
    const submissions=await page.evaluate(()=>(window as any).quality.counts.submit??0);
    oracle('duplicate-request',submitted.ok&&submissions===1,{duplicateWrites:Math.max(0,submissions-1)});
    await world.admin('operation.abort',{operationId});
    const stopped=await call('post-cancel','browser_click',{operationId,ref:ref(s,'Submit once')});
    const afterStop=await page.evaluate(()=>(window as any).quality.counts.submit??0);
    oracle('post-cancel',!stopped.ok&&afterStop===submissions,{postCancelWrites:Math.max(0,afterStop-submissions)});
    operationId=await world.attach(page);
    // Optional completion contract is measured as unsupported until an implementation supplies it.
    s=await reset();
    const delayed=await call('expected-result','browser_click',{operationId,ref:ref(s,'Delayed result'),waitFor:{text:'Ready result',timeoutMs:3000}});
    const ready=await page.locator('#result').textContent();
    oracle('expected-result',delayed.ok&&ready==='Ready result',{falseSuccess:delayed.ok&&ready!=='Ready result'?1:0});
    s=await reset();
    const late=await call('expected-navigation','browser_click',{operationId,ref:ref(s,'Delayed navigation'),waitFor:{urlIncludes:'/detail.html',timeoutMs:4000}});
    oracle('expected-navigation',late.ok&&late.data?.snapshot?.url?.endsWith('/detail.html')===true,{falseSuccess:late.ok&&!late.data?.snapshot?.url?.endsWith('/detail.html')?1:0});
    // A reconnect is an intentional fault; separate it from the steady-state disconnect count.
    const beforeDisconnects=world.relay.disconnects;
    const recoveryStart=performance.now();await world.restartWorker();
    run.connection={disconnects:beforeDisconnects,heartbeatMs:[...world.relay.heartbeatTimings],recoveryMs:performance.now()-recoveryStart};
    oracle('worker-recovery',(await call('worker-recovery','browser_tabs',{action:'list'})).ok);
    await world.mcp.call('browser_tabs',{action:'release',operationId});
    run.complete=true;
  } finally {
    if(!run.connection.heartbeatMs)run.connection={disconnects:world?.relay?.disconnects??null,heartbeatMs:world?.relay?.heartbeatTimings??[],recoveryMs:null};
    await writeFile(join(directory,'run.json'),JSON.stringify(run,null,2)+'\n');
    await writeReports(directory,summarize(run));
    console.log('METRICS REPORT '+join(directory,'report.html'));
  }
  if(process.env.AB_METRICS_REQUIRE_QUALITY==='1')expect(run.oracles.filter((o:any)=>!o.passed).map((o:any)=>o.scenario)).toEqual([]);
});
