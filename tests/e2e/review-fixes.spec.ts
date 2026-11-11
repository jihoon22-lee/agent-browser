import { test, expect } from "@playwright/test";
import { startWorld, type World } from "./harness";

/** Layout- and browser-dependent fixes from the 2026-11-11 review (plan items A2, A6, A7, A9, A11). */
let world: World;
const all = (snapshot: any): Array<{ ref: string; name: string }> => snapshot.frames.flatMap((frame: any) => frame.elements);
const refIn = (snapshot: any, name: string) => { const found = all(snapshot).filter(e => e.name === name); expect(found, name).toHaveLength(1); return found[0]!.ref; };
const setTrusted = (on: boolean) => world.adminPage.evaluate(async on => { await (globalThis as any).chrome.storage.local.set({ trustedInput: on }); }, on);
/** A loopback port nothing listens on: Chrome shows its own error page. */
const UNREACHABLE = "http://127.0.0.1:1/";

test.beforeAll(async () => { world = await startWorld(); });
test.afterEach(async () => {
  await setTrusted(false);
  const status = await world.admin("status.get");
  if (status.operation) await world.mcp.call("browser_tabs", { action: "release", operationId: status.operation.id });
  for (const page of world.context.pages()) if (page !== world.adminPage) await page.close();
});
test.afterAll(async () => { await world?.stop(); });

async function attach(prepare: (page: import("@playwright/test").Page) => Promise<void>, path = "pointer.html") {
  const page = await world.open(path);
  await prepare(page);
  const attached = await world.ok("browser_tabs", { action: "attach", tabId: await world.tabId(page) });
  return { page, operationId: attached.operationId!, snapshot: attached.data.snapshot };
}

for (const trusted of [false, true]) {
  const label = trusted ? "trusted" : "DOM";
  test(`A2 ${label}: a drag whose target must be scrolled into view still presses on the source`, async () => {
    await setTrusted(trusted);
    const { page, operationId, snapshot } = await attach(async page => {
      await page.setViewportSize({ width: 800, height: 400 });
      await page.evaluate(() => {
        const items = document.querySelectorAll<HTMLElement>(".item");
        // Item C starts below the fold; A and C still fit in the viewport together.
        items[2]!.style.marginTop = "260px";
        (window as any).__press = [];
        document.addEventListener("mousedown", event => {
          const r = items[0]!.getBoundingClientRect();
          (window as any).__press.push({ target: (event.target as Element).closest(".item")?.getAttribute("data-id") ?? null,
            inside: event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom });
        }, true);
      });
    });
    expect(await page.evaluate(() => document.querySelectorAll(".item")[2]!.getBoundingClientRect().top >= innerHeight)).toBe(true);
    const result = await world.ok("browser_click", { operationId, ref: refIn(snapshot, "항목 A"), toRef: refIn(snapshot, "항목 C"), mode: "drag" });
    if (trusted) expect(result.verified!.trusted).toBe(true);
    expect(await page.evaluate(() => (window as any).__press)).toEqual([{ target: "A", inside: true }]);
    await expect(page.locator("#order")).toHaveText("B,A,C");
  });
}

test("A2: a drag whose two ends cannot be on screen together is refused before any input", async () => {
  const { page, operationId, snapshot } = await attach(async page => {
    await page.setViewportSize({ width: 800, height: 400 });
    await page.evaluate(() => {
      const items = document.querySelectorAll<HTMLElement>(".item");
      items[2]!.style.marginTop = "2000px";
      (window as any).__events = 0;
      for (const type of ["pointerdown", "mousedown", "mouseup"]) document.addEventListener(type, () => { (window as any).__events++; }, true);
    });
  });
  const result = await world.mcp.call("browser_click", { operationId, ref: refIn(snapshot, "항목 A"), toRef: refIn(snapshot, "항목 C"), mode: "drag" });
  expect(result.ok, JSON.stringify(result)).toBe(false);
  expect(result.error?.code).toBe("ELEMENT_NOT_INTERACTABLE");
  expect(await page.evaluate(() => (window as any).__events)).toBe(0);
  await expect(page.locator("#order")).toHaveText("A,B,C");
});

test("A7: controls inside a collapsed <details> are not offered until it is opened", async () => {
  const { operationId, snapshot } = await attach(async page => {
    await page.evaluate(() => {
      const details = document.createElement("details");
      const summary = document.createElement("summary"); summary.textContent = "더보기";
      const hidden = document.createElement("button"); hidden.textContent = "접힌 버튼";
      details.append(summary, hidden); document.body.prepend(details);
    });
  });
  const names = all(snapshot).map(e => e.name);
  expect(names).toContain("더보기");
  expect(names).not.toContain("접힌 버튼");
  const opened = await world.ok("browser_click", { operationId, ref: refIn(snapshot, "더보기") });
  expect(opened.ok).toBe(true);
  const after = (await world.ok("browser_snapshot", { operationId })).data;
  expect(all(after).map(e => e.name)).toContain("접힌 버튼");
});

test("A11: an element that cannot be brought into the viewport is not clicked", async () => {
  const { page, operationId, snapshot } = await attach(async page => {
    await page.evaluate(() => {
      const button = document.createElement("button"); button.textContent = "화면 밖";
      button.style.cssText = "position:fixed;left:-500px;top:10px";
      (window as any).__offscreen = 0; button.addEventListener("click", () => { (window as any).__offscreen++; });
      // The common custom-checkbox pattern: the native control is parked off screen behind its label.
      const label = document.createElement("label"); label.textContent = "동의";
      const box = document.createElement("input"); box.type = "checkbox"; box.style.cssText = "position:absolute;left:-9999px";
      label.prepend(box);
      document.body.append(button, label);
    });
  });
  const checked = await world.ok("browser_select", { operationId, ref: refIn(snapshot, "동의"), checked: true });
  expect(checked.verified).toMatchObject({ checked: true });
  const result = await world.mcp.call("browser_click", { operationId, ref: refIn(snapshot, "화면 밖") });
  expect(result.ok, JSON.stringify(result)).toBe(false);
  expect(result.error?.code).toBe("ELEMENT_NOT_INTERACTABLE");
  expect(await page.evaluate(() => (window as any).__offscreen)).toBe(0);
});

test("A6: a subframe showing Chrome's error page does not prevent closing the tab", async () => {
  const { page, operationId } = await attach(async page => {
    await page.evaluate(async url => {
      const frame = document.createElement("iframe"); frame.src = url; frame.title = "broken";
      const settled = new Promise(resolve => { frame.addEventListener("load", resolve); setTimeout(resolve, 3000); });
      document.body.append(frame); await settled;
    }, UNREACHABLE);
  });
  const snapshot = await world.ok("browser_snapshot", { operationId });
  expect(snapshot.data.frameErrors.length, JSON.stringify(snapshot.data.frameErrors)).toBeGreaterThan(0);
  const closed = await world.mcp.call("browser_tabs", { action: "close", operationId });
  expect(closed.ok, JSON.stringify(closed)).toBe(true);
  await expect.poll(() => page.isClosed()).toBe(true);
});

test("A9: navigating to a host that cannot be reached is reported as a failure", async () => {
  const { page, operationId } = await attach(async () => {});
  const result = await world.mcp.call("browser_navigate", { operationId, url: UNREACHABLE });
  expect(result.ok, JSON.stringify(result)).toBe(false);
  expect(JSON.stringify(result.error)).toMatch(/ERR_|could not be loaded|error page/i);
  // The failure is final: nothing asks the agent to keep retrying snapshots of an error page.
  const snapshot = await world.mcp.call("browser_snapshot", { operationId });
  if (!snapshot.ok) expect(snapshot.error?.retry).not.toBe("safe");
  expect(page.isClosed()).toBe(false);
});
