import { BridgeConnection, type ConnStatus } from "./bridge-connection";
import { createHandlers } from "./handlers";
import { chromeSessionStore } from "./dedupe";
import { ProtocolError } from "../protocol/errors";
import { chromeStorage, realChromeApi } from "./chrome-api";
import { isExtensionPage } from "./sender";

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
  onEvent: (event, data) => { void chrome.runtime.sendMessage({ kind: "bridge-event", event, data }).catch(() => {}); },
});

chrome.runtime.onStartup.addListener(() => conn.ensure());
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  conn.ensure();
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "bridge-keepalive") conn.ensure(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.pairingToken || changes.bridgeUrl)) { conn.stop(); conn.start(); }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Extension pages only; a content script must never be able to reach the bridge or read its status.
  if (!isExtensionPage(sender, chrome.runtime.id)) return;
  if (msg?.kind === "reconnect") { conn.stop(); conn.start(); sendResponse({ ok: true }); return; }
  if (msg?.kind === "get-conn-status") { sendResponse(lastStatus); return; }
  if (msg?.kind === "bridge" && ["status.get", "operation.abort", "browser.use"].includes(msg.method)) {
    conn.request(msg.method, msg.params ?? {}).then((r) => sendResponse({ ok: true, result: r }), (e) => sendResponse({ ok: false, error: e instanceof ProtocolError ? e.toRpc() : { code: "INTERNAL", message: String(e), retry: "never" } }));
    return true;
  }
});
chrome.tabs.onRemoved.addListener((tabId) => { conn.sendEvent("tab.closed", { tabId }); });
conn.start();
