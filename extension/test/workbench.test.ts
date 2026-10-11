import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/sidepanel/App";
const test = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), request: vi.fn(), stream: undefined as any, online: undefined as any, calls: [] as string[] }));
vi.mock("../src/agents/opencode-v1/client", () => ({ OpenCodeV1Client: class {
  directory: string; constructor(value: any) { this.directory = value.directory; }
  get = (path: string, query?: any) => test.get(path, query);
  findFiles = (query: string, limit = 12) => test.get("/find/file", { query, limit });
  post = (path: string, body?: any) => { test.calls.push(path); return test.post(path, body); };
  patch = (path: string, body?: any) => test.post(path, body);
  delete = (path: string) => test.post(path);
  request = (method: string, path: string, options?: any) => test.request(method, path, options);
  events(event: any, online: any, signal: AbortSignal) { test.stream = event; test.online = online; online(true); return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); }
} }));
let host: HTMLDivElement, root: Root;
let questions: any[], messages: any[], sessions: any[];
const listeners = new Set<(message: any) => void>();
const info = { id: "msg-one", sessionID: "ses-one", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "internal", modelID: "company" } };
const model = { id: "company", providerID: "internal", name: "사내 모델", status: "active", limit: { context: 10000 }, variants: { careful: {} } };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); test.calls = []; listeners.clear();
  sessions = [{ id: "ses-one", title: "기존 대화", directory: "/fixture", time: { updated: 1 }, agent: "build" }];
  messages = [{ info, parts: [{ id: "prt-one", type: "text", text: "기존 질문" }] }]; questions = [];
  test.get.mockReset().mockImplementation(async (path: string) => {
    if (path === "/provider") return { all: [{ id: "internal", name: "업무", models: { company: model } }], connected: ["internal"], default: { internal: "company" } };
    if (path === "/agent") return [{ name: "build", mode: "primary" }];
    if (path === "/session") return sessions;
    if (path === "/session/status") return { "ses-one": { type: "idle" } };
    if (path === "/question") return questions;
    if (path.endsWith("/message")) return messages;
    if (path === "/mcp") return { browser: { status: "connected" } };
    return [];
  });
  test.post.mockReset().mockResolvedValue(true); test.request.mockReset().mockResolvedValue(true);
  const storage: Record<string, any> = { clientId: "local", lastProfileId: "native", "recentSession:native": "ses-one" };
  vi.stubGlobal("chrome", { runtime: { id: "extension", openOptionsPage: vi.fn(), onMessage: { addListener: (f: any) => listeners.add(f), removeListener: (f: any) => listeners.delete(f) }, sendMessage: vi.fn(async message => {
    if (message.kind === "get-conn-status") return { state: "connected" };
    if (message.method === "profile.list") return { ok: true, result: { profiles: [{ id: "native", name: "업무 Windows", kind: "windows", directory: "/fixture" }], defaultProfileId: "native" } };
    if (message.method === "runtime.ensure") return { ok: true, result: { profileId: "native", state: "ready", baseUrl: "http://127.0.0.1:7777", directory: "/fixture", version: "1.18.29", owned: true } };
    if (message.method === "operation.abort") { test.calls.push("bridge-gate"); return { ok: true, result: { aborted: true } }; }
    return { ok: true, result: { operation: { id: "op-known", clientId: "local", tabs: [1], currentTab: 1, state: "active" }, browsers: [], timeline: [] } };
  }) }, storage: { local: { get: vi.fn(async () => storage), set: vi.fn(async value => Object.assign(storage, value)) } }, tabs: { get: vi.fn(async () => ({ id: 1, title: "고정 탭", url: "https://example.test" })), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }, onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => { root.render(createElement(App)); await new Promise(resolve => setTimeout(resolve, 0)); }); }
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === text)!;

it("restores the selected profile/session and isolates streaming messages by session", async () => {
  await render(); expect(host.textContent).toContain("기존 질문"); expect(host.textContent).toContain("사내 모델");
  await act(async () => test.stream({ id: "evt-other", type: "message.part.updated", properties: { sessionID: "ses-other", part: { id: "prt-other", messageID: "msg-other", sessionID: "ses-other", type: "text", text: "다른 세션 비밀" } } }));
  expect(host.textContent).not.toContain("다른 세션 비밀");
});
it("closes the Bridge gate before aborting the proven owning OpenCode session", async () => {
  messages.push({ info: { ...info, id: "msg-tool", role: "assistant", time: { created: 2 } }, parts: [{ id: "prt-tool", type: "tool", tool: "browser_browser_tabs", state: { status: "completed", input: { action: "attach" }, output: JSON.stringify({ ok: true, tool: "browser_tabs", operationId: "op-known" }) } }] });
  await render(); await act(async () => button("중단").click());
  expect(test.calls).toEqual(["bridge-gate", "/session/ses-one/abort"]);
});
it("does not abort an arbitrary selected session for an unknown CLI operation", async () => {
  await render(); await act(async () => button("중단").click());
  expect(test.calls).toEqual(["bridge-gate"]);
});
it("does not reply to a question already answered in another client", async () => {
  questions = [{ id: "que-one", sessionID: "ses-one", questions: [{ header: "선택", question: "골라주세요", options: [{ label: "A", description: "첫째" }], custom: false }] }];
  await render(); await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  questions = []; await act(async () => button("답변 제출").click());
  expect(test.post).not.toHaveBeenCalled(); expect(host.textContent).toContain("다른 곳에서 이미 처리");
});
it("seeds a fork with the excluded user message so it can be edited and resumed", async () => {
  await render();
  test.post.mockImplementation(async (path: string) => path.endsWith("/fork") ? { ...sessions[0], id: "ses-fork", title: "분기" } : true);
  await act(async () => button("여기서 분기").click());
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="메시지"]')!.value).toBe("기존 질문");
});

it("renders a part that arrives before its message envelope without crashing", async () => {
  await render();
  await act(async () => test.stream({ id: "evt-early-part", type: "message.part.updated", properties: { sessionID: "ses-one", part: { id: "prt-early", messageID: "msg-early", sessionID: "ses-one", type: "text", text: "먼저 온 조각" } } }));
  expect(host.textContent).toContain("먼저 온 조각");
});
it("clears stale models when switching environments whose model query fails", async () => {
  await render();
  const original = test.get.getMockImplementation()!;
  test.get.mockImplementation(async (path: string, query: any) => { if (path === "/provider") throw new Error("새 환경 모델 조회 실패"); return original(path, query); });
  await act(async () => button("디렉터리 적용").click());
  expect([...host.querySelectorAll("option")].some(option => option.textContent?.includes("사내 모델"))).toBe(false);
});

it("keeps a newer full part update that arrives while the HTTP snapshot is loading", async () => {
  let resolveMessages!: (value: any[]) => void;
  const original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path.endsWith("/message") ? new Promise(resolve => { resolveMessages = resolve; }) : original(path, query));
  await render();
  await act(async () => {
    test.stream({ id: "evt-newest", type: "message.part.updated", properties: { sessionID: "ses-one", part: { id: "prt-one", messageID: "msg-one", sessionID: "ses-one", type: "text", text: "최신 내용" } } });
    resolveMessages(messages);
  });
  expect(host.textContent).toContain("최신 내용"); expect(host.textContent).not.toContain("기존 질문");
});

it("keeps unsent drafts scoped to each runtime profile", async () => {
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(async message => message.method === "profile.list" ? { ok: true, result: { profiles: [{ id: "native", name: "첫 환경" }, { id: "second", name: "둘째 환경" }], defaultProfileId: "native" } } : original(message));
  await render();
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="메시지"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "첫 환경의 초안"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  const select = [...host.querySelectorAll("label")].find(label => label.textContent?.startsWith("실행 환경"))!.querySelector("select")!;
  await act(async () => { select.value = "second"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(textarea.value).toBe("");
  await act(async () => { select.value = "native"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(textarea.value).toBe("첫 환경의 초안");
});

it("refreshes profiles saved in the already-open Options page without reopening the panel", async () => {
  await render();
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(async message => message.method === "profile.list" ? { ok: true, result: { profiles: [{ id: "native", name: "업무 Windows" }, { id: "added", name: "추가된 WSL" }], defaultProfileId: "native" } } : original(message));
  await act(async () => { for (const listener of listeners) listener({ kind: "profiles-changed", profileId: "added" }); });
  expect(host.textContent).toContain("추가된 WSL");
});

it("restores the last user model from a saved session instead of silently taking the provider default", async () => {
  messages = [{ info: { ...info, model: { providerID: "internal", modelID: "previous" } }, parts: [{ id: "prt-one", type: "text", text: "이전 모델 대화" }] }];
  const original = test.get.getMockImplementation()!;
  test.get.mockImplementation(async (path: string, query: any) => path === "/provider" ? { all: [{ id: "internal", models: { company: model, previous: { ...model, id: "previous", name: "이전 모델" } } }], connected: ["internal"], default: { internal: "company" } } : original(path, query));
  await render();
  const select = [...host.querySelectorAll("label")].find(label => label.firstChild?.textContent === "모델")!.querySelector("select")!;
  expect(select.value).toBe("internal/previous");
});

it("requires explicit model selection when the saved model is no longer available", async () => {
  messages = [{ info: { ...info, model: { providerID: "retired-private", modelID: "old" } }, parts: [{ id: "prt-one", type: "text", text: "이전 환경 대화" }] }];
  await render();
  const select = [...host.querySelectorAll("label")].find(label => label.firstChild?.textContent === "모델")!.querySelector("select")!;
  expect(select.value).toBe("");
});

const composerValue = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="메시지"]')!;
async function draftValue(value: string) { await act(async () => { const el = composerValue(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function selectOtherSession() { await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(el => el.querySelector("strong")?.textContent === "둘째 대화")!.click()); }
function secondSession() { sessions.push({ ...sessions[0], id: "ses-two", title: "둘째 대화" }); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

it.each([false, true])("preserves the other session draft when a pending send settles (failure=%s)", async failure => {
  secondSession(); await render(); const pending = deferred<any>(); test.post.mockReturnValue(pending.promise);
  await draftValue("첫 대화 초안"); await act(async () => button("보내기").click());
  await selectOtherSession(); await draftValue("둘째 대화 초안");
  await act(async () => { if (failure) pending.reject(new Error("첫 대화 전송 실패")); else pending.resolve(true); });
  expect(composerValue().value).toBe("둘째 대화 초안");
  expect(host.textContent).not.toContain("첫 대화 전송 실패");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(el => el.querySelector("strong")?.textContent === "기존 대화")!.click());
  expect(composerValue().value).toBe("첫 대화 초안");
});
it("does not attach a browser reference to a different session after its delayed read", async () => {
  secondSession(); await render(); const pending = deferred<any>();
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(message => message.kind === "browser-context" ? pending.promise : original(message));
  await act(async () => button("현재 탭").click()); await selectOtherSession(); await draftValue("둘째 대화 초안");
  await act(async () => { pending.resolve({ ok: true, result: { title: "첫 세션 전용", url: "https://example.test", text: "private", tabId: 1 } }); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(host.querySelector(".attachments")).toBeNull(); expect(composerValue().value).toBe("둘째 대화 초안");
});
it.each(["전체 분기", "새 세션", "여기서 분기"])("does not select a late %s result over the user's new session selection", async action => {
  secondSession(); await render(); const pending = deferred<any>(); test.post.mockReturnValue(pending.promise);
  await act(async () => button(action).click()); await selectOtherSession(); await draftValue("둘째 대화 초안");
  await act(async () => pending.resolve({ ...sessions[0], id: "ses-late", title: "늦은 세션" }));
  expect(host.querySelector(".conversation h2")?.textContent).toBe("둘째 대화"); expect(composerValue().value).toBe("둘째 대화 초안");
});
it("stops the explicitly selected response after closing an unknown browser operation gate", async () => {
  await render(); await act(async () => test.stream({ type: "session.status", properties: { sessionID: "ses-one", status: { type: "busy" } } }));
  await act(async () => button("응답 중단").click()); expect(test.calls).toEqual(["bridge-gate", "/session/ses-one/abort"]);
});

async function selectProfile(id: string) { await act(async () => { const select = [...host.querySelectorAll("label")].find(label => label.textContent?.startsWith("실행 환경"))!.querySelector("select")!; select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); }); }
function twoProfiles() { const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>; runtime.mockImplementation(message => message.method === "profile.list" ? Promise.resolve({ ok: true, result: { profiles: [{ id: "native", name: "첫 환경" }, { id: "second", name: "둘째 환경" }], defaultProfileId: "native" } }) : original(message)); }
it.each(["file", "skill"])("discards a delayed %s FileReader completion after switching profiles", async source => {
  twoProfiles(); const original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path === "/skill" ? Promise.resolve([{ name: "fixture", location: "/private", content: "private skill" }]) : original(path, query));
  await render(); const reads: Array<() => void> = [], read = FileReader.prototype.readAsDataURL;
  const spy = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader, blob: Blob) { reads.push(() => read.call(this, blob)); });
  try {
    if (source === "file") await act(async () => { const el = host.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(el, "files", { configurable: true, value: [new File(["private"], "private.txt", { type: "text/plain" })] }); el.dispatchEvent(new Event("change", { bubbles: true })); });
    else await act(async () => button("fixture 스킬 첨부").click());
    expect(reads).toHaveLength(1); await selectProfile("second"); await draftValue("다른 환경 초안");
    await act(async () => { reads[0]!(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(host.querySelector(".attachments")).toBeNull(); expect(composerValue().value).toBe("다른 환경 초안");
  } finally { spy.mockRestore(); }
});
it("discards a delayed remote file from a different profile", async () => {
  twoProfiles(); await render(); const pending = deferred<any>(), original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path === "/find/file" ? Promise.resolve(["private.txt"]) : path === "/file/content" ? pending.promise : original(path, query));
  await draftValue("@private"); await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)); });
  await act(async () => button("@private.txt · 서버 파일").click()); await selectProfile("second"); await draftValue("다른 환경 초안");
  await act(async () => pending.resolve({ encoding: "base64", mimeType: "text/plain", content: "cHJpdmF0ZQ==" }));
  expect(host.querySelector(".attachments")).toBeNull(); expect(composerValue().value).toBe("다른 환경 초안");
});
it("retains new edits made while sending within the same session", async () => {
  await render(); const pending = deferred<any>(); test.post.mockReturnValue(pending.promise);
  await draftValue("보낼 내용"); await act(async () => button("보내기").click()); await draftValue("새 초안");
  await act(async () => pending.resolve(true)); expect(composerValue().value).toBe("새 초안");
});
it("stops selected B even when A owns the browser operation and selection changes during gate closure", async () => {
  secondSession(); messages.push({ info: { ...info, id: "msg-tool", role: "assistant" }, parts: [{ id: "prt-tool", type: "tool", tool: "browser_browser_tabs", state: { status: "completed", input: { action: "attach" }, output: JSON.stringify({ ok: true, tool: "browser_tabs", operationId: "op-known" }) } }] });
  await render(); await selectOtherSession(); await act(async () => test.stream({ type: "session.status", properties: { sessionID: "ses-two", status: { type: "busy" } } }));
  const pending = deferred<any>(), runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(message => { if (message.method === "operation.abort") { test.calls.push("bridge-gate"); return pending.promise; } return original(message); });
  await act(async () => button("응답 중단").click());
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(el => el.querySelector("strong")?.textContent === "기존 대화")!.click());
  await act(async () => pending.resolve({ ok: true, result: { aborted: true } }));
  expect(test.calls).toEqual(["bridge-gate", "/session/ses-two/abort"]);
});
