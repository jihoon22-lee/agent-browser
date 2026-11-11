import { OpenCodeV1Client } from "../src/agents/opencode-v1/client";
import { initialWorkbench, workbenchReducer, availableModels, operationBindings, shouldSubmit, filePart, respondOnce } from "../src/sidepanel/workbench-state";

it("updates parts by ID without mixing in another session", () => {
  let state = workbenchReducer(initialWorkbench, { type: "messages", sessionID: "ses-a", messages: [{ info: { id: "msg-a", sessionID: "ses-a", role: "assistant" }, parts: [{ id: "prt-a", messageID: "msg-a", sessionID: "ses-a", type: "text", text: "시작" }] }] });
  const delta = { id: "evt-one", type: "message.part.delta", properties: { sessionID: "ses-a", messageID: "msg-a", partID: "prt-a", field: "text", delta: " 끝" } };
  state = workbenchReducer(state, { type: "event", event: delta });
  state = workbenchReducer(state, { type: "event", event: { id: "evt-two", type: "message.part.updated", properties: { sessionID: "ses-b", part: { id: "prt-b", messageID: "msg-b", sessionID: "ses-b", type: "text", text: "다른 대화" } } } });
  expect(state.messages["ses-a"]![0]!.parts[0]!.text).toBe("시작 끝");
  expect(state.messages["ses-a"]).toHaveLength(1);
  expect(state.messages["ses-b"]![0]!.parts[0]!.text).toBe("다른 대화");
});
it("restores pending questions and removes ones answered elsewhere", () => {
  let state = workbenchReducer(initialWorkbench, { type: "pending", questions: [{ id: "que-a", sessionID: "ses-a", questions: [] }], permissions: [] });
  state = workbenchReducer(state, { type: "event", event: { id: "evt-done", type: "question.replied", properties: { sessionID: "ses-a", requestID: "que-a", answers: [] } } });
  expect(state.questions).toEqual([]);
});
it("shows models only from connected provider results", () => {
  expect(availableModels({ all: [{ id: "internal", models: { m: { id: "m", name: "사내" } } }, { id: "external", models: { x: { id: "x" } } }], connected: ["internal"] })).toEqual([expect.objectContaining({ providerID: "internal", id: "m" })]);
});
it("maps operations only from successful browser attach results", () => {
  const info = { id: "msg-a", sessionID: "ses-known", role: "assistant" };
  const completed = (output: string, action = "attach") => ({ type: "tool", tool: "browser_browser_tabs", state: { status: "completed", input: { action }, output } });
  expect(operationBindings([{ info, parts: [completed(JSON.stringify({ ok: true, tool: "browser_tabs", operationId: "op-known" }))] }])).toEqual({ "op-known": "ses-known" });
  expect(operationBindings([{ info, parts: [completed(JSON.stringify({ ok: false, tool: "browser_tabs", operationId: "op-bad" })), completed(JSON.stringify({ ok: true, tool: "browser_tabs", operationId: "op-unrelated" }), "list")] }])).toEqual({});
});
it("never submits Enter during IME composition or with Shift", () => {
  expect(shouldSubmit({ key: "Enter", isComposing: true, shiftKey: false, keyCode: 13 })).toBe(false);
  expect(shouldSubmit({ key: "Enter", isComposing: false, shiftKey: false, keyCode: 229 })).toBe(false);
  expect(shouldSubmit({ key: "Enter", isComposing: false, shiftKey: true, keyCode: 13 })).toBe(false);
  expect(shouldSubmit({ key: "Enter", isComposing: false, shiftKey: false, keyCode: 13 })).toBe(true);
});
it("uses typed data URL attachments instead of Windows local file paths", async () => {
  const part = await filePart(new File(["합성 본문"], "한글.txt", { type: "text/plain" }));
  expect(part).toMatchObject({ type: "file", mime: "text/plain", filename: "한글.txt" });
  expect(part.url).toMatch(/^data:text\/plain;base64,/);
  expect(part.url).not.toContain("C:\\");
});
it("prechecks unanswered requests and suppresses concurrent duplicate responses", async () => {
  const pending = new Set<string>(), post = vi.fn(async () => {});
  let resolve!: (value: unknown[]) => void;
  const list = vi.fn(() => new Promise<unknown[]>(r => { resolve = r; }));
  const first = respondOnce(pending, "que-a", list, post);
  await expect(respondOnce(pending, "que-a", list, post)).resolves.toBe(false);
  resolve([{ id: "que-a" }]); await expect(first).resolves.toBe(true); expect(post).toHaveBeenCalledTimes(1);
  await expect(respondOnce(pending, "que-a", async () => [], post)).resolves.toBe(false);
  expect(post).toHaveBeenCalledTimes(1);
});

it("treats a not-found response after pending precheck as already answered", async () => {
  const error = Object.assign(new Error("already answered"), { status: 404 });
  await expect(respondOnce(new Set(), "que-race", async () => [{ id: "que-race" }], async () => { throw error; })).resolves.toBe(false);
});
it("retains the model ID provided by the server instead of replacing it with an object key", () => {
  expect(availableModels({ all: [{ id: "configured", models: { alias: { id: "actual-model", name: "회사" } } }], connected: ["configured"] })[0]!.id).toBe("actual-model");
});

it("recognizes quoted file references with spaces without reading them as local paths", async () => {
  const { activeMention, replaceMention } = await import("../src/sidepanel/workbench-state");
  expect(activeMention('읽어줘 @"한글 폴더/서류')).toBe("한글 폴더/서류");
  expect(replaceMention('읽어줘 @"한글 폴더/서류', "")).toBe("읽어줘 ");
  expect(activeMention("읽어줘 @src/")).toBe("src/");
});

it("keeps session errors visible even when no assistant message was created", () => {
  let state = workbenchReducer(initialWorkbench, { type: "event", event: { id: "evt-failed", type: "session.error", properties: { sessionID: "ses-a", error: { name: "APIError", data: { message: "모델 한도에 도달했습니다." } } } } });
  expect(state.errors["ses-a"]).toBe("모델 한도에 도달했습니다.");
  state = workbenchReducer(state, { type: "event", event: { id: "evt-retry", type: "session.status", properties: { sessionID: "ses-a", status: { type: "busy" } } } });
  expect(state.errors["ses-a"]).toBeUndefined();
});

it("does not fabricate an assistant message from session metadata events", () => {
  const state = workbenchReducer(initialWorkbench, { type: "event", event: { id: "evt-session-meta", type: "session.updated", properties: { sessionID: "ses-one", info: { id: "ses-one", title: "합성 세션" } } } });
  expect(state.messages).toEqual({});
});

it("keeps no event history of its own: the stream client drops a replayed delta before the reducer", async () => {
  const delta = { id: "evt-one", type: "message.part.delta", properties: { sessionID: "ses-a", messageID: "msg-a", partID: "prt-a", field: "text", delta: " 끝" } };
  const controller = new AbortController(), wire = `data: ${JSON.stringify(delta)}\n\n`;
  // The server sends the same event again after each reconnect.
  const fetcher = vi.fn(async () => new Response(wire + wire, { headers: { "content-type": "text/event-stream" } }));
  let state = workbenchReducer(initialWorkbench, { type: "messages", sessionID: "ses-a", messages: [{ info: { id: "msg-a", sessionID: "ses-a", role: "assistant" }, parts: [{ id: "prt-a", messageID: "msg-a", sessionID: "ses-a", type: "text", text: "시작" }] }] });
  let connections = 0;
  await new OpenCodeV1Client({ baseUrl: "http://127.0.0.1:4096", directory: "/fixture" }, fetcher, { retryDelayMs: 0 })
    .events(event => { state = workbenchReducer(state, { type: "event", event }); }, online => { if (online && ++connections === 3) controller.abort(); }, controller.signal);
  expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(state.messages["ses-a"]![0]!.parts[0]!.text).toBe("시작 끝");
  expect(state).not.toHaveProperty("seen");
  expect(initialWorkbench).not.toHaveProperty("seen");
});

it("keeps the code and retry class of a failed Bridge request", async () => {
  const { bridgeRequest, BridgeRequestError, codeOf } = await import("../src/sidepanel/workbench-state");
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => ({ ok: false, error: { code: "BROWSER_DISCONNECTED", message: "Bridge is not connected", retry: "safe" } })) } });
  try {
    const error = await bridgeRequest("profile.list").catch(value => value);
    expect(error).toBeInstanceOf(BridgeRequestError);
    expect(error).toMatchObject({ message: "Bridge is not connected", code: "BROWSER_DISCONNECTED", retry: "safe" });
    expect(codeOf(error)).toBe("BROWSER_DISCONNECTED");
    expect(codeOf(new Error("Failed to fetch"))).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
});
