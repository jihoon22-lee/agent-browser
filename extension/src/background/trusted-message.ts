import { trustedShortcut } from "./trusted-input";
/** Who may ask the background to send trusted input: this extension's top-frame content script,
 * for the click, drag or key press it is executing right now, on a tab the debugger is attached to. */
export type TrustedSender = { id?: string; tab?: { id?: number }; frameId?: number; documentId?:string };
export type TrustedContext = {
  runtimeId: string;
  running(tabId: number, requestId: string, method: string): boolean;
  enabled: boolean;
  attached(tabId: number): boolean;
  frameAllowed?(sender:TrustedSender,requestId:string):boolean;
};

export function acceptTrustedRequest(msg: any, sender: TrustedSender, ctx: TrustedContext): boolean {
  const tabId = sender.tab?.id;
  if (msg?.kind !== "trusted-input" || sender.id !== ctx.runtimeId || typeof tabId !== "number" || (sender.frameId !== 0 && !ctx.frameAllowed?.(sender,msg.requestId))) return false;
  if (!ctx.enabled || !ctx.attached(tabId) || typeof msg.requestId !== "string") return false;
  if (msg.action === "text") return !!ctx.frameAllowed?.(sender,msg.requestId) && typeof msg.text === "string" && msg.text.length<=100000 && ctx.running(tabId,msg.requestId,"browser.fill");
  if (msg.action === "click") return Number.isFinite(msg.x) && Number.isFinite(msg.y) && [undefined, "click", "double", "right", "hover"].includes(msg.mode) && ctx.running(tabId, msg.requestId, "browser.click");
  if (msg.action === "drag") return [msg.x, msg.y, msg.toX, msg.toY].every(Number.isFinite) && ctx.running(tabId, msg.requestId, "browser.click");
  const modifiersOk = msg.modifiers === undefined || (Array.isArray(msg.modifiers) && msg.modifiers.every((m: unknown) => ["Alt", "Control", "Meta", "Shift"].includes(m as string)));
  if (msg.action === "key") return typeof msg.key === "string" && modifiersOk && trustedShortcut(msg.key, msg.modifiers ?? []) && ctx.running(tabId, msg.requestId, "browser.press");
  return false;
}
