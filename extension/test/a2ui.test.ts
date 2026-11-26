import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AGENT_BROWSER_CATALOG_ID, parseA2uiBlock } from "../src/sidepanel/a2ui/parser";
import { A2uiCard, formatA2uiActionMessage } from "../src/sidepanel/a2ui/A2uiCard";
import { SafeMarkdown } from "../src/sidepanel/SafeMarkdown";

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

const plainMd = ({ markdown }: { markdown: string }) => createElement(SafeMarkdown, { text: markdown });

describe("parseA2uiBlock", () => {
  it("accepts single-message v1.0 JSON, JSON arrays, and JSONL streams", () => {
    const single = parseA2uiBlock(JSON.stringify({
      version: "1.0",
      createSurface: { surfaceId: "s1", components: [{ id: "root", component: "Text", text: "안녕" }], dataModel: {} },
    }));
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(single.messages).toHaveLength(1);
      expect((single.messages[0] as any).createSurface.catalogId).toBe(AGENT_BROWSER_CATALOG_ID);
    }

    const jsonl = parseA2uiBlock([
      JSON.stringify({ version: "1.0", createSurface: { surfaceId: "s2", catalogId: AGENT_BROWSER_CATALOG_ID } }),
      JSON.stringify({ version: "1.0", updateComponents: { surfaceId: "s2", components: [{ id: "root", component: "Text", text: { "@path": "/msg" } }] } }),
      JSON.stringify({ version: "1.0", updateDataModel: { surfaceId: "s2", path: "/", value: { msg: "줄 단위" } } }),
    ].join("\n"));
    expect(jsonl.ok).toBe(true);
    if (jsonl.ok) expect(jsonl.messages).toHaveLength(3);
  });

  it("sanitizes obscured password fields and unsafe URLs with explicit warnings", () => {
    const parsed = parseA2uiBlock(JSON.stringify({
      version: "1.0",
      createSurface: {
        surfaceId: "phish",
        catalogId: AGENT_BROWSER_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["pw", "badLink"] },
          { id: "pw", component: "TextField", label: "비밀번호", variant: "obscured" },
          { id: "badLink", component: "TabLink", title: "위험", url: "javascript:alert(1)" },
        ],
      },
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const comps = (parsed.messages[0] as any).createSurface.components;
      expect(comps[1].variant).toBe("shortText");
      expect(comps[2].url).toBeUndefined();
      expect(parsed.warnings.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("rejects empty, malformed, and oversized payloads cleanly", () => {
    expect(parseA2uiBlock("").ok).toBe(false);
    expect(parseA2uiBlock("{broken json").ok).toBe(false);
    expect(parseA2uiBlock("x".repeat(130_000)).ok).toBe(false);
  });
});

describe("A2uiCard & SafeMarkdown integration", () => {
  it("renders custom browser-agent catalog components and dispatches DataTable row actions", async () => {
    const onAction = vi.fn();
    const updateTab = vi.fn(async () => ({}));
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn(async (id: number) => ({ id, windowId: 1 })), update: updateTab },
      windows: { update: vi.fn(async () => ({})) },
    });

    const payload = JSON.stringify({
      version: "1.0",
      createSurface: {
        surfaceId: "dash",
        catalogId: AGENT_BROWSER_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["stat", "badge", "kv", "prog", "tab", "tbl"] },
          { id: "stat", component: "StatCard", label: "검색 결과", value: { "@path": "/count" }, delta: "+3", tone: "ai" },
          { id: "badge", component: "Badge", text: "검증 완료", tone: "success" },
          { id: "kv", component: "KeyValue", items: [{ label: "대상", value: "테스트 페이지", mono: true }] },
          { id: "prog", component: "ProgressBar", label: "진행률", value: 3, max: 4, tone: "accent" },
          { id: "tab", component: "TabLink", title: "검색 탭 열기", tabId: 77, subtitle: "https://example.test" },
          {
            id: "tbl",
            component: "DataTable",
            title: "후보 표",
            columns: ["이름", "점수"],
            rows: [["A안", "95"], ["B안", "88"]],
            selectable: true,
            actionLabel: "선택안 적용",
            onSelectAction: { event: { name: "apply_rows", context: { source: "table" } } },
          },
        ],
        dataModel: { count: "12건" },
      },
    });

    await act(async () => root.render(createElement(A2uiCard, { source: payload, markdownRenderer: plainMd, onAction })));

    expect(host.textContent).toContain("AI 생성 UI");
    expect(host.textContent).toContain("12건");
    expect(host.textContent).toContain("검증 완료");
    expect(host.textContent).toContain("테스트 페이지");
    expect(host.textContent).toContain("75%");
    expect(host.textContent).toContain("검색 탭 열기");

    // Clicking TabLink focuses Chrome tab #77.
    await act(async () => host.querySelector<HTMLButtonElement>(".a2ui-tab-link")!.click());
    expect(updateTab).toHaveBeenCalledWith(77, { active: true });

    // Selecting a row in DataTable and clicking the action button dispatches through MessageProcessor.
    const cb = host.querySelector<HTMLInputElement>('tbody input[type="checkbox"]')!;
    await act(async () => cb.click());
    const btn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "선택안 적용")!;
    await act(async () => btn.click());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]![0]).toMatchObject({
      name: "apply_rows",
      surfaceId: "dash",
      context: { source: "table", count: 1, selectedRows: [["A안", "95"]] },
    });
    expect(host.textContent).toContain("전송됨 · apply_rows");

    // Toggle source inspection and back.
    const toggle = host.querySelector<HTMLButtonElement>(".a2ui-source-toggle")!;
    await act(async () => toggle.click());
    expect(host.querySelector(".a2ui-source-view pre")?.textContent).toContain('"surfaceId":"dash"');
  });

  it("shows streaming skeleton for unclosed a2ui fences and ignores a2ui when enableA2ui is false", async () => {
    const partial = '결과입니다:\n\n```a2ui\n{"version":"1.0","createSurface":{"surfaceId":"s1"';
    await act(async () => root.render(createElement(SafeMarkdown, { text: partial, enableA2ui: true })));
    expect(host.querySelector(".a2ui-streaming")).not.toBeNull();
    expect(host.textContent).toContain("구성 중…");

    // User messages (enableA2ui=false) render raw code block instead of executing A2UI.
    await act(async () => root.render(createElement(SafeMarkdown, { text: partial + "\n```", enableA2ui: false })));
    expect(host.querySelector(".a2ui-shell")).toBeNull();
    expect(host.querySelector(".code-block")).not.toBeNull();
  });

  it("formats structured action payloads cleanly for OpenCode follow-up messages", () => {
    const msg = formatA2uiActionMessage({
      name: "apply_filter",
      surfaceId: "s1",
      sourceComponentId: "btn1",
      context: { category: "laptop", maxPrice: 1500000 },
    });
    expect(msg).toContain("[A2UI 액션: apply_filter]");
    expect(msg).toContain('"category": "laptop"');
  });
});
