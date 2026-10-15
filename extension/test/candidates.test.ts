import { takeSnapshot } from "../src/content/snapshot";
import { resetRegistry } from "../src/content/refs";
const opts = { snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false };
beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });

it("lists outer pointer regions and ARIA widgets that were missing", () => {
  document.body.innerHTML = `<div class="card" style="cursor:pointer"><h3>추천 상품: 노트북 거치대</h3><span style="cursor:pointer">19,900원</span></div>
    <div role="searchbox" aria-label="상품 검색"></div><div role="textbox" contenteditable="plaintext-only">메모</div><div>plain</div>
    <button style="cursor:pointer"><span style="cursor:pointer">저장</span></button>`;
  expect(takeSnapshot(opts).elements.map(e => [e.role, e.name])).toEqual([
    ["clickable", "추천 상품: 노트북 거치대19,900원"], ["searchbox", "상품 검색"], ["textbox", "메모"], ["button", "저장"],
  ]);
});
