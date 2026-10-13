import type { BookmarkAccess } from './bookmarks';
import type { KeyValueStore } from './bridge-connection';
import { ProtocolError } from '../protocol/errors';
async function traverse(id: number, documentId: string | undefined, direction: 'back' | 'forward') {
    const results = await chrome.scripting.executeScript({
        target: {tabId:id,...(documentId ? {documentIds:[documentId]} : {frameIds:[0]})},
        args: [direction],
        func: (direction: 'back' | 'forward') => {
            const nav=(window as any).navigation;
            // Navigation API hides cross-origin entries. Only treat its boundary
            // as definitive when it exposes the complete session history.
            if(history.length===1 || (nav && nav.entries().length===history.length && !(direction==='back' ? nav.canGoBack : nav.canGoForward))) return false;
            history[direction](); return true;
        },
    });
    if(results[0]?.result===false) throw new ProtocolError('ELEMENT_NOT_INTERACTABLE','No history entry is available in that direction.','never',{executed:false});
}
export const chromeStorage: KeyValueStore = {
    get: async (k) => (await chrome.storage.local.get(k))[k], set: (k, v) => chrome.storage.local.set({ [k]: v }),
};
export type FrameInfo = {
    frameId: number;
    documentId: string;
    url: string;
};
export interface ChromeApi {
    bookmarks?: BookmarkAccess;
    windowsList?(): Promise<chrome.windows.Window[]>;
    tabsQuery(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
    tabsGet(id: number): Promise<chrome.tabs.Tab>;
    tabsCreate(params: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
    tabsUpdate(id: number, params: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab>;
    tabsGoBack(id: number, documentId?: string): Promise<void>;
    tabsGoForward(id: number, documentId?: string): Promise<void>;
    tabsReload(id: number): Promise<void>;
    tabsRemove(id:number):Promise<void>;
    historyEntry?(id:number,documentId:string):Promise<string|undefined>;
    captureVisibleTab(windowId: number): Promise<string>;
    listFrames(tabId: number): Promise<FrameInfo[]>;
    inject(tabId: number, frame: FrameInfo): Promise<FrameInfo>;
    sendToFrame(tabId: number, frame: FrameInfo, msg: unknown): Promise<any>;
    onTabUpdated(fn: (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void): () => void;
    onNavigationStarted?(fn: (tabId: number) => void): () => void;
    onTabActivated(fn: (info: chrome.tabs.OnActivatedInfo) => void): () => void;
    onTabRemoved(fn: (id: number) => void): () => void;
    onCreatedNavigationTarget(fn: (details: chrome.webNavigation.WebNavigationSourceCallbackDetails) => void): () => void;
}
export const realChromeApi: ChromeApi = {
    bookmarks: {
        granted: () => chrome.permissions.contains({permissions:['bookmarks']}),
        children: id => chrome.bookmarks.getChildren(id),
        search: query => chrome.bookmarks.search(query),
    },
    windowsList: () => chrome.windows.getAll({windowTypes:['normal']}),
    tabsRemove: id => chrome.tabs.remove(id),
    tabsQuery: q => chrome.tabs.query(q), tabsGet: id => chrome.tabs.get(id), tabsCreate: p => chrome.tabs.create(p),
    tabsUpdate: async (id, p) => { const tab = await chrome.tabs.update(id, p); if (!tab)
        throw new Error('Tab was closed'); return tab; }, // Traverse exactly one history entry. tabs.goBack/goForward behave like
    // browser UI and can skip entries without trusted user activation (agent clicks).
    tabsGoBack: (id, documentId) => traverse(id,documentId,'back'),
    tabsGoForward: (id, documentId) => traverse(id,documentId,'forward'), tabsReload: id => chrome.tabs.reload(id),
    historyEntry: async(id,documentId)=>{
        const [result]=await chrome.scripting.executeScript({target:{tabId:id,documentIds:[documentId]},func:()=>{
            const entry=(window as any).navigation?.currentEntry;
            return typeof entry?.key==='string' ? entry.key : undefined;
        }});
        return result?.result;
    },
    captureVisibleTab: windowId => chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
    listFrames: async (tabId) => (await chrome.webNavigation.getAllFrames({ tabId }) ?? []).map(f => ({ frameId: f.frameId, documentId: f.documentId, url: f.url })),
    inject: async (tabId, frame) => {
        const [injected] = await chrome.scripting.executeScript({ target: { tabId, documentIds: [frame.documentId] }, files: ['content.js'] });
        if (!injected || injected.documentId !== frame.documentId)
            throw new Error('Document changed while injecting');
        return frame;
    },
    sendToFrame: (tabId, frame, msg) => chrome.tabs.sendMessage(tabId, msg, { documentId: frame.documentId }),
    onTabUpdated: fn => { chrome.tabs.onUpdated.addListener(fn); return () => chrome.tabs.onUpdated.removeListener(fn); },
    onNavigationStarted: fn => {
        const listener=(details:{tabId:number;frameId:number})=>{if(details.frameId===0)fn(details.tabId);};
        chrome.webNavigation.onBeforeNavigate.addListener(listener);
        return ()=>chrome.webNavigation.onBeforeNavigate.removeListener(listener);
    },
    onTabActivated: fn => { chrome.tabs.onActivated.addListener(fn); return () => chrome.tabs.onActivated.removeListener(fn); },
    onTabRemoved: fn => { chrome.tabs.onRemoved.addListener(fn); return () => chrome.tabs.onRemoved.removeListener(fn); },
    onCreatedNavigationTarget: fn => { chrome.webNavigation.onCreatedNavigationTarget.addListener(fn); return () => chrome.webNavigation.onCreatedNavigationTarget.removeListener(fn); },
};
