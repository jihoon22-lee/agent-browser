import { markerScript, shouldRemark, syncMarkers } from "../src/background/work-marker";

beforeEach(() => { document.querySelectorAll("#agent-browser-work-marker").forEach(e => e.remove()); });

it("adds one invisible-to-snapshot marker and removes it", () => {
  markerScript(true, "AgentBrowser 작업 중");
  markerScript(true, "AgentBrowser · 사용자가 조작 중");
  const hosts = document.querySelectorAll("#agent-browser-work-marker");
  expect(hosts).toHaveLength(1);
  expect(hosts[0]!.shadowRoot).toBeNull();
  expect((hosts[0] as HTMLElement).style.pointerEvents).toBe("none");
  expect(hosts[0]!.getAttribute("aria-hidden")).toBe("true");
  expect(document.body.textContent ?? "").not.toContain("작업 중");
  markerScript(false, "");
  expect(document.querySelector("#agent-browser-work-marker")).toBeNull();
});

it("marks new operation tabs and clears tabs that left", async () => {
  const calls: Array<[number, boolean]> = [];
  const api = { executeScript: async (tabId: number, _f: unknown, args: [boolean, string]) => { calls.push([tabId, args[0]]); } };
  let marked = await syncMarkers(api, new Set(), { tabs: [1, 2], paused: false });
  marked = await syncMarkers(api, marked, { tabs: [2], paused: false });
  await syncMarkers(api, marked, null);
  expect(calls).toEqual([[1, true], [2, true], [2, true], [1, false], [2, false]]);
});

it("replaces markers left by an earlier extension instance instead of adding another", () => {
  const stray = document.createElement("div"); stray.id = "agent-browser-work-marker"; document.documentElement.append(stray);
  markerScript(true, "AgentBrowser 작업 중");
  expect(document.querySelectorAll("#agent-browser-work-marker")).toHaveLength(1);
  markerScript(false, "");
  expect(document.querySelectorAll("#agent-browser-work-marker")).toHaveLength(0);
});

it("remembers marked tabs across worker restarts and sweeps all web tabs after a reload", async () => {
  const { markedBefore } = await import("../src/background/work-marker");
  const store: Record<string, unknown> = {};
  const session = { get: async (key: string) => ({ [key]: store[key] }), set: async (value: Record<string, unknown>) => { Object.assign(store, value); } };
  const query = async () => [7, 8];
  expect([...await markedBefore(session, query, new Set([1]))]).toEqual([1]);
  expect([...await markedBefore(session, query, null)]).toEqual([7, 8]);
  store.markedTabs = [3];
  expect([...await markedBefore(session, query, null)]).toEqual([3]);
});

it("re-marks a marked tab when its top document changes", () => {
  expect(shouldRemark(5, 0, new Set([5]))).toBe(true);
  expect(shouldRemark(5, 3, new Set([5]))).toBe(false);
  expect(shouldRemark(6, 0, new Set([5]))).toBe(false);
  expect(shouldRemark(5, 0, null)).toBe(false);
});

it("marks with important styles so page CSS cannot make it clickable", () => {
  markerScript(true, "x");
  const host = document.getElementById("agent-browser-work-marker") as HTMLElement;
  expect(host.style.getPropertyPriority("pointer-events")).toBe("important");
  expect(host.style.getPropertyPriority("position")).toBe("important");
});

it("re-marks after a navigation only in the marker queue, after pending refreshes", async () => {
  const { remarkInQueue } = await import("../src/background/work-marker");
  let marked: Set<number> | null = new Set([5]);
  let release!: () => void;
  const refresh = new Promise<void>(resolve => { release = () => { marked = new Set(); resolve(); }; });
  const applied: number[] = [];
  const queue = remarkInQueue(refresh, 5, 0, () => marked, async tabId => { applied.push(tabId); });
  release(); await queue;
  expect(applied).toEqual([]);
});
