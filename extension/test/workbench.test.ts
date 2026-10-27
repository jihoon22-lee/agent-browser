import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OpenCodeApiError } from "../src/agents/opencode-v1/client";
import { App } from "../src/sidepanel/App";
const test = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), request: vi.fn(), stream: undefined as any, online: undefined as any, calls: [] as string[], scopes: [] as [string, string][], streamDirectories: [] as string[] }));
vi.mock("../src/agents/opencode-v1/client", async importOriginal => ({ ...(await importOriginal<typeof import("../src/agents/opencode-v1/client")>()), OpenCodeV1Client: class {
  directory: string; constructor(value: any) { this.directory = value.directory; }
  get = (path: string, query?: any) => { test.scopes.push([path, this.directory]); return test.get(path, query); };
  findFiles = (query: string, limit = 12) => test.get("/find/file", { query, limit });
  post = (path: string, body?: any) => { test.calls.push(path); return test.post(path, body); };
  patch = (path: string, body?: any) => test.post(path, body);
  delete = (path: string) => test.post(path);
  request = (method: string, path: string, options?: any) => test.request(method, path, options);
  events(event: any, online: any, signal: AbortSignal) { test.streamDirectories.push(this.directory); test.stream = event; test.online = online; online(true); return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); }
} }));
let host: HTMLDivElement, root: Root;
let questions: any[], messages: any[], sessions: any[];
const listeners = new Set<(message: any) => void>();
const info = { id: "msg-one", sessionID: "ses-one", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "internal", modelID: "company" } };
const model = { id: "company", providerID: "internal", name: "사내 모델", status: "active", limit: { context: 10000 }, variants: { careful: {} } };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); test.calls = []; test.scopes = []; test.streamDirectories = []; listeners.clear();
  sessions = [{ id: "ses-one", title: "기존 대화", directory: "/fixture", time: { updated: 1 }, agent: "build" }];
  messages = [{ info, parts: [{ id: "prt-one", type: "text", text: "기존 질문" }] }]; questions = [];
  test.get.mockReset().mockImplementation(async (path: string) => {
    if (path === "/provider") return { all: [{ id: "internal", name: "업무", models: { company: model } }], connected: ["internal"], default: { internal: "company" } };
    if (path === "/agent") return [{ name: "build", mode: "primary" }];
    if (path === "/session") return sessions;
    if (sessions.some(session => path === `/session/${session.id}`)) return sessions.find(session => path === `/session/${session.id}`);
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

it('captures a fresh active tab for each prompt and sends its request context in system',async()=>{
  const win={id:4,focused:true,tabs:[{id:31,active:true,url:'https://mail.test'}]};
  (chrome as any).windows={getLastFocused:vi.fn(async()=>structuredClone(win))};
  const runtime=chrome.runtime.sendMessage as ReturnType<typeof vi.fn>,original=runtime.getMockImplementation() as (message:any)=>Promise<any>;
  runtime.mockImplementation(async(message:any)=>message.kind==='request-prepare'?{ok:true,result:{system:`requestId=${message.lease.requestId}; captured=${message.target.tabId}`}}:original(message));
  await render();await draftValue('첫 요청');await act(async()=>button('보내기').click());
  win.tabs[0]!.id=42;
  await draftValue('다음 요청');await act(async()=>button('보내기').click());
  const prepares=runtime.mock.calls.map(([m])=>m).filter(m=>m.kind==='request-prepare');
  expect(prepares.map(m=>m.target.tabId)).toEqual([31,42]);
  expect(prepares[0].lease.requestId).not.toBe(prepares[1].lease.requestId);
  const sends=test.post.mock.calls.filter(([path])=>path.endsWith('/prompt_async'));
  expect(sends[0]![1].system).toContain('captured=31');expect(sends[1]![1].system).toContain('captured=42');
  expect(sends[0]![1].messageID).toBe(prepares[0].lease.messageId);
});

it('discards an unsent reservation when the selected session changes during preparation',async()=>{
  secondSession();await render();const pending=deferred<any>();
  const runtime=chrome.runtime.sendMessage as ReturnType<typeof vi.fn>,original=runtime.getMockImplementation() as (message:any)=>Promise<any>;
  runtime.mockImplementation((message:any)=>message.kind==='request-prepare'?pending.promise:original(message));
  await draftValue('전송 대기');await act(async()=>button('보내기').click());
  await selectOtherSession();
  await act(async()=>pending.resolve({ok:true,result:{system:'request'}}));
  expect(test.post.mock.calls.some(([path])=>path.endsWith('/prompt_async'))).toBe(false);
  const messages=runtime.mock.calls.map(([m])=>m);
  expect(messages.find(m=>m.kind==='request-discard')?.requestId).toBe(messages.find(m=>m.kind==='request-prepare').lease.requestId);
});

it('does not submit after Stop while the browser reservation is pending',async()=>{
  await render();const pending=deferred<any>();
  const runtime=chrome.runtime.sendMessage as ReturnType<typeof vi.fn>,original=runtime.getMockImplementation() as (message:any)=>Promise<any>;
  runtime.mockImplementation((message:any)=>message.kind==='request-prepare'?pending.promise:original(message));
  await draftValue('cancel this');await act(async()=>button('보내기').click());
  await act(async()=>button('응답 중단').click());
  await act(async()=>pending.resolve({ok:true,result:{system:'request'}}));
  expect(test.post.mock.calls.some(([path])=>path.endsWith('/prompt_async'))).toBe(false);
});
it.each([400,403,404,422])('discards the exact reservation on rejected HTTP %s submission',async status=>{
  await render();test.post.mockRejectedValueOnce(new OpenCodeApiError(status,'rejected'));
  await draftValue('rejected');await act(async()=>button('보내기').click());
  const calls=(chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(([m])=>m);
  expect(calls.find(m=>m.kind==='request-discard')?.requestId).toBe(calls.find(m=>m.kind==='request-prepare').lease.requestId);
});
it('closes the browser reservation even when OpenCode abort fails',async()=>{
  await render();await draftValue('request');await act(async()=>button('보내기').click());
  test.post.mockRejectedValueOnce(Error('offline'));
  await act(async()=>button('응답 중단').click());
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({kind:'request-cancel'}));
});
it('Stop still owns the earlier request after a premature next submission is rejected',async()=>{
  await render();let saved:any;
  const localGet=chrome.storage.local.get as ReturnType<typeof vi.fn>,getStorage=localGet.getMockImplementation() as ()=>Promise<Record<string,any>>;
  localGet.mockImplementation(async()=>({...await getStorage(),panelBrowserRequest:saved}));
  const runtime=chrome.runtime.sendMessage as ReturnType<typeof vi.fn>,original=runtime.getMockImplementation() as (message:any)=>Promise<any>;
  runtime.mockImplementation(async(message:any)=>{
    if(message.kind==='request-prepare'){
      if(saved)return {ok:false,error:{message:'previous request incomplete'}};
      saved=message.lease;return {ok:true,result:{system:'request'}};
    }
    return original(message);
  });
  await draftValue('first');await act(async()=>button('보내기').click());
  await draftValue('too soon');await act(async()=>button('보내기').click());
  await act(async()=>button('응답 중단').click());
  expect(runtime.mock.calls.map(([m])=>m).find(m=>m.kind==='request-cancel').scope.requestId).toBe(saved.requestId);
});
it('still aborts subsequent session work when a completed prompt has no remaining lease',async()=>{
  await render();await draftValue('completed request');await act(async()=>button('보내기').click());
  const runtime=chrome.runtime.sendMessage as ReturnType<typeof vi.fn>,original=runtime.getMockImplementation() as (message:any)=>Promise<any>;
  runtime.mockImplementation(async(message:any)=>message.kind==='request-cancel'?{ok:true,result:false}:original(message));
  await act(async()=>test.stream({type:'session.status',properties:{sessionID:'ses-one',status:{type:'busy'}}}));
  await act(async()=>button('응답 중단').click());
  expect(test.post).toHaveBeenCalledWith('/session/ses-one/abort',undefined);
});
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

it.each(['panel reopen', 'profile return'])('R02 restores the saved session directory for all instance APIs and SSE: %s', async mode => {
  sessions[0].directory = '/project-b'; twoProfiles();
  await render();
  if (mode === 'profile return') { await selectProfile('second'); test.scopes = []; test.streamDirectories = []; await selectProfile('native'); }
  expect(test.streamDirectories.at(-1)).toBe('/project-b');
  for (const path of ['/session/status','/question','/permission','/provider']) {
    expect(test.scopes.filter(([p]) => p === path).at(-1)).toEqual([path, '/project-b']);
  }
});
it('R09 ignores a root list begun before a session deletion event', async () => {
  secondSession(); await render();
  const stale = deferred<any[]>(), before = [...sessions], original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path === '/session' ? stale.promise : original(path,query));
  await act(async () => { test.online(false); test.online(true); });
  await act(async () => test.stream({type:'session.deleted', properties:{info:sessions[1]}}));
  expect(host.querySelector('.session-tree')!.textContent).not.toContain('둘째 대화');
  await act(async () => stale.resolve(before));
  expect(host.querySelector('.session-tree')!.textContent).not.toContain('둘째 대화');
});
it.each([false, true])('R10 refreshes offscreen child discovery on reconnect after an empty or failed check: %s', async failed => {
  secondSession(); const original = test.get.getMockImplementation()!;
  if (failed) test.get.mockImplementation((path: string, query: any) => path === '/session/ses-two/children' ? Promise.reject(Error('offline')) : original(path,query));
  await render();
  expect(host.querySelector('button[aria-label="둘째 대화 하위 세션 펼치기"]')).toBeNull();
  test.get.mockImplementation((path: string, query: any) => path === '/session/ses-two/children' ? Promise.resolve([{...sessions[1], id:'ses-new-child',parentID:'ses-two',title:'Offline child'}]) : original(path,query));
  await act(async () => { test.online(false); test.online(true); });
  expect(host.querySelector('button[aria-label="둘째 대화 하위 세션 펼치기"]')).not.toBeNull();
});
it.each([false,true])('R11 refreshes final details on a successful absent status, never on a failed snapshot: %s', async failed => {
  await render();
  await act(async () => test.stream({type:'session.status',properties:{sessionID:'ses-one',status:{type:'busy'}}}));
  const original = test.get.getMockImplementation()!, count = (path: string) => test.get.mock.calls.filter(([p]) => p === path).length;
  const paths = ['/todo','/children','/diff'].map(path => '/session/ses-one'+path), before = paths.map(count);
  test.get.mockImplementation((path: string, query: any) => path === '/session/status' ? (failed ? Promise.reject(Error('fixture unavailable')) : Promise.resolve({})) : original(path,query));
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => new Promise(resolve => setTimeout(resolve, 150)));
  expect(paths.map(count)).toEqual(before.map(value => value + (failed ? 0 : 1)));
});

it.each([404, 500])('R02 clears a deleted saved session but does not hide a restore server failure: %s', async status => {
  const original = test.get.getMockImplementation()!;
  test.get.mockImplementation((path: string, query: any) => path === '/session/ses-one' ? Promise.reject(new OpenCodeApiError(status, 'fixture')) : original(path, query));
  await render();
  if (status === 404) {
    expect(test.streamDirectories).toEqual(['/fixture']);
    expect(host.textContent).toContain('사내 모델');
    expect((await chrome.storage.local.get('recentSession:native'))['recentSession:native']).toBe('');
  } else {
    expect(test.streamDirectories).toEqual([]);
    expect(host.textContent).toContain('OpenCode HTTP 500');
  }
});


it.each(['initial', 'search', 'load more'])('review list deletion retains an in-flight %s result', async mode => {
  sessions = Array.from({length: 70}, (_, i) => ({...sessions[0], id: i ? `ses-root-${i}` : 'ses-one', title: `페이지 결과 ${i}`}));
  const original = test.get.getMockImplementation()!, pending = deferred<any[]>();
  let hold = mode === 'initial', response: any[] = [];
  test.get.mockImplementation((path: string, query: any) => {
    if (path !== '/session') return original(path, query);
    const result = sessions.filter(session => !query?.search || session.title.includes(query.search)).slice(0, query?.limit ?? 50);
    if (hold) { response = result; return pending.promise; }
    return Promise.resolve(result);
  });
  await render();
  if (mode !== 'initial') {
    hold = true;
    if (mode === 'search') {
      const input = host.querySelector<HTMLInputElement>('input[aria-label="세션 검색"]')!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '페이지 결과 6'); input.dispatchEvent(new Event('input', {bubbles:true})); });
      await act(async () => button('검색').click());
    } else await act(async () => button('더 보기').click());
  }
  expect(response.length).toBeGreaterThan(0);
  await act(async () => test.stream({type:'session.deleted', properties:{info:{id:'ses-unlisted-child',parentID:'ses-one'}}}));
  await act(async () => pending.resolve(response));
  expect([...host.querySelectorAll('.session-tree > li strong')].map(element => element.textContent)).toEqual(response.map(session => session.title));
});

it.each(['select', 'delete'])('review connect completion preserves the current selection after %s', async action => {
  secondSession(); const original = test.get.getMockImplementation()!, catalog = deferred<any>();
  test.get.mockImplementation((path: string, query: any) => path === '/provider' ? catalog.promise : original(path, query));
  await render();
  if (action === 'select') await selectOtherSession();
  else await act(async () => test.stream({type:'session.deleted', properties:{info:sessions[0]}}));
  const expected = action === 'select' ? 'ses-two' : '';
  expect((await chrome.storage.local.get('recentSession:native'))['recentSession:native']).toBe(expected);
  await act(async () => catalog.resolve(await original('/provider')));
  expect((await chrome.storage.local.get('recentSession:native'))['recentSession:native']).toBe(expected);
});

it.each(['reconnect', 'profile change'])('review child discovery stays capped across %s with old requests pending', async mode => {
  sessions = Array.from({length: 8}, (_, i) => ({...sessions[0], id:`ses-root-${i}`, title:`대화 ${i}`}));
  await chrome.storage.local.set({'recentSession:native':''}); twoProfiles();
  const original = test.get.getMockImplementation()!, pending: Array<ReturnType<typeof deferred<any[]>>> = [];
  let active = 0, peak = 0;
  test.get.mockImplementation((path: string, query: any) => {
    if (!path.endsWith('/children')) return original(path, query);
    const request = deferred<any[]>(); pending.push(request); active++; peak = Math.max(peak, active);
    return request.promise.finally(() => active--);
  });
  await render(); expect(active).toBe(4);
  if (mode === 'profile change') await selectProfile('second');
  else for (let i=0; i<3; i++) await act(async () => {test.online(false);test.online(true);});
  const peakBeforeRelease = peak;
  await act(async () => { for (const request of pending.slice(0,4)) request.resolve([{...sessions[0],id:'ses-stale-child',parentID:'ses-root-0',title:'stale child'}]); });
  expect(host.querySelector('button[aria-label="대화 0 하위 세션 펼치기"]')).toBeNull();
  expect(active).toBe(4);
  // Drain every synthetic request, including the replacement generation's queued rows.
  for (let i=0; i<8 && active; i++) await act(async () => {for (const request of [...pending]) request.resolve([]);});
  expect(peakBeforeRelease).toBeLessThanOrEqual(4);
  expect(peak).toBeLessThanOrEqual(4);
  expect(active).toBe(0);
});

it('review tombstoned roots keep the next page reachable', async () => {
  sessions = Array.from({length: 70}, (_, i) => ({...sessions[0], id: i ? `ses-root-${i}` : 'ses-one', title: `페이지 결과 ${i}`}));
  const original = test.get.getMockImplementation()!, pending = deferred<any[]>();
  let held = true;
  test.get.mockImplementation((path: string, query: any) => path === '/session'
    ? held ? pending.promise : Promise.resolve(sessions.filter(session => session.id !== 'ses-one').slice(0, query.limit))
    : original(path, query));
  await render();
  await act(async () => test.stream({type:'session.deleted', properties:{info:sessions[0]}}));
  await act(async () => pending.resolve(sessions.slice(0, 50)));
  expect(host.textContent).not.toContain('페이지 결과 0');
  expect(button('더 보기')).toBeDefined();
  held = false;
  await act(async () => button('더 보기').click());
  expect([...host.querySelectorAll('.session-tree > li strong')].map(element => element.textContent)).toEqual(sessions.slice(1).map(session => session.title));
  expect(button('더 보기')).toBeUndefined();
});

it.each(['response','transport'])('F2 always posts abort when request-cancel fails (%s)',async failure=>{
  await render();await draftValue('long task');await act(async()=>button('보내기').click());
  const runtime=chrome.runtime.sendMessage as ReturnType<typeof vi.fn>,original=runtime.getMockImplementation() as (message:any)=>Promise<any>;
  runtime.mockImplementation(async(message:any)=>{
    if(message.kind!=='request-cancel')return original(message);
    if(failure==='transport')throw Error('Bridge disconnected');
    return {ok:false,error:{message:'Bridge disconnected'}};
  });
  test.post.mockClear();
  await act(async()=>button('응답 중단').click());
  expect(test.post).toHaveBeenCalledWith('/session/ses-one/abort',undefined);
  expect(host.textContent).toContain('Bridge disconnected');
});
it('review R3 updates Stop when the background removes the selected lease',async()=>{
  const changed=new Set<(changes:any,area:string)=>void>();
  (chrome.storage as any).onChanged={addListener:(fn:any)=>changed.add(fn),removeListener:(fn:any)=>changed.delete(fn)};
  const localGet=chrome.storage.local.get as ReturnType<typeof vi.fn>,original=localGet.getMockImplementation() as ()=>Promise<Record<string,any>>;
  const lease={requestId:'held',messageId:'msg-held',profileId:'native',directory:'/fixture',sessionId:'ses-one'};
  let saved:any=lease;localGet.mockImplementation(async()=>({...await original(),panelBrowserRequest:saved}));
  await render();expect(button('응답 중단').hidden).toBe(false);
  saved=undefined;
  await act(async()=>{for(const fn of changed)fn({panelBrowserRequest:{oldValue:lease}},'local');});
  expect(button('응답 중단').hidden).toBe(true);
  expect(test.post.mock.calls.some(([path])=>path.endsWith('/abort'))).toBe(false);
});
it('review R7 does not repeat the session abort already completed by the background',async()=>{
  await render();await draftValue('stop once');await act(async()=>button('보내기').click());
  const runtime=chrome.runtime.sendMessage as ReturnType<typeof vi.fn>,original=runtime.getMockImplementation() as (message:any)=>Promise<any>;
  runtime.mockImplementation(async(message:any)=>message.kind==='request-cancel'?{ok:true,result:{handled:true,abortSent:true}}:original(message));
  test.post.mockClear();await act(async()=>button('응답 중단').click());
  expect(test.post.mock.calls.filter(([path])=>path.endsWith('/abort'))).toHaveLength(0);
});
it('review R7 falls back once when the gate closed but no background abort was sent',async()=>{
  await render();await draftValue('stop offline');await act(async()=>button('보내기').click());
  const runtime=chrome.runtime.sendMessage as ReturnType<typeof vi.fn>,original=runtime.getMockImplementation() as (message:any)=>Promise<any>;
  runtime.mockImplementation(async(message:any)=>message.kind==='request-cancel'?{ok:true,result:{handled:true,abortSent:false}}:original(message));
  test.post.mockClear();await act(async()=>button('응답 중단').click());
  expect(test.post.mock.calls.filter(([path])=>path.endsWith('/abort'))).toHaveLength(1);
});
it.each([true,false])('review R8 serializes rapid Stop clicks including fallback (background abort=%s)',async abortSent=>{
  await render();
  await act(async()=>test.stream({type:'session.status',properties:{sessionID:'ses-one',status:{type:'busy'}}}));
  const runtime=chrome.runtime.sendMessage as ReturnType<typeof vi.fn>,original=runtime.getMockImplementation() as (message:any)=>Promise<any>;
  let finish!:(value:any)=>void;
  runtime.mockImplementation((message:any)=>message.kind==='request-cancel'?new Promise(resolve=>{finish=resolve;}):original(message));
  const stop=button('응답 중단');
  await act(async()=>{stop.click();stop.click();});
  expect(runtime.mock.calls.filter(([m])=>m.kind==='request-cancel')).toHaveLength(1);
  expect(stop.disabled).toBe(true);
  let finishAbort!:()=>void;
  test.post.mockImplementation(async(path:string)=>{if(path.endsWith('/abort'))await new Promise<void>(resolve=>{finishAbort=resolve;});return true;});
  await act(async()=>finish({ok:true,result:{handled:true,abortSent}}));
  if(!abortSent){
    expect(stop.disabled).toBe(true);
    await act(async()=>stop.click());
    expect(test.post.mock.calls.filter(([path])=>path.endsWith('/abort'))).toHaveLength(1);
    await act(async()=>finishAbort());
  }
  expect(test.post.mock.calls.filter(([path])=>path.endsWith('/abort'))).toHaveLength(abortSent?0:1);
  await act(async()=>test.stream({type:'session.status',properties:{sessionID:'ses-one',status:{type:'busy'}}}));
  expect(stop.disabled).toBe(false);
});
it('review R8 releases the Stop guard after abort failure so the user can retry',async()=>{
  await render();
  await act(async()=>test.stream({type:'session.status',properties:{sessionID:'ses-one',status:{type:'busy'}}}));
  const runtime=chrome.runtime.sendMessage as ReturnType<typeof vi.fn>,original=runtime.getMockImplementation() as (message:any)=>Promise<any>;
  runtime.mockImplementation(async(message:any)=>message.kind==='request-cancel'?{ok:true,result:false}:original(message));
  test.post.mockRejectedValueOnce(Error('abort unavailable'));
  await act(async()=>button('응답 중단').click());
  expect(host.textContent).toContain('abort unavailable');
  expect(button('응답 중단').disabled).toBe(false);
  await act(async()=>button('응답 중단').click());
  expect(test.post.mock.calls.filter(([path])=>path.endsWith('/abort'))).toHaveLength(2);
});

it("creates a session and sends the first message when none is selected", async () => {
  sessions.length = 0;
  const storage = await chrome.storage.local.get(); delete (storage as any)["recentSession:native"];
  test.post.mockImplementation(async (path: string) => {
    if (path === "/session") { const created = { id: "ses-new", title: "새 대화", directory: "/fixture", time: { updated: 2 } }; sessions.push(created); return created; }
    return true;
  });
  (chrome as any).windows = { getLastFocused: vi.fn(async () => ({ id: 4, focused: true, tabs: [{ id: 31, active: true, url: "https://mail.test" }] })) };
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(async (message: any) => message.kind === "request-prepare" ? { ok: true, result: { system: "ctx" } } : original(message));
  await render(); await draftValue("첫 요청"); await act(async () => button("보내기").click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const sends = test.post.mock.calls.filter(([path]) => path.endsWith("/prompt_async"));
  expect(sends.map(([path]) => path)).toEqual(["/session/ses-new/prompt_async"]);
  expect(JSON.stringify(sends[0]![1].parts)).toContain("첫 요청");
});

it("creates only one session when the first message is sent twice while it is being created", async () => {
  sessions.length = 0;
  const storage = await chrome.storage.local.get(); delete (storage as any)["recentSession:native"];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  test.post.mockImplementation(async (path: string) => {
    if (path === "/session") { await gate; const created = { id: "ses-once", title: "새 대화", directory: "/fixture", time: { updated: 3 } }; sessions.push(created); return created; }
    return true;
  });
  (chrome as any).windows = { getLastFocused: vi.fn(async () => ({ id: 4, focused: true, tabs: [{ id: 31, active: true, url: "https://mail.test" }] })) };
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(async (message: any) => message.kind === "request-prepare" ? { ok: true, result: { system: "ctx" } } : original(message));
  await render(); await draftValue("한 번만");
  const box = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(test.post.mock.calls.filter(([path]) => path === "/session")).toHaveLength(1);
  expect(test.post.mock.calls.filter(([path]) => path.endsWith("/prompt_async")).map(([path]) => path)).toEqual(["/session/ses-once/prompt_async"]);
});

it("offers to add a runtime profile when none exists", async () => {
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(async (message: any) => message.method === "profile.list" ? { ok: true, result: { profiles: [], defaultProfileId: null } } : original(message));
  await render();
  await act(async () => button("실행 환경 추가").click());
  expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
});

it("lets the user take over the browser and hand it back", async () => {
  await render();
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
  await act(async () => button("잠시 넘겨받기").click());
  expect(runtime.mock.calls.map(([m]) => m).filter(m => m.method === "operation.pause")).toEqual([
    { kind: "bridge", method: "operation.pause", params: { operationId: "op-known", clientId: "local" } },
  ]);
  await act(async () => { for (const listener of listeners) listener({ kind: "bridge-event", event: "status.changed", data: { operation: { id: "op-known", clientId: "local", tabs: [1], currentTab: 1, state: "active", paused: true }, browsers: [], timeline: [] } }); await new Promise(r => setTimeout(r, 0)); });
  expect(host.textContent).toContain("브라우저를 직접 조작하는 중입니다");
  await act(async () => button("이어서 진행").click());
  expect(runtime.mock.calls.map(([m]) => m).some(m => m.method === "operation.resume" && m.params.operationId === "op-known")).toBe(true);
});

it("offers no take-over for another browser's operation", async () => {
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(async (message: any) => message.method === "status.get" ? { ok: true, result: { operation: { id: "op-other", clientId: "other", tabs: [1], currentTab: 1, state: "active" }, browsers: [], timeline: [] } } : original(message));
  await render();
  expect(button("잠시 넘겨받기")).toBeUndefined();
});

it("announces the take-over notice and blocks a second press while it is sent", async () => {
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  runtime.mockImplementation(async (message: any) => message.method === "operation.pause" ? (await gate, { ok: true, result: {} }) : original(message));
  await render();
  await act(async () => { button("잠시 넘겨받기").click(); });
  expect(button("잠시 넘겨받기").disabled).toBe(true);
  await act(async () => { release(); await new Promise(r => setTimeout(r, 0)); });
  await act(async () => { for (const listener of listeners) listener({ kind: "bridge-event", event: "status.changed", data: { operation: { id: "op-known", clientId: "local", tabs: [1], currentTab: 1, state: "active", paused: true }, browsers: [], timeline: [] } }); await new Promise(r => setTimeout(r, 0)); });
  expect([...host.querySelectorAll('[role="status"]')].some(e => e.textContent?.includes("브라우저를 직접 조작하는 중입니다"))).toBe(true);
});

it("offers take-over once this browser is paired while the panel is open", async () => {
  const storage = await chrome.storage.local.get() as Record<string, unknown>; delete storage.clientId;
  const changes = new Set<(c: any, area: string) => void>();
  (chrome as any).storage.onChanged = { addListener: (f: any) => changes.add(f), removeListener: (f: any) => changes.delete(f) };
  await render();
  expect(button("잠시 넘겨받기")).toBeUndefined();
  await act(async () => { storage.clientId = "local"; for (const f of changes) f({ clientId: { newValue: "local" } }, "local"); await new Promise(r => setTimeout(r, 0)); });
  expect(button("잠시 넘겨받기")).toBeDefined();
});

it("hands the message's attached files to the request so only they can be uploaded", async () => {
  (chrome as any).windows = { getLastFocused: vi.fn(async () => ({ id: 4, focused: true, tabs: [{ id: 31, active: true, url: "https://mail.test" }] })) };
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(async (message: any) => message.kind === "request-prepare" ? { ok: true, result: { system: "ctx" } } : original(message));
  await render();
  await act(async () => { const el = host.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(el, "files", { configurable: true, value: [new File(["합성"], "a.png", { type: "image/png" })] }); el.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
  await draftValue("올려 줘"); await act(async () => button("보내기").click());
  const prepare = runtime.mock.calls.map(([m]) => m).find(m => m.kind === "request-prepare");
  expect(prepare.files).toEqual([{ name: "a.png", mime: "image/png", dataUrl: expect.stringMatching(/^data:image\/png;base64,/) }]);
});

it("sends at most the uploadable attachments so a large message cannot fail to send", async () => {
  (chrome as any).windows = { getLastFocused: vi.fn(async () => ({ id: 4, focused: true, tabs: [{ id: 31, active: true, url: "https://mail.test" }] })) };
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(async (message: any) => message.kind === "request-prepare" ? { ok: true, result: { system: "ctx" } } : original(message));
  await render();
  for (const n of [1, 2, 3, 4, 5, 6]) await act(async () => { const el = host.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(el, "files", { configurable: true, value: [new File(["x"], `${n}.png`, { type: "image/png" })] }); el.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
  await draftValue("올려 줘"); await act(async () => button("보내기").click());
  const prepare = runtime.mock.calls.map(([m]) => m).find(m => m.kind === "request-prepare");
  expect(prepare.files.map((f: any) => f.name)).toEqual(["1.png", "2.png", "3.png", "4.png", "5.png"]);
  expect(prepare.skippedFiles).toEqual(["6.png"]);
});

it('keeps model, agent and reasoning selection in the composer without opening execution settings',async()=>{
  await render();
  const form=host.querySelector('.composer')!;
  for(const name of ['모델','에이전트','모델 variant·추론 옵션']) expect([...form.querySelectorAll('label')].some(label=>label.firstChild?.textContent===name&&label.querySelector('select'))).toBe(true);
  expect(form.textContent).toContain('이미지 지원 정보 없음');
});

it('freezes the request vision metadata with the submitted model',async()=>{
 const original=test.get.getMockImplementation()!;
 test.get.mockImplementation((path:string,q:any)=>path==='/provider'?Promise.resolve({all:[{id:'internal',models:{company:{...model,capabilities:{input:{image:true},toolcall:true}}}}],connected:['internal']}):original(path,q));
 await render();await draftValue('이미지 작업');await act(async()=>button('보내기').click());
 const prepare=(chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(([m])=>m).find(m=>m.kind==='request-prepare');
 expect(prepare.lease.vision).toEqual({model:'internal/company',image:'supported',toolcall:true});
});
