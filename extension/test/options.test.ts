import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/options/App";
let root: Root, host: HTMLDivElement;
let send: ReturnType<typeof vi.fn>, save: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  send = vi.fn(async message => message.kind === "get-conn-status" ? { state: "connected" } : message.method === "profile.list" ? { ok: true, result: { profiles: [{ id: "native", name: "기존 환경", kind: "windows", directory: "C:\\work", executable: "C:\\opencode.exe", hasPassword: true, envKeys: ["PRIVATE_KEY"] }], defaultProfileId: "native" } } : { ok: true, result: {} });
  save = vi.fn(async () => {});
  vi.stubGlobal("chrome", { runtime: { sendMessage: send, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } }, storage: { local: { get: vi.fn(async () => ({})), set: save } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...host.querySelectorAll("button")].find(element => element.textContent === label)!;
async function render() { await act(async () => root.render(createElement(App))); }
it("edits a profile without exposing or replacing saved secrets", async () => {
  await render(); await act(async () => button("편집").click()); await act(async () => button("프로필 저장").click());
  const call = send.mock.calls.find(([message]) => message.method === "profile.save")![0];
  expect(call.params.profile.id).toBe("native"); expect(call.params.profile).not.toHaveProperty("password"); expect(call.params.profile).not.toHaveProperty("env");
  expect(host.textContent).not.toContain("PRIVATE_KEY");
});
it("reports pairing storage failure without claiming it was saved", async () => {
  save.mockRejectedValue(new Error("저장소 오류")); await render(); await act(async () => button("저장 후 연결").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("저장소 오류");
  expect(host.textContent).not.toContain("저장했습니다. 연결 상태를 확인하세요.");
  expect(send.mock.calls.some(([message]) => message.kind === "reconnect")).toBe(false);
});
