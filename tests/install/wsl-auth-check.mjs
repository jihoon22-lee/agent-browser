import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const [root,configPath,linuxRoot]=process.argv.slice(2);
assert(root.includes('\\windows-setup-ui\\')&&linuxRoot.startsWith('/tmp/agent-browser-'));
const state=JSON.parse(readFileSync(join(root,'.agent-browser-install.json'),'utf8'));
assert.notEqual(state.Port,4317);
function stripComments(text){let out='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){out+=c;if(c==='\\')out+=text[++i];else if(c==='"')quoted=false;}else if(c==='"'){quoted=true;out+=c;}else if(c==='/'&&text[i+1]==='/'){while(i<text.length&&text[i]!=='\n')i++;out+='\n';}else if(c==='/'&&text[i+1]==='*'){i+=2;while(i<text.length&&!(text[i]==='*'&&text[i+1]==='/'))i++;i++;}else out+=c;}return out;}
const wsl='C:\\Windows\\System32\\wsl.exe',settings=JSON.parse(stripComments(readFileSync(configPath,'utf8')));
const entry=settings.mcp.browser;
execFileSync(wsl,['-d','Ubuntu','--exec','mkdir','-p',...['home','config','data','cache','state','work'].map(p=>linuxRoot+'/'+p)],{windowsHide:true});
const env={HOME:linuxRoot+'/home',XDG_CONFIG_HOME:linuxRoot+'/config',XDG_DATA_HOME:linuxRoot+'/data',XDG_CACHE_HOME:linuxRoot+'/cache',XDG_STATE_HOME:linuxRoot+'/state',OPENCODE_CONFIG:linuxRoot+'/opencode.jsonc',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_CONFIG_CONTENT:'{"plugin":[],"enabled_providers":[]}'};
const output=execFileSync(wsl,['-d','Ubuntu','--cd',linuxRoot+'/work','--exec','/usr/bin/env',...Object.entries(env).map(([k,v])=>k+'='+v),'/home/jihoon/.opencode/bin/opencode','mcp','list'],{windowsHide:true,encoding:'utf8',timeout:35000,stdio:['ignore','pipe','pipe']});
assert.match(output,/browser[\s\S]*connected/i);
const child=spawn(wsl,['-d','Ubuntu','--exec','/usr/bin/env',...Object.entries(entry.environment).map(([k,v])=>k+'='+v),...entry.command],{windowsHide:true,stdio:['pipe','pipe','pipe']});
let buffer='',id=0;const pending=new Map();child.stderr.resume();
child.stdout.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const result=JSON.parse(line),item=pending.get(result.id);if(item){clearTimeout(item.timer);pending.delete(result.id);item.resolve(result);}}catch{}}});
function call(method,params={}){return new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(n,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});}
try{
 const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'isolated-gui-engine-auth-check',version:'1'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const response=await call('tools/call',{name:'browser_snapshot',arguments:{operationId:'installer-isolated-no-such-operation-'+randomUUID()}});
 const outcome=JSON.parse(response.result.content[0].text);
 assert.equal(outcome.error.code,'OPERATION_INVALID');assert.equal(outcome.delivered,false);assert.equal(outcome.executed,'no');assert.equal(outcome.data,null);
 const result={openCodeVersion:'1.18.29',actualOpenCodeCliBrowserConnected:true,bridgeVersion:init.result.serverInfo.version,authenticatedResidentReply:outcome.error.code,delivered:false,executed:'no',pageDataRead:false};
 writeFileSync(join(root,'data','isolated-auth-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{child.stdin.end();await new Promise(r=>setTimeout(r,250));if(child.exitCode===null)child.kill();for(const item of pending.values())clearTimeout(item.timer);}

