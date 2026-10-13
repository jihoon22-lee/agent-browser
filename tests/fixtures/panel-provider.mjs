import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
export async function startPanelProvider(port=0) {
const providerRequests = [];
let providerScenario = "recover-missing-id";
let plan, pauseAt, resume;
function decoded(value, output=[]) {
 if(typeof value === "string"){try{decoded(JSON.parse(value),output);}catch{}}
 else if(value && typeof value === "object"){output.push(value);for(const v of Object.values(value))decoded(v,output);}
 return output;
}
const server = createServer(async (req, res) => {
  if(req.url==='/test/state'){res.end(JSON.stringify({pauseAt}));return;}
  if(req.url==='/test/continue'){resume?.();resume=undefined;pauseAt=undefined;res.end('{}');return;}
  if(req.url==='/test/plan'){let body='';for await(const chunk of req)body+=chunk;plan=JSON.parse(body);providerScenario='plan';res.end('{}');return;}
  if(req.url==='/test/report'){res.end(JSON.stringify(providerRequests));return;}
  if(req.url==='/test/error'){providerScenario='error';res.end('{}');return;}
  if(req.url==='/test/shutdown'){res.end('{}');setTimeout(()=>{server.closeAllConnections();server.close();},50);return;}
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body), messages = input.messages ?? [];
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const requestId = /requestId=([\w-]+)/.exec(system)?.[1];
  const latestUser = messages.findLastIndex(m => m.role === 'user');
  const replies = messages.slice(latestUser + 1).filter(m => m.role === 'tool');
  providerRequests.push({ requestId, toolReplies: replies.length });
  if (!requestId) { res.writeHead(400); res.end(JSON.stringify({error:{message:'Panel requestId did not reach the provider'}})); return; }
  const toolName = name => input.tools.find(t => t.function.name.endsWith(name)).function.name;
  let delta, finish;
  const texts=replies.map(reply=>typeof reply.content==='string'?reply.content:JSON.stringify(reply.content));
  const attached=texts.map(text=>/"operationId"\s*:\s*"([^"]+)"/.exec(text.replaceAll('\\"','"'))).find(Boolean);
  const attach = includeId => ({ tool_calls: [{ index: 0, id: 'call_attach_' + replies.length + '_' + requestId, type: 'function', function: { name: toolName('browser_tabs'), arguments: JSON.stringify({ action: 'attach', ...(includeId?{requestId}:{}) }) } }] });
  if(providerScenario==='error') {res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic provider rejection'}}));return;}
  if(providerScenario==='plan') {
    const step=plan.steps[replies.length];
    if(step) {
      if(step.pause){pauseAt=replies.length;await new Promise(r=>{resume=r;});}
      const results=replies.map(reply=>decoded(reply.content).find(v=>v.ok!==undefined && v.tool));
      const resolve=value=>{
        if(value==='$requestId')return requestId;
        if(value==='$operationId')return results.findLast(v=>v?.operationId)?.operationId;
        if(typeof value==='string' && value.startsWith('$tab:'))return results[Number(value.slice(5))]?.data?.tab?.tabId;
        if(typeof value==='string' && value.startsWith('$opened:'))return results[Number(value.slice(8))]?.data?.openedTabs?.[0]?.tabId;
        if(typeof value==='string' && value.startsWith('$ref:')){
          const snapshot=results.findLast(v=>v?.tool==='browser_snapshot'&&v.ok);
          const matches=snapshot?.data?.frames?.flatMap(f=>f.elements).filter(e=>e.name===value.slice(5));
          if(matches?.length!==1)throw Error('Fixture accessible name was not unique: '+value);
          return matches[0].ref;
        }
        return value;
      };
      const args=Object.fromEntries(Object.entries(step.args).map(([key,value])=>[key,resolve(value)]));
      delta={tool_calls:[{index:0,id:'call_plan_'+replies.length+'_'+requestId,type:'function',function:{name:toolName(step.tool),arguments:JSON.stringify(args)}}]};finish='tool_calls';
    }else{delta={content:'합성 연속 작업 확인 완료.'};finish='stop';}
  }
  else if (replies.length === 0) {delta=attach(false);finish='tool_calls';}
  else if (!attached && texts.some(text=>text.includes('latest user request') && text.includes('requestId'))) {delta=attach(true);finish='tool_calls';}
  else if (attached && !texts.some(text=>text.includes('browser_snapshot'))) {
    delta = { tool_calls: [{ index: 0, id: 'call_snapshot_' + requestId, type: 'function', function: { name: toolName('browser_snapshot'), arguments: JSON.stringify({ operationId: attached[1] }) } }] }; finish = 'tool_calls';
  } else { delta = { content: '합성 페이지 확인 완료.' }; finish = 'stop'; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (d, f) => res.write('data: ' + JSON.stringify({ id: 'chatcmpl-panel', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{index:0,delta:d,finish_reason:f}] }) + '\n\n');
  send({role:'assistant',...delta}, null); send({}, finish); res.end('data: [DONE]\n\n');
});
await new Promise(r=>server.listen(port,'127.0.0.1',r));
return { server, providerRequests };
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 const {server}=await startPanelProvider(Number(process.argv[2]));
 console.log(JSON.stringify({port:server.address().port}));
}
