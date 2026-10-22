import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, summarize, compareRuns, renderHtml, benchmarkSuiteHash, BENCHMARK_SUITE_FILES } from './metrics-report.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const environment = { platform:'linux', arch:'x64', browserVersion:'156', headless:true, inputMode:'dom', bridgeBuild:'debug', suiteHash:'workload-v1:synthetic' };
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
test('workload changes prevent a speed comparison even when the fixture is unchanged',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-browser-suite-'));
  try {
    for(const path of BENCHMARK_SUITE_FILES){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),'original');}
    for(const required of ['tests/e2e/browser-metrics.spec.ts','tests/e2e/metrics.config.ts','tests/e2e/harness.ts','tests/fixtures/site/quality.html'])assert(BENCHMARK_SUITE_FILES.includes(required));
    const beforeHash=await benchmarkSuiteHash(root);
    const before={...run([sample(100)]),environment:{...environment,suiteHash:beforeHash}};
    for(const path of BENCHMARK_SUITE_FILES){
      await writeFile(join(root,path),'changed');
      const afterHash=await benchmarkSuiteHash(root);assert.notEqual(afterHash,beforeHash,path);
      const result=compareRuns(before,{...run([sample(50)]),environment:{...environment,suiteHash:afterHash}});
      assert.equal(result.comparable,false,path);assert.equal(result.timings[0].p50ChangePercent,null,path);
      await writeFile(join(root,path),'original');
    }
    // A product change is what the benchmark measures, not a different workload.
    await mkdir(join(root,'extension'),{recursive:true});await writeFile(join(root,'extension/content.js'),'new product');
    assert.equal(await benchmarkSuiteHash(root),beforeHash);
    await rm(join(root,'tests/e2e/metrics.config.ts'));
    await assert.rejects(benchmarkSuiteHash(root),{code:'ENOENT'});
  } finally {await rm(root,{recursive:true,force:true});}
});
test('legacy fixture-only hashes cannot certify an equivalent workload',()=>{
  const old={...run([sample(100)]),environment:{...environment,suiteHash:'old-fixture-digest'}};
  const comparison=compareRuns(old,old);
  assert.equal(comparison.comparable,false);assert(comparison.mismatches.includes('unverified-workload-hash'));
  assert.equal(comparison.timings[0].p50ChangePercent,null);
});
