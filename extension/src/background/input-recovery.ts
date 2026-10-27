import { ProtocolError } from '../protocol/errors';
import type { FrameInfo } from './chrome-api';
export type InputDocument = {tabId:number;documentId:string;sourceDocumentId?:string};
type Entry={tabId:number;documentId:string;pending:string[];blocked?:boolean};
type Storage={get(key:string):Promise<Record<string,unknown>>;set(value:Record<string,unknown>):Promise<void>};
const KEY='inputRecovery';
export const recoveryMessage='An interrupted input left this page in an uncertain state. Inspect and save the page manually, then reload it before automated input. Do not repeat the original action.';
export interface InputRecovery {
 capture(tabId:number,sourceDocumentId?:string):Promise<InputDocument>;
 current(document:InputDocument):Promise<boolean>;
 begin(document:InputDocument,id:string):Promise<void>;
 finish(document:InputDocument,id:string,uncertain:boolean):Promise<void>;
 assertWritable(tabId:number,allowMissingDocument?:boolean):Promise<void>;
 status(tabId:number):Promise<{required:boolean;message?:string;pending?:boolean}>;
 removeTab(tabId:number):Promise<void>;
}
export function inputRecovery(storage:Storage,frames:(tabId:number)=>Promise<FrameInfo[]>):InputRecovery {
 let queue:Promise<unknown>=Promise.resolve();
 const active=new Set<string>(),memoryBlocked=new Set<string>(),removedTabs=new Set<number>();
 const serial=<T>(work:()=>Promise<T>)=>{const p=queue.then(work);queue=p.catch(()=>{});return p;};
 const key=(d:InputDocument)=>`${d.tabId}:${d.documentId}`;
 const read=async()=>{const value=(await storage.get(KEY))[KEY];return Array.isArray(value)?value as Entry[]:[];};
 const write=(entries:Entry[])=>storage.set({[KEY]:entries});
 const failure=()=>new ProtocolError('ELEMENT_NOT_INTERACTABLE',recoveryMessage,'never',{inputRecoveryRequired:true});
 const blocked=(d:InputDocument,entries:Entry[])=>memoryBlocked.has(key(d))||entries.some(e=>e.tabId===d.tabId&&e.documentId===d.documentId&&(e.blocked||e.pending.some(id=>!active.has(id))));
 const capture=async(tabId:number,sourceDocumentId?:string)=>{const live=await frames(tabId),top=live.find(f=>f.frameId===0);if(!top||sourceDocumentId&&!live.some(f=>f.documentId===sourceDocumentId))throw new ProtocolError('STALE_ELEMENT','The input document changed. Observe the page again.');return {tabId,documentId:top.documentId,...(sourceDocumentId?{sourceDocumentId}:{})};};
 return {
  capture,
  async current(d){const live=await frames(d.tabId).catch(()=>[]);return live.some(f=>f.frameId===0&&f.documentId===d.documentId)&&(!d.sourceDocumentId||live.some(f=>f.documentId===d.sourceDocumentId));},
  begin:(d,id)=>serial(async()=>{const entries=await read();if(blocked(d,entries))throw failure();if(entries.some(e=>e.tabId===d.tabId&&e.documentId===d.documentId&&e.pending.length))throw new ProtocolError('BROWSER_BUSY','The previous input is still settling.');let entry=entries.find(e=>e.tabId===d.tabId&&e.documentId===d.documentId);if(!entry){entry={tabId:d.tabId,documentId:d.documentId,pending:[]};entries.push(entry);}entry.pending.push(id);await write(entries);active.add(id);}),
  finish:(d,id,uncertain)=>{if(removedTabs.has(d.tabId)){active.delete(id);return Promise.resolve();}if(uncertain)memoryBlocked.add(key(d));return serial(async()=>{try{if(removedTabs.has(d.tabId))return;const entries=await read();let entry=entries.find(e=>e.tabId===d.tabId&&e.documentId===d.documentId);if(!entry&&uncertain){entry={tabId:d.tabId,documentId:d.documentId,pending:[]};entries.push(entry);}if(entry){entry.pending=entry.pending.filter(p=>p!==id);if(uncertain)entry.blocked=true;}await write(entries.filter(e=>e.blocked||e.pending.length));}finally{active.delete(id);}});},
  async assertWritable(tabId,allowMissingDocument=false){let d:InputDocument;try{d=await capture(tabId);}catch(error){if(!allowMissingDocument)throw error;await queue;if((await read()).some(e=>e.tabId===tabId)||[...memoryBlocked].some(k=>k.startsWith(`${tabId}:`)))throw failure();return;}await queue;const entries=await read();if(blocked(d,entries))throw failure();if(entries.some(e=>e.tabId===tabId&&e.documentId===d.documentId&&e.pending.length))throw new ProtocolError('BROWSER_BUSY','The previous input is still settling.');},
  async status(tabId){const d=await capture(tabId);await queue;const entries=await read();return blocked(d,entries)?{required:true,message:recoveryMessage}:{required:false,pending:entries.some(e=>e.tabId===tabId&&e.documentId===d.documentId&&e.pending.length>0)};},
  removeTab:tabId=>{removedTabs.add(tabId);for(const key of memoryBlocked)if(key.startsWith(`${tabId}:`))memoryBlocked.delete(key);return serial(async()=>{const entries=await read();for(const e of entries)if(e.tabId===tabId){for(const id of e.pending)active.delete(id);memoryBlocked.delete(`${tabId}:${e.documentId}`);}await write(entries.filter(e=>e.tabId!==tabId));});},
 };
}
