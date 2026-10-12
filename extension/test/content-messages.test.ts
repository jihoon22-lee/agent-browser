let listener: (msg: any, sender: any, response: (value: any) => void) => boolean | undefined;
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = "<p>ready</p>";
  delete window.__agentBrowserContent;
  vi.stubGlobal("chrome", { runtime: { id: "test-extension", onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } } });
  await import("../src/content/index");
});
afterEach(() => { vi.unstubAllGlobals(); });

function command(msg: unknown): Promise<any> {
  return new Promise((resolve) => { listener(msg, { id: "test-extension" }, resolve); });
}

it("handles operation cancellation and rejects subsequent snapshots for that operation", async () => {
  const waiting = command({ kind: "cmd", method: "wait", params: { operationId: "stop", generation: 5, text: "missing" } });
  listener({ kind: "cancel", operationId: "stop", generation: 5 }, { id: "test-extension" }, () => {});
  expect(await waiting).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  expect(await command({ kind: "cmd", method: "snapshot", params: { operationId: "stop", generation: 5, snapshotId: 1, frameId: 0, maxChars: 100, offset: 0 } })).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  expect(await command({ kind: "cmd", method: "wait", params: { operationId: "new", generation: 1, text: "ready" } })).toMatchObject({ ok: true });
});

it("ignores cancellation from a different extension", async () => {
  listener({ kind: "cancel", operationId: "allowed", generation: 5 }, { id: "other-extension" }, () => {});
  expect(await command({ kind: "cmd", method: "wait", params: { operationId: "allowed", generation: 1, text: "ready" } })).toMatchObject({ ok: true });
});

it('pagehide invalidates references even if BFCache preserves the connected nodes', async () => {
  const {newTable,resolveRef}=await import('../src/content/refs');
  const button=document.createElement('button');button.textContent='Read';document.body.append(button);
  const ref=newTable(99,0).add(button);expect(resolveRef(ref)).toBe(button);
  window.dispatchEvent(new Event('pagehide'));
  expect(button.isConnected).toBe(true);
  expect(()=>resolveRef(ref)).toThrowError(expect.objectContaining({code:'STALE_ELEMENT'}));
});
