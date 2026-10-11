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
  if (action === "전체 분기") await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="현재 세션 작업"]')!.click());
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
it("stops selected B without closing the browser operation that session A owns", async () => {
  secondSession(); messages.push({ info: { ...info, id: "msg-tool", role: "assistant" }, parts: [{ id: "prt-tool", type: "tool", tool: "browser_browser_tabs", state: { status: "completed", input: { action: "attach" }, output: JSON.stringify({ ok: true, tool: "browser_tabs", operationId: "op-known" }) } }] });
  await render(); await selectOtherSession(); await act(async () => test.stream({ type: "session.status", properties: { sessionID: "ses-two", status: { type: "busy" } } }));
  await act(async () => button("응답 중단").click());
  // op-known is bound to ses-one by its browser_tabs attach result; B's stop must leave it running.
  expect(test.calls).toEqual(["/session/ses-two/abort"]);
});

it.each(["/todo", "/children", "/diff"])("keeps messages and live updates visible while optional session metadata %s is pending", async endpoint => {
  const pending = deferred<any[]>(), original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path.endsWith(endpoint) ? pending.promise : original(path, query));
  await render();
  await act(async () => test.stream({ id: "evt-live-during-metadata", type: "message.part.updated", properties: { sessionID: "ses-one", part: { id: "prt-one", messageID: "msg-one", sessionID: "ses-one", type: "text", text: "메타데이터보다 먼저 도착한 응답" } } }));
  expect(host.textContent).toContain("메타데이터보다 먼저 도착한 응답");
  await act(async () => pending.resolve([]));
});

it("separates chat, sessions and browser activity while keeping browser Stop available", async () => {
  await render();
  const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el => el.textContent === name)!;
  expect(tab("대화")?.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector<HTMLElement>('#view-chat')?.hidden).toBe(false);
  expect(host.querySelector<HTMLElement>('#view-sessions')?.hidden).toBe(true);
  expect(host.querySelector<HTMLElement>('#view-browser')?.hidden).toBe(true);
  await draftValue("탐색 중 유지할 초안");
  for (const name of ["세션", "브라우저", "대화"]) {
    await act(async () => tab(name).click());
    expect(tab(name).getAttribute("aria-selected")).toBe("true");
    expect(button("중단").closest("[hidden]")).toBeNull();
  }
  expect(composerValue().value).toBe("탐색 중 유지할 초안");
});
it("opens focused controls without stacking them below the conversation and returns focus with Escape", async () => {
  await render();
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="실행 설정"]')!; expect(trigger).toBeDefined();
  await act(async () => trigger.click());
  expect(host.querySelector<HTMLElement>('[aria-label="실행 설정 패널"]')?.hidden).toBe(false);
  expect(host.querySelector<HTMLElement>('#view-chat .conversation')?.hidden).toBe(true);
  await act(async () => host.querySelector<HTMLElement>('[aria-label="실행 설정 패널"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector<HTMLElement>('#view-chat .conversation')?.hidden).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

it("reconciles a missing final message and idle event while the SSE connection remains open", async () => {
  await render(); vi.useFakeTimers();
  try {
    await act(async () => test.stream({ id: "evt-busy-only", type: "session.status", properties: { sessionID: "ses-one", status: { type: "busy" } } }));
    messages.push({ info: { ...info, id: "msg-final-missed", role: "assistant", time: { created: 2, completed: 3 } }, parts: [{ id: "prt-final-missed", type: "text", text: "이벤트 없이 완료된 응답" }] });
    await act(async () => { test.stream({ id: "evt-heartbeat-only", type: "server.heartbeat", properties: {} }); await vi.advanceTimersByTimeAsync(2500); });
    expect(host.textContent).toContain("이벤트 없이 완료된 응답");
    expect(button("응답 중단").hidden).toBe(true);
    expect(test.calls).not.toContain("/session/ses-one/abort");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect([...host.querySelectorAll(".message")].filter(el => el.textContent?.includes("이벤트 없이 완료된 응답"))).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
it("checks for a submitted reply even when neither initial busy nor message events arrive", async () => {
  await render(); vi.useFakeTimers();
  try {
    await draftValue("이벤트가 없는 요청"); await act(async () => button("보내기").click());
    messages.push({ info: { ...info, id: "msg-no-events", role: "assistant", time: { created: 2, completed: 3 } }, parts: [{ id: "prt-no-events", type: "text", text: "HTTP 조회로 복원한 응답" }] });
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(host.textContent).toContain("HTTP 조회로 복원한 응답");
    expect(test.calls).not.toContain("/session/ses-one/abort");
  } finally { vi.useRealTimers(); }
});
it("refreshes the selected session on visibility restoration without requiring a broken SSE connection", async () => {
  await render(); const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  try {
    messages.push({ info: { ...info, id: "msg-visible-again", role: "assistant", time: { created: 2, completed: 3 } }, parts: [{ id: "prt-visible-again", type: "text", text: "화면 복귀 후 복원한 응답" }] });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(host.textContent).toContain("화면 복귀 후 복원한 응답");
  } finally { visibility.mockRestore(); }
});

it("queries root sessions explicitly so subagents cannot consume the first page", async () => {
  sessions.push({ ...sessions[0], id: "ses-child", parentID: "ses-one", title: "하위 작업" });
  await render();
  expect(test.get).toHaveBeenCalledWith("/session", expect.objectContaining({ roots: true, limit: 50 }));
  const list = host.querySelector(".session-tree"); expect(list).not.toBeNull();
  expect(list?.textContent).not.toContain("하위 작업");
});
it("loads more root sessions in bounded increments and resets the bound for a new search", async () => {
  sessions = Array.from({ length: 70 }, (_, i) => ({ ...sessions[0], id: i ? `ses-root-${i}` : "ses-one", title: `상위 대화 ${i}` }));
  const original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path === "/session" ? Promise.resolve(sessions.filter(session => !query?.search || session.title.includes(query.search)).slice(0, query?.limit ?? 100)) : original(path, query));
  await render(); expect(host.querySelectorAll(".session-tree > li")).toHaveLength(50);
  await act(async () => button("더 보기").click()); expect(host.querySelectorAll(".session-tree > li")).toHaveLength(70);
  expect(test.get).toHaveBeenCalledWith("/session", expect.objectContaining({ roots: true, limit: 100 }));
  const search = host.querySelector<HTMLInputElement>('input[aria-label="세션 검색"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "상위 대화 6"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => button("검색").click());
  expect(test.get).toHaveBeenCalledWith("/session", expect.objectContaining({ roots: true, limit: 50, search: "상위 대화 6" }));
});

it("expands nested children lazily and preserves a selected child's title and parent navigation", async () => {
  const child = { ...sessions[0], id: "ses-child", parentID: "ses-one", title: "하위 조사" }, grandchild = { ...sessions[0], id: "ses-grandchild", parentID: "ses-child", title: "중첩 조사" };
  const original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path === "/session/ses-one/children" ? Promise.resolve([child]) : path === "/session/ses-child/children" ? Promise.resolve([grandchild]) : path === "/session/ses-child" ? Promise.resolve(child) : original(path, query));
  await render();
  expect(host.querySelector(".session-tree")?.textContent).not.toContain("하위 조사");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="기존 대화 하위 세션 펼치기"]')!.click());
  expect(host.querySelector(".session-tree")?.textContent).toContain("하위 조사");
  expect(host.querySelector(".session-tree")?.textContent).not.toContain("중첩 조사");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="하위 조사 하위 세션 펼치기"]')!.click());
  expect(host.querySelector(".session-tree")?.textContent).toContain("중첩 조사");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".session-tree .session-open")].find(el => el.querySelector("strong")?.textContent === "하위 조사")!.click());
  expect(host.querySelector(".conversation h2")?.textContent).toBe("하위 조사");
  await act(async () => button("상위 세션으로").click());
  expect(host.querySelector(".conversation h2")?.textContent).toBe("기존 대화");
  expect(host.querySelectorAll(".session-tree > li")).toHaveLength(1);
});
it("discards a child-tree response from a runtime that was replaced", async () => {
  twoProfiles(); const pending = deferred<any[]>(), original = test.get.getMockImplementation()!; let first = true;
  // Only the first runtime's check is held; the replacement runtime gets its own (empty) answer.
  test.get.mockImplementation((path: string, query: any) => path === "/session/ses-one/children" ? (first ? (first = false, pending.promise) : Promise.resolve([])) : original(path, query));
  await render(); await selectProfile("second");
  await act(async () => pending.resolve([{ ...sessions[0], id: "ses-private-child", parentID: "ses-one", title: "다른 환경 하위 작업" }]));
  expect(host.querySelector(".session-tree")?.textContent).not.toContain("다른 환경 하위 작업");
  expect(host.querySelector('button[aria-label="기존 대화 하위 세션 펼치기"]')).toBeNull();
});

it("shows a child toggle only after a subagent session exists", async () => {
  await render();
  expect(host.querySelector('button[aria-label="기존 대화 하위 세션 펼치기"]')).toBeNull();
  const child = { ...sessions[0], id: "ses-new-child", parentID: "ses-one", title: "나중에 생성된 하위 작업" };
  await act(async () => test.stream({ id: "evt-child-created", type: "session.created", properties: { sessionID: child.id, info: child } }));
  const original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path === "/session/ses-one/children" ? Promise.resolve([child]) : original(path, query));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="기존 대화 하위 세션 펼치기"]')!.click());
  expect(host.querySelector(".session-tree")?.textContent).toContain("나중에 생성된 하위 작업");
});
it("shows child toggles only for sessions that have children, including nested children", async () => {
  secondSession(); const child = { ...sessions[0], id: "ses-child", parentID: "ses-one", title: "하위 조사" }, original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path === "/session/ses-one/children" ? Promise.resolve([child]) : original(path, query));
  await render();
  expect(host.querySelector('button[aria-label="기존 대화 하위 세션 펼치기"]')).not.toBeNull();
  expect(host.querySelector('button[aria-label="둘째 대화 하위 세션 펼치기"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="기존 대화 하위 세션 펼치기"]')!.click());
  expect(host.querySelector(".session-tree")?.textContent).toContain("하위 조사");
  expect(host.querySelector('button[aria-label="하위 조사 하위 세션 펼치기"]')).toBeNull();
});

const messageGets = () => test.get.mock.calls.filter(([path]) => path === "/session/ses-one/message").length;
async function sessionMenu(label: string, action: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  await act(async () => button(action).click());
}
it("deletes a session in place without clearing the list or reconnecting the runtime", async () => {
  secondSession(); await render();
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, ensures = () => runtime.mock.calls.filter(([message]) => message.method === "runtime.ensure").length, before = ensures();
  const pending = deferred<any[]>(), original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path === "/session" ? pending.promise : original(path, query));
  await sessionMenu("둘째 대화 세션 작업", "삭제"); await act(async () => button("삭제 확인").click());
  expect(test.post.mock.calls.some(([path]) => path === "/session/ses-two")).toBe(true);
  const tree = host.querySelector(".session-tree")!;
  expect(tree.textContent).toContain("기존 대화"); expect(tree.textContent).not.toContain("둘째 대화");
  expect(ensures()).toBe(before);
  await act(async () => pending.resolve([sessions[0]]));
  expect(host.querySelector(".conversation h2")?.textContent).toBe("기존 대화");
});
it("clears the conversation when the selected session is deleted", async () => {
  await render();
  await sessionMenu("현재 세션 작업", "삭제"); await act(async () => button("삭제 확인").click());
  expect(host.querySelector(".conversation h2")?.textContent).toBe("새 대화");
  expect(host.textContent).not.toContain("기존 질문");
});
it("renames a session inline from its menu and applies the title without a full resync", async () => {
  await render(); const gets = messageGets();
  await sessionMenu("현재 세션 작업", "이름 변경");
  const input = host.querySelector<HTMLInputElement>('input[aria-label="세션 이름"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "바뀐 이름"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(test.post).toHaveBeenCalledWith("/session/ses-one", { title: "바뀐 이름" });
  expect(host.querySelector(".conversation h2")?.textContent).toBe("바뀐 이름");
  expect(host.querySelector('input[aria-label="세션 이름"]')).toBeNull();
  await act(async () => test.stream({ id: "evt-renamed", type: "session.updated", properties: { sessionID: "ses-one", info: { ...sessions[0], title: "바뀐 이름" } } }));
  await act(async () => new Promise(resolve => setTimeout(resolve, 200)));
  expect(messageGets()).toBe(gets);
});
it("cancels inline rename with Escape and hides the rename field by default", async () => {
  await render();
  expect(host.querySelector('input[aria-label="세션 이름"]')).toBeNull();
  await sessionMenu("현재 세션 작업", "이름 변경");
  await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="세션 이름"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector('input[aria-label="세션 이름"]')).toBeNull();
  expect(test.post).not.toHaveBeenCalledWith("/session/ses-one", expect.anything());
});
it("applies todo updates from the event without refetching messages", async () => {
  await render(); const gets = messageGets();
  await act(async () => test.stream({ id: "evt-todo", type: "todo.updated", properties: { sessionID: "ses-one", todos: [{ content: "이벤트로 받은 할 일", status: "pending", priority: "high" }] } }));
  await act(async () => new Promise(resolve => setTimeout(resolve, 200)));
  expect(host.textContent).toContain("이벤트로 받은 할 일"); expect(messageGets()).toBe(gets);
});
it("keeps message actions to the relevant role and hides empty reasoning", async () => {
  messages.push(
    { info: { ...info, id: "msg-step-1", role: "assistant", time: { created: 2 } }, parts: [{ id: "prt-r1", type: "reasoning", text: "  " }, { id: "prt-t1", type: "tool", tool: "browser_click", state: { status: "completed", input: { ref: "e12" }, output: "ok", title: "클릭" } }] },
    { info: { ...info, id: "msg-step-2", role: "assistant", time: { created: 3 } }, parts: [{ id: "prt-s", type: "step-start" }, { id: "prt-a", type: "text", text: "최종 답변" }] });
  await render();
  const user = host.querySelector('article.message.user')!, turn = host.querySelector('.turn.assistant')!;
  expect([...user.querySelectorAll("button")].map(el => el.textContent)).toEqual(["여기서 분기", "이전으로 되돌리기"]);
  expect(host.textContent).not.toContain("추론 과정");
  expect([...turn.querySelectorAll("button")].filter(el => el.textContent === "복사")).toHaveLength(1);
  expect(turn.querySelectorAll("article.message > header")).toHaveLength(1);
  expect(turn.querySelector(".tool-card summary")?.textContent).toContain("e12");
});
it("refreshes the conversation and file changes once when the selected run finishes", async () => {
  await render();
  await act(async () => test.stream({ id: "evt-run-busy", type: "session.status", properties: { sessionID: "ses-one", status: { type: "busy" } } }));
  const diffs = () => test.get.mock.calls.filter(([path]) => path === "/session/ses-one/diff").length, before = diffs();
  messages.push({ info: { ...info, id: "msg-finished", role: "assistant", time: { created: 2, completed: 3 } }, parts: [{ id: "prt-finished", type: "text", text: "완료 후 확인한 최종 응답" }] });
  await act(async () => test.stream({ id: "evt-run-idle", type: "session.idle", properties: { sessionID: "ses-one" } }));
  await act(async () => new Promise(resolve => setTimeout(resolve, 200)));
  expect(diffs()).toBe(before + 1);
  expect(host.textContent).toContain("완료 후 확인한 최종 응답");
});
it("applies a session.diff event to the selected session's file changes", async () => {
  await render();
  await act(async () => test.stream({ id: "evt-diff", type: "session.diff", properties: { sessionID: "ses-one", diff: [{ file: "src/이벤트-변경.ts", additions: 3, deletions: 1 }] } }));
  expect(host.textContent).toContain("src/이벤트-변경.ts");
});

it("closes the gate of the browser operation the selected session owns before aborting it", async () => {
  messages.push({ info: { ...info, id: "msg-tool", role: "assistant" }, parts: [{ id: "prt-tool", type: "tool", tool: "browser_browser_tabs", state: { status: "completed", input: { action: "attach" }, output: JSON.stringify({ ok: true, tool: "browser_tabs", operationId: "op-known" }) } }] });
  await render(); await act(async () => test.stream({ type: "session.status", properties: { sessionID: "ses-one", status: { type: "busy" } } }));
  await act(async () => button("응답 중단").click());
  expect(test.calls).toEqual(["bridge-gate", "/session/ses-one/abort"]);
});
it("leaves an unattributed browser operation alone when another session is also running", async () => {
  secondSession(); await render();
  await act(async () => { test.stream({ type: "session.status", properties: { sessionID: "ses-one", status: { type: "busy" } } }); test.stream({ type: "session.status", properties: { sessionID: "ses-two", status: { type: "busy" } } }); });
  await act(async () => button("응답 중단").click());
  expect(test.calls).toEqual(["/session/ses-one/abort"]);
});
