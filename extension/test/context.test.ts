import { takeSnapshot, utf8Bytes, MAX_SNAPSHOT_BYTES } from "../src/content/snapshot";
import { resetRegistry } from "../src/content/refs";
const opts = { snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false };
beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });

it("adds row context only to otherwise identical controls", () => {
  document.body.innerHTML = `<table><tr><td>A-1001</td><td><button>취소</button></td></tr><tr><td>A-1002</td><td><button>취소</button></td></tr></table><button>저장</button>`;
  const elements = takeSnapshot(opts).elements;
  expect(elements.filter(e => e.name === "취소").map(e => e.context)).toEqual([expect.stringContaining("A-1001"), expect.stringContaining("A-1002")]);
  expect(elements.find(e => e.name === "저장")?.context).toBeUndefined();
});

it("finds row context in plain div lists used by single-page apps", () => {
  document.body.innerHTML = `<div class="list"><div class="row"><span>김철수</span><span>대기</span><div><button>승인</button></div></div>
    <div class="row"><span>이영희</span><span>대기</span><div><button>승인</button></div></div></div>`;
  const approvals = takeSnapshot(opts).elements.filter(e => e.name === "승인");
  expect(approvals.map(e => e.context)).toEqual([expect.stringContaining("김철수"), expect.stringContaining("이영희")]);
});

it("keeps the byte budget after adding contexts", () => {
  document.body.innerHTML = Array.from({ length: 150 }, (_, i) => `<li>${"긴 설명 문장입니다 ".repeat(8)}${i}<button>보기</button></li>`).join("");
  expect(utf8Bytes(JSON.stringify(takeSnapshot(opts)))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
});
