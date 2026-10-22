import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { startWorld, ROOT } from './harness';
const exec=promisify(execFile);

test('goal-only model evaluation on an isolated browser',async()=>{
  const model=process.env.AB_METRICS_MODEL,opencode=process.env.AB_OPENCODE;
  if(!model||!opencode)throw new Error('Explicit AB_METRICS_MODEL=opencode/<verified-free-id> and AB_OPENCODE are required. The runner verifies price and isolation before any LLM request.');
  const runs=Number(process.env.AB_MODEL_RUNS??3),timeoutMs=Number(process.env.AB_MODEL_TIMEOUT_MS??180000);
  if(!Number.isInteger(runs)||runs<1||runs>20||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>900000)throw new Error('Invalid model run count/timeout');
  test.setTimeout(runs*(timeoutMs+300000)+120000);
  const world=await startWorld();
  try{
    const environment={platform:world.runtime.platform,nodeVersion:world.runtime.nodeVersion,browserVersion:world.runtime.browserVersion,headless:world.runtime.headless};
    console.log('MODEL RUNTIME '+JSON.stringify(environment));
    const page=await world.open('search.html');
    let stdout='',failed=false;
    try{
      const result=await exec(process.execPath,[join(ROOT,'tests/agent/run-agent.mjs'),model,String(runs),'--opencode',opencode,'--exe',world.config.bridgeExe,'--bridge-home',world.bridge.home,'--bridge-port',String(world.bridge.port),'--fixture-url',world.fixture.base,'--tab-id',String(await world.tabId(page)),'--task-mode','goal','--timeout-ms',String(timeoutMs)],{cwd:ROOT,maxBuffer:2*1024*1024,windowsHide:true});
      stdout=result.stdout;
    }catch(error){stdout=String((error as any).stdout??'');failed=true;console.log('Model evaluation stopped: '+String((error as any).stderr??'').slice(0,1000));}
    const path=stdout.match(/^Evidence directory: (.+)$/m)?.[1];
    if(path){
      await writeFile(join(path,'environment.json'),JSON.stringify(environment,null,2)+'\n');
      console.log('MODEL METRICS '+join(path,'report.html'));
      const metrics=await readFile(join(path,'metrics.json'),'utf8').then(JSON.parse).catch(()=>null);
      if(metrics)console.log(JSON.stringify(metrics));
    }
    expect(failed,'Model evaluation failed or was blocked. See the isolated evidence; no paid fallback was used.').toBe(false);
  }finally{await world.stop();}
});
