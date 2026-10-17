import { trustedInput, type DebuggerApi } from "../src/background/trusted-input";

function fakeDebugger() {
  const calls: Array<[string, number, string?, unknown?]> = [];
  let detachListener: ((tabId: number, reason: string) => void) | undefined, eventListener: ((tabId: number, method: string, params: any) => void) | undefined;
  const api: DebuggerApi = {
    attach: async tabId => { calls.push(["attach", tabId]); },
    detach: async tabId => { calls.push(["detach", tabId]); },
    send: async (tabId, method, params) => { calls.push(["send", tabId, method, params]); return (method === "Page.captureScreenshot" ? { data: "AAAA" } : {}) as any; },
    onDetach: listener => { detachListener = listener; return () => {}; },
    onEvent: listener => { eventListener = listener; return () => {}; },
  };
  return { api, calls, detach: (tab: number, reason: string) => detachListener!(tab, reason), event: (tab: number, method: string, params: any) => eventListener!(tab, method, params) };
}
const on = (tabs: number[], operationId = "op-1") => ({ enabled: true, operationTabs: tabs, operationId });

it("never_attaches_when_off", async () => {
  const d = fakeDebugger(), t = trustedInput(d.api);
  expect(await t.ensure(1, { enabled: false, operationTabs: [1] })).toBe(false);
  expect(d.calls).toEqual([]);
});

it("attaches once to an operation tab and enables page events", async () => {
  const d = fakeDebugger(), t = trustedInput(d.api);
  expect(await t.ensure(1, on([1]))).toBe(true);
  expect(await t.ensure(1, on([1]))).toBe(true);
  expect(d.calls.filter(c => c[0] === "attach")).toHaveLength(1);
  expect(d.calls.filter(c => c[2] === "Page.enable")).toHaveLength(1);
});

it("refuses a tab outside this browser's operation", async () => {
  const d = fakeDebugger(), t = trustedInput(d.api);
  expect(await t.ensure(2, on([1]))).toBe(false);
  expect(d.calls).toEqual([]);
});

it("detaches_when_the_operation_ends_or_the_tab_leaves", async () => {
  const d = fakeDebugger(), t = trustedInput(d.api);
  await t.ensure(1, on([1, 2])); await t.ensure(2, on([1, 2]));
  await t.sync(on([2]));
  expect(d.calls.filter(c => c[0] === "detach").map(c => c[1])).toEqual([1]);
  await t.sync({ enabled: true, operationTabs: [], operationId: null });
  expect(d.calls.filter(c => c[0] === "detach").map(c => c[1])).toEqual([1, 2]);
});

it("detaches everything when turned off", async () => {
  const d = fakeDebugger(), t = trustedInput(d.api);
  await t.ensure(1, on([1]));
  await t.sync({ enabled: false, operationTabs: [1], operationId: "op-1" });
  expect(d.calls.filter(c => c[0] === "detach").map(c => c[1])).toEqual([1]);
});

it("user_cancel_falls_back_for_the_rest_of_the_operation", async () => {
  const d = fakeDebugger(), t = trustedInput(d.api);
  await t.ensure(1, on([1]));
  d.detach(1, "canceled_by_user");
  expect(await t.ensure(1, on([1]))).toBe(false);
  expect(t.cancelledReason(1)).toBe("canceled_by_user");
  await t.sync(on([1], "op-2"));
  expect(await t.ensure(1, on([1], "op-2"))).toBe(true);
});

it("reattaches after a non-user detach", async () => {
  const d = fakeDebugger(), t = trustedInput(d.api);
  await t.ensure(1, on([1]));
  d.detach(1, "target_closed");
  expect(await t.ensure(1, on([1]))).toBe(true);
  expect(d.calls.filter(c => c[0] === "attach")).toHaveLength(2);
});

it("accepts an alert, dismisses a confirm and reports each once", async () => {
  const d = fakeDebugger(), t = trustedInput(d.api);
  await t.ensure(1, on([1]));
  await t.click(1, 1, 1); // dialogs are answered during and shortly after an agent input
  d.event(1, "Page.javascriptDialogOpening", { type: "confirm", message: "삭제할까요?" });
  await new Promise(r => setTimeout(r, 0));
  expect(d.calls.find(c => c[2] === "Page.handleJavaScriptDialog")?.[3]).toEqual({ accept: false });
  expect((await t.click(1, 10, 10)).dialog).toEqual({ type: "confirm", message: "삭제할까요?" });
  expect((await t.click(1, 10, 10)).dialog).toBeUndefined();
  d.event(1, "Page.javascriptDialogOpening", { type: "alert", message: "저장됨" });
  await new Promise(r => setTimeout(r, 0));
  expect(d.calls.filter(c => c[2] === "Page.handleJavaScriptDialog").at(-1)?.[3]).toEqual({ accept: true });
});

it("sends a full mouse click and key strokes", async () => {
  const d = fakeDebugger(), t = trustedInput(d.api);
  await t.ensure(1, on([1]));
  await t.click(1, 10, 20);
  expect(d.calls.filter(c => c[2] === "Input.dispatchMouseEvent").map(c => (c[3] as any).type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  await t.key(1, "Enter");
  const keys = d.calls.filter(c => c[2] === "Input.dispatchKeyEvent").map(c => c[3] as any);
  expect(keys.map(k => k.type)).toEqual(["keyDown", "keyUp"]);
  expect(keys[0]).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  expect(await t.screenshot(1)).toBe("data:image/png;base64,AAAA");
});

describe("review fixes", () => {
  it("detaches when enabling page events fails", async () => {
    const d = fakeDebugger(), t = trustedInput(d.api);
    d.api.send = async (_tab, method) => { if (method === "Page.enable") throw new Error("boom"); return {} as any; };
    expect(await t.ensure(1, on([1]))).toBe(false);
    expect(d.calls.filter(c => c[0] === "detach").map(c => c[1])).toEqual([1]);
    expect(t.isAttached(1)).toBe(false);
  });
  it("attaches once for concurrent requests on one tab", async () => {
    const d = fakeDebugger(), t = trustedInput(d.api);
    const [a, b] = await Promise.all([t.ensure(1, on([1])), t.ensure(1, on([1]))]);
    expect([a, b]).toEqual([true, true]);
    expect(d.calls.filter(c => c[0] === "attach")).toHaveLength(1);
    expect(t.isAttached(1)).toBe(true);
  });
  it("detaches a tab whose operation ended while it was attaching", async () => {
    const d = fakeDebugger(); let release!: () => void;
    const attach = d.api.attach; d.api.attach = async tab => { await new Promise<void>(r => { release = r; }); return attach(tab); };
    const t = trustedInput(d.api);
    const pending = t.ensure(1, on([1]));
    await new Promise(r => setTimeout(r, 0));
    const ended = t.sync({ enabled: true, operationTabs: [], operationId: null });
    release(); await pending; await ended;
    expect(t.isAttached(1)).toBe(false);
    expect(d.calls.filter(c => c[0] === "detach").map(c => c[1])).toEqual([1]);
  });
  it("marks a partly delivered input so it is never repeated", async () => {
    const d = fakeDebugger(), t = trustedInput(d.api);
    await t.ensure(1, on([1]));
    let sent = 0; d.api.send = async (_tab, method) => { if (method === "Input.dispatchMouseEvent" && ++sent === 2) return {} as any; if (method === "Input.dispatchMouseEvent" && sent === 3) throw new Error("detached"); return {} as any; };
    await expect(t.click(1, 1, 1)).rejects.toMatchObject({ dispatched: true });
  });
  it("a user cancel keeps every tab of the operation on DOM input", async () => {
    const d = fakeDebugger(), t = trustedInput(d.api);
    await t.ensure(1, on([1, 2]));
    d.detach(1, "canceled_by_user");
    expect(await t.ensure(2, on([1, 2]))).toBe(false);
    expect(t.cancelledReason(2)).toBe("canceled_by_user");
  });
  it("leaves a dialog that opens outside an agent input to the person", async () => {
    const d = fakeDebugger(), t = trustedInput(d.api);
    await t.ensure(1, on([1]));
    d.event(1, "Page.javascriptDialogOpening", { type: "confirm", message: "사람의 확인창" });
    await new Promise(r => setTimeout(r, 0));
    expect(d.calls.some(c => c[2] === "Page.handleJavaScriptDialog")).toBe(false);
  });
});

it("hands a held operation's tabs back to the person", async () => {
  const { trustedTargets } = await import("../src/background/trusted-input");
  expect(trustedTargets({ id: "op", clientId: "me", tabs: [1] }, "me", true)).toEqual({ enabled: true, operationTabs: [1], operationId: "op" });
  expect(trustedTargets({ id: "op", clientId: "me", tabs: [1], paused: true }, "me", true).operationTabs).toEqual([]);
  expect(trustedTargets({ id: "op", clientId: "other", tabs: [1] }, "me", true).operationTabs).toEqual([]);
});

describe("pointer modes over the debugger", () => {
  it("double, right and hover send their own mouse events", async () => {
    const d = fakeDebugger(), t = trustedInput(d.api);
    await t.ensure(1, on([1]));
    await t.click(1, 1, 1, "double");
    const mouse = () => d.calls.filter(c => c[2] === "Input.dispatchMouseEvent").map(c => c[3] as any);
    expect(mouse().filter(m => m.type === "mousePressed").map(m => m.clickCount)).toEqual([1, 2]);
    d.calls.length = 0;
    await t.click(1, 1, 1, "right");
    expect(mouse().filter(m => m.type === "mousePressed").map(m => m.button)).toEqual(["right"]);
    d.calls.length = 0;
    await t.click(1, 1, 1, "hover");
    expect(mouse().map(m => m.type)).toEqual(["mouseMoved"]);
  });
  it("a double click cut short after the first press is partly delivered", async () => {
    const d = fakeDebugger(), t = trustedInput(d.api);
    await t.ensure(1, on([1]));
    let presses = 0; d.api.send = async (_tab, method, params: any) => { if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed" && ++presses === 2) throw new Error("detached"); return {} as any; };
    await expect(t.click(1, 1, 1, "double")).rejects.toMatchObject({ dispatched: true });
  });
});
