import { OpenCodeApiError, OpenCodeV1Client } from '../agents/opencode-v1/client';
import { completedRequest, requestInstructions, type RequestLease, type RequestTarget } from '../sidepanel/request-target';
type Call=(method:string,params:Record<string,unknown>)=>Promise<any>;
const KEY='panelBrowserRequest';
export function panelRequests(call:Call) {
  let tail:Promise<unknown>=Promise.resolve();
  const serial=<T>(work:()=>Promise<T>)=>{const next=tail.then(work);tail=next.catch(()=>{});return next;};
  const client=async (lease:RequestLease)=>{
    const runtime=await call('runtime.status',{profileId:lease.profileId,includeConnection:true}).catch(error=>{
      if(error?.code==='INVALID_PARAMS'&&error?.message==='Unknown runtime profile')return null;
      throw error;
    });
    if(runtime===null||runtime?.state==='stopped'||runtime?.state==='error')return null;
    if(runtime?.state!=='ready')throw Error('실행 환경의 상태를 아직 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
    return new OpenCodeV1Client({...runtime,directory:lease.directory});
  };
  async function end(lease:RequestLease,clientId:string,abort=false) {
    try { await call('request.end',{requestId:lease.requestId,clientId,...(abort?{abort:true}:{})}); }
    catch(error) { if((error as any)?.code!=='OPERATION_INVALID')throw error; }
    await chrome.storage.local.remove(KEY);
  }
  async function complete(saved:RequestLease,clientId:string) {
    const api=await client(saved);
    // An unavailable profile must not hold all other profiles hostage. Closing
    // the Bridge gate is still mandatory before forgetting its durable lease.
    if(!api){await end(saved,clientId,true);return true;}
    const [messages,statuses]=await Promise.all([api.get<any[]>(`/session/${encodeURIComponent(saved.sessionId)}/message`).catch(error=>{
      if(error instanceof OpenCodeApiError&&error.status===404)return null;
      throw error;
    }),api.get<Record<string,any>>('/session/status')]);
    if(['busy','retry'].includes(statuses[saved.sessionId]?.type)||(messages!==null&&!completedRequest(saved,messages)))return false;
    await end(saved,clientId);return true;
  }
  let polling=false;
  return {
    discard:(requestId:string)=>serial(async()=>{
      const saved=(await chrome.storage.local.get(KEY))[KEY] as RequestLease|undefined;
      if(!saved||saved.requestId!==requestId)return;
      const {clientId}=await chrome.storage.local.get('clientId');
      if(typeof clientId!=='string')throw Error('Browser client unavailable');
      await end(saved,clientId);
    }),
    prepare:(lease:RequestLease,target:RequestTarget|null,previousOperationId?:string)=>serial(async()=>{
      const {clientId}=await chrome.storage.local.get('clientId');
      if(typeof clientId!=='string')throw Error('브라우저 연결을 먼저 확인하세요.');
      const saved=(await chrome.storage.local.get(KEY))[KEY] as RequestLease|undefined;
      if(saved){
        if(!await complete(saved,clientId))throw Error('이전 요청이 아직 실행 중이거나 완료를 확인하지 못했습니다. 완료를 기다리거나 해당 세션에서 응답을 중단하세요.');
      } else if(previousOperationId) {
        const api=await client(lease);
        if(!api)throw Error('이전 작업의 실행 상태를 확인하지 못했습니다. 해당 작업을 중단한 뒤 다시 시도하세요.');
        const statuses=await api.get<Record<string,any>>('/session/status');
        if(Object.values(statuses).some(s=>['busy','retry'].includes(s?.type)))throw Error('실행 중인 요청이 있어 이전 작업 탭을 해제하지 않았습니다.');
        await call('operation.abort',{operationId:previousOperationId});
      }
      await chrome.storage.local.set({[KEY]:lease});
      try { await call('request.begin',{requestId:lease.requestId,clientId,tabId:target?.tabId??null}); }
      catch(error){
        // A lost acknowledgement may have reserved the request. Keep its identity
        // so Stop can release it instead of silently forgetting the owner.
        if(['BROWSER_BUSY','OPERATION_INVALID','INVALID_PARAMS'].includes((error as any)?.code))await chrome.storage.local.remove(KEY);
        throw error;
      }
      return {requestId:lease.requestId,system:requestInstructions(lease.requestId,target)};
    }),
    finish:(scope:Pick<RequestLease,'profileId'|'directory'|'sessionId'>)=>serial(async()=>{
      const saved=(await chrome.storage.local.get(KEY))[KEY] as RequestLease|undefined;
      if(!saved||saved.profileId!==scope.profileId||saved.directory!==scope.directory||saved.sessionId!==scope.sessionId)return false;
      const {clientId}=await chrome.storage.local.get('clientId');
      return typeof clientId==='string' ? complete(saved,clientId) : false;
    }),
    reconcile:async()=>{
      if(polling)return false;
      polling=true;
      try { return await serial(async()=>{
        const data=await chrome.storage.local.get([KEY,'clientId']);
        const saved=data[KEY] as RequestLease|undefined;
        return saved&&typeof data.clientId==='string' ? complete(saved,data.clientId) : false;
      }); } finally { polling=false; }
    },
    removeProfile:(profileId:string)=>serial(async()=>{
      const data=await chrome.storage.local.get([KEY,'clientId']);
      const saved=data[KEY] as RequestLease|undefined;
      if(saved?.profileId===profileId&&typeof data.clientId==='string')await end(saved,data.clientId,true);
    }),
    cancel:(scope:Pick<RequestLease,'profileId'|'directory'|'sessionId'> & {requestId?:string})=>serial(async()=>{
      const saved=(await chrome.storage.local.get(KEY))[KEY] as RequestLease|undefined;
      if(!saved)return false;
      if(saved.profileId!==scope.profileId||saved.directory!==scope.directory||saved.sessionId!==scope.sessionId)return;
      if(scope.requestId&&scope.requestId!==saved.requestId)return;
      const {clientId}=await chrome.storage.local.get('clientId');
      if(typeof clientId!=="string")throw Error("Browser client unavailable");
      await end(saved,clientId,true);
      // User Stop already closed the gate and cleared the lease. The panel also
      // attempts /abort using its captured connection if discovery is unavailable.
      const api=await client(saved).catch(()=>null);
      if(!api)return {handled:true,abortSent:false};
      try { await api.post(`/session/${encodeURIComponent(saved.sessionId)}/abort`); }
      catch(error) { if(!(error instanceof OpenCodeApiError && error.status===404))throw error; }
      return {handled:true,abortSent:true};
    }),
  };
}
