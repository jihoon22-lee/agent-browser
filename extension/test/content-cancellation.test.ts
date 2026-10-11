import { runAction } from "../src/content/actions";
import { cancelCommands } from "../src/content/cancellation";
import { resetRegistry } from "../src/content/refs";
import { takeSnapshot } from "../src/content/snapshot";

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ""; resetRegistry(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
