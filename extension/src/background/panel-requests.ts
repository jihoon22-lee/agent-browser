import { OpenCodeApiError, OpenCodeV1Client } from '../agents/opencode-v1/client';
import { completedRequest, requestInstructions, type RequestLease, type RequestTarget } from '../sidepanel/request-target';
type Call=(method:string,params:Record<string,unknown>)=>Promise<any>;
const KEY='panelBrowserRequest';
export function panelRequests(call:Call) {
  let tail:Promise<unknown>=Promise.resolve();
  const serial=<T>(work:()=>Promise<T>)=>{const next=tail.then(work);tail=next.catch(()=>{});return next;};
  const probes=new Map<string,Promise<any>>();
  const management=new Map<string,{generation:number;active:number}>();
  const state=(id:string)=>{let value=management.get(id);if(!value){value={generation:0,active:0};management.set(id,value);}return value;};
  const check=(id:string,generation:number)=>{const current=state(id);if(current.active||current.generation!==generation)throw Error('실행 환경 설정이 변경 중이거나 변경됐습니다. 상태를 확인한 뒤 다시 요청하세요.');};
  const runtimeStatus=(profileId:string,shared:boolean)=>{
    const generation=state(profileId).generation;check(profileId,generation);
    const pending=shared?probes.get(profileId):undefined;
    if(pending)return pending;
    const lookup=call('runtime.status',{profileId,includeConnection:true}).catch(error=>{
      if(error?.code==='INVALID_PARAMS'&&error?.message==='Unknown runtime profile')return null;
      throw error;
    }).then(value=>{check(profileId,generation);return value;});
    if(!shared)return lookup;
    const tracked=lookup.finally(()=>{if(probes.get(profileId)===tracked)probes.delete(profileId);});
    probes.set(profileId,tracked);return tracked;
  };
  type Discovery={kind:'gone'}|{kind:'error'}|{kind:'ready';api:OpenCodeV1Client};
  const discover=async(lease:RequestLease,shared=true):Promise<Discovery>=>{
    // Concurrent completion/prepare reads must not contend for the Bridge's
    // runtime lock and mistake the other read for a starting runtime.
    const runtime=await runtimeStatus(lease.profileId,shared);
    if(runtime===null||runtime?.state==='stopped')return {kind:'gone'};
    if(runtime?.state==='error')return {kind:'error'};
    if(runtime?.state!=='ready')throw Error('실행 환경의 상태를 아직 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
    return {kind:'ready',api:new OpenCodeV1Client({...runtime,directory:lease.directory})};
  };
  const client=async(lease:RequestLease,shared=true)=>{const found=await discover(lease,shared);return found.kind==='ready'?found.api:null;};
  async function end(lease:RequestLease,clientId:string,abort=false) {
    try { await call('request.end',{requestId:lease.requestId,clientId,...(abort?{abort:true}:{})}); }
    catch(error) { if((error as any)?.code!=='OPERATION_INVALID')throw error; }
    await chrome.storage.local.remove(KEY);
  }
  async function completion(saved:RequestLease,unattended=false):Promise<{abort:boolean}|null> {
    const found=await discover(saved);
    // A removed or stopped profile must not hold all other profiles hostage. Closing
    // the Bridge gate is still mandatory before forgetting its durable lease.
    if(found.kind==='gone')return {abort:true};
    // A live runtime can fail one readiness probe while its session is still working.
    // Only a user-initiated new request may clear it; background polling retains it.
    if(found.kind==='error')return unattended?null:{abort:true};
    const api=found.api;
    const [messages,statuses]=await Promise.all([api.get<any[]>(`/session/${encodeURIComponent(saved.sessionId)}/message`).catch(error=>{
      if(error instanceof OpenCodeApiError&&error.status===404)return null;
      throw error;
    }),api.get<Record<string,any>>('/session/status')]);
    if(['busy','retry'].includes(statuses[saved.sessionId]?.type)||(messages!==null&&!completedRequest(saved,messages)))return null;
    return {abort:false};
  }
  async function complete(saved:RequestLease,clientId:string) {
    const result=await completion(saved);
    if(!result)return false;
    await end(saved,clientId,result.abort);return true;
  }
  async function observeCompletion(scope?:Pick<RequestLease,'profileId'|'directory'|'sessionId'>) {
    const data=await chrome.storage.local.get([KEY,'clientId']);
    const saved=data[KEY] as RequestLease|undefined;
    if(!saved||typeof data.clientId!=='string')return false;
    const clientId=data.clientId;
    const generation=state(saved.profileId).generation;check(saved.profileId,generation);
    if(scope&&(saved.profileId!==scope.profileId||saved.directory!==scope.directory||saved.sessionId!==scope.sessionId))return false;
    // Network probes must never hold the mutation queue needed by Stop.
    const result=await completion(saved,true);
    if(!result)return false;
    return serial(async()=>{
      check(saved.profileId,generation);
      const current=await chrome.storage.local.get([KEY,'clientId']);
      const active=current[KEY] as RequestLease|undefined;
      if(current.clientId!==clientId||!active||active.requestId!==saved.requestId||active.messageId!==saved.messageId||active.profileId!==saved.profileId||active.directory!==saved.directory||active.sessionId!==saved.sessionId)return false;
      await end(saved,clientId,result.abort);return true;
    });
  }
  let polling=false;
  return {
    manageProfile:async<T>(profileId:string,work:()=>Promise<T>)=>{
      const current=state(profileId);current.generation++;current.active++;probes.delete(profileId);
      try{return await work();}finally{current.generation++;current.active--;probes.delete(profileId);}
    },
    discard:(requestId:string)=>serial(async()=>{
      const saved=(await chrome.storage.local.get(KEY))[KEY] as RequestLease|undefined;
      if(!saved||saved.requestId!==requestId)return;
      const {clientId}=await chrome.storage.local.get('clientId');
      if(typeof clientId!=='string')throw Error('Browser client unavailable');
      await end(saved,clientId);
    }),
    prepare:(lease:RequestLease,target:RequestTarget|null,previousOperationId?:string)=>{
      const generation=state(lease.profileId).generation;
      return serial(async()=>{
      check(lease.profileId,generation);
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
      check(lease.profileId,generation);
      await chrome.storage.local.set({[KEY]:lease});
      try {
        check(lease.profileId,generation);
        await call('request.begin',{requestId:lease.requestId,clientId,tabId:target?.tabId??null});
        check(lease.profileId,generation);
      }
      catch(error){
        if(state(lease.profileId).generation!==generation||state(lease.profileId).active){await end(lease,clientId,true);throw error;}
        // A lost acknowledgement may have reserved the request. Keep its identity
        // so Stop can release it instead of silently forgetting the owner.
        if(['BROWSER_BUSY','OPERATION_INVALID','INVALID_PARAMS'].includes((error as any)?.code))await chrome.storage.local.remove(KEY);
        throw error;
      }
      return {requestId:lease.requestId,system:requestInstructions(lease.requestId,target)};
    });},
    finish:(scope:Pick<RequestLease,'profileId'|'directory'|'sessionId'>)=>observeCompletion(scope),
    reconcile:async()=>{
      if(polling)return false;
      polling=true;
      try { return await observeCompletion(); } finally { polling=false; }
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
      // Stop never waits for a shared completion probe. A busy discovery falls
      // back to the panel's already captured connection after closing the gate.
      const api=await client(saved,false).catch(()=>null);
      if(!api)return {handled:true,abortSent:false};
      try { await api.post(`/session/${encodeURIComponent(saved.sessionId)}/abort`); }
      catch(error) { if(!(error instanceof OpenCodeApiError && error.status===404))throw error; }
      return {handled:true,abortSent:true};
    }),
  };
}
