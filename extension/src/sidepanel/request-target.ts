import { isWeb } from '../background/tabs';
export type RequestTarget = { tabId: number; windowId: number };
export type RequestLease = { requestId: string; messageId: string; sessionId: string; profileId: string; directory: string };
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
export function requestInstructions(requestId:string,target:RequestTarget|null):string {
  return `Browser context for this user request: requestId=${requestId}. ${target ? `The active tab captured at submission was ${target.tabId}.` : 'No safe active tab was available at submission.'} If browser tools are needed, start a NEW browser_tabs action=attach with this requestId, then take browser_snapshot. An explicit tab requested by the user takes priority: resolve that tab and pass tabId on attach. Otherwise omit tabId to use the captured default. Do not reuse operationIds or refs from earlier requests. Keep the operation fixed through this request; user focus changes do not change its target. If attach fails, do not fall back to another tab. New tabs created by this operation may be used normally.`;
}
export function completedRequest(lease:Pick<RequestLease,'messageId'|'sessionId'>,messages:Array<{info:Record<string,any>;parts?:unknown[]}>):boolean {
  const info=messages.filter(({info})=>info.role==='assistant'&&info.sessionID===lease.sessionId&&info.parentID===lease.messageId).at(-1)?.info;
  return !!info && typeof info.time?.completed==='number' &&
    (!!info.error || (typeof info.finish==='string' && !['tool-calls','unknown'].includes(info.finish)));
}
