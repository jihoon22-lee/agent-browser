import { takeSnapshot, utf8Bytes, MAX_SNAPSHOT_BYTES } from "../src/content/snapshot";
import { extract, EXTRACT_BYTES } from "../src/content/extract";
import { resetRegistry } from "../src/content/refs";

beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });

it("keeps a Korean page snapshot inside the UTF-8 byte budget and offers a continuation", () => {
  document.body.innerHTML = `<p>${"가나다라마바사".repeat(4000)}</p>` +
    Array.from({ length: 150 }, (_, i) => `<button>주문 ${i} 상세 보기 버튼입니다</button>`).join("");
  const snapshot = takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 20000, offset: 0, checkLayout: false });
  expect(utf8Bytes(JSON.stringify(snapshot))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  expect(snapshot.text.nextOffset).not.toBeNull();
});

it("keeps Korean text extraction inside the byte budget", async () => {
  document.body.innerHTML = `<p>${"한글본문".repeat(15000)}</p>`;
  const result: any = await extract({ kind: "text", maxChars: 50000 });
  expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(EXTRACT_BYTES + 200);
  expect(result.text.nextOffset).not.toBeNull();
});
