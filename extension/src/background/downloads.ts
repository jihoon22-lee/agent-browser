import { ProtocolError } from '../protocol/errors';
import { aborted } from './tabs';
export type TrackedDownload={id:number;operationId:string;bound:boolean;at?:number};
export const downloadSummary=(d:chrome.downloads.DownloadItem)=>({id:d.id,filename:d.filename.split(/[\\/]/).at(-1)??'',state:d.state,complete:d.state==='complete',bytesReceived:d.bytesReceived,totalBytes:d.totalBytes>=0?d.totalBytes:null,error:d.error??null,paused:d.paused,danger:d.danger});
export function matchingDownload(items:TrackedDownload[],operationId:string,id:number) {
 const item=items.find(d=>d.operationId===operationId&&d.id===id);
 if(!item?.bound)throw new ProtocolError('ELEMENT_NOT_INTERACTABLE','Select this download in the browser panel first. Time or URL alone cannot prove which action created it.');
 return item;
}
const KEY='advancedDownloads',WINDOW='advancedDownloadWindow';
export function downloads(active:()=>string|undefined,enabled:()=>boolean) {
 let queue:Promise<unknown>=Promise.resolve();
 const serial=<T>(fn:()=>Promise<T>)=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
 const read=async():Promise<TrackedDownload[]>=>{const data=(await chrome.storage.session.get(KEY))[KEY];return Array.isArray(data)?data.filter(d=>Date.now()-d.at<3600000).slice(-30):[];};
 const save=(items:TrackedDownload[])=>chrome.storage.session.set({[KEY]:items.slice(-30)});
 const granted=async()=>{if(!enabled()||!await chrome.permissions.contains({permissions:['downloads']}))throw new ProtocolError('FORBIDDEN_METHOD','Enable advanced browser features and allow download access in Settings.');};
 const created=(item:chrome.downloads.DownloadItem)=>{const op=active();if(!op||!enabled())return;void serial(async()=>{await granted();const items=await read();if(!items.some(d=>d.id===item.id)){items.push({id:item.id,operationId:op,bound:false,at:Date.now()});await save(items);}}).catch(()=>{});};
 let source:typeof chrome.downloads.onCreated|undefined;
 const listen=()=>{const next=chrome.downloads?.onCreated;if(next&&next!==source){source?.removeListener(created);next.addListener(created);source=next;}};
 listen();chrome.permissions.onAdded?.addListener(listen);
 const reconcile=()=>serial(async()=>{
   await granted();const window=(await chrome.storage.session.get(WINDOW))[WINDOW] as {operationId:string;at:number}|undefined;
   const op=active();if(!window||window.operationId!==op||Date.now()-window.at>3600000)return;
   const recent=await chrome.downloads.search({startedAfter:new Date(window.at).toISOString(),orderBy:['-startTime'],limit:30});
   const items=await read();for(const item of recent)if(!items.some(d=>d.id===item.id))items.push({id:item.id,operationId:op!,bound:false,at:Date.now()});
   if(active()===op)await save(items);
 });

 return {
  observe:(operationId:string|undefined)=>serial(async()=>{const old=(await chrome.storage.session.get(WINDOW))[WINDOW] as {operationId?:string}|undefined;if(operationId&&old?.operationId!==operationId)await chrome.storage.session.set({[WINDOW]:{operationId,at:Date.now()}});}),
  async list(operationId:string) {await granted();await queue;await reconcile();const items=(await read()).filter(d=>d.operationId===operationId);const result=[];
   for(const item of items){const [d]=await chrome.downloads.search({id:item.id});if(d)result.push({...downloadSummary(d),bound:item.bound});}await granted();return {downloads:result,note:'Unbound items are candidates, not proof of this task completing. Select the matching file in the browser panel.'};},
  bind:(operationId:string,id:number)=>serial(async()=>{await granted();if(active()!==operationId)throw new ProtocolError('OPERATION_INVALID','The operation is no longer active.');const items=await read(),item=items.find(d=>d.operationId===operationId&&d.id===id);if(!item)throw new ProtocolError('INVALID_PARAMS','Unknown download candidate.');item.bound=true;await save(items);return {bound:true};}),
  async handle(p:Record<string,unknown>,signal:AbortSignal) {
   const op=String(p.operationId);if(p.action==='list'||p.action===undefined)return this.list(op);
   await granted();await queue;matchingDownload(await read(),op,Number(p.downloadId));
   const timeout=p.action==='wait'?Math.min(30000,Math.max(100,Number(p.timeoutMs??5000))):0,deadline=Date.now()+timeout;
   do {aborted(signal);await granted();if(active()!==op)throw new ProtocolError('OPERATION_INVALID','The operation ended.');
     const [item]=await chrome.downloads.search({id:Number(p.downloadId)});if(!item)throw new ProtocolError('ELEMENT_NOT_FOUND','Chrome no longer has this download.');
     const data=downloadSummary(item);if(item.paused||!['safe','accepted','allowlistedByPolicy','deepScannedSafe'].includes(item.danger))return {...data,bound:true,userDecisionRequired:true};if(p.action!=='wait'||item.state!=='in_progress')return {...data,bound:true};
     await new Promise(r=>setTimeout(r,Math.min(250,Math.max(0,deadline-Date.now()))));
   }while(Date.now()<deadline);
   aborted(signal);throw new ProtocolError('TIMEOUT','Download is still pending. It was not restarted or cancelled.','safe');
  },
 };
}
