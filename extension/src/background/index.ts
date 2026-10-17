import { BridgeConnection, type ConnStatus } from "./bridge-connection";
import { createHandlers } from "./handlers";
import { chromeSessionStore } from "./dedupe";
import { ProtocolError } from "../protocol/errors";
import { chromeStorage, realChromeApi } from "./chrome-api";
import { isExtensionPage } from "./sender";
import { panelRequests } from './panel-requests';
import { chromeDebugger, trustedInput, trustedTargets } from './trusted-input';
import { acceptTrustedRequest } from './trusted-message';
import { chromeGroups, syncGroup, type GroupState } from './tab-groups';
import { applyBadge, badgeFor } from './badge';
import { markedBefore, markerScript, shouldRemark, syncMarkers } from './work-marker';

// Trusted input (off by default): the debugger is attached only to this browser's operation tabs.
const trusted = trustedInput(chromeDebugger());
let trustedEnabled = false, ownClientId: string | undefined;
void chrome.storage.local.get(["trustedInput", "clientId"]).then(({ trustedInput: on, clientId }) => { trustedEnabled = on === true; if (typeof clientId === "string") ownClientId = clientId; }).catch(() => {});
// The person holding the browser (paused operation) gets every tab back, debugger detached.
const trustedState = () => trustedTargets(lastOperation, ownClientId, trustedEnabled);
const syncTrusted = () => void trusted.sync(trustedState()).catch(() => {});
// Optional tab groups: serialized so status bursts cannot group a tab twice.
let groups: GroupState = { grouped: new Set() }, grouping: Promise<unknown> = Promise.resolve();
const syncGroups = () => { grouping = grouping.then(async () => {
  const granted = await chrome.permissions.contains({ permissions: ["tabGroups"] }).catch(() => false);
  const mine = lastOperation && ownClientId && lastOperation.clientId === ownClientId ? lastOperation : null;
  groups = await syncGroup(chromeGroups(), granted, mine?.tabs ?? [], groups);
}).catch(() => {}); };
const handleBridgeRequest = createHandlers(realChromeApi, chromeSessionStore(), {
  ensure: tabId => trusted.ensure(tabId, trustedState()),
  screenshot: tabId => trusted.screenshot(tabId),
});
let lastStatus: ConnStatus = { state: "disconnected" };
// Toolbar badge inputs: the Bridge's current operation and whether the panel request awaits an answer.
let lastOperation: { clientId: string; paused?: boolean; tabs?: number[]; id?: string } | null = null, waiting = false;
let marked: Set<number> | null = null, marking: Promise<unknown> = Promise.resolve();
const markerApi = { executeScript: (tabId: number, func: (...args: any[]) => void, args: [boolean, string]) => chrome.scripting.executeScript({ target: { tabId }, func, args }) };
/** Frames this browser's operation tabs; serialized so quick status bursts cannot interleave. */
const refreshMarkers = () => { marking = marking.then(async () => {
  const { clientId } = await chrome.storage.local.get("clientId");
  const mine = lastOperation && lastOperation.clientId === clientId ? lastOperation : null;
  const webTabs = async () => (await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })).map(tab => tab.id).filter((id): id is number => Number.isInteger(id));
  const previous = await markedBefore(chrome.storage.session, webTabs, marked);
  marked = await syncMarkers(markerApi, previous, mine ? { tabs: mine.tabs ?? [], paused: !!mine.paused } : null);
  await chrome.storage.session.set({ markedTabs: [...marked] });
}).catch(() => {}); };
const refreshBadge = () => void chrome.storage.local.get("clientId")
  .then(({ clientId }) => applyBadge(badgeFor({ operation: lastOperation, clientId: typeof clientId === "string" ? clientId : undefined, waiting })))
  .catch(() => {});
const conn = new BridgeConnection({
  WebSocketImpl: WebSocket,
  storage: chromeStorage,
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (id) => clearTimeout(id),
  onRequest: (req) => handleBridgeRequest(req),
  onDisconnect: () => handleBridgeRequest.disconnect(),
  onStatus: (s) => { lastStatus = s; if (s.state !== "connected") { lastOperation = null; waiting = false; refreshBadge(); refreshMarkers(); syncTrusted(); syncGroups(); } void chrome.runtime.sendMessage({ kind: "conn-status", status: s }).catch(() => {}); },
  extensionVersion: chrome.runtime.getManifest().version,
  reload: () => chrome.runtime.reload(),
  onEvent: (event, data) => {
    if (event === "status.changed") { lastOperation = (data as { operation?: typeof lastOperation })?.operation ?? null; refreshBadge(); refreshMarkers(); syncTrusted(); syncGroups(); }
    void chrome.runtime.sendMessage({ kind: "bridge-event", event, data }).catch(() => {});
  },
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
const reconcile=()=>{
  if(lastStatus.state!=='connected')return;
  void requests.reconcile().catch(()=>{});
  void requests.attention().then(found=>{ if(found.waiting!==waiting){ waiting=found.waiting; refreshBadge(); } });
};
// Keep the alarm compatible with the existing minimum Chrome 116.
void chrome.alarms.create('panel-request-reconcile',{periodInMinutes:1});
setInterval(reconcile,15_000);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bridge-keepalive") conn.ensure();
  if (a.name === 'panel-request-reconcile') reconcile();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.trustedInput || changes.clientId)) {
    if (changes.trustedInput) trustedEnabled = changes.trustedInput.newValue === true;
    if (typeof changes.clientId?.newValue === "string") ownClientId = changes.clientId.newValue;
    syncTrusted();
  }
  if (area === "local" && (changes.pairingToken || changes.bridgeUrl)) { conn.stop(); conn.start(); }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // The one content-script request: trusted input for the click or key it is executing right now.
  if (msg?.kind === "trusted-input") {
    const ok = acceptTrustedRequest(msg, sender, { runtimeId: chrome.runtime.id, running: handleBridgeRequest.isRunning, enabled: trustedEnabled, attached: tabId => trusted.isAttached(tabId) });
    if (!ok) { sendResponse({ ok: false, reason: trusted.cancelledReason(sender.tab?.id ?? -1) ?? "not-allowed" }); return; }
    const tabId = sender.tab!.id!;
    (msg.action === "click" ? trusted.click(tabId, msg.x, msg.y) : trusted.key(tabId, msg.key))
      .then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, reason: trusted.cancelledReason(tabId) ?? "debugger-error", ...(error?.dispatched ? { dispatched: true } : {}) }));
    return true;
  }
  // Extension pages only; a content script must never be able to reach the bridge or read its status.
  if (!isExtensionPage(sender, chrome.runtime.id)) return;
  if(['request-prepare','request-cancel','request-finish','request-discard'].includes(msg?.kind)) {
    const work=msg.kind==='request-prepare'?requests.prepare(msg.lease,msg.target,msg.previousOperationId):msg.kind==='request-discard'?requests.discard(msg.requestId):msg.kind==='request-finish'?requests.finish(msg.scope):requests.cancel(msg.scope);
    work.then(result=>sendResponse({ok:true,result}),error=>sendResponse({ok:false,error:{message:error instanceof Error?error.message:String(error)}}));
    return true;
  }
  if (msg?.kind === "pair-with-code" && typeof msg.code === "string") {
    conn.pairWithCode(msg.code).then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: error instanceof ProtocolError ? error.toRpc() : { code: "INTERNAL", message: String(error), retry: "never" } }));
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
  if (msg?.kind === "bridge" && ["status.get", "operation.abort", "operation.pause", "operation.resume", "browser.use", "profile.list", "profile.save", "profile.delete", "runtime.ensure", "runtime.status", "runtime.stop", "doctor.run"].includes(msg.method)) {
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
// A navigation replaces the document and its marker; put it back on a tab that is still marked.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (!shouldRemark(tabId, frameId, marked)) return;
  const label = lastOperation?.paused ? "AgentBrowser · 사용자가 조작 중" : "AgentBrowser 작업 중";
  void chrome.scripting.executeScript({ target: { tabId }, func: markerScript, args: [true, label] }).catch(() => {});
});
conn.start();
