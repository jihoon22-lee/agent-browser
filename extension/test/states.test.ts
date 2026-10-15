import { takeSnapshot } from "../src/content/snapshot";
import { resetRegistry } from "../src/content/refs";
const opts = { snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false };
beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });

it("reports widget state that the model needs to choose the next action", () => {
  document.body.innerHTML = `<div role="tab" aria-selected="true" tabindex="0">전체</div><button aria-expanded="false">필터 열기</button>
    <div role="slider" aria-valuenow="3" aria-label="평점" tabindex="0"></div><div role="checkbox" aria-checked="true" tabindex="0">알림</div>
    <input required aria-label="이메일">`;
  const byName = Object.fromEntries(takeSnapshot(opts).elements.map(e => [e.name, e]));
  expect(byName["전체"]).toMatchObject({ state: ["selected"] });
  expect(byName["필터 열기"]).toMatchObject({ state: ["collapsed"] });
  expect(byName["평점"]).toMatchObject({ value: "3" });
  expect(byName["알림"]).toMatchObject({ checked: true });
  expect(byName["이메일"]).toMatchObject({ state: ["required"] });
});
