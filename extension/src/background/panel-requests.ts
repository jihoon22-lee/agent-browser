import { OpenCodeV1Client } from '../agents/opencode-v1/client';
import { completedRequest, requestInstructions, type RequestLease, type RequestTarget } from '../sidepanel/request-target';
type Call=(method:string,params:Record<string,unknown>)=>Promise<any>;
const KEY='panelBrowserRequest';
export function panelRequests(call:Call) {
  let tail:Promise<unknown>=Promise.resolve();
  const serial=<T>(work:()=>Promise<T>)=>{const next=tail.then(work);tail=next.catch(()=>{});return next;};
  const client=async (lease:RequestLease)=>{
    const runtime=await call('runtime.ensure',{profileId:lease.profileId});
    if(runtime.state!=='ready')throw Error('이전 요청의 완료 상태를 확인하지 못했습니다. 해당 요청을 중단한 뒤 다시 시도하세요.');
    return new OpenCodeV1Client({...runtime,directory:lease.directory});
  };
  async function end(lease:RequestLease,clientId:string,clear=true) {
    try { await call('request.end',{requestId:lease.requestId,clientId}); }
    catch(error) { if((error as any)?.code!=='OPERATION_INVALID')throw error; }
    if(clear)await chrome.storage.session.remove(KEY);
  }
  return {
    discard:(requestId:string)=>serial(async()=>{
      const saved=(await chrome.storage.session.get(KEY))[KEY] as RequestLease|undefined;
      if(!saved||saved.requestId!==requestId)return;
      const {clientId}=await chrome.storage.local.get('clientId');
      if(typeof clientId!=='string')throw Error('Browser client unavailable');
      await end(saved,clientId);
    }),
    prepare:(lease:RequestLease,target:RequestTarget|null,previousOperationId?:string)=>serial(async()=>{
      const {clientId}=await chrome.storage.local.get('clientId');
      if(typeof clientId!=='string')throw Error('브라우저 연결을 먼저 확인하세요.');
      const saved=(await chrome.storage.session.get(KEY))[KEY] as RequestLease|undefined;
      if(saved){
        const api=await client(saved);
        const [messages,statuses]=await Promise.all([api.get<any[]>(`/session/${encodeURIComponent(saved.sessionId)}/message`),api.get<Record<string,any>>('/session/status')]);
        if(['busy','retry'].includes(statuses[saved.sessionId]?.type)||!completedRequest(saved,messages))throw Error('이전 요청이 아직 실행 중이거나 완료를 확인하지 못했습니다. 완료를 기다리거나 해당 세션에서 응답을 중단하세요.');
        await end(saved,clientId);
      } else if(previousOperationId) {
        const api=await client(lease),statuses=await api.get<Record<string,any>>('/session/status');
        if(Object.values(statuses).some(s=>['busy','retry'].includes(s?.type)))throw Error('실행 중인 요청이 있어 이전 작업 탭을 해제하지 않았습니다.');
        await call('operation.abort',{operationId:previousOperationId});
      }
      await chrome.storage.session.set({[KEY]:lease});
      try { await call('request.begin',{requestId:lease.requestId,clientId,tabId:target?.tabId??null}); }
      catch(error){
        // A lost acknowledgement may have reserved the request. Keep its identity
        // so Stop can release it instead of silently forgetting the owner.
        if(['BROWSER_BUSY','OPERATION_INVALID','INVALID_PARAMS'].includes((error as any)?.code))await chrome.storage.session.remove(KEY);
        throw error;
      }
      return {requestId:lease.requestId,system:requestInstructions(lease.requestId,target)};
    }),
    finish:(scope:Pick<RequestLease,'profileId'|'directory'|'sessionId'>)=>serial(async()=>{
      const saved=(await chrome.storage.session.get(KEY))[KEY] as RequestLease|undefined;
      if(!saved||saved.profileId!==scope.profileId||saved.directory!==scope.directory||saved.sessionId!==scope.sessionId)return false;
      const api=await client(saved);
      const [messages,statuses]=await Promise.all([api.get<any[]>(`/session/${encodeURIComponent(saved.sessionId)}/message`),api.get<Record<string,any>>('/session/status')]);
      if(['busy','retry'].includes(statuses[saved.sessionId]?.type)||!completedRequest(saved,messages))return false;
      const {clientId}=await chrome.storage.local.get('clientId');
      if(typeof clientId!=='string')return false;
      await end(saved,clientId);return true;
    }),
    cancel:(scope:Pick<RequestLease,'profileId'|'directory'|'sessionId'> & {requestId?:string})=>serial(async()=>{
      const saved=(await chrome.storage.session.get(KEY))[KEY] as RequestLease|undefined;
      if(!saved||saved.profileId!==scope.profileId||saved.directory!==scope.directory||saved.sessionId!==scope.sessionId)return;
      if(scope.requestId&&scope.requestId!==saved.requestId)return;
      const {clientId}=await chrome.storage.local.get('clientId');
      if(typeof clientId!=="string")throw Error("Browser client unavailable");
      await end(saved,clientId,false);
      const api=await client(saved);
      await api.post(`/session/${encodeURIComponent(saved.sessionId)}/abort`);
      await chrome.storage.session.remove(KEY);
      return true;
    }),
  };
}
