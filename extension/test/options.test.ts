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
async function fill(label: string, value: string) {
  const input = [...host.querySelectorAll("label")].find(element => element.firstChild?.textContent === label)!.querySelector<HTMLInputElement>("input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
it("folds pairing away once connected and puts the cursor in the code field when unpaired", async () => {
  await render();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Bridge에 연결되었습니다");
  expect(host.querySelector<HTMLDetailsElement>("details.pairing-change")?.open).toBe(false);
  await act(async () => root.unmount()); root = createRoot(host);
  send.mockImplementation(async message => message.kind === "get-conn-status" ? { state: "unpaired" } : { ok: false, error: { code: "BROWSER_DISCONNECTED", message: "Bridge is not connected" } });
  await render(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.querySelector("details.pairing-change")).toBeNull();
  expect(document.activeElement).toBe([...host.querySelectorAll("label")].find(element => element.firstChild?.textContent === "페어링 코드")!.querySelector("input"));
});
it("keeps pairing folded until the status arrives and points a stopped Bridge to its start command", async () => {
  let answer!: (value: unknown) => void;
  send.mockImplementation(async message => message.kind === "get-conn-status" ? new Promise(resolve => { answer = resolve; }) : message.kind === "reconnect" ? { ok: true } : { ok: false, error: { code: "BROWSER_DISCONNECTED", message: "Bridge is not connected" } });
  await render();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("연결하는 중");
  expect(host.querySelector<HTMLDetailsElement>("details.pairing-change")?.open).toBe(false);
  // A paired browser whose Bridge is stopped needs the Bridge started, not a new pairing code.
  await act(async () => answer({ state: "disconnected", retryInMs: 4000 }));
  expect(host.querySelector<HTMLDetailsElement>("details.pairing-change")?.open).toBe(false);
  expect(host.textContent).toContain("start-bridge.cmd");
  await act(async () => button("다시 연결").click());
  expect(send.mock.calls.some(([message]) => message.kind === "reconnect")).toBe(true);
});

it("creates a profile ID when the field is left empty", async () => {
  await render();
  await fill("이름", "새 환경"); await fill("OpenCode 실행 파일의 절대 경로", "C:\\Tools\\opencode.exe"); await fill("작업 디렉터리", "C:\\Work");
  await act(async () => button("프로필 저장").click());
  const call = send.mock.calls.find(([message]) => message.method === "profile.save")![0];
  expect(call.params.profile.id).toMatch(/^windows-[a-f0-9]{8}$/);
  expect(send.mock.calls.find(([message]) => message.kind === "profiles-changed")![0].profileId).toBe(call.params.profile.id);
});
it("shows diagnostics as a checklist with the raw result folded", async () => {
  send.mockImplementation(async message => message.kind === "get-conn-status" ? { state: "connected" } : message.method === "doctor.run" ? { ok: true, result: { ok: true, checks: [{ id: "bridge", status: "ok", message: "Authenticated Bridge" }] } } : message.method === "profile.list" ? { ok: true, result: { profiles: [], defaultProfileId: null } } : { ok: true, result: {} });
  await render(); await act(async () => button("진단 실행").click());
  expect(host.querySelector(".doctor-checks")?.textContent).toContain("인증된 Bridge가 실행 중입니다");
  expect(host.querySelector<HTMLDetailsElement>("details.doctor-raw")?.open).toBe(false);
});
