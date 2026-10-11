import { pageText, takeSnapshot } from "../src/content/snapshot";
import { runAction } from "../src/content/actions";
import { resetRegistry } from "../src/content/refs";

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = "<p>일반 본문</p><div id='host'></div>"; resetRegistry(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function root() { return document.getElementById("host")!.attachShadow({ mode: "open" }); }

it("includes shadow-only and nested shadow text in snapshots and text extraction", async () => {
  const shadow = root(); shadow.innerHTML = "루트 텍스트 <button>그림자 버튼</button><div id='nested'></div>";
  shadow.querySelector("#nested")!.attachShadow({ mode: "open" }).innerHTML = "<p>중첩 본문</p>";
  const snap = takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false });
  expect(snap.text.content).toContain("루트 텍스트");
  expect(snap.text.content).toContain("중첩 본문");
  expect(await runAction("extract", { operationId: "shadow-text", generation: 1, kind: "text" })).toMatchObject({ text: { content: snap.text.content } });
});

it("does not duplicate shadow text already supplied by rendered ancestor innerText", () => {
  root().innerHTML = "<p>이미 렌더링됨</p>";
  Object.defineProperty(document.body, "innerText", { configurable: true, value: "일반 본문\n이미 렌더링됨" });
  try { expect(pageText(document)).toBe("일반 본문\n이미 렌더링됨"); }
  finally { delete (document.body as any).innerText; }
});

it("excludes hidden shadow hosts and style/script text", () => {
  root().innerHTML = "<style>button { color:red }</style><script>secretCode()</script><p>보이는 본문</p>";
  expect(pageText(document)).toContain("보이는 본문");
  expect(pageText(document)).not.toContain("secretCode");
  expect(pageText(document)).not.toContain("color:red");
  document.getElementById("host")!.hidden = true;
  expect(pageText(document)).not.toContain("보이는 본문");
});

it("wait notices shadow-only text mutations immediately and removes observers", async () => {
  const shadow = root(); shadow.innerHTML = "<p>로딩 중</p>";
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  const result = runAction("wait", { operationId: "shadow-wait", generation: 1, text: "완료", timeoutMs: 1000 });
  shadow.querySelector("p")!.textContent = "완료";
  await expect(result).resolves.toMatchObject({ verified: { met: "text" }, elapsedMs: 0 });
  expect(disconnect).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("wait discovers a new shadow host inserted after it starts", async () => {
  const result = runAction("wait", { operationId: "shadow-new-host", generation: 1, text: "추가됨", timeoutMs: 1000 });
  const host = document.createElement("div"); host.attachShadow({ mode: "open" }).innerHTML = "<p>추가됨</p>"; document.body.append(host);
  await expect(result).resolves.toMatchObject({ verified: { met: "text" }, elapsedMs: 0 });
});

it("click verification detects mutations inside a shadow root", async () => {
  const shadow = root(); shadow.innerHTML = "<button>변경</button><p>대기</p>";
  shadow.querySelector("button")!.addEventListener("click", () => { shadow.querySelector("p")!.textContent = "변경됨"; });
  const ref = takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 1000, offset: 0, checkLayout: false }).elements[0]!.ref;
  const result = expect(runAction("click", { operationId: "shadow-click", generation: 1, ref })).resolves.toMatchObject({ executed: true, verified: { domChanged: true } });
  await vi.advanceTimersByTimeAsync(500);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

it("retains equal text from independent shadow roots", () => {
  root().innerHTML = "<p>반복된 항목</p>";
  const host = document.createElement("div"); document.body.append(host);
  host.attachShadow({ mode: "open" }).innerHTML = "<p>반복된 항목</p>";
  expect(pageText(document).split("반복된 항목")).toHaveLength(3);
});

it("wait discovers a root attached to an existing host without a document mutation", async () => {
  const result = expect(runAction("wait", { operationId: "late-shadow-root", generation: 1, text: "새 그림자", timeoutMs: 1000 })).resolves.toMatchObject({ verified: { met: "text" } });
  root().innerHTML = "<p>새 그림자</p>";
  await vi.advanceTimersByTimeAsync(250);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

it("does not mistake a substring in ordinary text for an already-rendered shadow chunk", () => {
  document.querySelector("p")!.textContent = "already";
  root().innerHTML = "<p>ready</p>";
  expect(pageText(document)).toBe("already\nready");
});
