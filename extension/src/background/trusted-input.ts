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
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
};
/** CDP modifier bits and the key each modifier presses. */
const MODIFIER_KEYS: Record<string, { bit: number; key: string; code: string; windowsVirtualKeyCode: number }> = {
  Alt: { bit: 1, key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
  Control: { bit: 2, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Meta: { bit: 4, key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  Shift: { bit: 8, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
};
function keySpec(key: string, modifiers: string[]) {
  if (KEYS[key]) return KEYS[key];
  if (modifiers.length === 0 || !/^[a-zA-Z0-9]$/.test(key)) return undefined;
  const upper = key.toUpperCase(), shift = modifiers.includes("Shift");
  return { key: /\d/.test(key) ? key : shift ? upper : key.toLowerCase(), code: /\d/.test(key) ? `Digit${key}` : `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: /\d/.test(key) ? key : shift ? upper : key.toLowerCase() };
}

/** The input state for this browser: its operation's tabs, none while the person holds the browser. */
export function trustedTargets(operation: { id?: string; clientId?: string; tabs?: number[]; paused?: boolean } | null, clientId: string | undefined, enabled: boolean): TrustedState & { operationId: string | null } {
  const mine = operation && clientId && operation.clientId === clientId ? operation : null;
  return { enabled, operationTabs: mine && !mine.paused ? mine.tabs ?? [] : [], operationId: mine?.id ?? null };
}

/** An input that already reached the page must never be sent again as DOM events. */
export class PartlyDelivered extends Error { readonly dispatched = true; }

export function trustedInput(api: DebuggerApi) {
  const attached = new Set<number>();
  // [Cancel] on Chrome's debugging bar applies to the whole operation, not one tab.
  let cancelled: { operationId: string | null | undefined; reason: string } | undefined;
  const dialogs = new Map<number, Dialog>();
  // Dialogs are answered only during an agent input and shortly after; others belong to the person.
  const inputUntil = new Map<number, number>();
  let operationId: string | null | undefined;
  let current: TrustedState = { enabled: false, operationTabs: [] };
  // Attach, detach and sync run one at a time, so a session can never escape tracking.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => { const next = queue.then(work); queue = next.catch(() => {}); return next; };

  api.onDetach((tabId, reason) => {
    attached.delete(tabId);
    if (reason === "canceled_by_user") cancelled = { operationId, reason };
  });
  api.onEvent((tabId, method, params) => {
    if (method !== "Page.javascriptDialogOpening" || !attached.has(tabId)) return;
    if (!((inputUntil.get(tabId) ?? 0) >= Date.now())) return;
    // An alert only informs; a confirm, prompt or leave-page question is the user's decision.
    const accept = params?.type === "alert";
    dialogs.set(tabId, { type: String(params?.type ?? "unknown"), message: String(params?.message ?? "").slice(0, 200) });
    void api.send(tabId, "Page.handleJavaScriptDialog", { accept }).catch(() => {});
  });

  const takeDialog = (tabId: number) => { const dialog = dialogs.get(tabId); dialogs.delete(tabId); return dialog ? { dialog } : {}; };
  const isCancelled = () => !!cancelled && cancelled.operationId === operationId;

  async function release(tabId: number) {
    attached.delete(tabId); dialogs.delete(tabId); inputUntil.delete(tabId);
    await api.detach(tabId).catch(() => {});
  }
  /** Runs one agent input; a failure after the first event reached the page is marked as partly delivered. */
  async function deliver(tabId: number, steps: Array<() => Promise<unknown>>) {
    inputUntil.set(tabId, Number.POSITIVE_INFINITY);
    let sent = 0;
    try { for (const step of steps) { await step(); sent++; } }
    catch (error) { if (sent > 0) throw new PartlyDelivered(error instanceof Error ? error.message : String(error)); throw error; }
    finally { inputUntil.set(tabId, Date.now() + 1500); }
    return takeDialog(tabId);
  }

  return {
    ensure(tabId: number, state: TrustedState): Promise<boolean> {
      return serial(async () => {
        if (state.operationId !== undefined && state.operationId !== operationId) { operationId = state.operationId; if (cancelled && cancelled.operationId !== operationId) cancelled = undefined; }
        current = state;
        if (!state.enabled || !state.operationTabs.includes(tabId) || isCancelled()) return false;
        if (attached.has(tabId)) return true;
        try {
          await api.attach(tabId);
          attached.add(tabId);
          await api.send(tabId, "Page.enable");
          return true;
        } catch { await release(tabId); return false; }
      });
    },
    sync(state: TrustedState & { operationId: string | null }): Promise<void> {
      return serial(async () => {
        if (state.operationId !== operationId) { cancelled = undefined; operationId = state.operationId; }
        current = state;
        for (const tabId of [...attached]) if (!state.enabled || !state.operationId || !state.operationTabs.includes(tabId)) await release(tabId);
      });
    },
    click(tabId: number, x: number, y: number, mode: ClickMode = "click") {
      const mouse = (params: object) => () => api.send(tabId, "Input.dispatchMouseEvent", params);
      const button = mode === "right" ? "right" as const : "left" as const;
      const steps = [mouse({ type: "mouseMoved", x, y })];
      if (mode !== "hover") for (const clickCount of mode === "double" ? [1, 2] : [1])
        steps.push(mouse({ type: "mousePressed", x, y, button, clickCount }), mouse({ type: "mouseReleased", x, y, button, clickCount }));
      return deliver(tabId, steps);
    },
    drag(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }) {
      const mouse = (params: object) => () => api.send(tabId, "Input.dispatchMouseEvent", params);
      const steps = [mouse({ type: "mouseMoved", ...from }), mouse({ type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 })];
      for (const f of [0.25, 0.5, 0.75, 1]) steps.push(mouse({ type: "mouseMoved", x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, button: "left", buttons: 1 }));
      steps.push(mouse({ type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 }));
      return deliver(tabId, steps);
    },
    key(tabId: number, key: string, modifiers: string[] = []) {
      const spec = keySpec(key, modifiers);
      if (!spec || modifiers.some(m => !MODIFIER_KEYS[m])) return Promise.reject(new Error(`Unsupported key ${key}`));
      const send = (params: object) => () => api.send(tabId, "Input.dispatchKeyEvent", params);
      const held = modifiers.map(m => MODIFIER_KEYS[m]!);
      const bits = held.reduce((sum, m) => sum | m.bit, 0);
      // A key with Control, Alt or Meta is a shortcut, not typing.
      const { text, ...up } = spec;
      const typed = modifiers.every(m => m === "Shift") && text !== undefined ? { text } : {};
      const steps: Array<() => Promise<unknown>> = [];
      let down = 0;
      for (const m of held) { down |= m.bit; const { bit: _bit, ...k } = m; steps.push(send({ type: "keyDown", ...k, modifiers: down })); }
      steps.push(send({ type: "keyDown", ...up, ...typed, ...(bits ? { modifiers: bits } : {}) }), send({ type: "keyUp", ...up, ...(bits ? { modifiers: bits } : {}) }));
      for (const m of [...held].reverse()) { down &= ~m.bit; const { bit: _bit, ...k } = m; steps.push(send({ type: "keyUp", ...k, ...(down ? { modifiers: down } : {}) })); }
      return deliver(tabId, steps);
    },
    async screenshot(tabId: number) {
      const { data } = await api.send<{ data: string }>(tabId, "Page.captureScreenshot", { format: "png" });
      return `data:image/png;base64,${data}`;
    },
    cancelledReason: (_tabId: number) => isCancelled() ? cancelled!.reason : undefined,
    isAttached: (tabId: number) => attached.has(tabId) && current.operationTabs.includes(tabId),
  };
}
export type TrustedInput = ReturnType<typeof trustedInput>;
export type ClickMode = "click" | "double" | "right" | "hover";

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
