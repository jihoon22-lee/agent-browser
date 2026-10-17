import { test, expect } from "@playwright/test";
import { startWorld, type World } from "./harness";

type El = { ref: string; name: string; role: string; context?: string; state?: string[] };
let world: World;
const all = (snapshot: any): El[] => snapshot.frames.flatMap((frame: any) => frame.elements);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

test.beforeAll(async () => { world = await startWorld(); });
test.beforeEach(async () => { await fetch(`${world.fixture.base}/__reset`, { method: "POST" }); });
test.afterEach(async () => {
  const status = await world.admin("status.get");
  if (status.operation) await world.mcp.call("browser_tabs", { action: "release", operationId: status.operation.id });
  for (const page of world.context.pages()) if (page !== world.adminPage) await page.close();
});
test.afterAll(async () => { await world?.stop(); });

async function attachShop() {
  const page = await world.open("shop.html");
  const attached = await world.ok("browser_tabs", { action: "attach", tabId: await world.tabId(page) });
  return { page, attached, operationId: attached.operationId! };
}

test("R01 attach returns a bounded snapshot that names icons, cards, rows and states", async () => {
  const { attached } = await attachShop();
  const els = all(attached.data.snapshot);
  expect(bytes(attached)).toBeLessThanOrEqual(40_000);
  expect(els.find(e => e.role === "link")?.name).toBe("쇼핑몰 홈");
  expect(els.some(e => e.name === "장바구니")).toBe(true);
  expect(els.find(e => e.role === "clickable")?.name).toContain("노트북 거치대");
  expect(els.filter(e => e.name === "취소").map(e => e.context)).toEqual([expect.stringContaining("A-1001"), expect.stringContaining("A-1002")]);
  expect(els.find(e => e.name === "전체")?.state).toContain("selected");
  expect(els.find(e => e.name === "필터 열기")?.state).toContain("collapsed");
  expect(attached.data.openTabs.some((tab: any) => tab.tabId === attached.data.tab.tabId)).toBe(true);
  expect(els[0]!.ref.length).toBeLessThanOrEqual(12);
});

test("R02 consecutive clicks use refs from the previous result without separate snapshots", async () => {
  const { page, attached, operationId } = await attachShop();
  const cancel = all(attached.data.snapshot).find(e => e.name === "취소" && e.context?.includes("A-1002"))!;
  const first = await world.ok("browser_click", { operationId, ref: cancel.ref });
  await expect(page.locator("#result")).toHaveText("A-1002 취소됨");
  const filter = all(first.data.snapshot).find(e => e.name === "필터 열기")!;
  const second = await world.ok("browser_click", { operationId, ref: filter.ref });
  expect(all(second.data.snapshot).find(e => e.name === "필터 열기")?.state).toContain("expanded");
  const card = all(second.data.snapshot).find(e => e.role === "clickable")!;
  await world.ok("browser_click", { operationId, ref: card.ref });
  await expect(page.locator("#result")).toHaveText("거치대 선택");
});

test("R03 a hidden checkbox under its styled label is clicked on a smooth-scrolling page", async () => {
  const { page, attached, operationId } = await attachShop();
  const agree = all(attached.data.snapshot).find(e => e.name === "약관 동의" && e.role === "checkbox")!;
  await world.ok("browser_click", { operationId, ref: agree.ref });
  await expect(page.locator("#agree")).toBeChecked();
});

test("R04 goto works without a prior snapshot and returns the new page", async () => {
  const page = await world.open("shop.html");
  const operationId = await world.attach(page);
  const moved = await world.ok("browser_navigate", { operationId, url: `${world.fixture.base}/search.html` });
  expect(moved.data.snapshot.url).toContain("search.html");
});

test("R05 a 5,000-row page snapshots within three seconds and stays bounded", async () => {
  const page = await world.open("shop.html");
  await page.evaluate(() => { const list = document.createElement("ul"); for (let i = 0; i < 5000; i++) { const li = document.createElement("li"); li.textContent = `행 ${i}`; li.style.cursor = "pointer"; list.append(li); } document.body.append(list); });
  const operationId = await world.attach(page);
  const started = Date.now();
  const snapshot = await world.ok("browser_snapshot", { operationId });
  expect(Date.now() - started).toBeLessThan(3000);
  expect(bytes(snapshot)).toBeLessThanOrEqual(40_000);
});

test("R06 a link click that navigates returns the arrived page, not the old one", async () => {
  const page = await world.open("shop.html");
  await page.evaluate(() => { const link = document.createElement("a"); link.href = "/search.html"; link.textContent = "검색 페이지로"; document.body.prepend(link); });
  const attached = await world.ok("browser_tabs", { action: "attach", tabId: await world.tabId(page) });
  const link = all(attached.data.snapshot).find(e => e.name === "검색 페이지로")!;
  const clicked = await world.ok("browser_click", { operationId: attached.operationId!, ref: link.ref });
  expect(clicked.data.snapshot.url).toContain("search.html");
  expect(all(clicked.data.snapshot).some(e => e.name === "검색어")).toBe(true);
});

test("R07 a query returns only the matching row's control, whose ref works at once", async () => {
  const { page, operationId } = await attachShop();
  const found = await world.ok("browser_snapshot", { operationId, query: "A-1002" });
  const cancels = all(found.data).filter(e => e.name === "취소");
  expect(cancels).toHaveLength(1);
  expect(found.data.frames[0].query).toBe("a-1002");
  expect(bytes(found)).toBeLessThan(bytes(await world.ok("browser_snapshot", { operationId })) / 2);
  await world.ok("browser_click", { operationId, ref: cancels[0]!.ref });
  await expect(page.locator("#s2")).toHaveText("취소됨");
  await expect(page.locator("#s1")).toHaveText("배송중");
});

test("R08 a click whose script navigates 0.8s later returns the arrived page", async () => {
  const page = await world.open("late-nav.html");
  const attached = await world.ok("browser_tabs", { action: "attach", tabId: await world.tabId(page) });
  const button = all(attached.data.snapshot).find(e => e.name === "잠시 후 이동")!;
  const clicked = await world.ok("browser_click", { operationId: attached.operationId, ref: button.ref });
  expect(clicked.verified).toMatchObject({ navigated: true, lateNavigation: true });
  expect(clicked.data.snapshot.url).toContain("detail.html");
});

test("V01 the work marker shows on the operation tab but never in snapshots or clicks", async () => {
  const { page, attached, operationId } = await attachShop();
  await expect(page.locator("#agent-browser-work-marker")).toHaveCount(1);
  const read = await world.ok("browser_snapshot", { operationId });
  expect(JSON.stringify(read.data)).not.toContain("작업 중");
  const filter = all(attached.data.snapshot).find(e => e.name === "필터 열기")!;
  await world.ok("browser_click", { operationId, ref: filter.ref });
  await expect(page.locator("#filter")).toHaveAttribute("aria-expanded", "true");
  await world.ok("browser_tabs", { action: "release", operationId });
  await expect(page.locator("#agent-browser-work-marker")).toHaveCount(0);
});
