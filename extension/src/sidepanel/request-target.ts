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
  const first=JSON.stringify({action:'new',requestId});
  const existing=target ? `The captured tab is ${target.tabId}. For current-page work start with ${JSON.stringify({action:'attach',requestId})}.` : 'No safe current page was captured. For an existing page, list tabs and attach an explicit HTTP(S) tabId with this requestId.';
  return `Browser context for this user request: requestId=${requestId}. This identifies the request, not a tab; it already exists before a new tab is created. For a requested new tab, call browser_tabs with ${first}; add url/windowId as needed. No attach or snapshot is needed first. ${existing} An explicit tab requested by the user takes priority over the captured default. Lists and bookmarks need no attach. After attach/new returns operationId, keep using that operationId for further new, switch, close, navigation and page work within this request; do not start another operation per tab. Switch can select an explicit listed HTTP(S) tab. User focus changes do not retarget the operation. Snapshot after switching or navigation before page actions; from about:blank navigate to HTTP(S) first. Close only when requested, after inspecting the target; edited forms are preserved. Closing the current tab restores the most recently visited surviving tab in this operation; snapshot to confirm it, or switch/new with this operationId if none remains. For missing requestId on an unexecuted attach/new, correct the arguments with this requestId and retry. Never invent a tab-specific requestId or reuse IDs/refs from earlier requests.`;
}
export function completedRequest(lease:Pick<RequestLease,'messageId'|'sessionId'>,messages:Array<{info:Record<string,any>;parts?:unknown[]}>):boolean {
  const info=messages.filter(({info})=>info.role==='assistant'&&info.sessionID===lease.sessionId&&info.parentID===lease.messageId).at(-1)?.info;
  return !!info && typeof info.time?.completed==='number' &&
    (!!info.error || !['tool-calls','unknown'].includes(info.finish));
}
