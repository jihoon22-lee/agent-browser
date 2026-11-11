import { takeSnapshot } from "../src/content/snapshot";
import { RefTable } from "../src/content/refs";
import { resetRegistry, resolveRef } from "../src/content/refs";

const opts = { snapshotId: 3, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false };

beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });

describe("snapshot", () => {
  it("lists interactive elements with labels, state and refs", () => {
    document.body.innerHTML = `
      <label for="q">검색어</label><input id="q" value="abc">
      <select id="c"><option>전체</option><option selected>도서</option></select>
      <label><input type="checkbox" id="a" checked> 약관 동의</label>
      <button disabled>저장</button><a href="/x">상세 보기</a>
      <div hidden><button>숨김</button></div>`;
    const s = takeSnapshot(opts);
    const byName = Object.fromEntries(s.elements.map((e) => [e.name, e]));
    expect(byName["검색어"]).toMatchObject({ role: "textbox", value: "abc", ref: "s3f0e1" });
    expect(byName["분류"] ?? Object.values(byName).find((e) => e.role === "combobox")).toMatchObject({ value: "도서", options: ["전체", "도서"] });
    expect(byName["약관 동의"]).toMatchObject({ role: "checkbox", checked: true });
    expect(byName["저장"]).toMatchObject({ role: "button", disabled: true });
    expect(byName["상세 보기"]).toMatchObject({ role: "link" });
    expect(byName["숨김"]).toBeUndefined();
  });

  it("includes elements inside open shadow roots", () => {
    const host = document.createElement("div");
    document.body.append(host);
    host.attachShadow({ mode: "open" }).innerHTML = "<button>그림자 버튼</button>";
    const s = takeSnapshot(opts);
    expect(s.elements.find((e) => e.name === "그림자 버튼")).toMatchObject({ inShadow: true });
  });

  it("truncates text by characters with a next offset", () => {
    document.body.innerHTML = `<p>${"가".repeat(5000)}</p>`;
    const s = takeSnapshot({ ...opts, maxChars: 1000 });
    expect(s.text).toMatchObject({ returnedChars: 1000, truncated: true, nextOffset: 1000, totalChars: 5000 });
    const next = takeSnapshot({ ...opts, snapshotId: 4, maxChars: 1000, offset: 4500 });
    expect(next.text).toMatchObject({ returnedChars: 500, truncated: false, nextOffset: null });
  });

  it("caps element count and says so", () => {
    document.body.innerHTML = Array.from({ length: 300 }, (_, i) => `<button>b${i}</button>`).join("");
    const s = takeSnapshot({ ...opts, maxElements: 150 });
    expect(s.elements).toHaveLength(150);
    expect(s.elementsTruncated).toBe(true);
  });

  it("does not leak the value of an unlabelled password field through its name", () => {
    document.body.innerHTML = `<input type="password" value="secret"><input type="text" value="visible-value"><input type="submit" value="로그인">`;
    const s = takeSnapshot(opts);
    expect(JSON.stringify(s)).not.toContain("secret");
    // a text field's value is reported in `value`, never borrowed as its name; a submit button's value is its label
    expect(s.elements.find((e) => e.value === "visible-value")?.name).toBe("");
    expect(s.elements.find((e) => e.role === "button")?.name).toBe("로그인");
  });

  it("does not leak password values", () => {
    document.body.innerHTML = `<label for="p">비밀번호</label><input id="p" type="password" value="secret">`;
    const s = takeSnapshot(opts);
    expect(JSON.stringify(s)).not.toContain("secret");
  });
});

describe("refs", () => {
  it("resolves refs from the latest snapshots and reports stale ones", () => {
    document.body.innerHTML = `<button id="b">확인</button>`;
    const s = takeSnapshot(opts);
    const ref = s.elements[0]!.ref;
    expect(resolveRef(ref)).toBe(document.getElementById("b"));
    document.body.innerHTML = `<button id="b">확인</button>`; // re-rendered: same text, new node
    expect(() => resolveRef(ref)).toThrowError(expect.objectContaining({ code: "STALE_ELEMENT" }));
  });

  it("unknown snapshot ids are stale, malformed refs are not found", () => {
    expect(() => resolveRef("s99f0e1")).toThrowError(expect.objectContaining({ code: "STALE_ELEMENT" }));
    expect(() => resolveRef("button")).toThrowError(expect.objectContaining({ code: "ELEMENT_NOT_FOUND" }));
  });

  it("parses frame ids", () => {
    expect(RefTable.parse("s3f12e7")).toEqual({ snapshotId: 3, frameId: 12, index: 7 });
  });
});

it('rejects a recycled row whose href changed without replacing the DOM node', () => {
  document.body.innerHTML = '<a href="/post/1">Post</a>';
  const s = takeSnapshot(opts);
  document.querySelector('a')!.href = '/post/2';
  expect(() => resolveRef(s.elements[0]!.ref)).toThrowError(expect.objectContaining({ code: 'STALE_ELEMENT' }));
});
it('rejects a recycled button with changed accessible identity', () => {
  document.body.innerHTML = '<button aria-label="Read post 1">Read</button>';
  const s = takeSnapshot(opts);
  document.querySelector('button')!.setAttribute('aria-label', 'Read post 2');
  expect(() => resolveRef(s.elements[0]!.ref)).toThrowError(expect.objectContaining({ code: 'STALE_ELEMENT' }));
});

it('flags a document the DOM cannot read, such as a PDF viewer', () => {
  const type = vi.spyOn(document, 'contentType', 'get');
  try {
    type.mockReturnValue('application/pdf');
    document.body.innerHTML = '<embed type="application/pdf" src="about:blank">';
    expect(takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 1000, offset: 0, checkLayout: false }).limits).toContain('document-content-not-readable');
    type.mockReturnValue('text/html');
    expect(takeSnapshot({ snapshotId: 2, frameId: 0, maxChars: 1000, offset: 0, checkLayout: false }).limits).toEqual(['embedded-content-not-readable']);
    document.body.innerHTML = '<p>plain</p>';
    for (const readable of ['text/html', 'application/xhtml+xml', 'text/plain', 'image/svg+xml'])
      { type.mockReturnValue(readable); expect(takeSnapshot({ snapshotId: 3, frameId: 0, maxChars: 1000, offset: 0, checkLayout: false }).limits).toEqual([]); }
  } finally { type.mockRestore(); }
});

it('does not offer a control the browser reports as not rendered (collapsed details, content-visibility)', () => {
  document.body.innerHTML = '<details><summary>More</summary><button>Folded</button></details>';
  const button = document.querySelector('button')!, summary = document.querySelector('summary')!;
  const rect = [{ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }] as unknown as DOMRectList;
  vi.spyOn(button, 'getClientRects').mockReturnValue(rect); vi.spyOn(summary, 'getClientRects').mockReturnValue(rect);
  (button as any).checkVisibility = () => false; (summary as any).checkVisibility = () => true;
  const names = () => takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 1000, offset: 0, checkLayout: true }).elements.map(e => e.name);
  expect(names()).toEqual(['More']);
  (button as any).checkVisibility = () => true;
  expect(names()).toEqual(['More', 'Folded']);
});
