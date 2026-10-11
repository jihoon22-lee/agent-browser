import { initialPanelState, reduceStatus } from "../src/sidepanel/status-store";

const status = { operation: { id: "op-1", tabs: [1], currentTab: 1, state: "active" as const }, browsers: [{ clientId: "c", connected: true, selected: true }], timeline: [{ atMs: 1, operationId: "op-1", tool: "browser_click", summary: "s1f0e1", outcome: "ok" }] };

it("status.changed replaces operation, browsers and timeline", () => {
  const s = reduceStatus(initialPanelState, { kind: "bridge-event", event: "status.changed", data: status });
  expect(s.operation?.id).toBe("op-1");
  expect(s.browsers[0]?.selected).toBe(true);
  expect(s.timeline).toHaveLength(1);
});

it("stopping clears when the operation disappears", () => {
  let s = reduceStatus(initialPanelState, { kind: "stop-requested" });
  expect(s.stopping).toBe(true);
  s = reduceStatus(s, { kind: "bridge-event", event: "status.changed", data: { operation: null, browsers: [], timeline: [] } });
  expect(s.stopping).toBe(false);
});

it("failed stop resets stopping and retains the active operation", () => {
  let s = reduceStatus(initialPanelState, { kind: "bridge-event", event: "status.changed", data: status });
  s = reduceStatus(s, { kind: "stop-requested" });
  s = reduceStatus(s, { kind: "request-failed", message: "연결이 끊겼습니다." });
  expect(s.stopping).toBe(false);
  expect(s.error).toBe("연결이 끊겼습니다.");
  expect(s.operation?.id).toBe("op-1");
});

it("disconnect resets pending controls and clears stale live operation", () => {
  let s = reduceStatus(initialPanelState, { kind: "bridge-event", event: "status.changed", data: status });
  s = reduceStatus(s, { kind: "stop-requested" });
  s = reduceStatus(s, { kind: "conn-status", status: { state: "disconnected", retryInMs: 1000 } });
  expect(s.stopping).toBe(false);
  expect(s.operation).toBeNull();
  expect(s.conn.retryInMs).toBe(1000);
});

it("successful stop clears only the stopped operation and records the notice", () => {
  let s = reduceStatus(initialPanelState, { kind: "bridge-event", event: "status.changed", data: status });
  s = reduceStatus(s, { kind: "stop-completed", operationId: "op-1" });
  expect(s.operation).toBeNull();
  expect(s.stopped).toBe(true);
  s = reduceStatus(s, { kind: "bridge-event", event: "status.changed", data: { ...status, operation: { ...status.operation, id: "op-2" } } });
  s = reduceStatus(s, { kind: "stop-completed", operationId: "op-1" });
  expect(s.operation?.id).toBe("op-2");
  expect(s.stopped).toBe(false);
});

it("retains only the latest 20 timeline entries", () => {
  const timeline = Array.from({ length: 30 }, (_, atMs) => ({ ...status.timeline[0]!, atMs }));
  const s = reduceStatus(initialPanelState, { kind: "bridge-event", event: "status.changed", data: { ...status, timeline } });
  expect(s.timeline).toHaveLength(20);
  expect(s.timeline[0]?.atMs).toBe(10);
});

it("ignores unknown or malformed status messages", () => {
  expect(reduceStatus(initialPanelState, { kind: "something" })).toBe(initialPanelState);
  expect(reduceStatus(initialPanelState, { kind: "bridge-event", event: "status.changed", data: {} })).toBe(initialPanelState);
});
