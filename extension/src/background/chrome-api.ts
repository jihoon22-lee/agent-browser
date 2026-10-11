import type { KeyValueStore } from './bridge-connection';
export const chromeStorage: KeyValueStore = {
    get: async (k) => (await chrome.storage.local.get(k))[k], set: (k, v) => chrome.storage.local.set({ [k]: v }),
};
export type FrameInfo = {
    frameId: number;
    documentId: string;
    url: string;
};
export interface ChromeApi {
    tabsQuery(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
    tabsGet(id: number): Promise<chrome.tabs.Tab>;
    tabsCreate(params: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
    tabsUpdate(id: number, params: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab>;
    tabsGoBack(id: number): Promise<void>;
    tabsGoForward(id: number): Promise<void>;
    tabsReload(id: number): Promise<void>;
    captureVisibleTab(windowId: number): Promise<string>;
    listFrames(tabId: number): Promise<FrameInfo[]>;
    inject(tabId: number, frame: FrameInfo): Promise<FrameInfo>;
    sendToFrame(tabId: number, frame: FrameInfo, msg: unknown): Promise<any>;
    onTabUpdated(fn: (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void): () => void;
    onTabActivated(fn: (info: chrome.tabs.OnActivatedInfo) => void): () => void;
}
export const realChromeApi: ChromeApi = {
    tabsQuery: q => chrome.tabs.query(q), tabsGet: id => chrome.tabs.get(id), tabsCreate: p => chrome.tabs.create(p),
    tabsUpdate: async (id, p) => { const tab = await chrome.tabs.update(id, p); if (!tab)
        throw new Error('Tab was closed'); return tab; }, tabsGoBack: id => chrome.tabs.goBack(id), tabsGoForward: id => chrome.tabs.goForward(id), tabsReload: id => chrome.tabs.reload(id),
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
    onTabActivated: fn => { chrome.tabs.onActivated.addListener(fn); return () => chrome.tabs.onActivated.removeListener(fn); },
};
