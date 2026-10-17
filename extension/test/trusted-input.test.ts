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
