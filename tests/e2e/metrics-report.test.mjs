import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, summarize, compareRuns, renderHtml } from './metrics-report.mjs';

const environment = { platform:'linux', arch:'x64', browserVersion:'156', headless:true, inputMode:'dom', bridgeBuild:'debug', suiteHash:'fixture-v1' };
const sample = (ms, ok=true) => ({scenario:'query',tool:'browser_snapshot',durationMs:ms,outcomeBytes:100,ok,errorCode:ok?null:'TIMEOUT',executed:'no',browserMs:ms-1,snapshotMs:ms-1,longTaskMaxMs:0,longTaskCount:0});
const run = (calls=[]) => ({schemaVersion:1,environment,label:'synthetic',calls,oracles:[{scenario:'row',passed:false,wrongTarget:1,falseSuccess:1,duplicateWrites:0,postCancelWrites:0}],connection:{disconnects:0,heartbeatMs:[],recoveryMs:null},model:null,complete:true});

test('percentiles include slow and failed calls and show the denominator',()=>{
  const r=summarize(run([sample(10),sample(20),sample(1000,false)]));
  assert.deepEqual(r.timings[0].duration,{n:3,p50:20,p95:1000,min:10,max:1000});
  assert.equal(r.timings[0].failed,1);
  assert.deepEqual(r.quality,{n:1,passed:0,wrongTarget:1,falseSuccess:1,duplicateWrites:0,postCancelWrites:0});
  assert.equal(r.model,null);
  assert.equal(r.connection.heartbeat,null);
});
test('empty measurements are missing, not perfect zero scores',()=>{
  assert.equal(distribution([]),null);
  assert.throws(()=>distribution([NaN]),/finite/);
  assert.equal(summarize({...run(),oracles:[]}).quality,null);
  assert.equal(summarize(run([{...sample(10),longTaskCount:null}])).timings[0].longTaskCount,null);
  assert.equal(summarize({...run(),oracles:[{scenario:'partial',passed:false}]}).quality.wrongTarget,null);
});
test('comparison refuses unlike environments and missing scenarios',()=>{
  const before=run([sample(100)]),after=run([sample(50)]);
  assert.equal(compareRuns(before,after).timings[0].p50ChangePercent,-50);
  const other={...after,environment:{...environment,platform:'win32'}};
  assert.equal(compareRuns(before,other).comparable,false);
  assert.equal(compareRuns(before,other).timings[0].p50ChangePercent,null);
  assert.equal(compareRuns(before,run()).timings[0].after,null);
});
test('summary admits only numeric metrics and escapes HTML labels',()=>{
  const input={...run([ {...sample(10),text:'PRIVATE_PAGE',args:{text:'PRIVATE_INPUT'}} ]),label:'<script>alert(1)</script>',token:'PRIVATE_TOKEN'};
  const summary=summarize(input),html=renderHtml(summary);
  assert(!JSON.stringify(summary).includes('PRIVATE_'));
  assert(!html.includes('<script>'));
  assert(html.includes('&lt;script&gt;'));
});
