// Actual Windows Chrome side panel -> installed OpenCode v1 -> MCP -> Bridge -> page.
// Default: deterministic localhost provider; --model opencode/<free-model>: verified Zen free tier.
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { startPanelProvider } from '../fixtures/panel-provider.mjs';
import { createServer as tcpServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildConfig, isolatedEnvironment, verifyFreeModel, parseModelCatalog, verifyOfficialPricing } from '../agent/runner-lib.mjs';
const { chromium } = createRequire(import.meta.url)('@playwright/test');
const exec = promisify(execFile), wait = ms => new Promise(r => setTimeout(r, ms));
const { values } = parseArgs({ options: { model: { type: 'string' }, wsl: { type: 'boolean' } } });
assert.equal(process.platform, 'win32', 'Run with native Windows Node');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temp = await mkdtemp(join(tmpdir(), 'AgentBrowser-panel-'));
const workspace = join(temp, 'workspace'), home = join(temp, 'bridge');
await mkdir(workspace); await mkdir(home);
const exe = process.env.AB_BRIDGE_EXE ?? join(root, 'target/x86_64-pc-windows-msvc/release/browser-bridge.exe');
const opencode = process.env.AB_OPENCODE_EXE ?? join(process.env.LOCALAPPDATA, 'AgentBrowser-dev/opencode/1.18.29/opencode.exe');
const report = { actualSidePanel: true, headed: true, runtime: values.wsl ? 'wsl-managed' : 'windows-managed', model: values.model ?? 'synthetic', realLLM: !!values.model, checks: [], turns: [] };
const owned = []; let context, browserCDP, panel, api, sessionId, admin, capturePanel;
const linuxPath = path => '/mnt/' + path[0].toLowerCase() + path.slice(2).replaceAll('\\','/');
const start = (executable, args, env) => {
  const p = spawn(executable, args, { env, cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.resume(); p.stderr.resume(); owned.push(p); return p;
};
async function port() { const s = tcpServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function until(fn, label, ms = 20000) { const end = Date.now() + ms; do { if (await fn()) return; await wait(100); } while (Date.now() < end); throw Error('Timed out: ' + label); }
let provider, providerUrl;
const site = createServer((req,res) => {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<title>Panel fixture ${req.url === '/a' ? 'A' : 'B'}</title><h1>Panel fixture ${req.url === '/a' ? 'A' : 'B'}</h1><p>Only synthetic test content.</p>`);});
try {
if(values.wsl) {
  const providerPort=await port();providerUrl=`http://127.0.0.1:${providerPort}`;
  start(join(process.env.SystemRoot,'System32/wsl.exe'),['--distribution','Ubuntu','--exec','/usr/bin/node',linuxPath(join(root,'tests/fixtures/panel-provider.mjs')),String(providerPort)],process.env);
  await until(async()=>{try{return (await fetch(providerUrl+'/test/report')).ok;}catch{return false;}},'WSL synthetic provider ready');
} else {provider=(await startPanelProvider()).server;providerUrl=`http://127.0.0.1:${provider.address().port}`;}
await new Promise(r => site.listen(0,'127.0.0.1',r));
  const bridgePort = await port(), apiPort = await port(), configPath = join(temp,'opencode.json');
  const model = values.model ?? 'fixture/fixture';
  const config = buildConfig({model:values.model ?? 'opencode/big-pickle',exe,bridgeHome:home,bridgePort});
  if (!values.model) {
    config.model = config.small_model = model; config.enabled_providers = ['fixture'];
    config.provider = {fixture:{npm:'@ai-sdk/openai-compatible',name:'Local synthetic provider',whitelist:['fixture'],options:{baseURL:providerUrl+'/v1',apiKey:'synthetic'},models:{fixture:{name:'Synthetic',limit:{context:32768,output:4096},cost:{input:0,output:0}}}}};
    for (const agent of Object.values(config.agent)) agent.model = model;
  }
  await writeFile(configPath,JSON.stringify(config));
  let password = randomBytes(24).toString('hex'), baseUrl = `http://127.0.0.1:${apiPort}`, directory=workspace;
  const env = {...isolatedEnvironment(process.env,temp,configPath),OPENCODE_SERVER_PASSWORD:password,OPENCODE_SERVER_USERNAME:'opencode',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true'};
  for (const key of ['OPENCODE_CONFIG_DIR','OPENCODE_TEST_HOME','OPENCODE_TEST_MANAGED_CONFIG_DIR']) await mkdir(env[key],{recursive:true});
  assert.equal((await exec(opencode,['--version'],{env,cwd:workspace,windowsHide:true})).stdout.trim(),'1.18.29');
  if (values.model) {
    const catalog = await exec(opencode,['models','opencode','--verbose','--refresh','--pure'],{env,cwd:workspace,windowsHide:true,maxBuffer:8*1024*1024});
    assert(!/error|failed|unable/i.test(catalog.stderr),'Model refresh reported a failure');
    const metadata=verifyFreeModel(values.model,parseModelCatalog(catalog.stdout));
    const [prices,available] = await Promise.all(['https://opencode.ai/docs/en/zen/','https://opencode.ai/zen/v1/models'].map(url=>fetch(url,{signal:AbortSignal.timeout(20000)})));
    assert(available.ok,'Official model availability lookup failed');
    const live=await available.json();
    assert(live.data.some(m=>m.id===values.model.split('/')[1]));
    if(prices.ok) report.freeModel=verifyOfficialPricing(values.model,await prices.text(),live);
    else {assert.equal(prices.status,404);report.freeModel={modelId:metadata.id,cost:metadata.cost,source:'successful-installed-catalogue-refresh-and-live-official-model-list',pricingPageStatus:404};}
  }
  start(exe,['serve','--port',String(bridgePort)],{...env,AGENT_BROWSER_HOME:home,AGENT_BROWSER_PORT:String(bridgePort)});
  context = await chromium.launchPersistentContext(join(temp,'chrome'),{executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:false,ignoreDefaultArgs:['--disable-extensions']});
  browserCDP = await context.browser().newBrowserCDPSession();
  const extension = await browserCDP.send('Extensions.loadUnpacked',{path:process.env.AB_EXTENSION_DIR??join(root,'extension/dist')});
  admin = await context.newPage(); await admin.goto(`chrome-extension://${extension.id}/src/options/index.html`);
  await until(async()=>{try{return !!JSON.parse(await readFile(join(home,'config.json'),'utf8')).token;}catch{return false;}},'Bridge config');
  const {token} = JSON.parse(await readFile(join(home,'config.json'),'utf8'));
  await admin.evaluate(({token,bridgePort})=>chrome.storage.local.set({pairingToken:token,bridgeUrl:`ws://127.0.0.1:${bridgePort}/extension`}),{token,bridgePort});
  await until(async()=> (await admin.evaluate(()=>chrome.runtime.sendMessage({kind:'get-conn-status'})))?.state==='connected','extension connection');
  let profileEnv=Object.fromEntries(Object.entries(env).filter(([key])=>key.startsWith('OPENCODE_')||key.startsWith('XDG_')));
  delete profileEnv.OPENCODE_SERVER_PASSWORD;delete profileEnv.OPENCODE_SERVER_USERNAME;
  if(values.wsl) {
    directory=linuxPath(workspace);
    profileEnv=Object.fromEntries(Object.entries(profileEnv).map(([key,value])=>[key,/^[A-Za-z]:[\\/]/.test(value)?linuxPath(value):value]));
  }
  const profile={id:'actual-panel',name:'Actual OpenCode isolated test',kind:values.wsl?'wsl':'windows',directory,
    executable:values.wsl?(process.env.AB_WSL_OPENCODE??'/home/jihoon/.opencode/bin/opencode'):opencode,
    ...(values.wsl?{distribution:'Ubuntu'}:{}),env:profileEnv,port:apiPort};
  const saved = await admin.evaluate(async profile=>chrome.runtime.sendMessage({kind:'bridge',method:'profile.save',params:{profile,makeDefault:true}}),profile); assert(saved.ok,JSON.stringify(saved));
  const ensure=()=>admin.evaluate(()=>chrome.runtime.sendMessage({kind:'bridge',method:'runtime.ensure',params:{profileId:'actual-panel'}}));
  const ready=await ensure();assert(ready.ok,JSON.stringify(ready));assert.equal(ready.result.state,'ready');
  password=ready.result.password;baseUrl=ready.result.baseUrl;
  api = async (path,method='GET',body) => {
    const response = await fetch(`${baseUrl}${path}?directory=${encodeURIComponent(directory)}`,{method,headers:{authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64'),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert(response.ok,`OpenCode ${path}: ${response.status}`);return response.status===204?null:response.json();
  };
  assert.equal((await api('/global/health')).version,'1.18.29');
  assert.equal((await ensure()).result.baseUrl,baseUrl,'Repeated connection reuses the managed runtime');
  const session = await api('/session','POST',{title:'Isolated panel browser regression',agent:'browser-test',model:{providerID:model.split('/')[0],id:model.split('/')[1]}}); sessionId = session.id;
  await admin.evaluate(sessionId=>chrome.storage.local.set({lastProfileId:'actual-panel','recentSession:actual-panel':sessionId}),sessionId);
  const page = await context.newPage(); await page.goto(`http://127.0.0.1:${site.address().port}/a`); await page.bringToFront();
  const windowId = await admin.evaluate(async()=> (await chrome.windows.getLastFocused()).id);
  await admin.evaluate(windowId=>chrome.sidePanel.open({windowId}),windowId);
  let target;
  await until(async()=>{target=(await browserCDP.send('Target.getTargets')).targetInfos.find(t=>t.url===`chrome-extension://${extension.id}/src/sidepanel/index.html`);return !!target;},'actual side panel target');
  report.targetType = target.type;
  // Attach to the target opened by sidePanel.open, without opening its URL in a tab.
  const {sessionId:cdpSession} = await browserCDP.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
  let serial=0; const pending=new Map();
  browserCDP.on('Target.receivedMessageFromTarget',event=>{if(event.sessionId!==cdpSession)return;const result=JSON.parse(event.message);const p=pending.get(result.id);if(p){pending.delete(result.id);clearTimeout(p.timer);result.error?p.reject(Error(result.error.message)):p.resolve(result.result);}});
  const command=(method,params)=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP '+method));},10000);pending.set(id,{resolve,reject,timer});void browserCDP.send('Target.sendMessageToTarget',{sessionId:cdpSession,message:JSON.stringify({id,method,params})}).catch(reject);});
  capturePanel=()=>command('Page.captureScreenshot',{format:'png'});
  panel=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;};
  await until(()=>panel(`!!document.querySelector('textarea[aria-label="메시지"]') && !!document.querySelector('option[value="${model}"]')`),'panel model ready',40000);
  report.checks.push('Real headed Chrome side panel, isolated OpenCode 1.18.29 and Windows Bridge connected');
  for(const [index,suffix] of ['a','b'].entries()) {
    const targetPage = index === 0 ? page : await context.newPage();
    await targetPage.goto(`http://127.0.0.1:${site.address().port}/${suffix}`);await targetPage.bringToFront();
    const active = await admin.evaluate(async()=> (await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0]);
    const prompt='현재 페이지를 browser 도구로 읽고 제목을 알려 주세요. 반드시 현재 요청에 새로 attach한 뒤 snapshot으로 확인하세요.';
    await panel(`(()=>{const t=document.querySelector('textarea[aria-label="메시지"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(prompt)});t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(100); await panel(`document.querySelector('textarea[aria-label="메시지"]').closest('form').requestSubmit()`);
    let lease;
    await until(async()=>{lease=await admin.evaluate(async()=> (await chrome.storage.local.get('panelBrowserRequest')).panelBrowserRequest);return !!lease;},'request reservation');
    let messages,answer;
    await until(async()=>{
      messages=await api('/session/'+sessionId+'/message');
      const response=messages.filter(m=>m.info.role==='assistant'&&m.info.parentID===lease.messageId).at(-1);
      if(response?.info.error) throw Error('OpenCode response error: '+JSON.stringify(response.info.error));
      answer=response;return !!response?.info.time?.completed && !['tool-calls','unknown'].includes(response.info.finish);
    },'model completion',values.model?120000:30000);
    const calls=messages.filter(m=>m.info.parentID===lease.messageId).flatMap(m=>m.parts.filter(p=>p.type==='tool'));
    const attach=calls.findLast(p=>p.tool.endsWith('browser_tabs')&&p.state.input.action==='attach');
    const snapshot=calls.find(p=>p.tool.endsWith('browser_snapshot'));
    const turn={index,requestId:lease.requestId,tabId:active.id,attachInput:attach?.state.input,attachState:attach?.state.status,snapshotState:snapshot?.state.status,finish:answer.info.finish,toolCount:calls.length};report.turns.push(turn);
    assert.equal(attach?.state.input.requestId,lease.requestId,'Attach must carry the current panel requestId');
    if(!values.model){assert.equal(calls[0]?.state.input.requestId,undefined);assert.equal(calls[0]?.state.status,'error');turn.recoveredMissingId=true;}
    assert.equal(attach?.state.status,'completed');assert.equal(snapshot?.state.status,'completed');
    const outcome=JSON.parse(snapshot.state.output);assert.equal(outcome.ok,true);assert.equal(outcome.data.tabId,active.id);assert.equal(outcome.data.title,'Panel fixture '+suffix.toUpperCase());
    await until(async()=>!(await admin.evaluate(async()=> (await chrome.storage.local.get('panelBrowserRequest')).panelBrowserRequest)),'request released after completion');
    await until(()=>panel(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='응답 중단')?.disabled === true`),'Stop disabled after completion');
    turn.stopDisabled=true;report.checks.push(`Turn ${index+1}: current requestId -> attach -> current page snapshot -> completion -> Stop disabled`);
  }
  assert.notEqual(report.turns[0].requestId,report.turns[1].requestId);
  assert.notEqual(report.turns[0].tabId,report.turns[1].tabId);
  if(!values.model) {
    await fetch(providerUrl+'/test/error');
    await panel(`(()=>{const t=document.querySelector('textarea[aria-label="메시지"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'오류 응답 완료 상태 검사');t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(100);await panel(`document.querySelector('textarea[aria-label="메시지"]').closest('form').requestSubmit()`);
    await until(()=>panel(`document.body.innerText.includes('Synthetic provider rejection')`),'provider error displayed');
    await until(()=>panel(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='응답 중단')?.disabled === true`),'Stop disabled after provider error');
    assert.equal(await admin.evaluate(async()=> (await chrome.storage.local.get('panelBrowserRequest')).panelBrowserRequest),undefined);
    report.checks.push('Actual OpenCode provider-error completion also releases the request and disables Stop');
  }
  await panel(`document.body.dataset.testComplete='true'`);
  report.pass=true;
} catch(error) {report.error=String(error);process.exitCode=1;}
finally {
  report.providerRequests=await fetch(providerUrl+'/test/report').then(r=>r.json()).catch(()=>[]);
  if(panel)report.panelText=await panel('document.body.innerText').catch(()=>null);
  await mkdir(join(root,'tests/agent/results'),{recursive:true});
  if(capturePanel){const shot=await capturePanel().catch(()=>null);if(shot?.data)await writeFile(join(root,'tests/agent/results/actual-panel-'+(values.wsl?'wsl':'windows')+'.png'),Buffer.from(shot.data,'base64'));}
  if(api&&sessionId)await api('/session/'+sessionId,'DELETE').catch(()=>{});
  if(admin) {
    const stopped=await admin.evaluate(()=>chrome.runtime.sendMessage({kind:'bridge',method:'runtime.stop',params:{profileId:'actual-panel'}})).catch(()=>null);
    report.runtimeStopped=stopped?.ok===true;
    if(!report.runtimeStopped){report.pass=false;process.exitCode=1;}
  }
  await context?.close();
  await fetch(providerUrl+'/test/shutdown').catch(()=>{});await wait(200);
  for(const p of owned.reverse()) {if(p.exitCode===null){await exec(join(process.env.SystemRoot,'System32/taskkill.exe'),['/PID',String(p.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});await Promise.race([new Promise(r=>p.once('exit',r)),wait(5000)]);}}
  for(const server of [site]){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await mkdir(join(root,'tests/agent/results'),{recursive:true});
  await writeFile(join(root,'tests/agent/results/actual-panel-'+(values.model?'zen':'synthetic')+'.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,panelText:undefined,providerRequests:undefined,syntheticProviderRequests:report.providerRequests.length},null,2));
  await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
