import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/sidepanel/App";

let root: Root;
let host: HTMLDivElement;
const listeners = new Set<(message: any) => void>();
const status = { operation: { id: "op-panel", tabs: [7], currentTab: 7, state: "active", clientId: "local" }, browsers: [{ clientId: "local", connected: true, selected: true }], timeline: [{ atMs: 1, tool: "browser_click", summary: "<img src=x onerror=alert(1)>", outcome: "ok" }] };
let sendMessage: ReturnType<typeof vi.fn>;
let getTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listeners.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sendMessage = vi.fn(async (msg) => msg.kind === "get-conn-status" ? { state: "connected" } : { ok: true, result: status });
  getTab = vi.fn(async () => ({ id: 7, title: "작업 페이지", url: "https://example.test/work" }));
  vi.stubGlobal("chrome", { runtime: { id: "local-extension", sendMessage, openOptionsPage: vi.fn(async () => {}), onMessage: { addListener: (f: any) => listeners.add(f), removeListener: (f: any) => listeners.delete(f) } }, storage: { local: { get: vi.fn(async () => ({ clientId: "local" })) } }, tabs: { get: getTab, onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }, onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => { root.render(createElement(App)); });
function stopButton() { return [...host.querySelectorAll("button")].find((button) => button.textContent === "중단")!; }

it("renders tab details and timeline as text, and unsubscribes on close", async () => {
  await render();
  expect(host.textContent).toContain("작업 페이지");
  expect(host.textContent).toContain("https://example.test/work");
  expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(host.querySelector("img")).toBeNull();
  expect(listeners.size).toBe(1);
  await act(async () => root.unmount());
  expect(listeners.size).toBe(0);
  expect(sendMessage.mock.calls.some(([msg]) => msg.method === "operation.abort")).toBe(false);
});

it("recovers the stop button after a failed request and shows confirmed stop", async () => {
  await render();
  sendMessage.mockImplementation(async (msg) => msg.method === "operation.abort" ? { ok: false, error: { code: "TIMEOUT", message: "중단 응답을 받지 못했습니다." } } : { ok: true, result: status });
  await act(async () => stopButton().click());
  expect(host.textContent).toContain("중단 응답을 받지 못했습니다.");
  expect(stopButton().disabled).toBe(false);
  sendMessage.mockImplementation(async (msg) => ({ ok: true, result: msg.method === "operation.abort" ? { aborted: true } : { ...status, operation: null } }));
  await act(async () => stopButton().click());
  expect(host.textContent).toContain("이미 제출된 웹사이트 요청은 취소되지 않습니다.");
  expect(stopButton().disabled).toBe(true);
});

it("does not look up another browser's tab IDs in the local profile", async () => {
  sendMessage.mockImplementation(async (msg) => msg.kind === "get-conn-status" ? { state: "connected" } : { ok: true, result: { ...status, operation: { ...status.operation, clientId: "remote" } } });
  await render();
  expect(getTab).not.toHaveBeenCalled();
  expect(host.textContent).toContain("다른 브라우저의 작업 탭");
});

it("refreshes status after reconnect and shows a closed tab without failing", async () => {
  getTab.mockRejectedValue(new Error("No tab"));
  await render();
  expect(host.textContent).toContain("닫힌 탭");
  const before = sendMessage.mock.calls.length;
  await act(async () => { for (const listener of listeners) listener({ kind: "conn-status", status: { state: "disconnected" } }); });
  await act(async () => { for (const listener of listeners) listener({ kind: "conn-status", status: { state: "connected" } }); });
  expect(sendMessage.mock.calls.slice(before).some(([msg]) => msg.method === "status.get")).toBe(true);
});

it("keeps connection state when a status event arrives before initial connection reply", async () => {
  let answer!: (value: unknown) => void;
  sendMessage.mockImplementation(async (msg) => msg.kind === "get-conn-status" ? new Promise((resolve) => { answer = resolve; }) : { ok: true, result: status });
  await render();
  await act(async () => {
    for (const listener of listeners) listener({ kind: "bridge-event", event: "status.changed", data: status });
    answer({ state: "connected" });
  });
  expect(stopButton().disabled).toBe(false);
});

it("does not claim a successful stop if the operation already ended", async () => {
  await render();
  sendMessage.mockImplementation(async (msg) => ({ ok: true, result: msg.method === "operation.abort" ? { aborted: false } : { ...status, operation: null } }));
  await act(async () => stopButton().click());
  expect(host.textContent).not.toContain("중단됨:");
  expect(stopButton().disabled).toBe(true);
});
