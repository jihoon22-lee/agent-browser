/** Chrome's debugger, attached only to this browser's operation tabs while the user enabled
 * trusted input, so clicks and keys arrive as real user input (review B3, handoff §10 R10). */
export type DebuggerApi = {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  send<T = unknown>(tabId: number, method: string, params?: object): Promise<T>;
  onDetach(listener: (tabId: number, reason: string) => void): () => void;
  onEvent(listener: (tabId: number, method: string, params: any) => void): () => void;
};
export type TrustedState = { enabled: boolean; operationTabs: number[]; operationId?: string | null };
export type Dialog = { type: string; message: string };

const KEYS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

export function trustedInput(api: DebuggerApi) {
  const attached = new Set<number>();
  // A user who pressed [Cancel] on the debugging bar keeps DOM input for that operation.
  const cancelled = new Map<number, { operationId: string | null | undefined; reason: string }>();
  const dialogs = new Map<number, Dialog>();
  let operationId: string | null | undefined;

  api.onDetach((tabId, reason) => {
    attached.delete(tabId);
    if (reason === "canceled_by_user") cancelled.set(tabId, { operationId, reason });
  });
  api.onEvent((tabId, method, params) => {
    if (method !== "Page.javascriptDialogOpening" || !attached.has(tabId)) return;
    // An alert only informs; a confirm, prompt or leave-page question is the user's decision.
    const accept = params?.type === "alert";
    dialogs.set(tabId, { type: String(params?.type ?? "unknown"), message: String(params?.message ?? "").slice(0, 200) });
    void api.send(tabId, "Page.handleJavaScriptDialog", { accept }).catch(() => {});
  });

  const takeDialog = (tabId: number) => { const dialog = dialogs.get(tabId); dialogs.delete(tabId); return dialog ? { dialog } : {}; };

  async function release(tabId: number) {
    attached.delete(tabId); dialogs.delete(tabId);
    await api.detach(tabId).catch(() => {});
  }

  return {
    async ensure(tabId: number, state: TrustedState): Promise<boolean> {
      if (!state.enabled || !state.operationTabs.includes(tabId)) return false;
      if (state.operationId !== undefined) operationId = state.operationId;
      const stop = cancelled.get(tabId);
      if (stop && stop.operationId === operationId) return false;
      if (attached.has(tabId)) return true;
      try {
        await api.attach(tabId);
        attached.add(tabId);
        await api.send(tabId, "Page.enable");
        return true;
      } catch { attached.delete(tabId); return false; }
    },
    async sync(state: TrustedState & { operationId: string | null }) {
      if (state.operationId !== operationId) { cancelled.clear(); operationId = state.operationId; }
      for (const tabId of [...attached]) if (!state.enabled || !state.operationId || !state.operationTabs.includes(tabId)) await release(tabId);
    },
    async click(tabId: number, x: number, y: number) {
      const base = { x, y, button: "left" as const, clickCount: 1 };
      await api.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await api.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await api.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
      return takeDialog(tabId);
    },
    async key(tabId: number, key: string) {
      const spec = KEYS[key];
      if (!spec) throw new Error(`Unsupported key ${key}`);
      await api.send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...spec });
      const { text: _text, ...up } = spec;
      await api.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...up });
      return takeDialog(tabId);
    },
    async screenshot(tabId: number) {
      const { data } = await api.send<{ data: string }>(tabId, "Page.captureScreenshot", { format: "png" });
      return `data:image/png;base64,${data}`;
    },
    cancelledReason: (tabId: number) => cancelled.get(tabId)?.reason,
    isAttached: (tabId: number) => attached.has(tabId),
  };
}
export type TrustedInput = ReturnType<typeof trustedInput>;

/** chrome.debugger behind the small interface above. */
export function chromeDebugger(): DebuggerApi {
  const wrap = <T>(work: (done: (value: T) => void) => void) => new Promise<T>((resolve, reject) =>
    work(value => { const error = chrome.runtime.lastError; error ? reject(new Error(error.message)) : resolve(value); }));
  return {
    attach: tabId => wrap<void>(done => chrome.debugger.attach({ tabId }, "1.3", () => done())),
    detach: tabId => wrap<void>(done => chrome.debugger.detach({ tabId }, () => done())),
    send: (tabId, method, params) => wrap(done => chrome.debugger.sendCommand({ tabId }, method, (params ?? {}) as { [key: string]: unknown }, result => done(result as any))),
    onDetach: listener => { const fn = (source: chrome.debugger.Debuggee, reason: string) => { if (source.tabId !== undefined) listener(source.tabId, reason); }; chrome.debugger.onDetach.addListener(fn); return () => chrome.debugger.onDetach.removeListener(fn); },
    onEvent: listener => { const fn = (source: chrome.debugger.Debuggee, method: string, params?: object) => { if (source.tabId !== undefined) listener(source.tabId, method, params); }; chrome.debugger.onEvent.addListener(fn); return () => chrome.debugger.onEvent.removeListener(fn); },
  };
}
