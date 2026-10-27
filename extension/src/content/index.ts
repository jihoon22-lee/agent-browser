import { visualTarget } from './visual-target';
import { resolveRef } from "./refs";
import { resetRegistry } from "./refs";
import { takeSnapshot } from "./snapshot";
import { runAction } from "./actions";
import { ProtocolError } from "../protocol/errors";
import { cancelCommands, withCommandCancellation } from "./cancellation";
import { observeUserInput } from "./user-input";

declare global { interface Window { __agentBrowserContent?: boolean } }

if (!window.__agentBrowserContent) {
  window.__agentBrowserContent = true;
  const inputState = observeUserInput(window);
  // BFCache restores the same document and JS heap: old refs must not revive.
  window.addEventListener('pagehide', resetRegistry);
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.kind === "input-state") {
      sendResponse(inputState());
      return;
    }
    if(msg?.kind==='visual-target'){
      try{sendResponse(visualTarget(msg.action,msg.key,msg.points));}catch{sendResponse({ok:false});}return;
    }
    if (msg?.kind === "trusted-verify") {
      try {const el=resolveRef(msg.ref,false,'dispatch');let focused:Element|null=document.activeElement;while(focused?.shadowRoot?.activeElement)focused=focused.shadowRoot.activeElement;
        let hit:Element|null=msg.point?document.elementFromPoint(msg.point.x,msg.point.y):null;
        while(hit?.shadowRoot){const next=hit.shadowRoot.elementFromPoint(msg.point.x,msg.point.y);if(!next||next===hit)break;hit=next;}
        let within=false;for(let n:Element|null=hit;n;n=n.parentElement??(n.getRootNode() as ShadowRoot).host??null)if(n===el){within=true;break;}
        const label=hit?.closest('label');if(label&&'labels' in el&&[...((el as HTMLInputElement).labels??[])].includes(label))within=true;
        sendResponse({ok:(!msg.focus || el===focused || el.contains(focused))&&(!msg.point||within)});
      }catch{sendResponse({ok:false});}return;
    }
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
