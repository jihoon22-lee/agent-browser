import { takeSnapshot } from "../src/content/snapshot";
import { resetRegistry } from "../src/content/refs";
const opts = { snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false };
beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });

const orders = `<h1>주문 목록</h1><p>배송 안내 문단입니다.</p><table>
  <tr><td>A-1001</td><td>무선 마우스</td><td><button>취소</button></td></tr>
  <tr><td>A-1002</td><td>키보드</td><td><button>취소</button></td></tr></table>
  <a href="/help">고객센터</a>`;

it("matches a control by the text of its row", () => {
  document.body.innerHTML = orders;
  const result = takeSnapshot({ ...opts, query: "a-1002" });
  const buttons = result.elements.filter(e => e.role === "button");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.name).toBe("취소");
  expect(result.query).toBe("a-1002");
  expect(result.text.content).toContain("A-1002");
  expect(result.text.content).not.toContain("배송 안내");
});

it("matches names, values and links and keeps refs bound like a full snapshot", () => {
  document.body.innerHTML = orders + `<input aria-label="메모" value="고객센터 문의">`;
  const result = takeSnapshot({ ...opts, query: "고객센터" });
  expect(result.elements.map(e => e.name).sort()).toEqual(["고객센터", "메모"]);
  expect(result.elements.every(e => /^s.+f0e\w+$/.test(e.ref))).toBe(true);
  expect(result.elementsTotal).toBe(2);
});

it("reports no match instead of the whole page", () => {
  document.body.innerHTML = orders;
  const result = takeSnapshot({ ...opts, query: "없는말" });
  expect(result.elements).toEqual([]);
  expect(result.text.content).toBe("");
  expect(result.limits).toContain("query-no-match");
});

it("leaves the snapshot unchanged without a query", () => {
  document.body.innerHTML = orders;
  const plain = takeSnapshot(opts);
  expect(plain.elements.filter(e => e.role === "button")).toHaveLength(2);
  expect(plain.query).toBeUndefined();
});

it("never matches the hidden value of a password field", () => {
  document.body.innerHTML = `<label>비밀번호 <input type="password" aria-label="비밀번호" value="hunter2-secret"></label>`;
  const result = takeSnapshot({ ...opts, query: "hunter2" });
  expect(result.elements).toEqual([]);
  expect(result.limits).toContain("query-no-match");
});

it("returns the part of a long line around the match", () => {
  document.body.innerHTML = `<p>${"앞부분 설명입니다. ".repeat(80)}주문 A-1002 처리 완료 ${"뒷부분 설명입니다. ".repeat(80)}</p>`;
  const result = takeSnapshot({ ...opts, query: "a-1002" });
  expect(result.text.content).toContain("A-1002");
  expect(result.text.content.length).toBeLessThanOrEqual(302);
});

it("does not treat a large parent as a row", () => {
  document.body.innerHTML = `<main><p>주문 A-1003 ${"긴 소개 문단. ".repeat(40)}</p><button>저장</button><button>닫기</button></main>`;
  const result = takeSnapshot({ ...opts, query: "a-1003" });
  expect(result.elements.filter(e => e.role === "button")).toEqual([]);
});

it("reads each row's text once even for many controls in it", () => {
  document.body.innerHTML = `<ul><li>${Array.from({ length: 300 }, (_, i) => `<a href="#${i}">링크 ${i}</a>`).join(" ")}</li></ul>`;
  const row = document.querySelector("li")!;
  const read = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!.get!;
  let reads = 0;
  Object.defineProperty(row, "textContent", { configurable: true, get() { reads++; return read.call(this); } });
  takeSnapshot({ ...opts, query: "링크 299" });
  expect(reads).toBeLessThanOrEqual(2);
});

it("reads a row's rendered text: script text does not match, and cells stay separate words", () => {
  document.body.innerHTML = `<table><tr><td>주문</td><td><button>취소</button></td><td><script>var id="A-1002"</script></td></tr>
    <tr><td>A</td><td>1003</td><td><button>보기</button></td></tr></table>`;
  expect(takeSnapshot({ ...opts, query: "A-1002" }).elements.filter(e => e.role === "button")).toEqual([]);
  expect(takeSnapshot({ ...opts, query: "a 1003" }).elements.filter(e => e.role === "button").map(e => e.name)).toEqual(["보기"]);
});
