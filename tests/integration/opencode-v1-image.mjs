// Real OpenCode v1 + synthetic local provider/MCP image. No external model requests or user settings.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createServer as socketServer} from 'node:net';
import {once} from 'node:events';
import {parseArgs} from 'node:util';
import assert from 'node:assert/strict';
import {visionEvidence} from '../../extension/src/background/vision-evidence.ts';
import {isolatedEnvironment} from '../agent/runner-lib.mjs';
const {values}=parseArgs({options:{opencode:{type:'string'}}});
const exe=values.opencode??join(homedir(),'.opencode/bin/opencode');
const root=await mkdtemp(join(tmpdir(),'ab-image-contract-')),workspace=join(root,'workspace');await mkdir(workspace);
const {deflateSync}=await import('node:zlib');
const crc=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
const chunk=(name,data)=>{const type=Buffer.from(name),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([length,type,data,checksum]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(64,0);ihdr.writeUInt32BE(64,4);ihdr[8]=8;ihdr[9]=6;
const rows=Buffer.alloc(64*(1+64*4));for(let y=0;y<64;y++)for(let x=0;x<64;x++){const i=y*257+1+x*4;rows[i]=20;rows[i+1]=120;rows[i+2]=180;rows[i+3]=255;}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
const callArgs={captureId:'fixture-capture',x:12,y:24};
const mcp=join(root,'mcp.mjs');
await writeFile(mcp,`import {createInterface} from 'node:readline';import {readFile,writeFile} from 'node:fs/promises';const lines=createInterface({input:process.stdin});lines.on('line',async line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'image-fixture',version:'1'}};if(r.method==='tools/list')result={tools:[{name:'browser_pointer',description:'Return a synthetic image and inspect its running tool row',inputSchema:{type:'object',properties:{captureId:{type:'string'},x:{type:'number'},y:{type:'number'}}}}]};if(r.method==='tools/call'){const gate=JSON.parse(await readFile(${JSON.stringify(join(root,'gate.json'))},'utf8'));const get=async path=>(await fetch(gate.base+path+'?directory='+encodeURIComponent(gate.directory))).json();const [messages,statuses]=await Promise.all([get('/session/'+gate.sessionId+'/message'),get('/session/status')]);await writeFile(${JSON.stringify(join(root,'probe.json'))},JSON.stringify({messages,statuses}));result={content:[{type:'image',mimeType:'image/png',data:${JSON.stringify(png)}},{type:'text',text:'Synthetic screenshot fixture'}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`);

let requests=0,imageSeen=false,child,session,base,serverError;
const provider=createServer(async(req,res)=>{try{
 let body='';for await(const c of req)body+=c;const data=JSON.parse(body);requests++;
 assert.equal(req.url,'/v1/chat/completions');assert.equal(data.model,'fixture');assert.ok(requests<=2);
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'synthetic-image',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
 if(requests===1){const tool=data.tools.find(t=>t.function.name.includes('browser_pointer'));assert.ok(tool);send({role:'assistant',tool_calls:[{index:0,id:'image-call',type:'function',function:{name:tool.function.name,arguments:JSON.stringify(callArgs)}}]});send({},'tool_calls');}
 else {imageSeen=data.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'&&/^data:image\//.test(p.image_url?.url??'')));send({role:'assistant',content:'image contract complete'});send({},'stop');}
 res.end('data: [DONE]\n\n');
 }catch(e){serverError=e;res.end();}});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const sock=socketServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
const configPath=join(root,'opencode.json'),model='fixture/fixture';
const config={enabled_providers:['fixture'],provider:{fixture:{npm:'@ai-sdk/openai-compatible',name:'Local fixture',whitelist:['fixture'],options:{baseURL:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'synthetic'},models:{fixture:{name:'Image fixture',attachment:true,tool_call:true,modalities:{input:['text','image'],output:['text']},limit:{context:4096,output:512},cost:{input:0,output:0}}}}},model,small_model:model,default_agent:'image-fixture',subagent_depth:0,plugin:[],instructions:[],mcp:{browser:{type:'local',command:[process.execPath,mcp],enabled:true}},tools:{'*':false,'browser_*':true},permission:{'*':'deny','browser_*':'allow'},snapshot:false,formatter:false,lsp:false,compaction:{auto:false,prune:false},autoupdate:false,share:'disabled',agent:{'image-fixture':{model,mode:'primary',prompt:'Use the fixture tool once then finish.',permission:{'*':'deny','browser_*':'allow'}},...Object.fromEntries(['build','plan','title','summary','compaction'].map(name=>[name,{model}])),general:{model,disable:true},explore:{model,disable:true}}};
await writeFile(configPath,JSON.stringify(config));
const env={...isolatedEnvironment(process.env,root,configPath),OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true'};
for(const k of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[k];env.NO_PROXY='127.0.0.1,localhost,::1';
for(const k of ['OPENCODE_CONFIG_DIR','OPENCODE_TEST_HOME','OPENCODE_TEST_MANAGED_CONFIG_DIR'])await mkdir(env[k],{recursive:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const version=execFileSync(exe,['--version'],{env,cwd:workspace,encoding:'utf8'}).trim();assert.ok(['1.18.29','1.19.3'].includes(version));
 child=spawn(exe,['serve','--pure','--hostname','127.0.0.1','--port',String(port)],{env,cwd:workspace,stdio:'ignore'});base=`http://127.0.0.1:${port}`;
 const api=async(path,body,method=body?'POST':'GET')=>{console.log('CHECK '+method+' '+path);const r=await fetch(base+path+'?directory='+encodeURIComponent(workspace),{signal:AbortSignal.timeout(15000),method,headers:{'Content-Type':'application/json','x-opencode-directory':workspace},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`${method} ${path}: ${r.status}`);return r.status===204?null:r.json();};
 for(let i=0;i<150;i++){try{await api('/global/health');break;}catch{await wait(100);}}
 const catalog=await api('/provider'),fixture=catalog.all.find(p=>p.id==='fixture').models.fixture;assert.equal(fixture.capabilities.input.image,true);assert.equal(fixture.capabilities.toolcall,true);
 session=await api('/session',{title:'Synthetic image contract'});
 const messageId='msg_imagecontract'+Date.now();await writeFile(join(root,'gate.json'),JSON.stringify({base,directory:workspace,sessionId:session.id}));
 await api('/session/'+session.id+'/prompt_async',{messageID:messageId,agent:'image-fixture',model:{providerID:'fixture',modelID:'fixture'},parts:[{type:'text',text:'Return the synthetic capture.'}]});
 for(let i=0;i<200&&!imageSeen&&!serverError;i++)await wait(100);
 if(serverError)throw serverError;assert.equal(requests,2);assert.equal(imageSeen,true,'MCP image must arrive as an image part at the provider');
 const probe=JSON.parse(await readFile(join(root,'probe.json'),'utf8'));assert.equal(visionEvidence({sessionId:session.id,messageId},callArgs,probe.messages,catalog,probe.statuses),true,'Exact running root tool evidence must be observable during MCP execution');
 console.log(JSON.stringify({runningToolEvidence:true,success:true,platform:process.platform,version,capability:true,mcpImageDelivered:true,syntheticProviderRequests:requests,realLLMCalls:0}));
}finally{
 if(base&&session)await fetch(base+'/session/'+session.id,{method:'DELETE',signal:AbortSignal.timeout(3000),headers:{'x-opencode-directory':workspace}}).catch(()=>{});
 if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill();await Promise.race([exit,wait(3000)]);if(child.exitCode===null){child.kill('SIGKILL');await Promise.race([exit,wait(1000)]);}}
 provider.closeAllConnections();await new Promise(r=>provider.close(r));await rm(root,{recursive:true,force:true});
}
