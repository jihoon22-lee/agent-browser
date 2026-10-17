import { markerScript, syncMarkers } from "../src/background/work-marker";

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
