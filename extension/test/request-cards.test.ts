import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QuestionCard, PermissionCard } from "../src/sidepanel/MessageCards";
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("allows multiple answers across multiple questions and sends their ordered arrays", async () => {
  const request = { id: "q", questions: [{ header: "첫 질문", question: "여러 개", options: [{ label: "A" }, { label: "B" }], multiple: true, custom: false }, { header: "둘째", question: "하나", options: [{ label: "C" }], custom: false }] }, onReply = vi.fn(async () => {});
  await act(async () => root.render(createElement(QuestionCard, { request, onReply })));
  await act(async () => { for (const input of host.querySelectorAll<HTMLInputElement>("input")) input.click(); });
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(onReply).toHaveBeenCalledWith(request, [["A", "B"], ["C"]]);
});
it("displays actual permission target and remember scope", async () => {
  const request = { id: "p", permission: "bash", patterns: ["cargo test *"], always: ["cargo test *"], metadata: { command: "cargo test", directory: "/work" } }, onReply = vi.fn(async () => {});
  await act(async () => root.render(createElement(PermissionCard, { request, onReply })));
  expect(host.textContent).toContain("cargo test *"); expect(host.textContent).toContain("영구 허용이 아닙니다");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "이 규칙 기억")!.click());
  expect(onReply).toHaveBeenCalledWith(request, "always");
});

it("a single-choice option replaces a previously typed custom answer", async () => {
  const request = { id: "q", questions: [{ header: "선택", question: "하나만", options: [{ label: "A" }], custom: true }] }, onReply = vi.fn(async () => {});
  await act(async () => root.render(createElement(QuestionCard, { request, onReply })));
  const text = [...host.querySelectorAll<HTMLInputElement>("input")].find(input => input.type === "text")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(text, "직접 답변"); text.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(onReply).toHaveBeenCalledWith(request, [["A"]]);
});

it("opens server file artifacts through the owning runtime instead of a Windows local path", async () => {
  const { MessageCard } = await import("../src/sidepanel/MessageCards");
  const part = { id: "prt-file", type: "file", filename: "결과.txt", mime: "text/plain", url: "file:///home/user/output.txt" }, onOpenFile = vi.fn();
  await act(async () => root.render(createElement(MessageCard, { message: { info: { id: "msg-file", role: "assistant" }, parts: [part] }, onFork: vi.fn(), onRevert: vi.fn(), onOpenFile })));
  const open = [...host.querySelectorAll("button")].find(button => button.textContent === "서버 파일 열기");
  expect(open).toBeDefined(); await act(async () => open!.click()); expect(onOpenFile).toHaveBeenCalledWith(part);
  expect(host.querySelector('a[href^="file:"]')).toBeNull();
});
