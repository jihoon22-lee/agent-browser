import { test, expect, type Page } from '@playwright/test';
import { startWorld, type World } from './harness';

let world: World;
test.beforeAll(async () => { world = await startWorld(); });
test.afterEach(async () => {
  await world.adminPage.evaluate(async () => { await (globalThis as any).chrome.storage.local.set({ trustedInput: false }); });
  const status = await world.admin('status.get');
  if (status.operation) await world.mcp.call('browser_tabs', { action: 'release', operationId: status.operation.id });
  for (const page of world.context.pages()) if (page !== world.adminPage) await page.close();
});
test.afterAll(async () => world?.stop());

async function attach(page: Page, name: string) {
  const tabId = await world.tabId(page);
  const attached = await world.ok('browser_tabs', { action: 'attach', tabId });
  const elements = attached.data.snapshot.frames.flatMap((frame: any) => frame.elements);
  return { tabId, operationId: attached.operationId!, ref: elements.find((element: any) => element.name === name)!.ref };
}

async function submitFixture() {
  const page = await world.open('quality.html');
  await page.evaluate(() => {
    document.body.innerHTML = '<button>Submit fixture</button>';
    (window as any).inputSafetyWrites = [];
    document.querySelector('button')!.addEventListener('click', event => (window as any).inputSafetyWrites.push({ trusted: event.isTrusted }));
  });
  return { page, ...await attach(page, 'Submit fixture') };
}

test('S01 cancellation during a trusted request never revives it as a DOM click', async () => {
  const { page, tabId, operationId, ref } = await submitFixture();
  // Delay only the trusted reply, in this extension's isolated content world.
  await world.adminPage.evaluate(async tabId => {
    const chrome = (globalThis as any).chrome;
    await chrome.storage.local.set({ trustedInput: true });
    await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const chrome = (globalThis as any).chrome, send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message: any, ...rest: any[]) => {
        if (message.kind !== 'trusted-input') return send(message, ...rest);
        document.documentElement.dataset.trustedWaiting = 'yes';
        return new Promise(resolve => { (globalThis as any).finishTrusted = () => resolve({ ok: false, reason: 'not-allowed' }); });
      };
    } });
  }, tabId);
  const pending = world.mcp.call('browser_click', { operationId, ref });
  await expect(page.locator('html')).toHaveAttribute('data-trusted-waiting', 'yes');
  await world.admin('operation.abort', { operationId });
  await world.adminPage.evaluate(async ({ tabId, operationId }) => {
    const chrome = (globalThis as any).chrome;
    // Await content cancellation too; the assertion must not depend on transport timing.
    await chrome.tabs.sendMessage(tabId, { kind: 'cancel', operationId });
    await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
      (globalThis as any).finishTrusted();
      await new Promise(resolve => setTimeout(resolve, 0));
    } });
  }, { tabId, operationId });
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(['CANCELLED', 'EXECUTION_UNKNOWN']).toContain(result.error?.code);
  expect(await page.evaluate(() => (window as any).inputSafetyWrites)).toEqual([]);
});
