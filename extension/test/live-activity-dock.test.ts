import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveLivePhase, LiveActivityDock } from "../src/sidepanel/LiveActivityDock";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("deriveLivePhase", () => {
  it("returns idle when session is idle and operation is not paused", () => {
    expect(deriveLivePhase([], { type: "idle" }, null).kind).toBe("idle");
  });

  it("identifies active running tool with hint and completed count", () => {
    const messages = [
      { info: { id: "u1", role: "user", time: { created: 100 } }, parts: [{ type: "text", text: "검색해줘" }] },
      {
        info: { id: "a1", role: "assistant", time: { created: 200 } },
        parts: [
          { type: "tool", tool: "browser_browser_snapshot", state: { status: "completed", input: { url: "https://a.test" } } },
          { type: "tool", tool: "browser_browser_fill", state: { status: "running", input: { text: "노트북" } } },
        ],
      },
    ];
    const phase = deriveLivePhase(messages, { type: "busy" }, null);
    expect(phase.kind).toBe("tool");
    expect(phase.label).toContain("텍스트 입력");
    expect(phase.detail).toBe("노트북");
    expect(phase.completedTools).toBe(1);
    expect(phase.toolCount).toBe(2);
  });

  it("extracts latest reasoning preview when model is thinking", () => {
    const messages = [
      {
        info: { id: "a1", role: "assistant", time: { created: 200 } },
        parts: [{ type: "reasoning", text: "첫 줄\n표의 가격 열을 비교해야 함" }],
      },
    ];
    const phase = deriveLivePhase(messages, { type: "busy" }, null);
    expect(phase.kind).toBe("thinking");
    expect(phase.detail).toContain("표의 가격 열을 비교해야 함");
  });

  it("handles retry and paused handoff states", () => {
    const retry = deriveLivePhase([], { type: "retry", attempt: 2, message: "rate limit" }, null);
    expect(retry.kind).toBe("retry");
    expect(retry.label).toContain("2회");

    const paused = deriveLivePhase([], { type: "idle" }, { id: "op1", tabs: [5], currentTab: 5, state: "active", paused: true });
    expect(paused.kind).toBe("paused");
  });
});

describe("LiveActivityDock", () => {
  it("renders nothing when idle with no todos", async () => {
    await act(async () => root.render(createElement(LiveActivityDock, { messages: [], sessionStatus: { type: "idle" }, operation: null, todos: [] })));
    expect(host.querySelector(".live-dock")).toBeNull();
  });

  it("renders live tool phase, tab jump button, and expandable inline todos", async () => {
    const onFocusTab = vi.fn();
    const messages = [
      {
        info: { id: "a1", role: "assistant", time: { created: Date.now() - 3000 } },
        parts: [{ type: "tool", tool: "browser_browser_click", state: { status: "running", input: { ref: "e12" } } }],
      },
    ];
    const todos = [
      { content: "검색어 입력", status: "completed", priority: "high" },
      { content: "상세 표 추출", status: "in_progress", priority: "high" },
      { content: "결과 요약", status: "pending", priority: "medium" },
    ];
    await act(async () =>
      root.render(
        createElement(LiveActivityDock, {
          messages,
          sessionStatus: { type: "busy" },
          operation: { id: "op1", tabs: [42], currentTab: 42, state: "active" },
          todos,
          onFocusTab,
        }),
      ),
    );
    expect(host.textContent).toContain("클릭 실행 중");
    expect(host.textContent).toContain("할 일 1/3");
    expect(host.textContent).toContain("상세 표 추출");

    const tabBtn = host.querySelector<HTMLButtonElement>(".live-tab-jump")!;
    await act(async () => tabBtn.click());
    expect(onFocusTab).toHaveBeenCalledWith(42);

    const toggle = host.querySelector<HTMLButtonElement>(".live-todos-toggle")!;
    expect(host.querySelector(".live-todos-list")).toBeNull();
    await act(async () => toggle.click());
    expect(host.querySelectorAll(".live-todos-list > li")).toHaveLength(3);
  });
});
