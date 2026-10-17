/** Who may ask the background to send trusted input: this extension's top-frame content script,
 * for the click or key press it is executing right now, on a tab the debugger is attached to. */
export type TrustedSender = { id?: string; tab?: { id?: number }; frameId?: number };
export type TrustedContext = {
  runtimeId: string;
  running(tabId: number, requestId: string, method: string): boolean;
  enabled: boolean;
  attached(tabId: number): boolean;
};

export function acceptTrustedRequest(msg: any, sender: TrustedSender, ctx: TrustedContext): boolean {
  const tabId = sender.tab?.id;
  if (msg?.kind !== "trusted-input" || sender.id !== ctx.runtimeId || typeof tabId !== "number" || sender.frameId !== 0) return false;
  if (!ctx.enabled || !ctx.attached(tabId) || typeof msg.requestId !== "string") return false;
  if (msg.action === "click") return Number.isFinite(msg.x) && Number.isFinite(msg.y) && [undefined, "click", "double", "right", "hover"].includes(msg.mode) && ctx.running(tabId, msg.requestId, "browser.click");
  if (msg.action === "key") return typeof msg.key === "string" && ctx.running(tabId, msg.requestId, "browser.press");
  return false;
}
