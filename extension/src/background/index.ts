import { BridgeConnection, type ConnStatus } from "./bridge-connection";
import { createHandlers } from "./handlers";
import { chromeSessionStore } from "./dedupe";
import { ProtocolError } from "../protocol/errors";
import { chromeStorage, realChromeApi } from "./chrome-api";
import { isExtensionPage } from "./sender";
import { panelRequests } from './panel-requests';

const handleBridgeRequest = createHandlers(realChromeApi, chromeSessionStore());
let lastStatus: ConnStatus = { state: "disconnected" };
const conn = new BridgeConnection({
  WebSocketImpl: WebSocket,
  storage: chromeStorage,
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (id) => clearTimeout(id),
  onRequest: (req) => handleBridgeRequest(req),
  onDisconnect: () => handleBridgeRequest.disconnect(),
  onStatus: (s) => { lastStatus = s; void chrome.runtime.sendMessage({ kind: "conn-status", status: s }).catch(() => {}); },
  extensionVersion: chrome.runtime.getManifest().version,
  reload: () => chrome.runtime.reload(),
  onEvent: (event, data) => { void chrome.runtime.sendMessage({ kind: "bridge-event", event, data }).catch(() => {}); },
});

const requests=panelRequests((method,params)=>conn.request(method,params));
chrome.runtime.onStartup.addListener(() => conn.ensure());
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  conn.ensure();
});
// Alarms wake a suspended worker; the timer makes completion prompt while the
// WebSocket keeps it alive. Neither path starts an unavailable OpenCode profile.
const reconcile=()=>{ if(lastStatus.state==='connected')void requests.reconcile().catch(()=>{}); };
// Keep the alarm compatible with the existing minimum Chrome 116.
void chrome.alarms.create('panel-request-reconcile',{periodInMinutes:1});
setInterval(reconcile,15_000);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bridge-keepalive") conn.ensure();
  if (a.name === 'panel-request-reconcile') reconcile();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.pairingToken || changes.bridgeUrl)) { conn.stop(); conn.start(); }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Extension pages only; a content script must never be able to reach the bridge or read its status.
  if (!isExtensionPage(sender, chrome.runtime.id)) return;
  if(['request-prepare','request-cancel','request-finish','request-discard'].includes(msg?.kind)) {
    const work=msg.kind==='request-prepare'?requests.prepare(msg.lease,msg.target,msg.previousOperationId):msg.kind==='request-discard'?requests.discard(msg.requestId):msg.kind==='request-finish'?requests.finish(msg.scope):requests.cancel(msg.scope);
    work.then(result=>sendResponse({ok:true,result}),error=>sendResponse({ok:false,error:{message:error instanceof Error?error.message:String(error)}}));
    return true;
  }
  if (msg?.kind === "reconnect") { conn.stop(); conn.start(); sendResponse({ ok: true }); return; }
  if (msg?.kind === "profiles-changed") { sendResponse({ ok: true }); return; }
  if (msg?.kind === "get-conn-status") { sendResponse(lastStatus); return; }
  if (msg?.kind === "browser-context" && ["current-tab", "selection"].includes(msg.reference)) {
    void (async () => {
      const status = lastStatus.state === "connected" ? await conn.request("status.get", {}) as { operation?: { clientId: string; currentTab: number } } : undefined;
      const clientId = (await chrome.storage.local.get("clientId")).clientId;
      if (status?.operation && status.operation.clientId !== clientId) throw new Error("현재 작업은 다른 브라우저에 연결되어 있습니다.");
      const tab = status?.operation ? await chrome.tabs.get(status.operation.currentTab) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      if (!tab?.id || !tab.url || !["http:", "https:"].includes(new URL(tab.url).protocol)) throw new Error("일반 HTTP(S) 페이지에서만 브라우저 참조를 첨부할 수 있습니다.");
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [msg.reference], func: (reference: string) => ({ title: document.title, url: location.href, text: (reference === "selection" ? getSelection()?.toString() ?? "" : document.body?.innerText ?? "").slice(0, 16000) }) });
      if (!result?.result || (msg.reference === "selection" && !result.result.text)) throw new Error("선택한 텍스트가 없습니다.");
      sendResponse({ ok: true, result: { ...result.result, tabId: tab.id, reference: msg.reference } });
    })().catch(error => sendResponse({ ok: false, error: { code: "UNSUPPORTED_PAGE", message: error instanceof Error ? error.message : "페이지 참조를 읽지 못했습니다.", retry: "never" } }));
    return true;
  }
  if (msg?.kind === "bridge" && ["status.get", "operation.abort", "browser.use", "profile.list", "profile.save", "profile.delete", "runtime.ensure", "runtime.status", "runtime.stop", "doctor.run"].includes(msg.method)) {
    const work=()=>conn.request(msg.method, msg.params ?? {}).then(async r => {
      if(msg.method==='profile.delete')await requests.removeProfile(msg.params?.profileId);
      return r;
    });
    const profileId=msg.method==='profile.save'?msg.params?.profile?.id:msg.params?.profileId;
    const result=['profile.save','profile.delete','runtime.stop'].includes(msg.method)&&typeof profileId==='string'
      ? requests.manageProfile(profileId,work):work();
    result.then((r) => sendResponse({ ok: true, result: r }), (e) => sendResponse({ ok: false, error: e instanceof ProtocolError ? e.toRpc() : { code: "INTERNAL", message: String(e), retry: "never" } }));
    return true;
  }
});
chrome.tabs.onRemoved.addListener((tabId) => { conn.sendEvent("tab.closed", { tabId }); });
conn.start();
