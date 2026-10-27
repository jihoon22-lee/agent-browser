import { isWeb } from '../background/tabs';
export type RequestTarget = { tabId: number; windowId: number };
export type RequestLease = { requestId: string; messageId: string; sessionId: string; profileId: string; directory: string; vision?: {model:string;image:'supported'|'unsupported'|'unknown';toolcall:boolean} };
export async function captureRequestTarget(): Promise<RequestTarget | null> {
  try {
    const win=await chrome.windows.getLastFocused({populate:true,windowTypes:['normal','popup']});
    const active=win.tabs?.filter(tab=>tab.active) ?? [];
    if (!win.focused || active.length!==1 || !Number.isInteger(win.id)) return null;
    const tab=active[0]!;
    if (!tab.id || tab.pendingUrl || !isWeb(tab.url)) return null;
    return {tabId:tab.id,windowId:win.id!};
  } catch { return null; }
}
export function requestInstructions(requestId:string,target:RequestTarget|null,files:string[]=[],skipped:string[]=[]):string {
  const start=target?`The captured tab is ${target.tabId}; start with browser_snapshot or browser_tabs attach.`:`No tab was captured: call browser_tabs list, then attach an explicit tabId.`;
  return `Browser context: this user request is bound to browser tools, so omit requestId and operationId. ${start} An explicit tab named by the user wins. If a tool result asks for ids, use requestId=${requestId} and the returned operationId. Results include a snapshot and openTabs. Close tabs only when asked. Never reuse ids or refs from earlier requests.${uploadNote(files,skipped)}`;
}
const fileList=(names:string[])=>names.map(name=>name.slice(0,80)).join(', ');
function uploadNote(files:string[],skipped:string[]) {
  return (files.length?` Attached files you may upload with browser_upload: ${fileList(files)}.`:'')+
    (skipped.length?` Too large or too many to upload: ${fileList(skipped)}.`:'');
}
export function completedRequest(lease:Pick<RequestLease,'messageId'|'sessionId'>,messages:Array<{info:Record<string,any>;parts?:unknown[]}>):boolean {
  const info=messages.filter(({info})=>info.role==='assistant'&&info.sessionID===lease.sessionId&&info.parentID===lease.messageId).at(-1)?.info;
  return !!info && typeof info.time?.completed==='number' &&
    (!!info.error || !['tool-calls','unknown'].includes(info.finish));
}
