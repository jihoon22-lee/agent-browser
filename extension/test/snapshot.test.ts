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
