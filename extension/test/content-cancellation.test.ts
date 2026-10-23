import { runAction } from "../src/content/actions";
import { cancelCommands } from "../src/content/cancellation";
import { resetRegistry } from "../src/content/refs";
import { takeSnapshot } from "../src/content/snapshot";

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ""; resetRegistry(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("cancels a running wait immediately and removes its observer and timers", async () => {
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  const waiting = runAction("wait", { operationId: "wait-stop", requestId: "wait-1", generation: 4, text: "missing", timeoutMs: 30000 });
  const rejected = expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
  cancelCommands({ operationId: "wait-stop", generation: 4 });
  await rejected;
  expect(disconnect).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("stops only the timed-out request and rejects its delayed replay", async () => {
  const first = runAction("wait", { operationId: "request-scope", requestId: "req-a", generation: 3, text: "missing" });
  const second = runAction("wait", { operationId: "request-scope", requestId: "req-b", generation: 3, text: "ready" });
  const rejected = expect(first).rejects.toMatchObject({ code: "CANCELLED" });
  cancelCommands({ requestId: "req-a" });
  await rejected;
  document.body.textContent = "ready";
  await expect(second).resolves.toMatchObject({ verified: { met: "text" } });
  await expect(runAction("wait", { operationId: "request-scope", requestId: "req-a", generation: 3, text: "ready" })).rejects.toMatchObject({ code: "CANCELLED" });
  expect(vi.getTimerCount()).toBe(0);
});

it("accepts a new operation after bridge restart with a lower generation", async () => {
  cancelCommands({ operationId: "old-bridge-op", generation: 8 });
  document.body.textContent = "ready";
  await expect(runAction("wait", { operationId: "new-bridge-op", generation: 1, text: "ready" })).resolves.toMatchObject({ verified: { met: "text" } });
  await expect(runAction("wait", { operationId: "old-bridge-op", generation: 8, text: "ready" })).rejects.toMatchObject({ code: "CANCELLED" });
});

it("marks cancellation during click observation as already executed", async () => {
  document.body.innerHTML = "<button>Submit</button>";
  const ref = takeSnapshot({ snapshotId: 20, frameId: 0, maxChars: 100, offset: 0, checkLayout: false }).elements[0]!.ref;
  const clicked = vi.fn();
  document.querySelector("button")!.addEventListener("click", clicked);
  const pending = runAction("click", { operationId: "click-stop", requestId: "click-1", generation: 1, ref });
  const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELLED", details: { executed: true } });
  cancelCommands({ requestId: "click-1" });
  await rejected;
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("propagates an external AbortSignal and never starts an already-aborted command", async () => {
  const controller = new AbortController();
  const waiting = runAction("wait", { operationId: "external-signal", generation: 1, text: "missing" }, controller.signal);
  const rejected = expect(waiting).rejects.toMatchObject({ code: "CANCELLED", details: { executed: false } });
  controller.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  await expect(runAction("wait", { operationId: "external-signal", generation: 1, text: "missing" }, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['click','double','right','hover','drag','key'])('never sends %s DOM fallback after cancellation during a trusted request', async mode => {
  document.body.innerHTML = '<button>Submit</button><button>Drop</button>';
  const snapshot = takeSnapshot({ snapshotId: 21, frameId: 0, maxChars: 100, offset: 0, checkLayout: false });
  const delivered: string[] = [];
  for (const button of document.querySelectorAll('button'))
    for (const type of ['pointerdown','pointermove','click','contextmenu','keydown'])
      button.addEventListener(type, () => delivered.push(type));
  let reply!: (answer: unknown) => void;
  vi.stubGlobal('chrome', { runtime: { sendMessage: () => new Promise(resolve => { reply = resolve; }) } });
  const controller = new AbortController();
  const params = { ref: snapshot.elements[0]!.ref, trusted: true,
    ...(mode === 'key' ? { key: 'Enter' } : { mode, ...(mode === 'drag' ? { toRef: snapshot.elements[1]!.ref } : {}) }) };
  const pending = runAction(mode === 'key' ? 'press' : 'click', params, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED', details: { executed: false } });
  controller.abort();
  reply({ ok: false, reason: 'not-allowed', dispatched: false });
  await rejected;
  await vi.advanceTimersByTimeAsync(0); // Flush the focus task queued by jsdom for key preparation.
  expect(delivered).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops all requests in an operation without cancelling another operation", async () => {
  const first = runAction("wait", { operationId: "whole-op", requestId: "whole-a", generation: 9, text: "missing" });
  const second = runAction("wait", { operationId: "whole-op", requestId: "whole-b", generation: 9, text: "missing" });
  const other = runAction("wait", { operationId: "unrelated-op", requestId: "other-a", generation: 9, text: "ready" });
  const rejected = [expect(first).rejects.toMatchObject({ code: "CANCELLED" }), expect(second).rejects.toMatchObject({ code: "CANCELLED" })];
  cancelCommands({ operationId: "whole-op", generation: 9 });
  await Promise.all(rejected);
  document.body.textContent = "ready";
  await expect(other).resolves.toMatchObject({ verified: { met: "text" } });
  expect(vi.getTimerCount()).toBe(0);
});

it('R06 does not mistake eviction during refGone wait for DOM removal', async () => {
  document.body.innerHTML = '<button>Still attached</button>';
  const snapshot = (id: number) => takeSnapshot({snapshotId: id, frameId: 0, maxChars: 100, offset: 0, checkLayout: false});
  const ref = snapshot(100).elements[0]!.ref;
  const waiting = runAction('wait', {refGone: ref, timeoutMs: 2000, generation: 20});
  let resolved = false; void waiting.then(() => { resolved = true; });
  for(let id=101; id<=106; id++) snapshot(id);
  await vi.advanceTimersByTimeAsync(250); expect(resolved).toBe(false);
  document.querySelector('button')!.remove();
  await vi.advanceTimersByTimeAsync(250);
  await expect(waiting).resolves.toMatchObject({verified: {met: 'refGone'}});
  expect(vi.getTimerCount()).toBe(0);
});
it('R06 rejects a ref already expired when the wait starts', async () => {
  document.body.innerHTML = '<button>Still attached</button>';
  const snapshot = (id: number) => takeSnapshot({snapshotId: id, frameId: 0, maxChars: 100, offset: 0, checkLayout: false});
  const ref = snapshot(200).elements[0]!.ref;
  for(let id=201; id<=206; id++) snapshot(id);
  await expect(runAction('wait', {refGone: ref, generation: 20})).rejects.toMatchObject({code: 'STALE_ELEMENT'});
  expect(vi.getTimerCount()).toBe(0);
});
it('R06 recognizes a detached node retained by an unexpired ref', async () => {
  document.body.innerHTML = '<button>Remove</button>';
  const ref = takeSnapshot({snapshotId: 300, frameId: 0, maxChars: 100, offset: 0, checkLayout: false}).elements[0]!.ref;
  document.querySelector('button')!.remove();
  await expect(runAction('wait', {refGone: ref, generation: 20})).resolves.toMatchObject({verified: {met: 'refGone'}});
});
