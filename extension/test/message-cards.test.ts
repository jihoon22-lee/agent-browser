import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageCard } from "../src/sidepanel/MessageCards";
import { CopyButton } from "../src/sidepanel/CopyButton";
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];

it("renders a collapsed tool card's input and output only once it is opened", async () => {
  const state = { status: "completed", input: { url: "https://example.test/large" }, output: "합성 스냅샷 본문 ".repeat(200) };
  await act(async () => root.render(createElement(MessageCard, { message: { info: { id: "msg-lazy", role: "assistant" }, parts: [{ id: "prt-lazy", type: "tool", tool: "browser_browser_snapshot", state }] }, onFork: vi.fn(), onRevert: vi.fn() })));
  const card = host.querySelector<HTMLDetailsElement>(".tool-card")!;
  expect(card.open).toBe(false);
  expect(card.querySelector("summary")?.textContent).toContain("페이지 읽기");
  expect(card.textContent).not.toContain("합성 스냅샷 본문");
  await act(async () => { card.open = true; card.dispatchEvent(new Event("toggle")); });
  expect(card.querySelector(":scope > pre")?.textContent).toContain("합성 스냅샷 본문");
});

it("asks inside the message before reverting and sends nothing when cancelled", async () => {
  const onRevert = vi.fn(), confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  await act(async () => root.render(createElement(MessageCard, { message: { info: { id: "msg-user", role: "user" }, parts: [{ id: "prt-user", type: "text", text: "되돌릴 질문" }] }, onFork: vi.fn(), onRevert })));
  await act(async () => buttons().find(button => button.textContent === "이전으로 되돌리기")!.click());
  expect(host.textContent).toContain("이미 완료된 웹사이트 작업은 되돌리지 않습니다");
  await act(async () => buttons().find(button => button.textContent === "취소")!.click());
  expect(onRevert).not.toHaveBeenCalled();
  await act(async () => buttons().find(button => button.textContent === "이전으로 되돌리기")!.click());
  await act(async () => buttons().find(button => button.textContent === "되돌리기 확인")!.click());
  expect(onRevert).toHaveBeenCalledWith("msg-user");
  expect(confirm).not.toHaveBeenCalled();
});

it("confirms a copy and reports a clipboard failure", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await act(async () => root.render(createElement(CopyButton, { text: "복사할 답변" })));
  await act(async () => buttons()[0]!.click());
  expect(writeText).toHaveBeenCalledWith("복사할 답변");
  expect(buttons()[0]!.textContent).toBe("복사됨");
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(buttons()[0]!.textContent).toBe("복사");
  writeText.mockRejectedValueOnce(new Error("denied"));
  await act(async () => buttons()[0]!.click());
  expect(buttons()[0]!.textContent).toBe("복사 실패");
});
