import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TOOL_NAMES } from './runner-lib.mjs';

const exec = promisify(execFile);

test('runner records separate outcomes and raw synthetic evidence through real child-process pipes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-browser-runner-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let events = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/__reset') events = [];
    if (req.url === '/api/search') {
      let body = ''; for await (const chunk of req) body += chunk;
      events.push({ type: 'search', body: JSON.parse(body) });
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ events, submitCounts: {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const fixtureUrl = 'http://127.0.0.1:' + server.address().port;
  const opencode = join(root, 'fake-opencode.mjs');
  await writeFile(opencode, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const argv=process.argv.slice(2), cfg=JSON.parse(readFileSync(process.env.OPENCODE_CONFIG,'utf8'));
if(argv.includes('--version'))console.log('1.18.29');
else if(argv[0]==='debug')console.log(JSON.stringify(cfg));
else if(argv[0]==='models')console.log(cfg.model+'\\n'+JSON.stringify({id:'synthetic-free',providerID:'opencode',cost:{input:0,output:0,cache:{read:0,write:0}},capabilities:{toolcall:true}}));
else if(argv[0]==='run'){
 await fetch(${JSON.stringify(fixtureUrl + '/api/search')},{method:'POST',body:JSON.stringify({q:'합성 검색어 1',category:'도서'})});
 const tool=(id,name,input,data)=>console.log(JSON.stringify({type:'tool_use',sessionID:'synthetic-session',part:{id,callID:id,tool:'browser_'+name,state:{status:'completed',input,output:JSON.stringify({ok:true,tool:name,delivered:true,executed:'no',operationId:'op-synthetic',data})}}}));
 tool('a','browser_tabs',{action:'attach'},{tab:{tabId:1}});
 tool('b','browser_tabs',{action:'new'},{tab:{tabId:2,url:${JSON.stringify(fixtureUrl + '/detail.html?id=1')}}});
 tool('c','browser_extract',{kind:'table'},{rows:[['이름','에이전트 브라우저'],['가격','12,000원'],['비고','a | b, c']]});
 tool('d','browser_tabs',{action:'switch',tabId:1},{tab:{tabId:1}});
 tool('e','browser_tabs',{action:'release'},{released:true});
 console.log(JSON.stringify({type:'text',part:{text:'에이전트 브라우저 / 12,000원 / a | b, c'}}));
 console.log(JSON.stringify({type:'step_finish',part:{cost:0}}));
}
`, { mode: 0o755 });
  const exe = join(root, 'browser-bridge.exe');
  await writeFile(exe, `#!/usr/bin/env node
const { createInterface } = require('node:readline');
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(!q.id)return;
 let result;
 if(q.method==='initialize')result={serverInfo:{name:'agent-browser'}};
 else if(q.method==='tools/list')result={tools:${JSON.stringify(TOOL_NAMES.map(name => ({ name })))}};
 else result={content:[{type:'text',text:JSON.stringify({ok:true,tool:'browser_tabs',delivered:true,data:{tabs:[{tabId:1,url:${JSON.stringify(fixtureUrl + '/search.html')}}]}})}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
});
`, { mode: 0o755 });
  const { stdout } = await exec(process.execPath, ['tests/agent/run-agent.mjs', 'opencode/synthetic-free', '1', '--opencode', opencode, '--exe', exe, '--bridge-home', 'C:\\Synthetic Agent Test\\home', '--bridge-port', '4317', '--fixture-url', fixtureUrl, '--price-source', 'refresh'], { timeout: 20000 });
  const resultDir = stdout.match(/^Evidence directory: (.+)$/m)?.[1];
  assert.ok(resultDir);
  t.after(() => rm(resultDir, { recursive: true, force: true }));
  const summary = JSON.parse(await readFile(join(resultDir, 'summary.json'), 'utf8'));
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.runs[0].scores.communication.success, true);
  assert.deepEqual(summary.runs[0].scores.tools, { success: true, passed: 5, total: 5 });
  assert.equal(summary.runs[0].scores.model.success, true);
  assert.deepEqual(summary.runs[0].sessionIds, ['synthetic-session']);
  assert.ok((await readFile(join(resultDir, 'run-1.jsonl'), 'utf8')).includes('synthetic-session'));
  assert.equal(JSON.parse(await readFile(join(resultDir, 'run-1-fixture.json'), 'utf8')).events.length, 1);
});
