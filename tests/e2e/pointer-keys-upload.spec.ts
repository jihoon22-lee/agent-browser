import { test, expect } from "@playwright/test";
import { startWorld, type World } from "./harness";
import { startOpenCodeFixture } from "../fixtures/opencode.mjs";

let world: World, api: Awaited<ReturnType<typeof startOpenCodeFixture>>, lease: string | undefined;
const all = (snapshot: any): Array<{ ref: string; name: string }> => snapshot.frames.flatMap((frame: any) => frame.elements);
const setTrusted = (on: boolean) => world.adminPage.evaluate(async on => { await (globalThis as any).chrome.storage.local.set({ trustedInput: on }); }, on);
const panel = async (message: any) => { const response = await world.adminPage.evaluate(m => (globalThis as any).chrome.runtime.sendMessage(m), message); expect(response?.ok, JSON.stringify(response)).toBe(true); return response.result; };
const refIn = (snapshot: any, name: string) => { const found = all(snapshot).filter(e => e.name === name); expect(found, name).toHaveLength(1); return found[0]!.ref; };
const fresh = async (operationId: string) => (await world.ok("browser_snapshot", { operationId })).data;

test.beforeAll(async () => {
  world = await startWorld(); api = await startOpenCodeFixture();
  await world.admin("profile.save", { profile: { id: "uploads", name: "Synthetic uploads", kind: "external", baseUrl: api.origin, username: api.username, password: api.password, directory: api.directory } });
});
test.afterEach(async () => {
  await setTrusted(false);
  if (lease) { await panel({ kind: "request-discard", requestId: lease }); lease = undefined; }
  const status = await world.admin("status.get");
  if (status.operation) await world.mcp.call("browser_tabs", { action: "release", operationId: status.operation.id });
  for (const page of world.context.pages()) if (page !== world.adminPage) await page.close();
});
test.afterAll(async () => { await world?.stop(); await api?.close(); });

async function attach() {
  const page = await world.open("pointer.html");
  const attached = await world.ok("browser_tabs", { action: "attach", tabId: await world.tabId(page) });
  return { page, operationId: attached.operationId!, snapshot: attached.data.snapshot };
}

for (const trusted of [false, true]) {
  const label = trusted ? "trusted" : "DOM";
  test.describe(`${label} input`, () => {
    test.beforeEach(async () => { await setTrusted(trusted); });

    test(`P01 ${label}: hover opens the menu without following its link`, async () => {
      const { page, operationId, snapshot } = await attach();
      const before = page.url();
      const result = await world.ok("browser_click", { operationId, ref: refIn(snapshot, "메뉴"), mode: "hover" });
      await expect(page.locator("#hover")).toHaveText("열림");
      expect(page.url()).toBe(before);
      expect(result.verified!.mode).toBe("hover");
      if (trusted) expect(result.verified!.trusted).toBe(true);
    });

    test(`P02 ${label}: double and right clicks reach their own handlers`, async () => {
      const { page, operationId, snapshot } = await attach();
      await world.ok("browser_click", { operationId, ref: refIn(snapshot, "카운터"), mode: "double" });
      await expect(page.locator("#counts")).toHaveText("click 2 dbl 1 context 0");
      await world.ok("browser_click", { operationId, ref: refIn(await fresh(operationId), "카운터"), mode: "right" });
      await expect(page.locator("#counts")).toHaveText("click 2 dbl 1 context 1");
    });

    test(`P03 ${label}: drag reorders a pointer list and drops onto an HTML5 target`, async () => {
      const { page, operationId, snapshot } = await attach();
      await world.ok("browser_click", { operationId, ref: refIn(snapshot, "항목 A"), toRef: refIn(snapshot, "항목 C"), mode: "drag" });
      await expect(page.locator("#order")).toHaveText("B,A,C");
      const next = await fresh(operationId);
      await world.ok("browser_click", { operationId, ref: refIn(next, "카드"), toRef: refIn(next, "드롭 영역"), mode: "drag" });
      await expect(page.locator("#dropped")).toHaveText("카드 놓임");
    });

    test(`P04 ${label}: Control+A then Delete empties a field and Control+Enter reaches the site`, async () => {
      const { page, operationId, snapshot } = await attach();
      const memo = refIn(snapshot, "메모");
      await world.ok("browser_press", { operationId, ref: memo, key: "a", modifiers: ["Control"] });
      await world.ok("browser_press", { operationId, ref: memo, key: "Delete" });
      await expect(page.locator("textarea")).toHaveValue("");
      await world.ok("browser_fill", { operationId, ref: refIn(await fresh(operationId), "메모"), text: "안녕" });
      await world.ok("browser_press", { operationId, ref: refIn(await fresh(operationId), "메모"), key: "Enter", modifiers: ["Control"] });
      await expect(page.locator("#sent")).toHaveText("보냄: 안녕");
      // A clipboard shortcut never goes out as real input.
      if (trusted) {
        const paste = await world.ok("browser_press", { operationId, ref: refIn(await fresh(operationId), "메모"), key: "v", modifiers: ["Control"] });
        expect(paste.verified!.trusted).toBe(false);
        await expect(page.locator("textarea")).toHaveValue("안녕");
      }
    });
  });
}

test("P05 only a file attached to the running panel request can be uploaded", async () => {
  const page = await world.open("pointer.html");
  lease = crypto.randomUUID();
  const scope = { requestId: lease, messageId: "msg_" + lease, profileId: "uploads", directory: api.directory, sessionId: api.session().id };
  // A 1x1 PNG, synthetic.
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const prepared = await panel({ kind: "request-prepare", lease: scope, target: { tabId: await world.tabId(page), windowId: 1 }, files: [{ name: "a.png", mime: "image/png", dataUrl: png }] });
  expect(prepared.system).toContain("a.png");
  const attached = await world.ok("browser_tabs", { action: "attach", requestId: lease });
  const operationId = attached.operationId!;
  const label = refIn(attached.data.snapshot, "사진 선택");
  const other = await world.mcp.call("browser_upload", { operationId, ref: label, file: "b.png" });
  expect(other.ok).toBe(false);
  expect(JSON.stringify(other)).toContain("no attachment named");
  await expect(page.locator("#file-name")).toHaveText("파일 없음");
  const uploaded = await world.ok("browser_upload", { operationId, ref: refIn(await fresh(operationId), "사진 선택"), file: "a.png" });
  expect(uploaded.verified).toMatchObject({ files: ["a.png"] });
  await expect(page.locator("#file-name")).toHaveText(/^a\.png image\/png \d+$/);
  await panel({ kind: "request-discard", requestId: lease }); lease = undefined;
  const after = await world.mcp.call("browser_upload", { operationId, ref: label, file: "a.png" });
  expect(after.ok).toBe(false);
});
