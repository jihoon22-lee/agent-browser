import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AGENT_BROWSER_CATALOG_ID, parseA2uiBlock } from "../src/sidepanel/a2ui/parser";
import { safeV09Catalog } from "../src/sidepanel/a2ui/catalog";
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

  it("blocks password aliases, dynamic variant bindings, svg data urls, and enforces collection caps", () => {
    const bigCols = Array.from({ length: 35 }, (_, i) => `C${i}`);
    const bigRows = Array.from({ length: 210 }, (_, i) => [`R${i}`, `${i}`]);
    const bigKv = Array.from({ length: 55 }, (_, i) => ({ label: `K${i}`, value: `V${i}` }));
    const parsed = parseA2uiBlock(JSON.stringify({
      version: "1.0",
      createSurface: {
        surfaceId: "hardened",
        components: [
          { id: "main", component: "Column", children: ["tf1", "tf2", "svgImg", "tbl", "kv"] },
          { id: "tf1", component: "TextField", label: "비밀", variant: { "@path": "/v" }, textFieldType: "obscured" },
          { id: "tf2", component: "TextField", label: "암호", type: "password", usageHint: "obscured" },
          { id: "svgImg", component: "Image", url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", description: "svg" },
          { id: "tbl", component: "DataTable", columns: bigCols, rows: bigRows },
          { id: "kv", component: "KeyValue", items: bigKv },
        ],
      },
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const comps = (parsed.messages[0] as any).createSurface.components;
      // Single non-root top-level component "main" is normalized to "root".
      expect(comps[0].id).toBe("root");
      expect(comps[1].variant).toBe("shortText");
      expect(comps[1].textFieldType).toBeUndefined();
      expect(comps[2].type).toBeUndefined();
      expect(comps[2].usageHint).toBeUndefined();
      expect(comps[3].url).toBe("");
      expect(comps[4].columns).toHaveLength(30);
      expect(comps[4].rows).toHaveLength(200);
      expect(comps[5].items).toHaveLength(50);
      expect(parsed.warnings.some(w => w.includes("비밀번호"))).toBe(true);
      expect(parsed.warnings.some(w => w.includes("URL"))).toBe(true);
      expect(parsed.warnings.some(w => w.includes("상한"))).toBe(true);
    }
  });

  it("repairs real-world LLM mistakes (Card.children, nested inline trees, kebab-case IDs, Button.label, strict extra keys, object DataTable rows)", async () => {
    const onAction = vi.fn(() => "sent" as const);
    // Deliberately combines the exact patterns LLMs produce that broke strict A2UI v1.0 validation in v0.6.0:
    // - version: "v1.0", extra createSurface.title
    // - kebab-case IDs (page-card, stat-1, compare-tbl, apply-btn) failing UAX #31
    // - Card with title + children[] containing BOTH string IDs and inline nested component objects
    // - Row with extra CSS prop gap: 8 and alignment: "flex-start", distribution: "space-between"
    // - Text with variant: "h2" and v0.8 literalString wrapper
    // - StatCard with numeric value (12) and tone: "info"
    // - DataTable with headers + array-of-object rows
    // - Button with label (no child), variant: "secondary", and shorthand action { name, context: { empty: null, keep: "yes" } }
    // - TextField missing required value
    // - Icon with unknown name "sparkles"
    const messyLlmPayload = JSON.stringify({
      version: "v1.0",
      createSurface: {
        surfaceId: "summary-card",
        title: "extra ignored field",
        catalogId: "unknown-llm-catalog",
        components: [
          {
            id: "page-card",
            component: "Card",
            title: "페이지 요약 카드",
            children: [
              { id: "hdr-1", component: "Text", text: { literalString: "핵심 지표" }, variant: "h2" },
              {
                id: "stats-row",
                component: "Row",
                gap: 8,
                distribution: "space-between",
                alignment: "flex-start",
                children: {
                  explicitList: [
                    { id: "stat-1", component: "StatCard", label: "항목 수", value: 12, tone: "info" },
                    { id: "badge-1", component: "Badge", label: "정상", tone: "green" },
                  ],
                },
              },
              { id: "ic-1", component: "Icon", name: "sparkles", size: 16 },
              { id: "kv-1", component: "KeyValue", items: { 대상: "사내 포털", 개수: 3 } },
              {
                id: "compare-tbl",
                component: "DataTable",
                headers: ["항목", "점수"],
                rows: [{ 항목: "후보 A", 점수: 95 }, { 항목: "후보 B", 점수: 88 }],
              },
              { id: "memo-field", component: "TextField", label: "메모", placeholder: "입력하세요" },
              {
                id: "apply-btn",
                component: "Button",
                label: "이대로 적용",
                variant: "secondary",
                action: { name: "apply_summary", context: { empty: null, keep: "yes" } },
              },
            ],
          },
        ],
        dataModel: {},
      },
    });

    await act(async () => root.render(createElement(A2uiCard, { source: messyLlmPayload, markdownRenderer: plainMd, onAction })));

    // Must render the full UI card with ZERO fallback!
    expect(host.querySelector(".a2ui-fallback")).toBeNull();
    expect(host.textContent).toContain("페이지 요약 카드");
    expect(host.textContent).toContain("핵심 지표");
    expect(host.textContent).toContain("12");
    expect(host.textContent).toContain("정상");
    expect(host.textContent).toContain("사내 포털");
    expect(host.textContent).toContain("후보 A");
    expect(host.textContent).toContain("95");
    expect(host.querySelector<HTMLInputElement>(".a2ui-field-input")?.placeholder).toBe("입력하세요");

    // Verify Button synthesized child renders and dispatches normalized action cleanly.
    const applyBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("이대로 적용"));
    expect(applyBtn).toBeDefined();
  });

  it("auto-binds static-literal form inputs to orphan action @paths and empty button contexts", async () => {
    const onAction = vi.fn(() => "sent" as const);
    // Mirrors real-world DeepSeek output: literal ChoicePicker + literal TextField, while Button references @paths.
    const unboundFormPayload = JSON.stringify({
      version: "1.0",
      createSurface: {
        surfaceId: "search_note_form",
        catalogId: AGENT_BROWSER_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["card"] },
          { id: "card", component: "Card", child: "col" },
          { id: "col", component: "Column", children: ["pick", "memo", "submit_btn"] },
          {
            id: "pick",
            component: "ChoicePicker",
            label: "대상 항목",
            variant: "mutuallyExclusive",
            options: [{ label: "검색어 입력", value: "query" }, { label: "분류 선택", value: "category" }],
            value: ["query"],
          },
          { id: "memo", component: "TextField", label: "메모", value: "", placeholder: "메모 입력", variant: "longText" },
          {
            id: "submit_btn",
            component: "Button",
            child: "submit_txt",
            variant: "primary",
            action: { event: { name: "submit_note", context: { item: { "@path": "/selected" }, memo: { "@path": "/memo" } } } },
          },
          { id: "submit_txt", component: "Text", text: "메모 제출" },
        ],
        dataModel: {},
      },
    });

    const parsed = parseA2uiBlock(unboundFormPayload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const cs = (parsed.messages[0] as any).createSurface;
      expect(cs.dataModel).toEqual({ selected: ["query"], memo: "" });
      const pick = cs.components.find((c: any) => c.id === "pick");
      const memo = cs.components.find((c: any) => c.id === "memo");
      expect(pick.value).toEqual({ "@path": "/selected" });
      expect(memo.value).toEqual({ "@path": "/memo" });
    }

    await act(async () => root.render(createElement(A2uiCard, { source: unboundFormPayload, markdownRenderer: plainMd, onAction })));
    const ta = host.querySelector<HTMLTextAreaElement>(".a2ui-field-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "자동 바인딩 메모");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(ta.value).toBe("자동 바인딩 메모");

    // Also verify a Button with omitted context receives fallback `/_form/<id>` bindings.
    const noCtxPayload = parseA2uiBlock(JSON.stringify({
      version: "1.0",
      createSurface: {
        surfaceId: "no_ctx",
        components: [
          { id: "root", component: "Column", children: ["note", "go"] },
          { id: "note", component: "TextField", label: "메모", value: "기본값" },
          { id: "go", component: "Button", label: "확인", action: { event: { name: "confirm" } } },
        ],
      },
    }));
    expect(noCtxPayload.ok).toBe(true);
    if (noCtxPayload.ok) {
      const cs = (noCtxPayload.messages[0] as any).createSurface;
      expect(cs.dataModel).toEqual({ _form: { note: "기본값" } });
      const goBtn = cs.components.find((c: any) => c.id === "go");
      expect(goBtn.action.event.context).toEqual({ note: { "@path": "/_form/note" } });
    }
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

  it("hardens Image (no remote img fetch), TextField (no password + two-way binding), and safeV09Catalog", async () => {
    expect(safeV09Catalog.components.has("Video")).toBe(false);
    expect(safeV09Catalog.components.has("AudioPlayer")).toBe(false);
    expect(safeV09Catalog.components.has("Image")).toBe(true);
    expect(safeV09Catalog.components.has("TextField")).toBe(true);

    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const onAction = vi.fn(() => "sent" as const);
    const payload = JSON.stringify({
      version: "1.0",
      createSurface: {
        surfaceId: "sec",
        catalogId: AGENT_BROWSER_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["remoteImg", "inlineImg", "note", "tbl"] },
          { id: "remoteImg", component: "Image", url: "https://tracker.example/pixel.png", description: "원격 이미지" },
          { id: "inlineImg", component: "Image", url: png, description: "인라인 캡처" },
          { id: "note", component: "TextField", label: "메모", variant: "obscured", value: { "@path": "/note" } },
          {
            id: "tbl",
            component: "DataTable",
            columns: ["항목"],
            rows: [["1번"]],
            selectable: true,
            actionLabel: "적용",
            onSelectAction: { event: { name: "apply_note", context: { note: { "@path": "/note" } } } },
          },
        ],
        dataModel: { note: "초기값" },
      },
    });

    await act(async () => root.render(createElement(A2uiCard, { source: payload, markdownRenderer: plainMd, onAction })));

    // Remote image renders as link only; only the inline base64 PNG uses <img>.
    const imgs = [...host.querySelectorAll("img")];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.src).toContain("data:image/png;base64,");
    const remoteLink = host.querySelector<HTMLAnchorElement>('a[href="https://tracker.example/pixel.png"]');
    expect(remoteLink).not.toBeNull();
    expect(remoteLink!.textContent).toContain("원격 이미지");

    // TextField never renders type="password" and updates dataModel via two-way binding.
    expect(host.querySelector('input[type="password"]')).toBeNull();
    const input = host.querySelector<HTMLInputElement>(".a2ui-field-input")!;
    expect(input.type).toBe("text");
    expect(input.value).toBe("초기값");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "수정된 메모");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // DataTable resolves {"@path": "/note"} inside onSelectAction.event.context.
    await act(async () => host.querySelector<HTMLInputElement>('tbody input[type="checkbox"]')!.click());
    const btn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "적용")!;
    await act(async () => btn.click());
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
      name: "apply_note",
      context: expect.objectContaining({ note: "수정된 메모", count: 1 }),
    }));
  });

  it("reflects drafted and blocked action outcomes accurately and falls back when root is missing", async () => {
    const basePayload = JSON.stringify({
      version: "1.0",
      createSurface: {
        surfaceId: "act-res",
        components: [
          { id: "root", component: "DataTable", columns: ["항목"], rows: [["A"]], selectable: true, actionLabel: "실행", onSelectAction: { event: { name: "run_it" } } },
        ],
      },
    });

    // Blocked outcome must NOT claim "전송됨".
    await act(async () => root.render(createElement(A2uiCard, { source: basePayload, markdownRenderer: plainMd, onAction: () => "blocked" as const })));
    await act(async () => host.querySelector<HTMLInputElement>('tbody input[type="checkbox"]')!.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "실행")!.click());
    expect(host.querySelector(".a2ui-action-sent")).toBeNull();
    expect(host.querySelector(".a2ui-action-drafted")).toBeNull();

    // Drafted outcome shows "입력란에 채움 · run_it".
    await act(async () => root.render(createElement(A2uiCard, { source: basePayload, markdownRenderer: plainMd, onAction: () => "drafted" as const })));
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "실행")!.click());
    expect(host.querySelector(".a2ui-action-drafted")?.textContent).toContain("입력란에 채움 · run_it");

    // Surface with two disjoint non-root components cannot auto-pick a single root and falls back cleanly.
    const noRoot = JSON.stringify({
      version: "1.0",
      createSurface: {
        surfaceId: "noroot",
        components: [
          { id: "a", component: "Text", text: "하나" },
          { id: "b", component: "Text", text: "둘" },
        ],
      },
    });
    await act(async () => root.render(createElement(A2uiCard, { source: noRoot, markdownRenderer: plainMd })));
    expect(host.querySelector(".a2ui-fallback")).not.toBeNull();
  });
});
