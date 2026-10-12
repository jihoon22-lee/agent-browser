import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer,connect} from 'node:net';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require('@playwright/test');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'), owned=[], report={checks:[]};
const {startIframeFixture}=await import('../fixtures/iframe.mjs');
const fixture=await startIframeFixture(),fixturePort=fixture.port;
const temp=await mkdtemp(join(tmpdir(),'agent-browser-iframe-full-'));
let context,stopRuntime;
const child=(exe,args,options={})=>{const p=spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],...options});owned.push(p);p.stderr.on('data',()=>{});return p;};
const firstLine=p=>new Promise((resolve,reject)=>{const l=createInterface({input:p.stdout});l.once('line',s=>{l.close();resolve(s)});p.once('error',reject)});
try{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const env={...process.env,AGENT_BROWSER_HOME:join(temp,'home'),AGENT_BROWSER_PORT:String(port)};
 const exe=process.env.AB_BRIDGE_EXE??join(root,'target/x86_64-pc-windows-msvc/debug/browser-bridge.exe');
 const bridge=child(exe,['serve','--port',String(port)],{env});bridge.stdout.resume();
 for(let i=0;;i++){const ready=await new Promise(r=>{const s=connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();r(true)});s.once('error',()=>r(false))});if(ready)break;if(i>100)throw Error('Bridge startup');await new Promise(r=>setTimeout(r,100));}
 const mcp=child(exe,['mcp'],{env});let transport=mcp,seq=0;const pending=new Map();
 const listen=p=>createInterface({input:p.stdout}).on('line',s=>{const v=JSON.parse(s);assert.equal(v.jsonrpc,'2.0');const p=pending.get(v.id);if(p){pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(v.error):p.resolve(v.result)}});
 listen(mcp);
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(Error('MCP timeout '+method)),20000);pending.set(id,{resolve,reject,timer});transport.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
 report.initialize=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'iframe-investigation',version:'1'}});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 report.tools=await rpc('tools/list',{});
 const call=async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});return JSON.parse(r.content.find(c=>c.type==='text').text)};
 const ok=async(name,args)=>{const r=await call(name,args);assert.equal(r.ok,true,JSON.stringify(r));return r;};
 context=await chromium.launchPersistentContext(join(temp,'profile'),{executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true,ignoreDefaultArgs:['--disable-extensions']});
 const cdp=await context.browser().newBrowserCDPSession();
 report.browser=await cdp.send('Browser.getVersion');
 report.extensionLoad=await cdp.send('Extensions.loadUnpacked',{path:process.env.AB_EXTENSION_DIR??join(root,'extension/dist')});
 const admin=await context.newPage();await admin.goto(`chrome-extension://${report.extensionLoad.id}/src/options/index.html`);
 const {token}=JSON.parse(await readFile(join(temp,'home/config.json'),'utf8'));
 await admin.evaluate(({token,port})=>chrome.storage.local.set({pairingToken:token,bridgeUrl:`ws://127.0.0.1:${port}/extension`}),{token,port});
 for(let i=0;;i++){const s=await admin.evaluate(()=>chrome.runtime.sendMessage({kind:'get-conn-status'}));if(s?.state==='connected')break;if(i>200)throw Error('Connection timeout');await admin.waitForTimeout(100);}
 const page=await context.newPage();await page.goto(`http://127.0.0.1:${fixturePort}/case`);
 if(process.env.AB_WSL_OPENCODE){
   const management=async(method,params)=>{
     const r=await admin.evaluate(({method,params})=>chrome.runtime.sendMessage({kind:'bridge',method,params}),{method,params});
     assert(r.ok,JSON.stringify(r));return r.result;
   };
   const mapped=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replaceAll('\\','/');
   const isolated=join(temp,'linux');await mkdir(isolated,{recursive:true});
   const profileEnv={HOME:mapped(isolated),OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true'};
   for(const name of ['CONFIG','DATA','STATE','CACHE']){const p=join(isolated,name.toLowerCase());await mkdir(p);profileEnv['XDG_'+name+'_HOME']=mapped(p);}
   const profile={id:'iframe-wsl',name:'Isolated WSL Chrome test',kind:'wsl',distribution:process.env.AB_WSL_DISTRO??'Ubuntu',executable:process.env.AB_WSL_OPENCODE,directory:mapped(isolated),env:profileEnv};
   await management('profile.save',{profile});
   stopRuntime=async()=>{
     await management('runtime.stop',{profileId:profile.id});
     const status=await management('runtime.status',{profileId:profile.id});
     assert.equal(status.state,'stopped');report.wslStopped=true;
   };
   const runtime=await management('runtime.ensure',{profileId:profile.id});assert.equal(runtime.state,'ready');
   const headers={Authorization:'Basic '+Buffer.from(runtime.username+':'+runtime.password).toString('base64')};
   const health=await fetch(runtime.baseUrl+'/global/health',{headers}).then(r=>r.json());assert.equal(health.healthy,true);
   const status=await fetch(runtime.baseUrl+'/mcp?'+new URLSearchParams({directory:profile.directory}),{headers}).then(r=>r.json());assert.equal(status.browser.status,'connected');
   mcp.stdin.end();
   transport=child(join(process.env.SystemRoot,'System32/wsl.exe'),['-d',profile.distribution,'--exec','/usr/bin/python3',mapped(join(root,'tests/fixtures/wsl-mcp.py')),mapped(join(temp,'home'))]);listen(transport);
   const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'wsl-real-chrome',version:'1'}});
   transport.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
   report.wslRuntime={version:health.version,healthy:true,mcpConnected:true,serverInfo:initialized.serverInfo,modelCalls:0};
 }
 const tab=await admin.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url),page.url());
 const operationId=(await ok('browser_tabs',{action:'attach',tabId:tab.id})).operationId;
 const snap=await ok('browser_snapshot',{operationId});report.snapshot=snap;report.frames=[];
 for(const f of snap.data.frames.filter(f=>f.url.endsWith('/mail'))){
  const entry={frameId:f.frameId,documentId:f.documentId,url:f.url,clicks:[]};
  for(const [name,text] of [['Inline mail','inline body'],['Keyboard mail','keyboard body'],['Open body','opened body'],['Coordinate guarded','coordinate body'],['Trusted guarded','coordinate body']]){
   const fresh=await ok('browser_snapshot',{operationId});const frame=fresh.data.frames.find(fr=>fr.frameId===f.frameId);
   const ref=frame.elements.find(e=>e.name===name)?.ref;assert(ref,`Missing candidate ${name}`);
   const result=await ok('browser_click',{operationId,ref});
   await ok('browser_wait',{operationId,frameRef:frame.frameRef,text,timeoutMs:200});
   entry.clicks.push({name,result});
  }
  assert.equal((await call('browser_wait',{operationId,text:'coordinate body',timeoutMs:100})).error.code,'TIMEOUT');
  let fresh=await ok('browser_snapshot',{operationId}),frame=fresh.data.frames.find(fr=>fr.frameId===f.frameId);
  assert.equal((await call('browser_wait',{operationId,frameRef:frame.frameRef,text:'top-only',timeoutMs:100})).error.code,'TIMEOUT');
  assert.equal((await call('browser_wait',{operationId,frameRef:frame.frameRef,urlIncludes:'/mail',timeoutMs:100})).error.code,'TIMEOUT');
  await ok('browser_wait',{operationId,frameRef:frame.frameRef,urlIncludes:new URL(page.url()).pathname,timeoutMs:100});
  await ok('browser_click',{operationId,ref:frame.elements.find(e=>e.name==='Native checkbox').ref});
  fresh=await ok('browser_snapshot',{operationId});frame=fresh.data.frames.find(fr=>fr.frameId===f.frameId);
  assert.equal(frame.elements.find(e=>e.name==='Native checkbox').checked,true);
  entry.newTab=await ok('browser_click',{operationId,ref:frame.elements.find(e=>e.name==='New tab').ref});
  assert((await ok('browser_snapshot',{operationId})).data.url.endsWith('/body'));
  await ok('browser_tabs',{action:'switch',operationId,tabId:tab.id});
  report.frames.push(entry);
 }
 // Manipulate only synthetic pages to verify document and element lifetimes.
 const local=page.frames().find(f=>f.url().startsWith(`http://127.0.0.1:${fixturePort}/mail`));
 let fresh=await ok('browser_snapshot',{operationId}),frame=fresh.data.frames.find(f=>f.url.startsWith(`http://127.0.0.1:${fixturePort}/mail`));
 const oldRef=frame.elements.find(e=>e.name==='Open body').ref,frameRef=frame.frameRef;
 report.events=await local.evaluate(()=>({events:window.events,scrollY}));
 assert(report.events.scrollY>0);assert(report.events.events.some(e=>e.type==='click'&&e.x>0&&e.y>0&&!e.trusted));
 await local.evaluate(()=>document.body.innerHTML='<button>replacement body</button>');
 await ok('browser_wait',{operationId,frameRef,text:'replacement body',timeoutMs:100});
 assert.equal((await call('browser_click',{operationId,ref:oldRef})).error.code,'STALE_ELEMENT');
 await local.goto(`http://127.0.0.1:${fixturePort}/body`);
 assert.equal((await call('browser_wait',{operationId,frameRef,text:'Opened new tab',timeoutMs:100})).error.code,'STALE_ELEMENT');
 report.checks.push('same-origin, cross-origin, nested OOPIF: candidates, coordinates, scroll, untrusted guard, native checkbox and new tab', 'frame text/URL scoping, body replacement, stale element and navigated frame');
 report.isolatedWorld=await page.evaluate(()=>({contentMarker:typeof window.__agentBrowserContent,probeModule:typeof window.probeAction}));
 report.iframeTargets=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='iframe');
 assert.equal(report.frames.length,3);assert.equal(report.isolatedWorld.contentMarker,'undefined');
 assert(report.iframeTargets.length>=1);
 report.pass=true;console.log('PASS full MCP/Bridge/Extension/isolated-content path: 3 frame scenarios; OOPIF targets:',report.iframeTargets.length);
}catch(e){report.error=String(e);throw e;}finally{
 try{await stopRuntime?.();}catch(e){report.cleanupError=String(e);report.retainedHome=temp;}
 await context?.close();
 for(const p of owned.reverse()){if(p.exitCode===null){p.stdin?.end();p.kill();await new Promise(r=>{if(p.exitCode!==null)return r();p.once('exit',r);});}}
 report.ownedProcessesStopped=owned.every(p=>p.exitCode!==null||p.signalCode!==null);
 await fixture.close();
 await mkdir(join(root,'tests/agent/results'),{recursive:true});
 await writeFile(join(root,'tests/agent/results/iframe.json'),JSON.stringify(report,null,2));
 if(!report.cleanupError)await rm(temp,{recursive:true,force:true});
 else throw Error('Owned WSL runtime cleanup needs inspection; see iframe.json');
}
