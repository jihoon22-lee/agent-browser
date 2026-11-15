import { test, expect } from "@playwright/test";
import { startWorld, type World } from "./harness";

let world: World;
const all = (snapshot: any): Array<{ ref: string; name: string }> => snapshot.frames.flatMap((frame: any) => frame.elements);
const setTrusted = (on: boolean) => world.adminPage.evaluate(async on => { await (globalThis as any).chrome.storage.local.set({ trustedInput: on }); }, on);

test.beforeAll(async () => { world = await startWorld(); });
test.afterEach(async () => {
  await setTrusted(false);
  const status = await world.admin("status.get");
  if (status.operation) await world.mcp.call("browser_tabs", { action: "release", operationId: status.operation.id });
  for (const page of world.context.pages()) if (page !== world.adminPage) await page.close();
});
test.afterAll(async () => { await world?.stop(); });

async function attach(path = "trusted.html") {
  const page = await world.open(path);
  const attached = await world.ok("browser_tabs", { action: "attach", tabId: await world.tabId(page) });
  return { page, attached, operationId: attached.operationId!, ref: (name: string) => all(attached.data.snapshot).find(e => e.name === name)!.ref };
}

test("T01 trusted input reaches a page that ignores synthetic clicks, only when enabled", async () => {
  const { page, operationId, ref } = await attach();
  const plain = await world.ok("browser_click", { operationId, ref: ref("신뢰 버튼") });
  await expect(page.locator("#result")).toHaveText("무시");
  expect(plain.verified!.trusted).toBeUndefined();
  await setTrusted(true);
  const trusted = await world.ok("browser_click", { operationId, ref: ref("신뢰 버튼") });
  await expect(page.locator("#result")).toHaveText("눌림");
  expect(trusted.verified!.trusted).toBe(true);
});

test("T02 an alert is closed and reported, a confirm is declined and reported", async () => {
  await setTrusted(true);
  const { page, operationId, ref } = await attach();
  const alerted = await world.ok("browser_click", { operationId, ref: ref("알림 띄우기") });
  expect(alerted.verified!.dialog).toMatchObject({ type: "alert", message: "저장됨" });
  await expect(page.locator("#result")).toHaveText("알림 닫힘");
  expect((await world.mcp.call("browser_snapshot", { operationId })).ok).toBe(true);
  const fresh = await world.ok("browser_snapshot", { operationId });
  const confirmRef = all(fresh.data).find(e => e.name === "확인창 띄우기")!.ref;
  const confirmed = await world.ok("browser_click", { operationId, ref: confirmRef });
  expect(confirmed.verified!.dialog).toMatchObject({ type: "confirm", message: "삭제할까요?" });
  await expect(page.locator("#result")).toHaveText("취소");
});

test("T03 the debugger is detached when the operation ends", async () => {
  await setTrusted(true);
  const { page, operationId, ref } = await attach();
  await world.ok("browser_click", { operationId, ref: ref("신뢰 버튼") });
  const tabId = await world.tabId(page);
  // Playwright is attached to every tab too, so ask the extension itself: attaching again fails
  // while AgentBrowser still holds the tab, and succeeds once it was released.
  const attachedNow = () => world.adminPage.evaluate(async tabId => new Promise<boolean>(resolve => {
    const d = (globalThis as any).chrome.debugger;
    d.attach({ tabId }, "1.3", () => {
      const error = (globalThis as any).chrome.runtime.lastError;
      if (error) { resolve(/already attached/i.test(error.message)); return; }
      d.detach({ tabId }, () => resolve(false));
    });
  }), tabId);
  expect(await attachedNow()).toBe(true);
  await world.ok("browser_tabs", { action: "release", operationId });
  await expect.poll(attachedNow).toBe(false);
  // It stays detached: nothing re-attaches to a tab that left the operation.
  await page.waitForTimeout(2000);
  expect(await attachedNow()).toBe(false);
});

test("T04 an inactive operation tab can be captured with trusted input", async () => {
  await setTrusted(true);
  const { operationId } = await attach();
  const other = await world.open("index.html");
  await other.bringToFront();
  const shot = await world.mcp.callRaw("browser_screenshot", { operationId });
  expect(shot.isError).not.toBe(true);
  const image = shot.content.find((part) => part.type === "image");
  expect([...Buffer.from(image!.data!, "base64").subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(Buffer.from(image!.data!, "base64").length).toBeGreaterThan(100);
  // Capturing did not activate the operation tab.
  expect(await other.evaluate(() => document.visibilityState)).toBe("visible");
});

// Chrome's popup blocker is on here, as in a user's browser. A window a page opens by script needs a
// real user gesture, which trusted input gives; the agent's own trusted click is not the user's.
for (const [name, kind] of [["스크립트 새 탭", "script"], ["주소가 늦게 정해지는 새 탭", "delayed"]]) test(`T30 ${kind}: a window opened by script after a trusted click joins the operation`, async () => {
  await setTrusted(true);
  const { page, operationId, ref } = await attach("new-tabs.html");
  const original = await world.tabId(page);
  const popup = world.context.waitForEvent("page", { predicate: p => p !== world.adminPage && p !== page });
  const clicked = await world.ok("browser_click", { operationId, ref: ref(name) });
  const child = await popup; await child.waitForURL(`**/new-tab-child.html?kind=${kind}`);
  const childId = await world.tabId(child);
  expect(clicked.verified!.trusted).toBe(true);
  expect(clicked.data.openedTabWarnings ?? []).toEqual([]);
  expect(clicked.data.openedTabs).toEqual(expect.arrayContaining([expect.objectContaining({ tabId: childId, sourceTabId: original })]));
  expect((await world.ok("browser_snapshot", { operationId })).data.tabId).toBe(childId);
});

test("T31 a person's click right after the agent's trusted click is still the person's", async () => {
  await setTrusted(true);
  const { page, operationId, ref } = await attach("new-tabs.html");
  const original = await world.tabId(page);
  await page.locator("#original-note").evaluate(input => input.addEventListener("click", () => input.setAttribute("data-clicked", "true")));
  const commandSeen = world.relay.nextCommand("browser.click");
  const clicking = world.ok("browser_click", { operationId, ref: ref("원본 메모") });
  await commandSeen;
  await expect(page.locator("#original-note")).toHaveAttribute("data-clicked", "true");
  const popup = world.context.waitForEvent("page", { predicate: p => p !== world.adminPage && p !== page });
  await page.locator("a").first().click(); const child = await popup;
  const result = await clicking, childId = await world.tabId(child);
  expect(result.verified!.trusted).toBe(true);
  expect(result.data.openedTabs ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ tabId: childId })]));
  expect(result.data.openedTabWarnings).toContainEqual({ tabId: childId, reason: "user-intervention" });
  const status = await world.admin("status.get"); expect(status.operation.currentTab).toBe(original); expect(status.operation.tabs).not.toContain(childId);
});

test("T32 a trusted Enter on a button that opens a window by script adds that window to the operation", async () => {
  await setTrusted(true);
  const { page, operationId, ref } = await attach("new-tabs.html");
  const original = await world.tabId(page);
  const popup = world.context.waitForEvent("page", { predicate: p => p !== world.adminPage && p !== page });
  const pressed = await world.ok("browser_press", { operationId, ref: ref("스크립트 새 탭"), key: "Enter" });
  const child = await popup; await child.waitForURL("**/new-tab-child.html?kind=script");
  const childId = await world.tabId(child);
  expect(pressed.data.openedTabWarnings ?? []).toEqual([]);
  expect(pressed.data.openedTabs).toEqual(expect.arrayContaining([expect.objectContaining({ tabId: childId, sourceTabId: original })]));
});
