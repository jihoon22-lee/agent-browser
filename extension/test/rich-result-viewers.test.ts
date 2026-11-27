import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ImagePreview, InteractiveTable } from "../src/sidepanel/RichResultViewers";
import { MessageCard } from "../src/sidepanel/MessageCards";

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

describe("InteractiveTable", () => {
  it("sorts numerically, filters rows, and dispatches selected rows", async () => {
    const onRowAction = vi.fn();
    await act(async () =>
      root.render(
        createElement(InteractiveTable, {
          title: "상품 비교",
          columns: ["이름", "가격"],
          rows: [
            ["모델 B", "120,000원"],
            ["모델 A", "45,000원"],
            ["모델 C", "89,000원"],
          ],
          selectable: true,
          actionLabel: "선택 항목 비교",
          onRowAction,
        }),
      ),
    );

    // Sort by 가격 ascending (numeric-aware: 45,000 -> 89,000 -> 120,000).
    const priceHeader = [...host.querySelectorAll<HTMLButtonElement>(".rich-table-sort")].find(b => b.textContent?.includes("가격"))!;
    await act(async () => priceHeader.click());
    const firstOrder = [...host.querySelectorAll("tbody tr td:nth-child(2)")].map(td => td.textContent);
    expect(firstOrder).toEqual(["모델 A", "모델 C", "모델 B"]);

    // Filter rows by search input.
    const search = host.querySelector<HTMLInputElement>(".rich-table-search")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "모델 C");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(host.querySelector("tbody")?.textContent).toContain("89,000원");

    // Select the visible row and invoke action.
    const checkbox = host.querySelector<HTMLInputElement>('tbody input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    const actionBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "선택 항목 비교")!;
    await act(async () => actionBtn.click());
    expect(onRowAction).toHaveBeenCalledWith([["모델 C", "89,000원"]], ["이름", "가격"]);
  });

  it("scopes selection actions to visible filtered rows, supports select-all, and prunes stale indices", async () => {
    const onRowAction = vi.fn();
    const renderTable = (rows: string[][]) =>
      createElement(InteractiveTable, {
        columns: ["이름", "가격"],
        rows,
        selectable: true,
        actionLabel: "전송",
        onRowAction,
      });

    await act(async () => root.render(renderTable([["A", "10"], ["B", "20"], ["C", "30"]])));

    // Select all visible rows via header checkbox.
    const selectAll = host.querySelector<HTMLInputElement>('thead input[type="checkbox"]')!;
    await act(async () => selectAll.click());
    expect(host.textContent).toContain("선택 3행 CSV");

    // Filter to only row "B" -> visible selection count and dispatched rows must exclude hidden A and C.
    const search = host.querySelector<HTMLInputElement>(".rich-table-search")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "B");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("선택 1행 CSV");
    const sendBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "전송")!;
    await act(async () => sendBtn.click());
    expect(onRowAction).toHaveBeenCalledWith([["B", "20"]], ["이름", "가격"]);

    // Shrink rows to 1 item and clear filter -> stale indices (1, 2) are pruned.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => root.render(renderTable([["A", "10"]])));
    expect(host.textContent).toContain("선택 1행 CSV");
  });
});

describe("ImagePreview lightbox", () => {
  it("opens on click, stops Escape propagation, and restores focus to trigger", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const parentEsc = vi.fn();
    window.addEventListener("keydown", parentEsc);
    try {
      await act(async () => root.render(createElement(ImagePreview, { src: png, alt: "캡처 화면", downloadName: "capture.png" })));
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      const trigger = host.querySelector<HTMLButtonElement>(".image-thumb-trigger")!;
      await act(async () => trigger.click());
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(parentEsc).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
    } finally {
      window.removeEventListener("keydown", parentEsc);
    }
  });
});

describe("MessageCard rich tool viewers", () => {
  it("renders InteractiveTable for browser_extract table results and batch steps for browser_batch", async () => {
    const extractOutput = JSON.stringify({
      ok: true,
      tool: "browser_extract",
      data: { header: ["항목", "수량"], rows: [["사과", "3"], ["배", "1"]], markdown: "| 항목 | 수량 |\n| --- | --- |\n| 사과 | 3 |" },
    });
    await act(async () =>
      root.render(
        createElement(MessageCard, {
          message: {
            info: { id: "m-rich", role: "assistant" },
            parts: [
              { id: "p-batch", type: "tool", tool: "browser_browser_batch", state: { status: "completed", input: { steps: [{ tool: "fill", text: "검색어" }, { tool: "click", ref: "e5" }] }, output: JSON.stringify({ ok: true, tool: "browser_batch", data: { completedSteps: 2 } }) } },
              { id: "p-extract", type: "tool", tool: "browser_browser_extract", state: { status: "completed", input: { kind: "table" }, output: extractOutput } },
            ],
          },
          onFork: vi.fn(),
          onRevert: vi.fn(),
        }),
      ),
    );
    expect(host.querySelector(".tool-step-rail.multi")).not.toBeNull();
    const cards = [...host.querySelectorAll<HTMLDetailsElement>(".tool-card")];
    for (const card of cards) {
      await act(async () => { card.open = true; card.dispatchEvent(new Event("toggle")); });
    }
    expect(host.querySelectorAll(".batch-steps > li")).toHaveLength(2);
    expect(host.querySelector(".rich-table-card")).not.toBeNull();
    expect(host.querySelector(".rich-table")?.textContent).toContain("사과");
  });
});
