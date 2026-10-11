import { takeSnapshot } from "./snapshot";
import { runAction } from "./actions";
import { ProtocolError } from "../protocol/errors";
import { cancelCommands, withCommandCancellation } from "./cancellation";

declare global { interface Window { __agentBrowserContent?: boolean } }

if (!window.__agentBrowserContent) {
  window.__agentBrowserContent = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.kind === "cancel") {
      cancelCommands(msg);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.kind !== "cmd") return;
    (async () => {
      if (msg.method === "snapshot") return withCommandCancellation(msg.params, () => takeSnapshot({ ...msg.params, checkLayout: true }));
      return runAction(msg.method, msg.params);
    })().then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: e instanceof ProtocolError ? e.toRpc() : { code: "INTERNAL", message: String(e), retry: "never" } }),
    );
    return true;
  });
}
